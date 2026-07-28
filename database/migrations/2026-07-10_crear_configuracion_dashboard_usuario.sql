-- Migración: 2026-07-10_crear_configuracion_dashboard_usuario
-- Módulo: Dashboard personalizable (public.dashboard_configuraciones)
--
-- Objetivo:
--   Primera versión básica del Dashboard personalizable de NexaCore. Cada
--   usuario tiene un único tablero fijo ("Panel General") cuya selección y
--   orden de mosaicos se guarda en una sola fila por usuario. No hay todavía
--   múltiples tableros, nombres personalizados, presets ni layout complejo:
--   solo un array ordenado de IDs de mosaico (validados en el backend contra
--   un catálogo cerrado y contra la Matriz de permisos por módulo antes de
--   guardarse — ver dashboard/services/dashboardService.js).
--
--   La tabla NO guarda resultados de métricas, datos financieros, tokens,
--   nombres de rol ni datos completos del usuario: solo la referencia al
--   usuario dueño y el array de IDs de mosaico seleccionados.
--
-- Esta migración:
--   1) Crea la tabla public.dashboard_configuraciones.
--   2) FK hacia public.usuarios(id) ON DELETE CASCADE (si se borra el
--      usuario, su configuración de dashboard deja de tener sentido y se
--      borra con él — mismo criterio que usuario_modulo_permisos).
--   3) UNIQUE sobre usuario_id: garantiza una sola fila (un solo "Panel
--      General") por usuario, para poder hacer upsert por usuario_id.
--   4) Trigger de updated_at reutilizando la función genérica existente
--      public.update_updated_at() (misma que usan contactos, tareas,
--      movimientos, usuario_modulo_permisos, etc.).
--   5) RLS habilitada con policy "Backend service_role only", mismo patrón
--      que las tablas de negocio más recientes (contactos, tareas) — el
--      backend accede siempre con la service_role key.
--
-- No borra datos existentes. Idempotente: puede correrse más de una vez sin
-- error, tanto en la base Developer como en la productiva nexacore_db.

BEGIN;

-- 1) Tabla principal
CREATE TABLE IF NOT EXISTS public.dashboard_configuraciones (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  usuario_id uuid NOT NULL,
  widgets jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- 2) FK hacia usuarios, ON DELETE CASCADE
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dashboard_configuraciones_usuario_id_fkey'
  ) THEN
    ALTER TABLE public.dashboard_configuraciones
      ADD CONSTRAINT dashboard_configuraciones_usuario_id_fkey
      FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 3) Una sola fila por usuario (permite upsert con onConflict: 'usuario_id')
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dashboard_configuraciones_usuario_id_key'
  ) THEN
    ALTER TABLE public.dashboard_configuraciones
      ADD CONSTRAINT dashboard_configuraciones_usuario_id_key UNIQUE (usuario_id);
  END IF;
END $$;

-- 4) updated_at automático, reutilizando la función genérica ya existente
DROP TRIGGER IF EXISTS trigger_dashboard_configuraciones_updated_at ON public.dashboard_configuraciones;
CREATE TRIGGER trigger_dashboard_configuraciones_updated_at
  BEFORE UPDATE ON public.dashboard_configuraciones
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 5) RLS: solo el backend (service_role) accede a esta tabla
ALTER TABLE public.dashboard_configuraciones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Backend service_role only" ON public.dashboard_configuraciones;
CREATE POLICY "Backend service_role only" ON public.dashboard_configuraciones
  USING (auth.role() = 'service_role'::text)
  WITH CHECK (auth.role() = 'service_role'::text);

COMMIT;
