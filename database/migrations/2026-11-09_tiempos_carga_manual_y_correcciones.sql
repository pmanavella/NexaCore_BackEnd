-- Migración: 2026-11-09_tiempos_carga_manual_y_correcciones
-- Módulo: Operativo (public.tarea_registros_tiempo)
--
-- Objetivo:
--   Permitir registrar tiempo trabajado a mano (fecha y horario de inicio y
--   fin) y corregir registros finalizados, manteniendo los temporizadores
--   actuales y la protección de la base contra escrituras directas.
--
-- Reglas (definidas por el cliente):
--   - Cualquier usuario con acceso a la tarea registra tiempo propio.
--   - Solo el autor corrige sus registros (manuales o del temporizador).
--   - No se eliminan registros de tiempo (no hay RPC ni ruta de borrado).
--   - Se puede registrar y corregir en tareas completadas o canceladas,
--     mientras el usuario conserve acceso. Nunca se toca la tarea.
--   - inicio < fin y fin no futuro (hora del servidor de base de datos).
--     Sin límites de antigüedad ni de duración. Puede cruzar la medianoche.
--   - Las superposiciones se permiten; la advertencia la calcula el backend.
--
-- Esta migración:
--   1) Agrega a tarea_registros_tiempo:
--        - origen: 'temporizador' (todos los existentes, por DEFAULT) o
--          'carga_manual'. NO se reutiliza motivo_finalizacion: 'manual'
--          significa "temporizador detenido por su usuario".
--        - version: 1 al crearse; +1 en cada corrección (control optimista).
--        - corregido_at: última corrección (NULL si nunca se corrigió).
--      Los mantiene la base (trigger), nunca el cliente.
--   2) Reemplaza tarea_registros_tiempo_motivo_check: una carga manual nace
--      finalizada, con motivo NULL y fin > inicio. Las reglas del
--      temporizador no cambian.
--   3) Crea tarea_registros_tiempo_auditoria (append-only): una fila por
--      carga manual y por corrección, con valores anteriores y nuevos. La
--      escribe un trigger SECURITY DEFINER en la misma transacción: no hay
--      corrección sin auditoría. service_role solo puede leerla.
--   4) Amplía trigger_tarea_registros_tiempo_proteger y agrega un trigger de
--      alta. Fuera de las RPC nuevas sigue siendo imposible:
--        - cambiar tarea, usuario (salvo SET NULL por FK), origen, versión;
--        - cambiar inicio, fin o motivo de un registro finalizado;
--        - reactivar un registro (fin -> NULL);
--        - insertar un registro finalizado (ni del temporizador ni manual).
--      Las RPC habilitan la escritura con una marca transaccional
--      (set_config(..., true)), válida solo para ese registro y esa
--      transacción.
--   5) RPC (solo service_role), con el advisory lock de la correctiva:
--        - tarea_tiempo_registrar_manual(tarea, usuario, inicio, fin)
--        - tarea_tiempo_corregir(registro, tarea, usuario, inicio, fin, version)
--
-- Requiere: 2026-11-03_tareas_comentarios_y_tiempos y
-- 2026-11-03_tiempos_integridad_y_acceso (tarea_tiempos_bloquear,
-- tarea_tiempo_tiene_acceso). Aborta si faltan.
--
-- No borra ni modifica datos existentes (los registros actuales quedan como
-- origen 'temporizador', version 1). No toca tareas, etapas, tableros ni
-- asignaciones. No cambia tarea_tiempo_iniciar ni tarea_tiempo_detener.
-- Idempotente: puede correrse más de una vez.
--
-- Orden: después de las migraciones del 2026-11-03 y ANTES de desplegar el
-- backend que la usa. Primero nexacore_dev, validar, después nexacore_db.
-- Ejecutar a mano en el SQL Editor (convención de database/migrations/).
-- Verificaciones previas: database/verificaciones/2026-11-09_previas_actualizaciones_operativo.sql
--
-- NO afecta finance, movimientos, comprobantes, OCR, excel, deudas, empleados,
-- salarios, movimientos_salario, suscripciones, migraciones,
-- inversiones_historicas, sueldos_historicos, cuentas_por_cobrar
-- ni conciliaciones_migracion.

BEGIN;

-- ── 0) Prerrequisitos ────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.tarea_registros_tiempo') IS NULL THEN
    RAISE EXCEPTION 'Requiere 2026-11-03_tareas_comentarios_y_tiempos';
  END IF;
  IF to_regprocedure('public.tarea_tiempos_bloquear()') IS NULL
     OR to_regprocedure('public.tarea_tiempo_tiene_acceso(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Requiere 2026-11-03_tiempos_integridad_y_acceso';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tarea_registros_tiempo
             WHERE fin IS NOT NULL AND motivo_finalizacion IS NULL) THEN
    RAISE EXCEPTION 'Hay tiempos finalizados sin motivo: revisar antes de aplicar';
  END IF;
END;
$$;

-- Sin escrituras concurrentes de tiempos mientras cambian columnas y triggers.
LOCK TABLE public.tarea_registros_tiempo IN SHARE ROW EXCLUSIVE MODE;

-- ── 1) Columnas ──────────────────────────────────────────────────────────────

ALTER TABLE public.tarea_registros_tiempo
  ADD COLUMN IF NOT EXISTS origen       text    NOT NULL DEFAULT 'temporizador',
  ADD COLUMN IF NOT EXISTS version      integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS corregido_at timestamp with time zone;

ALTER TABLE public.tarea_registros_tiempo
  DROP CONSTRAINT IF EXISTS tarea_registros_tiempo_origen_check;
ALTER TABLE public.tarea_registros_tiempo
  ADD CONSTRAINT tarea_registros_tiempo_origen_check
  CHECK (origen IN ('temporizador', 'carga_manual'));

ALTER TABLE public.tarea_registros_tiempo
  DROP CONSTRAINT IF EXISTS tarea_registros_tiempo_version_check;
ALTER TABLE public.tarea_registros_tiempo
  ADD CONSTRAINT tarea_registros_tiempo_version_check
  CHECK (version >= 1 AND ((version = 1) = (corregido_at IS NULL)));

-- ── 2) Motivo según el origen ────────────────────────────────────────────────
-- Temporizador: igual que la correctiva (activo sin motivo; finalizado con
-- 'manual' o 'automatico'). Carga manual: siempre finalizada, sin motivo.

ALTER TABLE public.tarea_registros_tiempo
  DROP CONSTRAINT IF EXISTS tarea_registros_tiempo_motivo_check;
ALTER TABLE public.tarea_registros_tiempo
  ADD CONSTRAINT tarea_registros_tiempo_motivo_check CHECK (
    (origen = 'temporizador' AND fin IS NULL AND motivo_finalizacion IS NULL)
    OR (origen = 'temporizador' AND fin IS NOT NULL AND motivo_finalizacion IS NOT NULL
        AND motivo_finalizacion IN ('manual', 'automatico'))
    OR (origen = 'carga_manual' AND fin IS NOT NULL AND fin > inicio
        AND motivo_finalizacion IS NULL)
  );

COMMENT ON COLUMN public.tarea_registros_tiempo.origen IS 'temporizador: iniciado y detenido con el temporizador. carga_manual: registrado a mano con inicio y fin (nace finalizado, sin motivo).';
COMMENT ON COLUMN public.tarea_registros_tiempo.version IS 'Versión del registro para control de concurrencia: 1 al crearse, +1 en cada corrección. La mantiene trigger_tarea_registros_tiempo_proteger.';
COMMENT ON COLUMN public.tarea_registros_tiempo.corregido_at IS 'Última corrección de inicio/fin (NULL si nunca se corrigió). Historial completo en tarea_registros_tiempo_auditoria.';
COMMENT ON COLUMN public.tarea_registros_tiempo.motivo_finalizacion IS 'Solo temporizador. manual: detenido por su usuario. automatico: tarea final o pérdida de acceso/perfil activo. NULL en cargas manuales y en temporizadores activos.';
COMMENT ON TABLE public.tarea_registros_tiempo IS 'Tiempo trabajado por usuario y tarea. Temporizadores (tarea_tiempo_iniciar / tarea_tiempo_detener, cierre automático) y cargas manuales (tarea_tiempo_registrar_manual). Correcciones solo por tarea_tiempo_corregir, auditadas en tarea_registros_tiempo_auditoria. No se eliminan (salvo en cascada con la tarea).';

-- ── 3) Auditoría ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tarea_registros_tiempo_auditoria (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  registro_id     uuid NOT NULL REFERENCES public.tarea_registros_tiempo(id) ON DELETE CASCADE,
  tarea_id        uuid NOT NULL REFERENCES public.tareas(id)                 ON DELETE CASCADE,
  accion          text NOT NULL,
  actor_id        uuid          REFERENCES public.usuarios(id)               ON DELETE SET NULL,
  version         integer NOT NULL,
  inicio_anterior timestamp with time zone,
  fin_anterior    timestamp with time zone,
  inicio_nuevo    timestamp with time zone NOT NULL,
  fin_nuevo       timestamp with time zone NOT NULL,
  created_at      timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tarea_registros_tiempo_auditoria_accion_check CHECK (
    (accion = 'carga_manual' AND inicio_anterior IS NULL AND fin_anterior IS NULL)
    OR (accion = 'correccion' AND inicio_anterior IS NOT NULL AND fin_anterior IS NOT NULL)
  )
);

COMMENT ON TABLE public.tarea_registros_tiempo_auditoria IS 'Trazabilidad de tiempos: una fila por carga manual y por corrección (valores anteriores y nuevos). Append-only: la escribe trigger_tarea_registros_tiempo_auditar; service_role solo lee. Se elimina en cascada con la tarea, igual que el resto del historial de la tarea.';
COMMENT ON COLUMN public.tarea_registros_tiempo_auditoria.actor_id IS 'Usuario que hizo la carga o la corrección (el autor del registro). NULL si el usuario fue eliminado.';
COMMENT ON COLUMN public.tarea_registros_tiempo_auditoria.version IS 'Versión del registro resultante del cambio.';

CREATE INDEX IF NOT EXISTS idx_tarea_registros_tiempo_auditoria_registro
  ON public.tarea_registros_tiempo_auditoria (registro_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_tarea_registros_tiempo_auditoria_tarea
  ON public.tarea_registros_tiempo_auditoria (tarea_id);
CREATE INDEX IF NOT EXISTS idx_tarea_registros_tiempo_auditoria_actor
  ON public.tarea_registros_tiempo_auditoria (actor_id);

-- Las filas de auditoría no se modifican (las FK con SET NULL sí pueden
-- anular actor_id al eliminar al usuario).
CREATE OR REPLACE FUNCTION public.tarea_registros_tiempo_auditoria_proteger()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.actor_id IS NOT NULL OR OLD.actor_id IS NULL
     OR (to_jsonb(NEW) - 'actor_id') IS DISTINCT FROM (to_jsonb(OLD) - 'actor_id') THEN
    RAISE EXCEPTION 'NX_AUDITORIA_INMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_tarea_registros_tiempo_auditoria_proteger ON public.tarea_registros_tiempo_auditoria;
CREATE TRIGGER trigger_tarea_registros_tiempo_auditoria_proteger
  BEFORE UPDATE ON public.tarea_registros_tiempo_auditoria
  FOR EACH ROW EXECUTE FUNCTION public.tarea_registros_tiempo_auditoria_proteger();

-- ── 4) Protección de los registros ───────────────────────────────────────────

-- Alta: el temporizador solo crea registros activos; una carga manual solo la
-- crea tarea_tiempo_registrar_manual. version/corregido_at los fija la base.
CREATE OR REPLACE FUNCTION public.tarea_registros_tiempo_proteger_alta()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.origen = 'temporizador' THEN
    IF NEW.fin IS NOT NULL OR NEW.motivo_finalizacion IS NOT NULL THEN
      RAISE EXCEPTION 'NX_REGISTRO_TIEMPO_INMUTABLE' USING ERRCODE = 'P0001';
    END IF;
  ELSIF current_setting('nexacore.tiempo_carga', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'NX_REGISTRO_TIEMPO_INMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  NEW.version := 1;
  NEW.corregido_at := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_tarea_registros_tiempo_proteger_alta ON public.tarea_registros_tiempo;
CREATE TRIGGER trigger_tarea_registros_tiempo_proteger_alta
  BEFORE INSERT ON public.tarea_registros_tiempo
  FOR EACH ROW EXECUTE FUNCTION public.tarea_registros_tiempo_proteger_alta();

-- Modificación. Conserva todas las reglas de la migración original:
--   - tarea_id e inicio de un activo no cambian; un activo solo puede
--     finalizarse (lo usan tarea_tiempo_detener y los cierres automáticos);
--   - un finalizado no cambia fin ni motivo;
-- y agrega: origen, version y corregido_at no se escriben desde afuera;
-- usuario_id solo puede pasar a NULL (ON DELETE SET NULL); un finalizado no se
-- reactiva; inicio/fin de un finalizado cambian SOLO dentro de
-- tarea_tiempo_corregir para ese registro (marca nexacore.tiempo_correccion),
-- y en ese caso la base incrementa version y fija corregido_at.
CREATE OR REPLACE FUNCTION public.tarea_registros_tiempo_proteger()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.tarea_id IS DISTINCT FROM OLD.tarea_id
     OR NEW.origen IS DISTINCT FROM OLD.origen
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.corregido_at IS DISTINCT FROM OLD.corregido_at
     OR (NEW.usuario_id IS DISTINCT FROM OLD.usuario_id AND NEW.usuario_id IS NOT NULL) THEN
    RAISE EXCEPTION 'NX_REGISTRO_TIEMPO_INMUTABLE' USING ERRCODE = 'P0001';
  END IF;

  IF OLD.fin IS NULL THEN
    IF NEW.inicio IS DISTINCT FROM OLD.inicio THEN
      RAISE EXCEPTION 'NX_REGISTRO_TIEMPO_INMUTABLE' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.fin IS NULL OR NEW.motivo_finalizacion IS DISTINCT FROM OLD.motivo_finalizacion THEN
    RAISE EXCEPTION 'NX_REGISTRO_TIEMPO_INMUTABLE' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.inicio IS DISTINCT FROM OLD.inicio OR NEW.fin IS DISTINCT FROM OLD.fin THEN
    IF current_setting('nexacore.tiempo_correccion', true) IS DISTINCT FROM OLD.id::text THEN
      RAISE EXCEPTION 'NX_REGISTRO_TIEMPO_INMUTABLE' USING ERRCODE = 'P0001';
    END IF;
    NEW.version := OLD.version + 1;
    NEW.corregido_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_tarea_registros_tiempo_proteger ON public.tarea_registros_tiempo;
CREATE TRIGGER trigger_tarea_registros_tiempo_proteger
  BEFORE UPDATE ON public.tarea_registros_tiempo
  FOR EACH ROW EXECUTE FUNCTION public.tarea_registros_tiempo_proteger();

-- Auditoría en la misma transacción que el cambio. SECURITY DEFINER: es el
-- único camino de escritura de la tabla de auditoría.
CREATE OR REPLACE FUNCTION public.tarea_registros_tiempo_auditar()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.origen = 'carga_manual' THEN
      INSERT INTO public.tarea_registros_tiempo_auditoria
        (registro_id, tarea_id, accion, actor_id, version, inicio_nuevo, fin_nuevo)
      VALUES (NEW.id, NEW.tarea_id, 'carga_manual', NEW.usuario_id, NEW.version, NEW.inicio, NEW.fin);
    END IF;
  ELSIF OLD.fin IS NOT NULL
        AND (NEW.inicio IS DISTINCT FROM OLD.inicio OR NEW.fin IS DISTINCT FROM OLD.fin) THEN
    INSERT INTO public.tarea_registros_tiempo_auditoria
      (registro_id, tarea_id, accion, actor_id, version,
       inicio_anterior, fin_anterior, inicio_nuevo, fin_nuevo)
    VALUES (NEW.id, NEW.tarea_id, 'correccion',
            nullif(current_setting('nexacore.tiempo_actor', true), '')::uuid, NEW.version,
            OLD.inicio, OLD.fin, NEW.inicio, NEW.fin);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trigger_tarea_registros_tiempo_auditar ON public.tarea_registros_tiempo;
CREATE TRIGGER trigger_tarea_registros_tiempo_auditar
  AFTER INSERT OR UPDATE OF inicio, fin ON public.tarea_registros_tiempo
  FOR EACH ROW EXECUTE FUNCTION public.tarea_registros_tiempo_auditar();

-- ── 5) RPC ───────────────────────────────────────────────────────────────────

-- inicio < fin y fin no futuro, con la hora del servidor de base de datos.
CREATE OR REPLACE FUNCTION public.tarea_tiempo_validar_intervalo(p_inicio timestamptz, p_fin timestamptz)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF p_inicio IS NULL OR p_fin IS NULL OR p_inicio >= p_fin THEN
    RAISE EXCEPTION 'NX_INTERVALO_INVALIDO' USING ERRCODE = 'P0001';
  END IF;
  IF p_fin > clock_timestamp() THEN
    RAISE EXCEPTION 'NX_FIN_FUTURO' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Carga manual de tiempo propio. Mismo lock y misma regla de acceso que
-- tarea_tiempo_iniciar, pero admite tareas completadas o canceladas (no
-- crea un temporizador activo y no modifica la tarea).
CREATE OR REPLACE FUNCTION public.tarea_tiempo_registrar_manual(
  p_tarea_id uuid, p_usuario_id uuid, p_inicio timestamptz, p_fin timestamptz)
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
  PERFORM public.tarea_tiempo_validar_intervalo(p_inicio, p_fin);

  PERFORM set_config('nexacore.tiempo_carga', 'on', true);
  INSERT INTO public.tarea_registros_tiempo (tarea_id, usuario_id, inicio, fin, origen)
  VALUES (p_tarea_id, p_usuario_id, p_inicio, p_fin, 'carga_manual')
  RETURNING * INTO v_registro;
  PERFORM set_config('nexacore.tiempo_carga', '', true);
  RETURN v_registro;
END;
$$;

-- Corrección de un registro FINALIZADO propio. p_version debe coincidir con la
-- versión actual (si no, NX_VERSION_DESACTUALIZADA). Sin cambios efectivos
-- devuelve el registro tal cual (sin nueva versión ni auditoría).
CREATE OR REPLACE FUNCTION public.tarea_tiempo_corregir(
  p_registro_id uuid, p_tarea_id uuid, p_usuario_id uuid,
  p_inicio timestamptz, p_fin timestamptz, p_version integer)
RETURNS public.tarea_registros_tiempo
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_tablero_id uuid;
  v_registro public.tarea_registros_tiempo;
BEGIN
  PERFORM public.tarea_tiempos_bloquear();
  IF p_usuario_id IS NULL THEN
    RAISE EXCEPTION 'NX_USUARIO_REQUERIDO' USING ERRCODE = 'P0001';
  END IF;
  -- Mismo orden de bloqueo que tarea_tiempo_iniciar: tarea y después registro.
  SELECT t.tablero_id INTO v_tablero_id FROM public.tareas t WHERE t.id = p_tarea_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NX_TAREA_NO_ENCONTRADA' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.tarea_tiempo_tiene_acceso(v_tablero_id, p_usuario_id) THEN
    RAISE EXCEPTION 'NX_SIN_ACCESO_TAREA' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_registro FROM public.tarea_registros_tiempo
  WHERE id = p_registro_id AND tarea_id = p_tarea_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NX_REGISTRO_NO_ENCONTRADO' USING ERRCODE = 'P0001';
  END IF;
  -- Cubre usuario_id NULL (autor eliminado): nadie más puede corregirlo.
  IF v_registro.usuario_id IS DISTINCT FROM p_usuario_id THEN
    RAISE EXCEPTION 'NX_REGISTRO_AJENO' USING ERRCODE = 'P0001';
  END IF;
  IF v_registro.fin IS NULL THEN
    RAISE EXCEPTION 'NX_REGISTRO_ACTIVO' USING ERRCODE = 'P0001';
  END IF;
  IF p_version IS NULL OR p_version <> v_registro.version THEN
    RAISE EXCEPTION 'NX_VERSION_DESACTUALIZADA' USING ERRCODE = 'P0001';
  END IF;
  IF p_inicio IS NOT DISTINCT FROM v_registro.inicio AND p_fin IS NOT DISTINCT FROM v_registro.fin THEN
    RETURN v_registro;
  END IF;
  PERFORM public.tarea_tiempo_validar_intervalo(p_inicio, p_fin);

  PERFORM set_config('nexacore.tiempo_correccion', p_registro_id::text, true);
  PERFORM set_config('nexacore.tiempo_actor', p_usuario_id::text, true);
  UPDATE public.tarea_registros_tiempo
  SET inicio = p_inicio, fin = p_fin
  WHERE id = p_registro_id
  RETURNING * INTO v_registro;
  PERFORM set_config('nexacore.tiempo_correccion', '', true);
  PERFORM set_config('nexacore.tiempo_actor', '', true);
  RETURN v_registro;
END;
$$;

-- ── 6) Permisos y RLS ────────────────────────────────────────────────────────

ALTER TABLE public.tarea_registros_tiempo_auditoria ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Backend service_role only" ON public.tarea_registros_tiempo_auditoria;
CREATE POLICY "Backend service_role only" ON public.tarea_registros_tiempo_auditoria
  USING (auth.role() = 'service_role'::text)
  WITH CHECK (auth.role() = 'service_role'::text);

-- Append-only para el backend: solo lectura. La escribe el trigger
-- SECURITY DEFINER; la cascada desde tareas la ejecuta el dueño de la tabla.
REVOKE ALL ON TABLE public.tarea_registros_tiempo_auditoria FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.tarea_registros_tiempo_auditoria TO service_role;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.tarea_registros_tiempo_auditoria_proteger()',
    'public.tarea_registros_tiempo_proteger_alta()',
    'public.tarea_registros_tiempo_proteger()',
    'public.tarea_registros_tiempo_auditar()',
    'public.tarea_tiempo_validar_intervalo(timestamptz, timestamptz)',
    'public.tarea_tiempo_registrar_manual(uuid, uuid, timestamptz, timestamptz)',
    'public.tarea_tiempo_corregir(uuid, uuid, uuid, timestamptz, timestamptz, integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.tarea_tiempo_validar_intervalo(timestamptz, timestamptz)',
    'public.tarea_tiempo_registrar_manual(uuid, uuid, timestamptz, timestamptz)',
    'public.tarea_tiempo_corregir(uuid, uuid, uuid, timestamptz, timestamptz, integer)'
  ] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END;
$$;

COMMIT;

-- Verificación (solo lectura).
-- a) Recién aplicada, todos los registros existentes son 'temporizador',
--    versión 1 y sin corrección: debe devolver una sola fila.
SELECT origen, version, (corregido_at IS NOT NULL) AS corregido, count(*)
FROM public.tarea_registros_tiempo
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

-- b) Triggers instalados y habilitados (tgenabled = 'O').
SELECT tgname, tgenabled FROM pg_trigger
WHERE tgrelid = 'public.tarea_registros_tiempo'::regclass AND NOT tgisinternal
ORDER BY tgname;

-- c) service_role solo lee la auditoría: debe devolver únicamente SELECT.
SELECT privilege_type FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'tarea_registros_tiempo_auditoria' AND grantee = 'service_role';
