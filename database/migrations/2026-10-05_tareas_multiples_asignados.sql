-- Migración: 2026-10-05_tareas_multiples_asignados
-- Módulo: Operativo (public.tareas)
--
-- Objetivo:
--   Permitir que una tarea esté asignada a más de una persona, sin repetir la
--   misma persona dentro de la misma tarea.
--
--   Hasta ahora la asignación era public.tareas.asignado_a (text), que guarda el
--   NOMBRE del usuario (no su id ni una FK). Pasa a modelarse como relación
--   muchos-a-muchos tareas <-> usuarios en public.tarea_asignados.
--
--   tareas.asignado_a NO se elimina: se conserva por compatibilidad y la función
--   de sincronización lo mantiene con los nombres de los asignados separados por
--   ", " (igual que antes cuando hay una sola persona; NULL si no hay ninguna).
--
-- Esta migración:
--   1) Crea public.tarea_asignados (tarea_id, usuario_id, orden) con
--      UNIQUE (tarea_id, usuario_id).
--        - tarea_id   -> tareas(id)   ON DELETE CASCADE: borrar una tarea borra
--          sus asignaciones (mismo criterio que tarea_historial).
--        - usuario_id -> usuarios(id) ON DELETE CASCADE: el backend borra
--          usuarios en forma definitiva; RESTRICT haría fallar esa operación.
--          Desactivar un usuario (estado = 'Inactivo') no toca sus asignaciones.
--   2) Índice por usuario_id (búsqueda de tareas de una persona).
--   3) RLS "Backend service_role only", mismo patrón que el resto de tablas.
--   4) Crea public.tarea_sincronizar_asignados(p_tarea_id, p_usuario_ids):
--      deja la tarea con exactamente esa lista (altas, bajas, orden) y
--      recalcula tareas.asignado_a, todo en una sola transacción. Solo la
--      ejecuta service_role (backend).
--   5) Backfill: vincula cada tarea existente con el usuario cuyo nombre
--      coincide con su asignado_a (sin distinguir mayúsculas ni espacios en los
--      extremos), SOLO si la coincidencia es única. No modifica asignado_a.
--      Las tareas con un nombre que no coincide con ningún usuario, o con más
--      de uno, quedan sin vincular y conservan su texto (se informan al final).
--
-- No elimina columnas, no borra ni modifica datos existentes de tareas.
-- Idempotente: puede correrse más de una vez sin error (DEV y PROD). El
-- backfill solo actúa sobre tareas que todavía no tienen ningún asignado.

BEGIN;

-- 1) Tabla de relación
CREATE TABLE IF NOT EXISTS public.tarea_asignados (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tarea_id   uuid NOT NULL REFERENCES public.tareas(id)   ON DELETE CASCADE,
  usuario_id uuid NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  orden      integer NOT NULL DEFAULT 1,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT tarea_asignados_tarea_usuario_key UNIQUE (tarea_id, usuario_id),
  CONSTRAINT tarea_asignados_orden_check CHECK (orden >= 1)
);

COMMENT ON TABLE public.tarea_asignados IS 'Personas (usuarios) asignadas a cada tarea del módulo Operativo. Una persona no puede repetirse en la misma tarea.';
COMMENT ON COLUMN public.tarea_asignados.orden IS 'Orden en que se enviaron los asignados (1 = primero). Se usa para devolverlos y para componer tareas.asignado_a.';
COMMENT ON COLUMN public.tareas.asignado_a IS 'Compatibilidad: nombres de los asignados separados por ", ", mantenido por public.tarea_sincronizar_asignados. Fuente de verdad: public.tarea_asignados. En tareas históricas sin vincular conserva el nombre original.';

-- 2) Índices (tarea_id ya queda cubierto por el UNIQUE)
CREATE INDEX IF NOT EXISTS idx_tarea_asignados_usuario_id ON public.tarea_asignados (usuario_id);

-- 3) RLS: solo el backend (service_role) accede a esta tabla
ALTER TABLE public.tarea_asignados ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Backend service_role only" ON public.tarea_asignados;
CREATE POLICY "Backend service_role only" ON public.tarea_asignados
  USING (auth.role() = 'service_role'::text)
  WITH CHECK (auth.role() = 'service_role'::text);

-- 4) Sincronización atómica de la lista de asignados
CREATE OR REPLACE FUNCTION public.tarea_sincronizar_asignados(p_tarea_id uuid, p_usuario_ids uuid[])
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_ids uuid[] := coalesce(p_usuario_ids, ARRAY[]::uuid[]);
BEGIN
  IF (SELECT count(*) FROM unnest(v_ids)) <> (SELECT count(DISTINCT x) FROM unnest(v_ids) AS x) THEN
    RAISE EXCEPTION 'La misma persona no puede asignarse dos veces a una tarea.'
      USING ERRCODE = 'unique_violation';
  END IF;

  DELETE FROM public.tarea_asignados
  WHERE tarea_id = p_tarea_id
    AND NOT (usuario_id = ANY (v_ids));

  INSERT INTO public.tarea_asignados (tarea_id, usuario_id, orden)
  SELECT p_tarea_id, x.usuario_id, x.orden
  FROM unnest(v_ids) WITH ORDINALITY AS x(usuario_id, orden)
  ON CONFLICT (tarea_id, usuario_id) DO UPDATE SET orden = EXCLUDED.orden;

  UPDATE public.tareas t
  SET asignado_a = (
    SELECT string_agg(u.nombre, ', ' ORDER BY ta.orden)
    FROM public.tarea_asignados ta
    JOIN public.usuarios u ON u.id = ta.usuario_id
    WHERE ta.tarea_id = p_tarea_id
  )
  WHERE t.id = p_tarea_id;
END;
$$;

REVOKE ALL ON FUNCTION public.tarea_sincronizar_asignados(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tarea_sincronizar_asignados(uuid, uuid[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tarea_sincronizar_asignados(uuid, uuid[]) TO service_role;

-- 5) Backfill desde tareas.asignado_a (solo coincidencias únicas)
WITH candidatos AS (
  SELECT t.id AS tarea_id,
         u.id AS usuario_id,
         count(*) OVER (PARTITION BY t.id) AS coincidencias
  FROM public.tareas t
  JOIN public.usuarios u
    ON lower(btrim(u.nombre)) = lower(btrim(t.asignado_a))
  WHERE nullif(btrim(t.asignado_a), '') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.tarea_asignados ta WHERE ta.tarea_id = t.id)
)
INSERT INTO public.tarea_asignados (tarea_id, usuario_id, orden)
SELECT tarea_id, usuario_id, 1
FROM candidatos
WHERE coincidencias = 1
ON CONFLICT (tarea_id, usuario_id) DO NOTHING;

DO $$
DECLARE
  v_vinculadas   integer;
  v_sin_usuario  integer;
  v_ambiguas     integer;
BEGIN
  SELECT count(DISTINCT tarea_id) INTO v_vinculadas FROM public.tarea_asignados;

  SELECT count(*) INTO v_sin_usuario
  FROM public.tareas t
  WHERE nullif(btrim(t.asignado_a), '') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.tarea_asignados ta WHERE ta.tarea_id = t.id)
    AND NOT EXISTS (SELECT 1 FROM public.usuarios u WHERE lower(btrim(u.nombre)) = lower(btrim(t.asignado_a)));

  SELECT count(*) INTO v_ambiguas
  FROM public.tareas t
  WHERE nullif(btrim(t.asignado_a), '') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.tarea_asignados ta WHERE ta.tarea_id = t.id)
    AND (SELECT count(*) FROM public.usuarios u WHERE lower(btrim(u.nombre)) = lower(btrim(t.asignado_a))) > 1;

  RAISE NOTICE 'Operativo: % tarea(s) con asignados vinculados. Sin vincular: % (nombre sin usuario), % (nombre repetido en usuarios). Las no vinculadas conservan su texto en asignado_a.',
    v_vinculadas, v_sin_usuario, v_ambiguas;
END $$;

COMMIT;

-- Reporte (solo lectura): tareas con responsable histórico que no pudo
-- vincularse a un usuario. Siguen mostrando su asignado_a; para que aparezcan
-- en "asignados" hay que reasignarlas desde el tablero.
SELECT t.id, t.titulo, t.tipo, t.asignado_a,
       CASE WHEN count(u.id) = 0 THEN 'sin usuario con ese nombre'
            ELSE 'nombre repetido en ' || count(u.id) || ' usuarios' END AS motivo
FROM public.tareas t
LEFT JOIN public.usuarios u ON lower(btrim(u.nombre)) = lower(btrim(t.asignado_a))
WHERE nullif(btrim(t.asignado_a), '') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.tarea_asignados ta WHERE ta.tarea_id = t.id)
GROUP BY t.id, t.titulo, t.tipo, t.asignado_a
ORDER BY t.created_at;
