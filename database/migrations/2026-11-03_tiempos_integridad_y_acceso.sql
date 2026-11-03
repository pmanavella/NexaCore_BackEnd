-- Corrección incremental de 2026-11-03_tareas_comentarios_y_tiempos.sql.
-- Aplicación MANUAL, después de la original y de roles_nivel_jerarquico.
-- No elimina registros. Si hay cierres históricos sin motivo, aborta sin
-- inventar su causa: investigar y regularizar explícitamente antes de reintentar.
-- Reconciliación inicial: cierra activos finales/sin acceso a la hora de aplicar;
-- no es posible reconstruir retrospectivamente la fecha de pérdida de acceso.
-- Reejecutable. No ejecutar de nuevo la migración original después de esta.
BEGIN;

-- DDL y reconciliación sin escrituras concurrentes durante el despliegue.
LOCK TABLE public.roles, public.usuarios, public.operativo_tableros,
  public.operativo_tablero_miembros, public.operativo_etapas, public.tareas,
  public.tarea_registros_tiempo IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.roles'::regclass AND attname = 'nivel_jerarquico'
      AND attnotnull AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Requiere roles.nivel_jerarquico NOT NULL (migración de jerarquía)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tarea_registros_tiempo
             WHERE fin IS NOT NULL AND motivo_finalizacion IS NULL) THEN
    RAISE EXCEPTION 'Hay tiempos finalizados sin motivo: revisar antes de aplicar la corrección';
  END IF;
END;
$$;

ALTER TABLE public.tarea_registros_tiempo
  DROP CONSTRAINT IF EXISTS tarea_registros_tiempo_motivo_check;
ALTER TABLE public.tarea_registros_tiempo
  ADD CONSTRAINT tarea_registros_tiempo_motivo_check CHECK (
    (fin IS NULL AND motivo_finalizacion IS NULL)
    OR (fin IS NOT NULL AND motivo_finalizacion IS NOT NULL
        AND motivo_finalizacion IN ('manual', 'automatico'))
  );

-- Una exclusión transaccional común evita la ventana entre comprobar acceso/
-- etapa e insertar, incluso ante cambios de varias filas o cascadas. Se toma
-- ANTES de los bloqueos de fila mediante triggers FOR EACH STATEMENT.
-- Serializa inicios y cambios de las fuentes de acceso/finalización; NO la
-- lectura del panel. Preferimos este alcance conservador a un protocolo de
-- múltiples locks por usuario/etapa/tablero propenso a inversiones de orden.
CREATE OR REPLACE FUNCTION public.tarea_tiempos_bloquear()
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- Tras esperar se necesitan snapshots nuevos. No aceptar silenciosamente
  -- REPEATABLE READ, cuyo snapshot anterior podría autorizar un inicio obsoleto.
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION 'Los cambios de acceso/tiempos requieren READ COMMITTED'
      USING ERRCODE = '40001';
  END IF;
  PERFORM pg_advisory_xact_lock(20261103, 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.tarea_tiempos_bloquear_cambio()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  PERFORM public.tarea_tiempos_bloquear();
  RETURN NULL;
END;
$$;

-- Replica solo la regla existente: perfil activo y HIGH o membresía.
-- nivel_jerarquico NOT NULL es prerrequisito de la migración de roles.
-- es_admin y permisos de módulo NO conceden ni quitan acceso a estas rutas.
CREATE OR REPLACE FUNCTION public.tarea_tiempo_tiene_acceso(p_tablero_id uuid, p_usuario_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.usuarios u LEFT JOIN public.roles r ON r.id = u.rol_id
    WHERE u.id = p_usuario_id AND u.estado = 'Activo'
      AND (r.nivel_jerarquico = 'HIGH' OR EXISTS (
        SELECT 1 FROM public.operativo_tablero_miembros m
        WHERE m.tablero_id = p_tablero_id AND m.usuario_id = u.id
      ))
  );
$$;

CREATE OR REPLACE FUNCTION public.tarea_tiempos_reconciliar()
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  PERFORM public.tarea_tiempos_bloquear();
  UPDATE public.tarea_registros_tiempo r
    SET fin = greatest(clock_timestamp(), r.inicio), motivo_finalizacion = 'automatico'
    FROM public.tareas t
    WHERE r.tarea_id = t.id AND r.fin IS NULL
      AND (public.tarea_es_final(t.etapa_id, t.estado)
           OR NOT public.tarea_tiempo_tiene_acceso(t.tablero_id, r.usuario_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.tarea_tiempos_reconciliar_cambio()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  PERFORM public.tarea_tiempos_reconciliar();
  RETURN NULL;
END;
$$;

-- AFTER STATEMENT observa la configuración nueva y también las cascadas FK.
-- DELETE de usuarios: SET NULL conserva el registro y esta reconciliación
-- cierra los activos sin autor. Si la operación falla, todo se revierte.
DO $$
DECLARE cambio record;
BEGIN
  FOR cambio IN SELECT * FROM (VALUES
    ('tareas', 'estado, etapa_id, tablero_id'),
    ('operativo_etapas', 'tipo_base'),
    ('operativo_tablero_miembros', 'tablero_id, usuario_id'),
    ('usuarios', 'estado, rol_id'),
    ('roles', 'nivel_jerarquico')
  ) AS fuentes(tabla, columnas) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trigger_tiempos_bloquear_cambio ON public.%I', cambio.tabla);
    EXECUTE format('CREATE TRIGGER trigger_tiempos_bloquear_cambio BEFORE UPDATE OF %s OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.tarea_tiempos_bloquear_cambio()', cambio.columnas, cambio.tabla);
    EXECUTE format('DROP TRIGGER IF EXISTS trigger_tiempos_reconciliar_cambio ON public.%I', cambio.tabla);
    EXECUTE format('CREATE TRIGGER trigger_tiempos_reconciliar_cambio AFTER UPDATE OF %s OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.tarea_tiempos_reconciliar_cambio()', cambio.columnas, cambio.tabla);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.tarea_tiempo_iniciar(p_tarea_id uuid, p_usuario_id uuid)
RETURNS public.tarea_registros_tiempo
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_tarea public.tareas;
  v_registro public.tarea_registros_tiempo;
BEGIN
  PERFORM public.tarea_tiempos_bloquear();
  IF p_usuario_id IS NULL THEN
    RAISE EXCEPTION 'NX_USUARIO_REQUERIDO' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_tarea FROM public.tareas WHERE id = p_tarea_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NX_TAREA_NO_ENCONTRADA' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.tarea_tiempo_tiene_acceso(v_tarea.tablero_id, p_usuario_id) THEN
    RAISE EXCEPTION 'NX_SIN_ACCESO_TAREA' USING ERRCODE = 'P0001';
  END IF;
  IF public.tarea_es_final(v_tarea.etapa_id, v_tarea.estado) THEN
    RAISE EXCEPTION 'NX_TAREA_FINALIZADA' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    INSERT INTO public.tarea_registros_tiempo (tarea_id, usuario_id, inicio)
    VALUES (p_tarea_id, p_usuario_id, clock_timestamp()) RETURNING * INTO v_registro;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'NX_TEMPORIZADOR_ACTIVO' USING ERRCODE = 'P0001';
  END;
  RETURN v_registro;
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tarea_registros_tiempo TO service_role;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.tarea_tiempos_bloquear()', 'public.tarea_tiempos_bloquear_cambio()',
    'public.tarea_tiempo_tiene_acceso(uuid, uuid)',
    'public.tarea_tiempos_reconciliar()', 'public.tarea_tiempos_reconciliar_cambio()',
    'public.tarea_tiempo_iniciar(uuid, uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END;
$$;

COMMENT ON COLUMN public.tarea_registros_tiempo.motivo_finalizacion IS
  'manual: detenido por su usuario. automatico: tarea final o pérdida de acceso/perfil activo.';

-- Incluye activos preexistentes en etapas finales o con usuarios sin acceso.
SELECT public.tarea_tiempos_reconciliar();
COMMIT;

-- Verificación de solo lectura: debe devolver 0.
SELECT count(*) AS activos_invalidos
FROM public.tarea_registros_tiempo r JOIN public.tareas t ON t.id = r.tarea_id
WHERE r.fin IS NULL AND (public.tarea_es_final(t.etapa_id, t.estado)
  OR NOT public.tarea_tiempo_tiene_acceso(t.tablero_id, r.usuario_id));
