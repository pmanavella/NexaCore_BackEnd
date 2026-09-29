-- Migración: 2026-09-28_etapas_operativo
-- Módulo: Operativo (Tablero de tareas)
--
-- Objetivo:
--   Las 4 etapas fijas del tablero (Pendiente, En Proceso, Completada,
--   Cancelada) pasan a ser personalizables por el usuario: nombre, color,
--   orden y cantidad. Un único flujo global, válido para todas las tareas.
--
--   Para poder seguir calculando totales y "vencida" sin importar cuántas
--   etapas custom se creen, cada etapa guarda un `tipo_base` interno (uno
--   de los 4 valores originales) que indica si cuenta como abierta o
--   cerrada. `tipo_base` no se muestra al usuario final: el frontend solo
--   edita nombre/color/posición.
--
-- Esta migración:
--   1) Crea public.operativo_etapas (nombre, color, posicion, tipo_base).
--   2) Índices por posicion y tipo_base.
--   3) Trigger updated_at reutilizando public.update_updated_at().
--   4) RLS "Backend service_role only", mismo patrón que el resto de tablas.
--   5) Siembra las 4 etapas actuales, solo si la tabla está vacía.
--   6) Agrega public.tareas.etapa_id (FK a operativo_etapas, ON DELETE
--      RESTRICT: no se puede borrar una etapa con tareas asignadas) y
--      hace backfill de las tareas existentes según su `estado` actual.
--      No se borra ni se modifica la columna `estado`.
--
-- No modifica otras tablas ni módulos. No borra datos.
-- Idempotente: puede correrse más de una vez sin error (DEV y PROD).

BEGIN;

-- 1) Tabla principal
CREATE TABLE IF NOT EXISTS public.operativo_etapas (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  nombre     text NOT NULL,
  color      text NOT NULL,
  posicion   integer NOT NULL,
  tipo_base  text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT operativo_etapas_nombre_check
    CHECK (char_length(btrim(nombre)) BETWEEN 1 AND 100),
  CONSTRAINT operativo_etapas_color_check
    CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT operativo_etapas_tipo_base_check
    CHECK (tipo_base IN ('pendiente', 'en_curso', 'completada', 'cancelada')),
  CONSTRAINT operativo_etapas_posicion_check
    CHECK (posicion >= 0)
);

COMMENT ON TABLE public.operativo_etapas IS 'Etapas personalizables del tablero Operativo. Flujo único global para todas las tareas.';
COMMENT ON COLUMN public.operativo_etapas.tipo_base IS 'Clasificación interna fija (pendiente/en_curso/completada/cancelada) usada para calcular totales y "vencida". No se expone como algo editable más allá de elegirla al crear la etapa.';
COMMENT ON COLUMN public.operativo_etapas.posicion IS 'Orden de la etapa en el tablero (0 = primera). El backend la mantiene contigua (0..n-1) en cada alta/baja/reordenamiento.';
COMMENT ON COLUMN public.operativo_etapas.color IS 'Color de la etapa en formato hexadecimal (#RRGGBB), elegido por el usuario.';

-- 2) Índices
CREATE INDEX IF NOT EXISTS idx_operativo_etapas_posicion  ON public.operativo_etapas (posicion);
CREATE INDEX IF NOT EXISTS idx_operativo_etapas_tipo_base ON public.operativo_etapas (tipo_base);

-- 3) updated_at automático — reutiliza la función genérica ya existente
DROP TRIGGER IF EXISTS trigger_operativo_etapas_updated_at ON public.operativo_etapas;
CREATE TRIGGER trigger_operativo_etapas_updated_at
  BEFORE UPDATE ON public.operativo_etapas
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 4) RLS: solo el backend (service_role) accede a esta tabla
ALTER TABLE public.operativo_etapas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Backend service_role only" ON public.operativo_etapas;
CREATE POLICY "Backend service_role only" ON public.operativo_etapas
  USING (auth.role() = 'service_role'::text)
  WITH CHECK (auth.role() = 'service_role'::text);

-- 5) Siembra de las 4 etapas actuales — solo si la tabla está vacía.
--    Los colores son un default razonable; el usuario los puede cambiar
--    después desde el tablero.
INSERT INTO public.operativo_etapas (nombre, color, posicion, tipo_base)
SELECT v.nombre, v.color, v.posicion, v.tipo_base
FROM (VALUES
  ('Pendiente',  '#94A3B8', 0, 'pendiente'),
  ('En Proceso', '#3B82F6', 1, 'en_curso'),
  ('Completada', '#22C55E', 2, 'completada'),
  ('Cancelada',  '#EF4444', 3, 'cancelada')
) AS v(nombre, color, posicion, tipo_base)
WHERE NOT EXISTS (SELECT 1 FROM public.operativo_etapas);

-- 6) tareas.etapa_id
ALTER TABLE public.tareas
  ADD COLUMN IF NOT EXISTS etapa_id uuid REFERENCES public.operativo_etapas(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_tareas_etapa_id ON public.tareas (etapa_id);

-- Backfill: asigna a cada tarea existente la etapa cuyo nombre coincide con
-- su `estado` actual (comparación sin espacios ni mayúsculas/minúsculas).
UPDATE public.tareas t
SET etapa_id = e.id
FROM public.operativo_etapas e
WHERE t.etapa_id IS NULL
  AND t.estado IS NOT NULL
  AND lower(btrim(t.estado)) = lower(btrim(e.nombre));

-- Aviso si quedó alguna tarea sin poder mapear (estado con un valor inesperado,
-- no uno de los 4 originales). No frena la migración: la tarea queda con
-- etapa_id NULL y se puede corregir a mano o desde el tablero.
DO $$
DECLARE
  tareas_sin_etapa integer;
BEGIN
  SELECT count(*) INTO tareas_sin_etapa
  FROM public.tareas
  WHERE etapa_id IS NULL;

  IF tareas_sin_etapa > 0 THEN
    RAISE NOTICE 'Operativo: % tarea(s) quedaron sin etapa_id asignado (estado no coincide con ninguna etapa sembrada). Revisar manualmente.', tareas_sin_etapa;
  END IF;
END $$;

COMMIT;
