-- Migración: 2026-09-28_fechas_trabajo_tareas
-- Módulo: Operativo (Tablero de tareas)
--
-- Objetivo:
--   Seguir el curso real de una tarea y poder calcular cuántos días de
--   trabajo llevó. Se agregan 3 columnas nuevas a public.tareas:
--     - fecha_inicio_planeada: la carga la usuaria a mano (cuándo se
--       planea arrancar). No existía ningún campo para esto.
--     - fecha_inicio_real: se completa sola en el backend la primera vez
--       que la tarea entra a una etapa de tipo_base 'en_curso'.
--     - fecha_fin_real: se completa sola en el backend la primera vez que
--       la tarea entra a una etapa de tipo_base 'completada'.
--
--   La "cantidad de días de trabajo" NO se guarda: el backend la calcula
--   al vuelo (fecha_fin_real - fecha_inicio_real) cuando ambas están
--   presentes. Por eso esta migración no agrega ninguna columna para eso.
--
-- No modifica otras tablas ni módulos. No borra datos. No hace backfill:
-- las tareas existentes quedan con estas 3 columnas en NULL (no hay forma
-- confiable de reconstruir esas fechas para tareas ya en curso o
-- completadas antes de esta migración).
-- Idempotente: puede correrse más de una vez sin error (DEV y PROD).

BEGIN;

ALTER TABLE public.tareas
  ADD COLUMN IF NOT EXISTS fecha_inicio_planeada date,
  ADD COLUMN IF NOT EXISTS fecha_inicio_real      date,
  ADD COLUMN IF NOT EXISTS fecha_fin_real         date;

COMMENT ON COLUMN public.tareas.fecha_inicio_planeada IS 'Fecha en la que se planea arrancar la tarea. Carga manual del usuario.';
COMMENT ON COLUMN public.tareas.fecha_inicio_real IS 'Fecha real de inicio de trabajo. La completa el backend automáticamente la primera vez que la tarea entra a una etapa de tipo_base = en_curso; no se pisa en entradas posteriores.';
COMMENT ON COLUMN public.tareas.fecha_fin_real IS 'Fecha real de fin de trabajo. La completa el backend automáticamente la primera vez que la tarea entra a una etapa de tipo_base = completada; no se pisa en entradas posteriores.';

COMMIT;
