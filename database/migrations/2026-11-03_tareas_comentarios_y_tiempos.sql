-- Migración: 2026-11-03_tareas_comentarios_y_tiempos
-- Módulo: Operativo (public.tareas)
--
-- Objetivo:
--   Panel "Actualizaciones" de cada tarea: comentarios de los miembros del
--   tablero y registro del tiempo efectivo de trabajo (temporizadores por
--   usuario + tarea). Quién puede hacer qué lo decide el backend
--   (operations/services/tareaActualizacionesService.js), con el mismo acceso
--   que el resto de las tareas: miembros del tablero y mando alto
--   (tablerosService.asegurarAcceso). La base garantiza la integridad y la
--   concurrencia de los temporizadores.
--
-- Esta migración:
--   1) Crea public.tarea_comentarios (tarea_id, usuario_id, contenido,
--      created_at, editado_at).
--        - contenido: 1..2000 caracteres, no solo espacios (el backend lo
--          guarda recortado).
--        - editado_at: NULL hasta la primera edición; lo completa el trigger
--          trigger_tarea_comentarios_edicion cuando cambia el contenido
--          (nunca el cliente). created_at y tarea_id no cambian.
--   2) Crea public.tarea_registros_tiempo (tarea_id, usuario_id, inicio, fin,
--      duracion_segundos, motivo_finalizacion). Cada inicio + detención es un
--      registro. Activo = fin IS NULL.
--        - duracion_segundos: columna generada (segundos enteros entre inicio
--          y fin, truncados); no puede quedar inconsistente con las marcas.
--        - motivo_finalizacion: 'manual' (lo detuvo su usuario) o
--          'automatico' (la tarea pasó a completada o cancelada). NULL
--          mientras está activo.
--        - uq_tarea_registros_tiempo_activo: índice único parcial
--          (tarea_id, usuario_id) WHERE fin IS NULL -> como máximo un
--          temporizador activo por usuario y tarea, también ante pedidos
--          simultáneos.
--        - Trigger trigger_tarea_registros_tiempo_proteger: un registro
--          finalizado no se puede modificar (inicio, fin, motivo, tarea).
--   3) Claves foráneas:
--        - tarea_id -> tareas(id) ON DELETE CASCADE en ambas tablas: la
--          eliminación de tareas es física y ya borra su historial
--          (tarea_historial) y sus asignaciones (tarea_asignados); los
--          comentarios y registros de tiempo siguen el mismo criterio y no
--          quedan huérfanos. No se cambia la semántica de eliminación.
--        - usuario_id -> usuarios(id) ON DELETE SET NULL: borrar un usuario
--          no borra sus comentarios ni su tiempo trabajado (el frontend lo
--          muestra sin autor). Desactivarlo no toca nada.
--   4) Funciones (solo service_role), con la hora del servidor de base de
--      datos (clock_timestamp()):
--        - tarea_tiempo_iniciar(tarea, usuario): bloquea la tarea (FOR SHARE),
--          rechaza tareas completadas/canceladas e inserta el registro.
--        - tarea_tiempo_detener(tarea, usuario): cierra el temporizador activo
--          de ESE usuario en esa tarea (motivo 'manual').
--      Errores con ERRCODE P0001 y mensaje NX_* que el backend traduce a
--      404/409.
--   5) Trigger trigger_tareas_finalizar_tiempos (AFTER UPDATE OF etapa_id,
--      estado ON tareas): si la tarea queda completada o cancelada, cierra en
--      la misma transacción todos sus temporizadores activos (motivo
--      'automatico'). Así una tarea nunca queda finalizada con temporizadores
--      activos aunque falle algo después. 'en_revision_abierta' y
--      'en_revision_cerrada' NO son finales: los temporizadores siguen.
--      Criterio de "final": mismo que esTareaFinal (operations/config/etapas.js):
--      por tipo_base de la etapa; sin etapa, por tareas.estado.
--   6) RLS "Backend service_role only" en ambas tablas, sin privilegios para
--      anon ni authenticated (criterio de DEF-018).
--
-- No modifica ni borra datos existentes. No cambia columnas de tareas,
-- etapas, tableros ni asignaciones.
-- Idempotente: puede correrse más de una vez sin error.
--
-- Orden de despliegue: correr en nexacore_dev (Developer) y validar; después
-- en nexacore_db (producción). Siempre ANTES de desplegar el backend que usa
-- estas tablas. Se ejecuta a mano en el SQL Editor de Supabase, según la
-- convención de database/migrations/.
--
-- NO afecta finance, movimientos, comprobantes, OCR, excel, deudas, empleados,
-- salarios, movimientos_salario, suscripciones, migraciones,
-- inversiones_historicas, sueldos_historicos, cuentas_por_cobrar
-- ni conciliaciones_migracion.

BEGIN;

-- ── 1) Comentarios ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tarea_comentarios (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tarea_id    uuid NOT NULL REFERENCES public.tareas(id)   ON DELETE CASCADE,
  usuario_id  uuid          REFERENCES public.usuarios(id) ON DELETE SET NULL,
  contenido   text NOT NULL,
  created_at  timestamp with time zone NOT NULL DEFAULT now(),
  editado_at  timestamp with time zone,
  CONSTRAINT tarea_comentarios_contenido_check
    CHECK (char_length(contenido) BETWEEN 1 AND 2000 AND btrim(contenido, E' \t\r\n') <> '')
);

COMMENT ON TABLE public.tarea_comentarios IS 'Comentarios de una tarea del Operativo (panel Actualizaciones). Los crean los usuarios con acceso al tablero; solo el autor los edita o elimina (regla del backend).';
COMMENT ON COLUMN public.tarea_comentarios.usuario_id IS 'Autor (usuario autenticado al crear). NULL si el usuario fue eliminado.';
COMMENT ON COLUMN public.tarea_comentarios.editado_at IS 'Última edición del contenido. NULL si nunca se editó. La mantiene trigger_tarea_comentarios_edicion.';

CREATE INDEX IF NOT EXISTS idx_tarea_comentarios_tarea
  ON public.tarea_comentarios (tarea_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_tarea_comentarios_usuario
  ON public.tarea_comentarios (usuario_id);

-- editado_at lo pone la base cuando cambia el contenido; tarea_id y
-- created_at no cambian. usuario_id no se protege: ON DELETE SET NULL lo
-- actualiza al borrar al usuario.
CREATE OR REPLACE FUNCTION public.tarea_comentarios_marcar_edicion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.tarea_id   := OLD.tarea_id;
  NEW.created_at := OLD.created_at;
  IF NEW.contenido IS DISTINCT FROM OLD.contenido THEN
    NEW.editado_at := now();
  ELSE
    NEW.editado_at := OLD.editado_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_tarea_comentarios_edicion ON public.tarea_comentarios;
CREATE TRIGGER trigger_tarea_comentarios_edicion
  BEFORE UPDATE ON public.tarea_comentarios
  FOR EACH ROW EXECUTE FUNCTION public.tarea_comentarios_marcar_edicion();

-- ── 2) Registros de tiempo ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tarea_registros_tiempo (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tarea_id            uuid NOT NULL REFERENCES public.tareas(id)   ON DELETE CASCADE,
  usuario_id          uuid          REFERENCES public.usuarios(id) ON DELETE SET NULL,
  inicio              timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  fin                 timestamp with time zone,
  duracion_segundos   integer GENERATED ALWAYS AS (floor(extract(epoch FROM (fin - inicio)))::integer) STORED,
  motivo_finalizacion text,
  CONSTRAINT tarea_registros_tiempo_fin_check
    CHECK (fin IS NULL OR fin >= inicio),
  CONSTRAINT tarea_registros_tiempo_motivo_check
    CHECK ((fin IS NULL AND motivo_finalizacion IS NULL)
        OR (fin IS NOT NULL AND motivo_finalizacion IN ('manual', 'automatico')))
);

COMMENT ON TABLE public.tarea_registros_tiempo IS 'Tiempo trabajado por usuario y tarea (temporizadores). Cada inicio + detención es un registro; activo = fin IS NULL. Como máximo un activo por usuario y tarea (uq_tarea_registros_tiempo_activo). Se escribe solo con tarea_tiempo_iniciar / tarea_tiempo_detener y trigger_tareas_finalizar_tiempos.';
COMMENT ON COLUMN public.tarea_registros_tiempo.inicio IS 'Hora del servidor de base de datos al iniciar.';
COMMENT ON COLUMN public.tarea_registros_tiempo.fin IS 'Hora del servidor de base de datos al detener. NULL mientras está activo.';
COMMENT ON COLUMN public.tarea_registros_tiempo.duracion_segundos IS 'Segundos enteros (truncados) entre inicio y fin. Generada; NULL mientras está activo.';
COMMENT ON COLUMN public.tarea_registros_tiempo.motivo_finalizacion IS 'manual: lo detuvo su usuario. automatico: la tarea pasó a completada o cancelada.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_tarea_registros_tiempo_activo
  ON public.tarea_registros_tiempo (tarea_id, usuario_id) WHERE fin IS NULL;
CREATE INDEX IF NOT EXISTS idx_tarea_registros_tiempo_tarea_fin
  ON public.tarea_registros_tiempo (tarea_id, fin, id) WHERE fin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tarea_registros_tiempo_usuario
  ON public.tarea_registros_tiempo (usuario_id);

-- Un registro finalizado no se modifica; uno activo solo puede finalizarse.
-- usuario_id puede pasar a NULL (ON DELETE SET NULL).
CREATE OR REPLACE FUNCTION public.tarea_registros_tiempo_proteger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.tarea_id IS DISTINCT FROM OLD.tarea_id
     OR NEW.inicio IS DISTINCT FROM OLD.inicio
     OR (OLD.fin IS NOT NULL AND (NEW.fin IS DISTINCT FROM OLD.fin
                                  OR NEW.motivo_finalizacion IS DISTINCT FROM OLD.motivo_finalizacion)) THEN
    RAISE EXCEPTION 'NX_REGISTRO_TIEMPO_INMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_tarea_registros_tiempo_proteger ON public.tarea_registros_tiempo;
CREATE TRIGGER trigger_tarea_registros_tiempo_proteger
  BEFORE UPDATE ON public.tarea_registros_tiempo
  FOR EACH ROW EXECUTE FUNCTION public.tarea_registros_tiempo_proteger();

-- ── 4) Funciones de temporizador ─────────────────────────────────────────────

-- ¿La tarea está finalizada? Mismo criterio que esTareaFinal
-- (operations/config/etapas.js): por tipo_base de la etapa; sin etapa (o con
-- una etapa inexistente), por el estado canónico.
CREATE OR REPLACE FUNCTION public.tarea_es_final(p_etapa_id uuid, p_estado text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT e.tipo_base IN ('completada', 'cancelada') FROM public.operativo_etapas e WHERE e.id = p_etapa_id),
    coalesce(p_estado IN ('Completada', 'Cancelada'), false)
  );
$$;

-- Inicia el temporizador de p_usuario_id en p_tarea_id. FOR SHARE sobre la
-- tarea: espera a que termine un cambio de etapa o una eliminación en curso
-- (y un cambio de etapa espera a que termine este inicio, así el trigger de
-- cierre ve el registro nuevo). El duplicado lo impide el índice único
-- parcial, también entre transacciones simultáneas.
CREATE OR REPLACE FUNCTION public.tarea_tiempo_iniciar(p_tarea_id uuid, p_usuario_id uuid)
RETURNS public.tarea_registros_tiempo
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_etapa_id uuid;
  v_estado   text;
  v_registro public.tarea_registros_tiempo;
BEGIN
  IF p_usuario_id IS NULL THEN
    RAISE EXCEPTION 'NX_USUARIO_REQUERIDO' USING ERRCODE = 'P0001';
  END IF;

  SELECT t.etapa_id, t.estado INTO v_etapa_id, v_estado
  FROM public.tareas t
  WHERE t.id = p_tarea_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NX_TAREA_NO_ENCONTRADA' USING ERRCODE = 'P0001';
  END IF;

  IF public.tarea_es_final(v_etapa_id, v_estado) THEN
    RAISE EXCEPTION 'NX_TAREA_FINALIZADA' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    INSERT INTO public.tarea_registros_tiempo (tarea_id, usuario_id, inicio)
    VALUES (p_tarea_id, p_usuario_id, clock_timestamp())
    RETURNING * INTO v_registro;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'NX_TEMPORIZADOR_ACTIVO' USING ERRCODE = 'P0001';
  END;

  RETURN v_registro;
END;
$$;

-- Detiene el temporizador activo de p_usuario_id en p_tarea_id. Solo el de
-- ese usuario: no hay forma de detener el de otro. Si dos pedidos llegan a la
-- vez, el segundo no encuentra un activo (NX_SIN_TEMPORIZADOR_ACTIVO).
CREATE OR REPLACE FUNCTION public.tarea_tiempo_detener(p_tarea_id uuid, p_usuario_id uuid)
RETURNS public.tarea_registros_tiempo
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_registro public.tarea_registros_tiempo;
BEGIN
  UPDATE public.tarea_registros_tiempo
  SET fin = greatest(clock_timestamp(), inicio),
      motivo_finalizacion = 'manual'
  WHERE tarea_id = p_tarea_id
    AND usuario_id = p_usuario_id
    AND fin IS NULL
  RETURNING * INTO v_registro;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NX_SIN_TEMPORIZADOR_ACTIVO' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_registro;
END;
$$;

REVOKE ALL ON FUNCTION public.tarea_es_final(uuid, text)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tarea_tiempo_iniciar(uuid, uuid)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tarea_tiempo_detener(uuid, uuid)         FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tarea_es_final(uuid, text)            TO service_role;
GRANT EXECUTE ON FUNCTION public.tarea_tiempo_iniciar(uuid, uuid)      TO service_role;
GRANT EXECUTE ON FUNCTION public.tarea_tiempo_detener(uuid, uuid)      TO service_role;

-- ── 5) Cierre automático al completar o cancelar ─────────────────────────────

-- Corre en la misma transacción que el UPDATE de la tarea: si el cierre
-- falla, el cambio de etapa también se revierte.
CREATE OR REPLACE FUNCTION public.tarea_tiempo_finalizar_al_cerrar()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF public.tarea_es_final(NEW.etapa_id, NEW.estado) THEN
    UPDATE public.tarea_registros_tiempo
    SET fin = greatest(clock_timestamp(), inicio),
        motivo_finalizacion = 'automatico'
    WHERE tarea_id = NEW.id
      AND fin IS NULL;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trigger_tareas_finalizar_tiempos ON public.tareas;
CREATE TRIGGER trigger_tareas_finalizar_tiempos
  AFTER UPDATE OF etapa_id, estado ON public.tareas
  FOR EACH ROW EXECUTE FUNCTION public.tarea_tiempo_finalizar_al_cerrar();

-- ── 6) RLS: solo el backend (service_role) ───────────────────────────────────

ALTER TABLE public.tarea_comentarios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Backend service_role only" ON public.tarea_comentarios;
CREATE POLICY "Backend service_role only" ON public.tarea_comentarios
  USING (auth.role() = 'service_role'::text)
  WITH CHECK (auth.role() = 'service_role'::text);

ALTER TABLE public.tarea_registros_tiempo ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Backend service_role only" ON public.tarea_registros_tiempo;
CREATE POLICY "Backend service_role only" ON public.tarea_registros_tiempo
  USING (auth.role() = 'service_role'::text)
  WITH CHECK (auth.role() = 'service_role'::text);

REVOKE ALL ON TABLE public.tarea_comentarios, public.tarea_registros_tiempo FROM anon, authenticated;

COMMIT;

-- Verificación (solo lectura): deben aparecer las 2 tablas con RLS activo,
-- el índice único parcial y el trigger sobre tareas.
SELECT c.relname AS tabla, c.relrowsecurity AS rls
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('tarea_comentarios', 'tarea_registros_tiempo');

SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND indexname = 'uq_tarea_registros_tiempo_activo';

SELECT tgname FROM pg_trigger
WHERE tgrelid = 'public.tareas'::regclass AND tgname = 'trigger_tareas_finalizar_tiempos';
