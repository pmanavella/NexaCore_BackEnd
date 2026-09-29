-- Migración: 2026-09-29_agregar_fechas_contacto_crm
-- Módulo: CRM (public.contactos)
--
-- Objetivo:
--   El módulo CRM requiere registrar el último contacto realizado y el próximo
--   contacto planificado para cada entrada de la tabla public.contactos.
--
--   Mapeo de campos del requerimiento del cliente:
--     "Pertenece a"  = columna existente `empresa`  (texto libre, sin cambios)
--     "Comentarios"  = columna existente `notas`     (texto libre, sin cambios)
--     No se renombra ninguna columna existente.
--
--   Se usa tipo `date` (y no `timestamptz`) porque el seguimiento comercial se
--   gestiona por día calendario, no por hora exacta. El frontend envía y recibe
--   strings 'YYYY-MM-DD'; el backend valida que la fecha sea real antes de
--   persistirla.
--
-- Esta migración:
--   1) Agrega public.contactos.ultimo_contacto  date NULL.
--   2) Agrega public.contactos.proximo_contacto date NULL.
--   3) Crea índice idx_contactos_proximo_contacto (para ordenar la tabla por
--      próximo seguimiento, con NULLs al final).
--   4) Documenta ambas columnas con COMMENT ON COLUMN.
--
-- No hay backfill: los registros existentes quedan con NULL en ambas columnas.
-- Idempotente: puede correrse más de una vez sin error (DEV y PROD).

BEGIN;

-- 1) Columna: último contacto realizado
ALTER TABLE public.contactos
  ADD COLUMN IF NOT EXISTS ultimo_contacto date NULL;

-- 2) Columna: próximo contacto planificado
ALTER TABLE public.contactos
  ADD COLUMN IF NOT EXISTS proximo_contacto date NULL;

-- 3) Índice para ordenar por próximo contacto (NULLs al final)
CREATE INDEX IF NOT EXISTS idx_contactos_proximo_contacto
  ON public.contactos (proximo_contacto ASC NULLS LAST);

-- 4) Documentación de columnas
COMMENT ON COLUMN public.contactos.ultimo_contacto  IS 'Fecha del último contacto realizado con este registro (día, sin hora). NULL si no se ha registrado ninguno.';
COMMENT ON COLUMN public.contactos.proximo_contacto IS 'Fecha del próximo contacto planificado (día, sin hora). NULL si no hay seguimiento programado. Usada como criterio de ordenamiento en la vista de contactos.';

COMMIT;