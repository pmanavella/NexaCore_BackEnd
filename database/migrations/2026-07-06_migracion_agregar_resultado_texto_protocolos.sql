-- Migración: 2026-07-06_migracion_agregar_resultado_texto_protocolos
-- Módulo: Protocolos (public.protocolo_pruebas)
--
-- Objetivo:
--   Agregar el campo resultado_texto (text, hasta 800 caracteres) a la tabla
--   protocolo_pruebas. Este campo almacena el texto libre que el usuario escribe
--   en el recuadro visual "Resultados", independiente del checklist (resultados jsonb).
--
--   Además actualiza el constraint de longitud de observaciones de 300 a 800
--   caracteres para alinearlo con el nuevo límite unificado de ambos campos.
--
-- Esta migración:
--   1) Agrega la columna resultado_texto (nullable, text).
--   2) Aplica un CHECK de máx. 800 caracteres sobre resultado_texto.
--   3) Reemplaza el CHECK de observaciones elevando el límite a 800 caracteres.
--
-- No borra datos existentes: las filas actuales con observaciones <= 300 chars
-- siguen cumpliendo el nuevo CHECK sin ningún cambio.
-- Idempotente: puede correrse más de una vez sin error, tanto en la base
-- Developer como en la productiva NexaCore DB.
--
-- NO afecta finance, movimientos, comprobantes, OCR, excel, deudas, empleados,
-- salarios, movimientos_salario, suscripciones, migraciones,
-- inversiones_historicas, sueldos_historicos, cuentas_por_cobrar
-- ni conciliaciones_migracion.

BEGIN;

-- 1) Columna nueva: resultado_texto
ALTER TABLE public.protocolo_pruebas
  ADD COLUMN IF NOT EXISTS resultado_texto text;

-- 2) Constraint de longitud para resultado_texto (máx. 800 chars)
ALTER TABLE public.protocolo_pruebas
  DROP CONSTRAINT IF EXISTS protocolo_pruebas_resultado_texto_len;

ALTER TABLE public.protocolo_pruebas
  ADD CONSTRAINT protocolo_pruebas_resultado_texto_len
  CHECK (char_length(coalesce(resultado_texto, '')) <= 800);

-- 3) Reemplazar constraint de longitud de observaciones (300 → 800 chars)
ALTER TABLE public.protocolo_pruebas
  DROP CONSTRAINT IF EXISTS protocolo_pruebas_observaciones_len;

ALTER TABLE public.protocolo_pruebas
  ADD CONSTRAINT protocolo_pruebas_observaciones_len
  CHECK (char_length(coalesce(observaciones, '')) <= 800);

COMMIT;
