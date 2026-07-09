-- Migración: 2026-07-05_link_organigrama_with_empleados
-- Módulo: Organización (public.organigrama) + Financiero/Sueldos (public.empleados)
--
-- Objetivo:
--   Permitir que un nodo del organigrama represente a un usuario del sistema,
--   a un empleado de Sueldos sin acceso al sistema, o a ambos (misma persona).
--   Hoy "organigrama.usuario_id" es NOT NULL + UNIQUE "duro": todo nodo exige
--   un usuario real y nunca puede repetirse, ni siquiera en nodos inactivos.
--
-- Esta migración:
--   1) Vuelve opcional "usuario_id" (un nodo puede ser solo-empleado).
--   2) Agrega "empleado_id", opcional, con FK hacia public.empleados.
--      FK con ON DELETE RESTRICT a propósito: un empleado que integra el
--      organigrama NO puede borrarse físicamente de la tabla empleados.
--      (El borrado desde el módulo Sueldos pasa a hacer soft-delete —
--      estado = 'Inactivo' — cuando el empleado tiene un nodo asociado;
--      ver finance/services/salariosService.js::eliminarEmpleado).
--   3) Agrega un CHECK: todo nodo debe representar a alguien
--      (usuario_id y/o empleado_id, nunca ninguno de los dos).
--   4) Reemplaza el UNIQUE "duro" de usuario_id por índices únicos PARCIALES
--      (solo sobre nodos activos) para usuario_id y empleado_id. Esto permite
--      conservar histórico: nodos inactivos pueden repetir usuario_id/empleado_id,
--      pero solo puede haber UN nodo activo por usuario y UN nodo activo por
--      empleado en simultáneo.
--
-- No borra datos existentes. Idempotente: puede correrse más de una vez sin
-- error, tanto en la base Developer como en la productiva nexacore_db.

BEGIN;

-- 1) usuario_id pasa a ser opcional
ALTER TABLE public.organigrama
  ALTER COLUMN usuario_id DROP NOT NULL;

-- 2) Nueva columna empleado_id (opcional)
ALTER TABLE public.organigrama
  ADD COLUMN IF NOT EXISTS empleado_id uuid;

-- FK hacia empleados. ON DELETE RESTRICT: bloquea el borrado físico de un
-- empleado mientras tenga un nodo (activo o inactivo) en el organigrama,
-- para preservar trazabilidad histórica.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organigrama_empleado_id_fkey'
  ) THEN
    ALTER TABLE public.organigrama
      ADD CONSTRAINT organigrama_empleado_id_fkey
      FOREIGN KEY (empleado_id) REFERENCES public.empleados(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- 3) Un nodo debe representar a alguien: usuario y/o empleado
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organigrama_persona_check'
  ) THEN
    ALTER TABLE public.organigrama
      ADD CONSTRAINT organigrama_persona_check
      CHECK (usuario_id IS NOT NULL OR empleado_id IS NOT NULL);
  END IF;
END $$;

-- 4) Reemplazar UNIQUE duro de usuario_id por unicidad parcial (solo activos)
ALTER TABLE public.organigrama
  DROP CONSTRAINT IF EXISTS organigrama_usuario_id_key;

DO $$
BEGIN
  IF to_regclass('public.organigrama_usuario_id_activo_idx') IS NULL THEN
    BEGIN
      CREATE UNIQUE INDEX organigrama_usuario_id_activo_idx
        ON public.organigrama (usuario_id)
        WHERE activo AND usuario_id IS NOT NULL;
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE 'No se pudo crear organigrama_usuario_id_activo_idx: existe más de un nodo activo para el mismo usuario_id. Desactivar duplicados y volver a ejecutar esta migración.';
    END;
  END IF;
END $$;

-- Misma unicidad parcial para empleado_id
DO $$
BEGIN
  IF to_regclass('public.organigrama_empleado_id_activo_idx') IS NULL THEN
    BEGIN
      CREATE UNIQUE INDEX organigrama_empleado_id_activo_idx
        ON public.organigrama (empleado_id)
        WHERE activo AND empleado_id IS NOT NULL;
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE 'No se pudo crear organigrama_empleado_id_activo_idx: existe más de un nodo activo para el mismo empleado_id. Desactivar duplicados y volver a ejecutar esta migración.';
    END;
  END IF;
END $$;

-- Índice de soporte para joins/filtros por empleado_id
CREATE INDEX IF NOT EXISTS idx_organigrama_empleado_id
  ON public.organigrama (empleado_id);

COMMIT;
