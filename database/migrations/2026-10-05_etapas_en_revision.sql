-- Migración: 2026-10-05_etapas_en_revision
-- Módulo: Operativo (public.operativo_etapas)
--
-- Objetivo:
--   Incorporar el estado "En Revisión" a las etapas configurables del tablero,
--   tanto abierta como cerrada, conservando las 4 combinaciones existentes:
--
--     tipo_base             Combinación en "Configurar etapas"
--     pendiente             Abierta · Pendiente      (existente)
--     en_curso              Abierta · En curso       (existente)
--     en_revision_abierta   Abierta · En Revisión    (nuevo)
--     completada            Cerrada · Completada     (existente)
--     cancelada             Cerrada · Cancelada      (existente)
--     en_revision_cerrada   Cerrada · En Revisión    (nuevo)
--
--   La condición Abierta/Cerrada no se guarda aparte: el backend la deriva del
--   tipo_base (operations/config/etapas.js). Por eso cada combinación nueva
--   necesita su propio valor.
--
-- Esta migración:
--   1) Reemplaza operativo_etapas_tipo_base_check agregando los 2 valores nuevos.
--   2) Actualiza el COMMENT de la columna tipo_base.
--
-- No modifica public.tareas: su columna `estado` (CHECK de 4 valores) sigue
-- recibiendo el equivalente canónico ("En Proceso" / "Completada") que asigna
-- el backend. No crea etapas nuevas, no modifica ni borra datos. Todas las
-- filas existentes cumplen el CHECK nuevo (es un superconjunto del anterior).
-- Idempotente: puede correrse más de una vez sin error (DEV y PROD).

BEGIN;

-- 1) CHECK de tipo_base ampliado
ALTER TABLE public.operativo_etapas
  DROP CONSTRAINT IF EXISTS operativo_etapas_tipo_base_check;

ALTER TABLE public.operativo_etapas
  ADD CONSTRAINT operativo_etapas_tipo_base_check
  CHECK (tipo_base IN (
    'pendiente', 'en_curso', 'en_revision_abierta',
    'completada', 'cancelada', 'en_revision_cerrada'
  ));

-- 2) Documentación
COMMENT ON COLUMN public.operativo_etapas.tipo_base IS 'Clasificación interna fija usada para calcular totales y "vencida". Abiertas: pendiente, en_curso, en_revision_abierta. Cerradas: completada, cancelada, en_revision_cerrada. Catálogo en operations/config/etapas.js.';

COMMIT;
