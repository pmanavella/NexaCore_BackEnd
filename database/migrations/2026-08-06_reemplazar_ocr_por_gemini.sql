-- Reemplazo definitivo del OCR local por extracción estructurada Gemini.
ALTER TABLE public.comprobantes DROP CONSTRAINT IF EXISTS comprobantes_ocr_estado_check;
ALTER TABLE public.comprobantes DROP COLUMN IF EXISTS url_archivo;
ALTER TABLE public.comprobantes DROP COLUMN IF EXISTS ocr_texto;
ALTER TABLE public.comprobantes DROP COLUMN IF EXISTS ocr_fecha;
ALTER TABLE public.comprobantes DROP COLUMN IF EXISTS ocr_monto;
ALTER TABLE public.comprobantes DROP COLUMN IF EXISTS ocr_proveedor;
ALTER TABLE public.comprobantes DROP COLUMN IF EXISTS ocr_estado;

ALTER TABLE public.comprobantes
  ADD COLUMN IF NOT EXISTS estado_analisis text NOT NULL DEFAULT 'requiere_revision',
  ADD COLUMN IF NOT EXISTS extraccion jsonb,
  ADD COLUMN IF NOT EXISTS diagnostico jsonb NOT NULL DEFAULT '{"errors":[],"auto_created":false}'::jsonb,
  ADD COLUMN IF NOT EXISTS document_fingerprint text,
  ADD COLUMN IF NOT EXISTS duplicate_of_id uuid;

ALTER TABLE public.comprobantes
  ADD CONSTRAINT comprobantes_estado_analisis_check
  CHECK (estado_analisis IN ('procesado', 'requiere_revision', 'error'));

ALTER TABLE public.comprobantes
  ADD CONSTRAINT comprobantes_duplicate_of_id_fkey
  FOREIGN KEY (duplicate_of_id) REFERENCES public.comprobantes(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS comprobantes_document_fingerprint_unique
  ON public.comprobantes(document_fingerprint)
  WHERE document_fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS comprobantes_estado_analisis_idx
  ON public.comprobantes(estado_analisis);

CREATE TABLE IF NOT EXISTS public.comprobante_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comprobante_id uuid NOT NULL REFERENCES public.comprobantes(id) ON DELETE CASCADE,
  orden integer NOT NULL,
  codigo text,
  descripcion text NOT NULL,
  cantidad numeric(15,4),
  precio_unitario numeric(15,2),
  bonificacion numeric(15,2),
  alicuota_iva numeric(6,2),
  importe numeric(15,2) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT comprobante_items_orden_unique UNIQUE (comprobante_id, orden)
);

CREATE INDEX IF NOT EXISTS comprobante_items_comprobante_idx ON public.comprobante_items(comprobante_id);

-- Los documentos financieros nunca deben exponerse mediante URL pública.
UPDATE storage.buckets SET public = false WHERE id = 'comprobantes';
