-- Migración: 2026-07-05_fix_optional_employee_contact_unique_constraints
-- Módulo: Financiero / Sueldos (public.empleados)
--
-- Problema:
--   La constraint "empleados_email_key" es un UNIQUE "duro" sobre email.
--   Postgres permite múltiples NULL bajo un UNIQUE, pero NO permite múltiples
--   valores "" (string vacío) repetidos, ya que "" = "" se considera igual.
--   Como el backend insertaba "" en vez de NULL cuando el campo quedaba vacío,
--   el primer empleado sin email se creaba, pero el segundo fallaba por
--   "duplicate key value violates unique constraint".
--

BEGIN;

-- 1) Normalizar datos existentes: "" o solo espacios -> NULL
UPDATE public.empleados
SET email = NULL
WHERE email IS NOT NULL AND btrim(email) = '';

UPDATE public.empleados
SET telefono = NULL
WHERE telefono IS NOT NULL AND btrim(telefono) = '';

-- 2) Eliminar la constraint UNIQUE "dura" sobre email (trataba "" como duplicado)
ALTER TABLE public.empleados
  DROP CONSTRAINT IF EXISTS empleados_email_key;

-- Por si en algún entorno se hubiera creado como índice suelto en vez de constraint
DROP INDEX IF EXISTS public.empleados_email_key;

-- 3) Índice único parcial sobre email: solo exige unicidad cuando el valor
--    es real. Envuelto en DO/EXCEPTION para no romper la migración si
--    existieran datos de producción con duplicados reales pendientes de
--    limpieza manual.
DO $$
BEGIN
  IF to_regclass('public.empleados_email_unique_idx') IS NULL THEN
    BEGIN
      CREATE UNIQUE INDEX empleados_email_unique_idx
        ON public.empleados (email)
        WHERE email IS NOT NULL AND btrim(email) <> '';
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE 'No se pudo crear empleados_email_unique_idx: existen emails duplicados reales. Limpiar datos y volver a ejecutar esta migración.';
    END;
  END IF;
END $$;

-- Rollback/corrección: el teléfono NO debe ser único. Elimina el índice
-- único sobre telefono si una corrida anterior de esta migración llegó a crearlo.
DROP INDEX IF EXISTS empleados_telefono_unique_idx;

COMMIT;
