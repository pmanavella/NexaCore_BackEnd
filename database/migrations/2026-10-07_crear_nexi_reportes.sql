-- Migración: 2026-10-07_crear_nexi_reportes
-- Módulo: Nexi — generación de reportes bajo demanda
--
-- Objetivo:
--   Registrar (auditoría + ubicación del archivo) los reportes que genera Nexi.
--   El archivo PDF NO se guarda en la base: vive en un bucket privado de
--   Supabase Storage (`nexi-reportes`, ruta <usuario_id>/<reporte_id>.pdf).
--
-- Por qué una tabla nueva:
--   - El archivo debe poder descargarse después de la respuesta del chat:
--     hace falta saber de quién es y dónde está.
--   - La auditoría pedida (usuario, fecha, módulos, rango, tipo, resultado,
--     duración, estado) no entra en nexi_tool_calls sin guardar datos de más.
--   - No existe otra tabla de reportes en NexaCore (la vista Reportes no tiene
--     backend propio todavía) ni un bucket reutilizable (`comprobantes` es de
--     Finanzas).
--
-- Esta migración:
--   1) Crea public.nexi_reportes (solo metadatos: nunca el contenido del reporte).
--   2) FKs ON DELETE SET NULL hacia usuarios y nexi_conversaciones: la
--      auditoría sobrevive al borrado de la conversación o del usuario.
--   3) Índice para listar y contar por usuario/fecha (límite por hora).
--   4) RLS "Backend service_role only", mismo patrón que el resto de tablas.
--   5) Crea el bucket PRIVADO `nexi-reportes` (o lo fuerza a privado si existe).
--
-- Depende de: public.usuarios, public.nexi_conversaciones (2026-09-27_crear_nexi).
-- No modifica ni borra tablas o datos existentes.
-- Idempotente: puede correrse más de una vez sin error (DEV y PROD).

BEGIN;

-- 1) Reportes generados
CREATE TABLE IF NOT EXISTS public.nexi_reportes (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  usuario_id          uuid,
  conversacion_id     uuid,
  tipo                text NOT NULL,
  titulo              text NOT NULL,
  secciones           text[] NOT NULL DEFAULT '{}',
  secciones_excluidas jsonb NOT NULL DEFAULT '[]'::jsonb,
  periodo_desde       date NOT NULL,
  periodo_hasta       date NOT NULL,
  periodo_etiqueta    text NOT NULL,
  comparacion_desde   date,
  comparacion_hasta   date,
  formato             text NOT NULL DEFAULT 'pdf',
  estado              text NOT NULL,
  motivo              text,
  archivo_path        text,
  archivo_bytes       integer,
  duracion_ms         integer NOT NULL DEFAULT 0,
  created_at          timestamp with time zone NOT NULL DEFAULT now(),
  finalizado_at       timestamp with time zone,
  CONSTRAINT nexi_reportes_tipo_check
    CHECK (tipo IN ('financiero', 'operativo', 'crm', 'indicadores', 'protocolos', 'dashboard', 'organizacion', 'ejecutivo', 'personalizado')),
  CONSTRAINT nexi_reportes_secciones_check
    CHECK (secciones <@ ARRAY['finanzas', 'indicadores', 'operativo', 'crm', 'protocolos', 'dashboard', 'organizacion']::text[]),
  CONSTRAINT nexi_reportes_formato_check
    CHECK (formato IN ('pdf')),
  CONSTRAINT nexi_reportes_estado_check
    CHECK (estado IN ('EN_PROCESO', 'GENERADO', 'DENEGADO', 'ERROR')),
  CONSTRAINT nexi_reportes_periodo_check
    CHECK (periodo_hasta > periodo_desde),
  CONSTRAINT nexi_reportes_titulo_check
    CHECK (char_length(titulo) BETWEEN 1 AND 300),
  CONSTRAINT nexi_reportes_duracion_check
    CHECK (duracion_ms >= 0),
  CONSTRAINT nexi_reportes_archivo_check
    CHECK (estado <> 'GENERADO' OR archivo_path IS NOT NULL)
);

-- 2) Claves foráneas
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nexi_reportes_usuario_id_fkey'
  ) THEN
    ALTER TABLE public.nexi_reportes
      ADD CONSTRAINT nexi_reportes_usuario_id_fkey
      FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nexi_reportes_conversacion_id_fkey'
  ) THEN
    ALTER TABLE public.nexi_reportes
      ADD CONSTRAINT nexi_reportes_conversacion_id_fkey
      FOREIGN KEY (conversacion_id) REFERENCES public.nexi_conversaciones(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON TABLE public.nexi_reportes IS 'Nexi: reportes generados bajo demanda (auditoría y ubicación del archivo en Storage). Nunca guarda el contenido del reporte.';
COMMENT ON COLUMN public.nexi_reportes.periodo_hasta IS 'Fin del período, EXCLUSIVO ([periodo_desde, periodo_hasta)).';
COMMENT ON COLUMN public.nexi_reportes.archivo_path IS 'Ruta en el bucket privado nexi-reportes (<usuario_id>/<id>.pdf).';
COMMENT ON COLUMN public.nexi_reportes.motivo IS 'Código del motivo de DENEGADO/ERROR (ej. SIN_SECCIONES_PERMITIDAS, TIMEOUT_GLOBAL, ERROR_INTERNO).';

-- 3) Índices
CREATE INDEX IF NOT EXISTS idx_nexi_reportes_usuario_created
  ON public.nexi_reportes (usuario_id, created_at DESC);

-- 4) RLS: solo el backend (service_role) accede a la tabla
ALTER TABLE public.nexi_reportes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Backend service_role only" ON public.nexi_reportes;
CREATE POLICY "Backend service_role only" ON public.nexi_reportes
  USING (auth.role() = 'service_role'::text)
  WITH CHECK (auth.role() = 'service_role'::text);

-- 5) Bucket privado para los archivos (sin políticas públicas: solo service_role)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('nexi-reportes', 'nexi-reportes', false, 5242880, ARRAY['application/pdf'])
ON CONFLICT (id) DO UPDATE SET public = false;

COMMIT;
