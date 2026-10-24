-- Migración: 2026-10-19_tableros_operativo
-- Módulo: Operativo (public.tareas)
--
-- Objetivo:
--   Pasar de un único tablero de tareas a varios tableros, cada uno con sus
--   miembros. Un usuario ve los tableros donde es miembro; Dirección y
--   Superadmin (nivel jerárquico HIGH) ven todos. Esa regla la aplica el
--   backend; la base solo guarda la relación. Las etapas (operativo_etapas)
--   siguen siendo las mismas para todos los tableros.
--
-- Esta migración:
--   1) Crea public.operativo_tableros (nombre, descripcion, created_by).
--      - nombre obligatorio (1..100 caracteres) y único sin distinguir
--        mayúsculas ni espacios de los bordes.
--      - created_by -> usuarios(id) ON DELETE SET NULL: borrar al usuario
--        que lo creó no borra el tablero.
--   2) Crea public.operativo_tablero_miembros (tablero_id, usuario_id) con
--      clave primaria compuesta.
--        - tablero_id -> operativo_tableros(id) ON DELETE CASCADE.
--        - usuario_id -> usuarios(id) ON DELETE CASCADE (el backend borra
--          usuarios en forma definitiva; mismo criterio que tarea_asignados).
--      Quitar a un miembro NO toca sus tareas: conservan el responsable.
--   3) Índice por usuario_id (tableros de una persona).
--   4) Trigger updated_at en operativo_tableros reutilizando
--      public.update_updated_at().
--   5) RLS "Backend service_role only" en ambas tablas, mismo patrón que el
--      resto de tablas de negocio.
--   6) Agrega public.tareas.tablero_id (FK a operativo_tableros, ON DELETE
--      RESTRICT: no se puede borrar un tablero con tareas). Queda NULLABLE
--      por ahora para no romper a quien todavía corre el backend anterior,
--      que crea tareas sin tablero.
--   7) Backfill, solo si no existe ningún tablero: crea "General", agrega a
--      todos los usuarios actuales como miembros y le asigna todas las tareas
--      existentes (asignaciones y propuestas) que no tengan tablero.
--
-- No borra datos ni modifica columnas existentes. No toca operativo_etapas.
-- Idempotente: puede correrse más de una vez sin error (DEV y PROD). Si ya
-- existe algún tablero, el paso 7 no hace nada.
--
-- NO afecta finance, movimientos, comprobantes, OCR, excel, deudas, empleados,
-- salarios, movimientos_salario, suscripciones, migraciones,
-- inversiones_historicas, sueldos_historicos, cuentas_por_cobrar
-- ni conciliaciones_migracion.

BEGIN;

-- 1) Tableros
CREATE TABLE IF NOT EXISTS public.operativo_tableros (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  nombre      text NOT NULL,
  descripcion text,
  created_by  uuid,
  created_at  timestamp with time zone DEFAULT now(),
  updated_at  timestamp with time zone DEFAULT now(),
  CONSTRAINT operativo_tableros_nombre_check
    CHECK (char_length(btrim(nombre)) BETWEEN 1 AND 100)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'operativo_tableros_created_by_fkey'
  ) THEN
    ALTER TABLE public.operativo_tableros
      ADD CONSTRAINT operativo_tableros_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.usuarios(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_operativo_tableros_nombre
  ON public.operativo_tableros (lower(btrim(nombre)));

COMMENT ON TABLE public.operativo_tableros IS 'Tableros de tareas del módulo Operativo. Cada uno tiene sus miembros (operativo_tablero_miembros) y sus tareas (tareas.tablero_id). Todos comparten las etapas de operativo_etapas.';
COMMENT ON COLUMN public.operativo_tableros.created_by IS 'Usuario que creó el tablero (NULL si fue creado por la migración o el usuario ya no existe).';

-- 2) Miembros
CREATE TABLE IF NOT EXISTS public.operativo_tablero_miembros (
  tablero_id uuid NOT NULL REFERENCES public.operativo_tableros(id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  CONSTRAINT operativo_tablero_miembros_pkey PRIMARY KEY (tablero_id, usuario_id)
);

COMMENT ON TABLE public.operativo_tablero_miembros IS 'Miembros de cada tablero del Operativo. Un usuario ve los tableros donde es miembro (Dirección y Superadmin ven todos, regla del backend). Quitar a un miembro no modifica sus tareas.';

-- 3) Índice para buscar los tableros de una persona
CREATE INDEX IF NOT EXISTS idx_operativo_tablero_miembros_usuario
  ON public.operativo_tablero_miembros (usuario_id);

-- 4) updated_at automático — reutiliza la función genérica ya existente
DROP TRIGGER IF EXISTS trigger_operativo_tableros_updated_at ON public.operativo_tableros;
CREATE TRIGGER trigger_operativo_tableros_updated_at
  BEFORE UPDATE ON public.operativo_tableros
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 5) RLS: solo el backend (service_role) accede a estas tablas
ALTER TABLE public.operativo_tableros ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Backend service_role only" ON public.operativo_tableros;
CREATE POLICY "Backend service_role only" ON public.operativo_tableros
  USING (auth.role() = 'service_role'::text)
  WITH CHECK (auth.role() = 'service_role'::text);

ALTER TABLE public.operativo_tablero_miembros ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Backend service_role only" ON public.operativo_tablero_miembros;
CREATE POLICY "Backend service_role only" ON public.operativo_tablero_miembros
  USING (auth.role() = 'service_role'::text)
  WITH CHECK (auth.role() = 'service_role'::text);

-- 6) tareas.tablero_id (nullable por ahora)
ALTER TABLE public.tareas
  ADD COLUMN IF NOT EXISTS tablero_id uuid REFERENCES public.operativo_tableros(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_tareas_tablero_id ON public.tareas (tablero_id);

COMMENT ON COLUMN public.tareas.tablero_id IS 'Tablero del Operativo al que pertenece la tarea. Nullable mientras convivan backends anteriores que crean tareas sin tablero.';

-- 7) Backfill: solo si todavía no hay ningún tablero
DO $$
DECLARE
  v_general uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.operativo_tableros) THEN
    INSERT INTO public.operativo_tableros (nombre, descripcion)
    VALUES ('General', 'Tablero creado automáticamente con las tareas existentes.')
    RETURNING id INTO v_general;

    INSERT INTO public.operativo_tablero_miembros (tablero_id, usuario_id)
    SELECT v_general, u.id FROM public.usuarios u
    ON CONFLICT DO NOTHING;

    UPDATE public.tareas
    SET tablero_id = v_general
    WHERE tablero_id IS NULL;
  END IF;
END $$;

COMMIT;
