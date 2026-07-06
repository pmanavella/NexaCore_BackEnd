-- Migración: 2026-07-05_add_manual_people_to_organigrama
-- Módulo: Organización (public.organigrama)
--
-- Objetivo:
--   Soportar en el organigrama personas que no son ni usuario del sistema
--   ni empleado de Sueldos (ej: contador externo, asesor legal, consultor,
--   proveedor externo). Se cargan a mano con nombre obligatorio y datos de
--   contacto opcionales; nunca tienen permisos del sistema.
--
-- Esta migración:
--   1) Agrega columnas nombre_manual, apellido_manual, email_manual,
--      telefono_manual (todas opcionales/nullable).
--   2) Reemplaza el CHECK "organigrama_persona_check" (que hoy exige
--      usuario_id y/o empleado_id) por uno que también acepta un nodo
--      identificado únicamente por nombre_manual.
--
-- No borra datos existentes: las filas actuales ya tienen usuario_id y/o
-- empleado_id, por lo que siguen cumpliendo el nuevo CHECK sin cambios.
-- Idempotente: puede correrse más de una vez sin error, tanto en la base
-- Developer como en la productiva nexacore_db.

BEGIN;

-- 1) Columnas para personas manuales/externas
ALTER TABLE public.organigrama ADD COLUMN IF NOT EXISTS nombre_manual   text;
ALTER TABLE public.organigrama ADD COLUMN IF NOT EXISTS apellido_manual text;
ALTER TABLE public.organigrama ADD COLUMN IF NOT EXISTS email_manual    text;
ALTER TABLE public.organigrama ADD COLUMN IF NOT EXISTS telefono_manual text;

-- 2) Actualizar el CHECK de identidad del nodo
ALTER TABLE public.organigrama
  DROP CONSTRAINT IF EXISTS organigrama_persona_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organigrama_persona_check'
  ) THEN
    ALTER TABLE public.organigrama
      ADD CONSTRAINT organigrama_persona_check
      CHECK (
        usuario_id IS NOT NULL
        OR empleado_id IS NOT NULL
        OR (nombre_manual IS NOT NULL AND btrim(nombre_manual) <> '')
      );
  END IF;
END $$;

COMMIT;
