-- Migración: 2026-11-03_tareas_fecha_finalizacion
-- Módulo: Operativo (public.tareas)
--
-- Objetivo:
--   En el Kanban, las tareas completadas o canceladas se muestran solo durante
--   los 7 días (168 horas) siguientes a su finalización; después siguen en la
--   base y se consultan con GET /api/operations/tareas?vista=historial.
--   Para eso hace falta el momento exacto de la finalización, que hoy no
--   existe de forma confiable:
--     - fecha_fin_real es date (sin hora), se completa solo la PRIMERA vez que
--       la tarea entra a 'completada', nunca para 'cancelada', y no se reinicia
--       si la tarea se reabre.
--     - tarea_historial audita el estado canónico, que no distingue
--       'completada' de 'en_revision_cerrada' (ambas "Completada"), y su
--       escritura es best-effort.
--
-- Esta migración:
--   1) Agrega public.tareas.fecha_finalizacion (timestamptz, NULL). La escribe
--      solo el backend (operations/services/operationsService.js):
--        - entrar a una etapa de tipo_base 'completada' o 'cancelada' desde un
--          tipo_base distinto -> now() (reabrir y volver a finalizar reinicia
--          el plazo; pasar de completada a cancelada también);
--        - pasar a cualquier otro tipo_base -> NULL;
--        - moverse entre etapas del mismo tipo_base -> sin cambios.
--      'en_revision_cerrada' no la usa: esas tareas se siguen viendo siempre.
--
-- No hace backfill ni modifica datos existentes: las tareas ya finalizadas
-- quedan con fecha_finalizacion NULL y el backend las sigue mostrando en el
-- Kanban (no se ocultan por una fecha inferida; created_at, fecha_fin_real y
-- el historial no son confiables para esto).
--
-- Regularización de tareas históricas (opcional, manual):
--   - Desde la aplicación: mover la tarea a otra etapa y volver a finalizarla
--     (el plazo de 7 días empieza en ese momento).
--   - O, revisando caso por caso, cargar una fecha conocida:
--       UPDATE public.tareas SET fecha_finalizacion = '<timestamptz verificado>'
--       WHERE id = '<id>' AND fecha_finalizacion IS NULL;
--
-- Orden de despliegue: correr ANTES de desplegar el backend que la escribe.
-- Idempotente: puede correrse más de una vez sin error (DEV y PROD).
--
-- NO afecta finance, movimientos, comprobantes, OCR, excel, deudas, empleados,
-- salarios, movimientos_salario, suscripciones, migraciones,
-- inversiones_historicas, sueldos_historicos, cuentas_por_cobrar
-- ni conciliaciones_migracion.

BEGIN;

ALTER TABLE public.tareas
  ADD COLUMN IF NOT EXISTS fecha_finalizacion timestamp with time zone;

COMMENT ON COLUMN public.tareas.fecha_finalizacion IS 'Momento en que la tarea entró a su etapa actual de tipo_base completada o cancelada (NULL si no está en una de ellas o si finalizó antes de esta columna). La mantiene el backend; el Kanban oculta las tareas finalizadas hace 168 horas o más.';

COMMIT;
