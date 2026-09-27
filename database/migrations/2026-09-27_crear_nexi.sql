-- Migración: 2026-09-27_crear_nexi
-- Módulo: Nexi — asistente inteligente (V1, solo lectura)
--
-- Objetivo:
--   Persistir las conversaciones de Nexi y auditar cada llamada a herramienta.
--   Nexi no escribe en tablas de negocio: estas tres tablas son las únicas que
--   el módulo modifica.
--
-- Esta migración:
--   1) Crea public.nexi_conversaciones (una por hilo, siempre de un usuario).
--   2) Crea public.nexi_mensajes (solo texto de usuario y asistente; los
--      resultados de herramientas NO se persisten).
--   3) Crea public.nexi_tool_calls (auditoría: herramienta, argumentos ya
--      validados, resultado OK/DENEGADO/ERROR, motivo y latencia). Sobrevive al
--      borrado de la conversación o del usuario (FK ON DELETE SET NULL).
--   4) Índices para listar conversaciones por usuario, mensajes por
--      conversación y auditoría por usuario/fecha.
--   5) Trigger updated_at en nexi_conversaciones reutilizando
--      public.update_updated_at().
--   6) RLS "Backend service_role only", mismo patrón que el resto de tablas.
--
-- Depende de: public.usuarios, public.update_updated_at() y, en tiempo de
-- ejecución, de public.indicadores_totales_movimientos (2026-09-27_crear_indicadores).
-- No modifica ni borra tablas o datos existentes.
-- Idempotente: puede correrse más de una vez sin error (DEV y PROD).

BEGIN;

-- 1) Conversaciones
CREATE TABLE IF NOT EXISTS public.nexi_conversaciones (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  usuario_id uuid NOT NULL,
  titulo     text NOT NULL DEFAULT 'Nueva conversación',
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT nexi_conversaciones_titulo_check
    CHECK (char_length(btrim(titulo)) BETWEEN 1 AND 120)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nexi_conversaciones_usuario_id_fkey'
  ) THEN
    ALTER TABLE public.nexi_conversaciones
      ADD CONSTRAINT nexi_conversaciones_usuario_id_fkey
      FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE CASCADE;
  END IF;
END $$;

COMMENT ON TABLE public.nexi_conversaciones IS 'Nexi: conversaciones. Cada fila pertenece a un único usuario; el backend filtra siempre por usuario_id.';

-- 2) Mensajes
CREATE TABLE IF NOT EXISTS public.nexi_mensajes (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  conversacion_id uuid NOT NULL,
  rol             text NOT NULL,
  contenido       text NOT NULL,
  created_at      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT nexi_mensajes_rol_check
    CHECK (rol IN ('usuario', 'asistente')),
  CONSTRAINT nexi_mensajes_contenido_check
    CHECK (char_length(contenido) BETWEEN 1 AND 20000)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nexi_mensajes_conversacion_id_fkey'
  ) THEN
    ALTER TABLE public.nexi_mensajes
      ADD CONSTRAINT nexi_mensajes_conversacion_id_fkey
      FOREIGN KEY (conversacion_id) REFERENCES public.nexi_conversaciones(id) ON DELETE CASCADE;
  END IF;
END $$;

COMMENT ON TABLE public.nexi_mensajes IS 'Nexi: mensajes de usuario y asistente. Los resultados de herramientas no se guardan.';

-- 3) Auditoría de herramientas
CREATE TABLE IF NOT EXISTS public.nexi_tool_calls (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  conversacion_id  uuid,
  usuario_id       uuid,
  herramienta      text NOT NULL,
  argumentos       jsonb NOT NULL DEFAULT '{}'::jsonb,
  resultado_estado text NOT NULL,
  motivo           text,
  duracion_ms      integer NOT NULL DEFAULT 0,
  created_at       timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT nexi_tool_calls_resultado_estado_check
    CHECK (resultado_estado IN ('OK', 'DENEGADO', 'ERROR')),
  CONSTRAINT nexi_tool_calls_duracion_check
    CHECK (duracion_ms >= 0),
  CONSTRAINT nexi_tool_calls_herramienta_check
    CHECK (char_length(herramienta) BETWEEN 1 AND 100)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nexi_tool_calls_conversacion_id_fkey'
  ) THEN
    ALTER TABLE public.nexi_tool_calls
      ADD CONSTRAINT nexi_tool_calls_conversacion_id_fkey
      FOREIGN KEY (conversacion_id) REFERENCES public.nexi_conversaciones(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nexi_tool_calls_usuario_id_fkey'
  ) THEN
    ALTER TABLE public.nexi_tool_calls
      ADD CONSTRAINT nexi_tool_calls_usuario_id_fkey
      FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON TABLE public.nexi_tool_calls IS 'Nexi: auditoría de llamadas a herramientas. Guarda argumentos validados (o solo nombres de claves si la llamada fue rechazada); nunca resultados ni secretos.';
COMMENT ON COLUMN public.nexi_tool_calls.motivo IS 'Código del motivo de DENEGADO/ERROR (ej. SIN_PERMISO, HERRAMIENTA_NO_REGISTRADA, PARAMETROS_INVALIDOS, ERROR_INTERNO).';

-- 4) Índices
CREATE INDEX IF NOT EXISTS idx_nexi_conversaciones_usuario_updated
  ON public.nexi_conversaciones (usuario_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_nexi_mensajes_conversacion_created
  ON public.nexi_mensajes (conversacion_id, created_at);
CREATE INDEX IF NOT EXISTS idx_nexi_tool_calls_usuario_created
  ON public.nexi_tool_calls (usuario_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nexi_tool_calls_conversacion
  ON public.nexi_tool_calls (conversacion_id);

-- 5) updated_at automático — reutiliza la función genérica ya existente
DROP TRIGGER IF EXISTS trigger_nexi_conversaciones_updated_at ON public.nexi_conversaciones;
CREATE TRIGGER trigger_nexi_conversaciones_updated_at
  BEFORE UPDATE ON public.nexi_conversaciones
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 6) RLS: solo el backend (service_role) accede a estas tablas
ALTER TABLE public.nexi_conversaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nexi_mensajes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nexi_tool_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Backend service_role only" ON public.nexi_conversaciones;
CREATE POLICY "Backend service_role only" ON public.nexi_conversaciones
  USING (auth.role() = 'service_role'::text)
  WITH CHECK (auth.role() = 'service_role'::text);

DROP POLICY IF EXISTS "Backend service_role only" ON public.nexi_mensajes;
CREATE POLICY "Backend service_role only" ON public.nexi_mensajes
  USING (auth.role() = 'service_role'::text)
  WITH CHECK (auth.role() = 'service_role'::text);

DROP POLICY IF EXISTS "Backend service_role only" ON public.nexi_tool_calls;
CREATE POLICY "Backend service_role only" ON public.nexi_tool_calls
  USING (auth.role() = 'service_role'::text)
  WITH CHECK (auth.role() = 'service_role'::text);

COMMIT;
