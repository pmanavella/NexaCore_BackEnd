-- Migración: 2026-09-27_crear_indicadores
-- Módulo: Indicadores (KPI)
--
-- Objetivo:
--   Incorpora Indicadores / KPI definidos por el usuario. Cada indicador guarda
--   solo su DEFINICIÓN (fórmula, objetivo, límite, sentido, etc.). Sus valores
--   NO se cargan ni se persisten: el backend los recalcula en cada consulta a
--   partir de public.movimientos (fuente de verdad: módulo Financiero).
--
--   La fórmula se guarda como texto normalizado con identificadores técnicos
--   del catálogo (ej: "(INGRESOS_TOTAL - GASTOS_TOTAL) / INGRESOS_TOTAL * 100").
--   Se valida en el backend con un parser restringido; nunca se ejecuta como
--   código ni se traduce a SQL.
--
-- Esta migración:
--   1) Crea public.indicadores con CHECK para perspectiva, frecuencia, unidad,
--      sentido, longitudes y coherencia objetivo/límite según el sentido.
--   2) Índices por activo y perspectiva.
--   3) Trigger updated_at reutilizando public.update_updated_at().
--   4) RLS "Backend service_role only", mismo patrón que el resto de tablas.
--   5) Crea public.indicadores_totales_movimientos(p_desde, p_hasta): función
--      SQL de SOLO LECTURA que agrega public.movimientos por (mes, tipo,
--      categoria). Evita el límite de 1000 filas de PostgREST al traer
--      movimientos crudos. Sin SQL dinámico: los únicos parámetros son dos
--      fechas. Solo la ejecuta service_role (backend).
--   6) Registra el módulo 'indicadores' en public.modulos.
--   7) Da acceso inicial por rol a 'Superadmin' y 'Dirección' (puede_ver +
--      puede_editar). El backend trata a Superadmin (acceso por rol) como
--      administrador del módulo; Dirección queda como editor. Ningún otro rol
--      recibe acceso. Los permisos particulares de usuario
--      (usuario_modulo_permisos) siguen teniendo prioridad sobre los de rol.
--
-- No modifica public.movimientos ni ninguna tabla existente (solo inserta la
-- fila del módulo y sus permisos de rol). No borra datos.
-- Idempotente: puede correrse más de una vez sin error (DEV y PROD).

BEGIN;

-- 1) Tabla principal
CREATE TABLE IF NOT EXISTS public.indicadores (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  nombre           text NOT NULL,
  descripcion      text,
  perspectiva      text NOT NULL,
  responsable      text NOT NULL,
  frecuencia       text NOT NULL,
  formula          text NOT NULL,
  unidad           text NOT NULL,
  sentido          text NOT NULL,
  valor_objetivo   numeric NOT NULL,
  limite_aceptable numeric NOT NULL,
  activo           boolean NOT NULL DEFAULT true,
  created_at       timestamp with time zone DEFAULT now(),
  updated_at       timestamp with time zone DEFAULT now(),
  created_by       text,
  updated_by       text,
  CONSTRAINT indicadores_nombre_check
    CHECK (char_length(btrim(nombre)) BETWEEN 2 AND 150),
  CONSTRAINT indicadores_responsable_check
    CHECK (char_length(btrim(responsable)) BETWEEN 2 AND 150),
  CONSTRAINT indicadores_descripcion_check
    CHECK (descripcion IS NULL OR char_length(descripcion) <= 1000),
  CONSTRAINT indicadores_formula_check
    CHECK (char_length(btrim(formula)) BETWEEN 1 AND 500),
  CONSTRAINT indicadores_perspectiva_check
    CHECK (perspectiva IN ('CLIENTE', 'PROCESOS_INTERNOS', 'APRENDIZAJE_CRECIMIENTO', 'FINANZAS')),
  CONSTRAINT indicadores_frecuencia_check
    CHECK (frecuencia IN ('MENSUAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL')),
  CONSTRAINT indicadores_unidad_check
    CHECK (unidad IN ('PORCENTAJE', 'MONEDA', 'NUMERO', 'HORAS', 'DIAS', 'CANTIDAD')),
  CONSTRAINT indicadores_sentido_check
    CHECK (sentido IN ('MAYOR_ES_MEJOR', 'MENOR_ES_MEJOR')),
  -- MAYOR_ES_MEJOR: límite <= objetivo. MENOR_ES_MEJOR: límite >= objetivo.
  CONSTRAINT indicadores_limite_check
    CHECK (
      (sentido = 'MAYOR_ES_MEJOR' AND limite_aceptable <= valor_objetivo)
      OR (sentido = 'MENOR_ES_MEJOR' AND limite_aceptable >= valor_objetivo)
    )
);

COMMENT ON TABLE public.indicadores IS 'Definiciones de Indicadores (KPI). Los valores se calculan en el backend desde public.movimientos; no se persisten.';
COMMENT ON COLUMN public.indicadores.formula IS 'Fórmula normalizada con identificadores del catálogo de variables (GET /api/indicadores/variables). Validada por el parser restringido del backend.';
COMMENT ON COLUMN public.indicadores.responsable IS 'Texto libre: persona, rol, área o dirección responsable.';
COMMENT ON COLUMN public.indicadores.limite_aceptable IS 'Umbral entre EN_RIESGO y CRITICO, en la misma unidad que valor_objetivo.';
COMMENT ON COLUMN public.indicadores.activo IS 'Borrado lógico: false = indicador desactivado (DELETE /api/indicadores/:id).';

-- 2) Índices
CREATE INDEX IF NOT EXISTS idx_indicadores_activo ON public.indicadores (activo);
CREATE INDEX IF NOT EXISTS idx_indicadores_perspectiva ON public.indicadores (perspectiva);

-- 3) updated_at automático — reutiliza la función genérica ya existente
DROP TRIGGER IF EXISTS trigger_indicadores_updated_at ON public.indicadores;
CREATE TRIGGER trigger_indicadores_updated_at
  BEFORE UPDATE ON public.indicadores
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 4) RLS: solo el backend (service_role) accede a esta tabla
ALTER TABLE public.indicadores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Backend service_role only" ON public.indicadores;
CREATE POLICY "Backend service_role only" ON public.indicadores
  USING (auth.role() = 'service_role'::text)
  WITH CHECK (auth.role() = 'service_role'::text);

-- 5) Agregación de movimientos (solo lectura)
--    Devuelve una fila por (mes, tipo, categoria) con la suma de montos de
--    public.movimientos en el rango [p_desde, p_hasta). `mes` es el primer día
--    del mes. STABLE + LANGUAGE sql: no modifica datos. search_path vacío y
--    nombres calificados para evitar resolución de objetos ajenos.
CREATE OR REPLACE FUNCTION public.indicadores_totales_movimientos(p_desde date, p_hasta date)
RETURNS TABLE (mes date, tipo text, categoria text, total numeric)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT
    date_trunc('month', m.fecha)::date AS mes,
    m.tipo,
    m.categoria,
    SUM(m.monto) AS total
  FROM public.movimientos m
  WHERE m.fecha >= p_desde
    AND m.fecha < p_hasta
  GROUP BY 1, 2, 3
  ORDER BY 1, 2, 3;
$$;

COMMENT ON FUNCTION public.indicadores_totales_movimientos(date, date) IS 'Indicadores (KPI): totales de public.movimientos por mes/tipo/categoria en [p_desde, p_hasta). Solo lectura; uso exclusivo del backend.';

REVOKE ALL ON FUNCTION public.indicadores_totales_movimientos(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.indicadores_totales_movimientos(date, date) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.indicadores_totales_movimientos(date, date) TO service_role;

-- 6) Registro del módulo (INSERT seguro: no duplica ni modifica si ya existe)
INSERT INTO public.modulos (nombre, label, descripcion)
VALUES ('indicadores', 'Indicadores', 'Indicadores de gestión (KPI) calculados desde los movimientos financieros')
ON CONFLICT (nombre) DO NOTHING;

-- 7) Acceso inicial por rol: solo Superadmin y Dirección.
--    ON CONFLICT DO NOTHING: si alguien ya ajustó estos permisos, se respetan.
INSERT INTO public.rol_modulo_permisos (rol_id, modulo_id, puede_ver, puede_editar)
SELECT r.id, m.id, true, true
FROM public.roles r
CROSS JOIN public.modulos m
WHERE r.nombre IN ('Superadmin', 'Dirección')
  AND m.nombre = 'indicadores'
ON CONFLICT (rol_id, modulo_id) DO NOTHING;

DO $$
DECLARE
  roles_con_acceso integer;
BEGIN
  SELECT count(*) INTO roles_con_acceso
  FROM public.rol_modulo_permisos rmp
  JOIN public.roles r   ON r.id = rmp.rol_id
  JOIN public.modulos m ON m.id = rmp.modulo_id
  WHERE m.nombre = 'indicadores' AND r.nombre IN ('Superadmin', 'Dirección');

  IF roles_con_acceso < 2 THEN
    RAISE NOTICE 'Indicadores: se esperaban permisos para Superadmin y Dirección, se encontraron %. Verificar nombres en public.roles.', roles_con_acceso;
  END IF;
END $$;

COMMIT;
