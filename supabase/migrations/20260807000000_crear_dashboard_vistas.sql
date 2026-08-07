-- Migración: 20260807000000_crear_dashboard_vistas
-- Módulo: Dashboard — múltiples vistas/pestañas por usuario
--
-- Objetivo:
--   Agrega soporte para que cada usuario pueda tener hasta 10 "vistas" de
--   dashboard (pestañas), cada una con nombre propio y su propia selección
--   de mosaicos. Es un complemento de dashboard_configuraciones (panel
--   único legacy) — no la reemplaza.
--
--   La tabla NO guarda datos de negocio: solo nombre, orden y el array de
--   IDs de mosaico elegidos por el usuario (validado en backend contra el
--   catálogo cerrado de widgets.js y la Matriz de permisos por módulo).
--
-- Esta migración:
--   1) Crea public.dashboard_vistas.
--   2) FK hacia public.usuarios(id) ON DELETE CASCADE.
--   3) Índice compuesto (usuario_id, orden) para listar/ordenar pestañas.
--   4) Trigger updated_at reutilizando public.update_updated_at().
--   5) RLS "Backend service_role only", mismo patrón que el resto de tablas
--      de negocio (contactos, tareas, dashboard_configuraciones).
--
-- Idempotente: puede correrse más de una vez sin error.

BEGIN;

-- 1) Tabla principal
CREATE TABLE IF NOT EXISTS public.dashboard_vistas (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  usuario_id uuid NOT NULL,
  nombre     text NOT NULL,
  orden      integer NOT NULL DEFAULT 0,
  widgets    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- 2) FK hacia usuarios, ON DELETE CASCADE
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dashboard_vistas_usuario_id_fkey'
  ) THEN
    ALTER TABLE public.dashboard_vistas
      ADD CONSTRAINT dashboard_vistas_usuario_id_fkey
      FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 3) Índice para listar y ordenar las vistas de un usuario
CREATE INDEX IF NOT EXISTS idx_dashboard_vistas_usuario_orden
  ON public.dashboard_vistas (usuario_id, orden);

-- 4) updated_at automático — reutiliza la función genérica ya existente
DROP TRIGGER IF EXISTS trigger_dashboard_vistas_updated_at ON public.dashboard_vistas;
CREATE TRIGGER trigger_dashboard_vistas_updated_at
  BEFORE UPDATE ON public.dashboard_vistas
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 5) RLS: solo el backend (service_role) accede a esta tabla
ALTER TABLE public.dashboard_vistas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Backend service_role only" ON public.dashboard_vistas;
CREATE POLICY "Backend service_role only" ON public.dashboard_vistas
  USING (auth.role() = 'service_role'::text)
  WITH CHECK (auth.role() = 'service_role'::text);

COMMIT;
