


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

















CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."nivel_organigrama" AS ENUM (
    'Directivo',
    'Mandos Medios',
    'Operarios / Staff',
    'Externo'
);


ALTER TYPE "public"."nivel_organigrama" OWNER TO "postgres";


CREATE TYPE "public"."tipo_alcance" AS ENUM (
    'propio',
    'equipo_directo',
    'subarbol',
    'global'
);


ALTER TYPE "public"."tipo_alcance" OWNER TO "postgres";


CREATE TYPE "public"."tipo_permiso" AS ENUM (
    'sin_acceso',
    'lector',
    'editor',
    'administrador'
);


ALTER TYPE "public"."tipo_permiso" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."indicadores_totales_movimientos"("p_desde" "date", "p_hasta" "date") RETURNS TABLE("mes" "date", "tipo" "text", "categoria" "text", "total" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."indicadores_totales_movimientos"("p_desde" "date", "p_hasta" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."indicadores_totales_movimientos"("p_desde" "date", "p_hasta" "date") IS 'Indicadores (KPI): totales de public.movimientos por mes/tipo/categoria en [p_desde, p_hasta). Solo lectura; uso exclusivo del backend.';



CREATE OR REPLACE FUNCTION "public"."protocolo_crear_con_items"("p_nombre" "text", "p_descripcion" "text", "p_categoria" "text", "p_acceso" "text", "p_usuario" "text", "p_items" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.protocolos (nombre, descripcion, categoria, acceso, activo, created_by, updated_by)
  VALUES (p_nombre, p_descripcion, p_categoria, p_acceso, true, p_usuario, p_usuario)
  RETURNING id INTO v_id;

  INSERT INTO public.protocolo_items (protocolo_id, texto, orden, activo)
  SELECT v_id, x.texto, x.orden, coalesce(x.activo, true)
  FROM jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) AS x(texto text, orden integer, activo boolean);

  RETURN v_id;
END;
$$;


ALTER FUNCTION "public"."protocolo_crear_con_items"("p_nombre" "text", "p_descripcion" "text", "p_categoria" "text", "p_acceso" "text", "p_usuario" "text", "p_items" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tarea_sincronizar_asignados"("p_tarea_id" "uuid", "p_usuario_ids" "uuid"[]) RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_ids uuid[] := coalesce(p_usuario_ids, ARRAY[]::uuid[]);
BEGIN
  IF (SELECT count(*) FROM unnest(v_ids)) <> (SELECT count(DISTINCT x) FROM unnest(v_ids) AS x) THEN
    RAISE EXCEPTION 'La misma persona no puede asignarse dos veces a una tarea.'
      USING ERRCODE = 'unique_violation';
  END IF;

  DELETE FROM public.tarea_asignados
  WHERE tarea_id = p_tarea_id
    AND NOT (usuario_id = ANY (v_ids));

  INSERT INTO public.tarea_asignados (tarea_id, usuario_id, orden)
  SELECT p_tarea_id, x.usuario_id, x.orden
  FROM unnest(v_ids) WITH ORDINALITY AS x(usuario_id, orden)
  ON CONFLICT (tarea_id, usuario_id) DO UPDATE SET orden = EXCLUDED.orden;

  UPDATE public.tareas t
  SET asignado_a = (
    SELECT string_agg(u.nombre, ', ' ORDER BY ta.orden)
    FROM public.tarea_asignados ta
    JOIN public.usuarios u ON u.id = ta.usuario_id
    WHERE ta.tarea_id = p_tarea_id
  )
  WHERE t.id = p_tarea_id;
END;
$$;


ALTER FUNCTION "public"."tarea_sincronizar_asignados"("p_tarea_id" "uuid", "p_usuario_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."categorias_salariales" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "nombre" "text" NOT NULL,
    "descripcion" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."categorias_salariales" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."comprobante_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "comprobante_id" "uuid" NOT NULL,
    "orden" integer NOT NULL,
    "codigo" "text",
    "descripcion" "text" NOT NULL,
    "cantidad" numeric(15,4),
    "precio_unitario" numeric(15,2),
    "bonificacion" numeric(15,2),
    "alicuota_iva" numeric(6,2),
    "importe" numeric(15,2) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."comprobante_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."comprobantes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "movimiento_id" "uuid",
    "nombre_archivo" "text" NOT NULL,
    "tipo_archivo" "text" NOT NULL,
    "storage_path" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "estado_analisis" "text" DEFAULT 'requiere_revision'::"text" NOT NULL,
    "extraccion" "jsonb",
    "diagnostico" "jsonb" DEFAULT '{"errors": [], "auto_created": false}'::"jsonb" NOT NULL,
    "document_fingerprint" "text",
    "duplicate_of_id" "uuid",
    CONSTRAINT "comprobantes_estado_analisis_check" CHECK (("estado_analisis" = ANY (ARRAY['procesado'::"text", 'requiere_revision'::"text", 'error'::"text"]))),
    CONSTRAINT "comprobantes_tipo_archivo_check" CHECK (("tipo_archivo" = ANY (ARRAY['image/jpeg'::"text", 'image/jpg'::"text", 'image/png'::"text", 'application/pdf'::"text"])))
);


ALTER TABLE "public"."comprobantes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conciliaciones_migracion" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "migration_batch_id" "uuid",
    "datos_raw" "jsonb" NOT NULL,
    "columnas_detectadas" "jsonb",
    "totales_calculados" "jsonb",
    "filas_count" integer,
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."conciliaciones_migracion" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contactos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "nombre" "text" NOT NULL,
    "empresa" "text",
    "email" "text",
    "telefono" "text",
    "tipo" "text" DEFAULT 'Cliente'::"text",
    "estado" "text" DEFAULT 'Activo'::"text",
    "notas" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "ultimo_contacto" "date",
    "proximo_contacto" "date",
    CONSTRAINT "contactos_estado_check" CHECK (("estado" = ANY (ARRAY['Activo'::"text", 'Inactivo'::"text", 'En negociación'::"text"]))),
    CONSTRAINT "contactos_tipo_check" CHECK (("tipo" = ANY (ARRAY['Cliente'::"text", 'Prospecto'::"text", 'Proveedor'::"text", 'Socio'::"text"])))
);


ALTER TABLE "public"."contactos" OWNER TO "postgres";


COMMENT ON COLUMN "public"."contactos"."ultimo_contacto" IS 'Fecha del último contacto realizado con este registro (día, sin hora). NULL si no se ha registrado ninguno.';



COMMENT ON COLUMN "public"."contactos"."proximo_contacto" IS 'Fecha del próximo contacto planificado (día, sin hora). NULL si no hay seguimiento programado. Usada como criterio de ordenamiento en la vista de contactos.';



CREATE TABLE IF NOT EXISTS "public"."cotizaciones_dolar" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "fecha" "date" NOT NULL,
    "fuente" "text" NOT NULL,
    "tipo" "text",
    "valor_compra" numeric(12,4),
    "valor_venta" numeric(12,4),
    "valor_referencia" numeric(12,4) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."cotizaciones_dolar" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cuentas_por_cobrar" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "migration_batch_id" "uuid",
    "nombre_cliente" "text" NOT NULL,
    "cantidad" numeric,
    "concepto" "text",
    "monto_total" numeric NOT NULL,
    "estado" "text" DEFAULT 'pendiente'::"text" NOT NULL,
    "origen_migracion" "text" DEFAULT 'excel'::"text",
    "notas" "text",
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "cuentas_por_cobrar_estado_check" CHECK (("estado" = ANY (ARRAY['pendiente'::"text", 'cobrado'::"text", 'anulado'::"text"])))
);


ALTER TABLE "public"."cuentas_por_cobrar" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dashboard_configuraciones" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "usuario_id" "uuid" NOT NULL,
    "widgets" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."dashboard_configuraciones" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dashboard_vistas" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "usuario_id" "uuid" NOT NULL,
    "nombre" "text" NOT NULL,
    "orden" integer DEFAULT 0 NOT NULL,
    "widgets" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."dashboard_vistas" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deudas" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "acreedor" "text" NOT NULL,
    "descripcion" "text",
    "monto" numeric(15,2) NOT NULL,
    "vencimiento" "date" NOT NULL,
    "estado" "text" DEFAULT 'Pendiente'::"text",
    "notas" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "text",
    "updated_by" "text",
    CONSTRAINT "deudas_estado_check" CHECK (("estado" = ANY (ARRAY['Pendiente'::"text", 'Pagada'::"text", 'Vencida'::"text"]))),
    CONSTRAINT "deudas_monto_check" CHECK (("monto" > (0)::numeric))
);


ALTER TABLE "public"."deudas" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."empleados" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "nombre" "text" NOT NULL,
    "apellido" "text" NOT NULL,
    "email" "text",
    "telefono" "text",
    "tipo_permanencia" "text" NOT NULL,
    "modalidad_trabajo" "text" NOT NULL,
    "fecha_ingreso" "date",
    "estado" "text" DEFAULT 'Activo'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "tipo_salario" "text" DEFAULT 'mensual'::"text",
    "monto_base" numeric(12,2) DEFAULT 0,
    "moneda" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "cotizacion_tipo" "text",
    "cotizacion_valor" numeric(12,4),
    "cotizacion_fecha" "date",
    "cotizacion_fuente" "text",
    "updated_by" "text",
    CONSTRAINT "empleados_cotizacion_tipo_check" CHECK (("cotizacion_tipo" = ANY (ARRAY['compra'::"text", 'venta'::"text"]))),
    CONSTRAINT "empleados_estado_check" CHECK (("estado" = ANY (ARRAY['Activo'::"text", 'Inactivo'::"text"]))),
    CONSTRAINT "empleados_modalidad_trabajo_check" CHECK (("modalidad_trabajo" = ANY (ARRAY['Mensual'::"text", 'Por Turno'::"text", 'Por Horas'::"text"]))),
    CONSTRAINT "empleados_moneda_check" CHECK (("moneda" = ANY (ARRAY['ARS'::"text", 'USD'::"text"]))),
    CONSTRAINT "empleados_monto_base_check" CHECK (("monto_base" >= (0)::numeric)),
    CONSTRAINT "empleados_tipo_permanencia_check" CHECK (("tipo_permanencia" = ANY (ARRAY['Planta'::"text", 'Temporal'::"text"]))),
    CONSTRAINT "empleados_tipo_salario_check" CHECK (("tipo_salario" = ANY (ARRAY['mensual'::"text", 'hora'::"text", 'turno'::"text"])))
);


ALTER TABLE "public"."empleados" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."indicadores" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "nombre" "text" NOT NULL,
    "descripcion" "text",
    "perspectiva" "text" NOT NULL,
    "responsable" "text" NOT NULL,
    "frecuencia" "text" NOT NULL,
    "formula" "text" NOT NULL,
    "unidad" "text" NOT NULL,
    "sentido" "text" NOT NULL,
    "valor_objetivo" numeric NOT NULL,
    "limite_aceptable" numeric NOT NULL,
    "activo" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "text",
    "updated_by" "text",
    CONSTRAINT "indicadores_descripcion_check" CHECK ((("descripcion" IS NULL) OR ("char_length"("descripcion") <= 1000))),
    CONSTRAINT "indicadores_formula_check" CHECK ((("char_length"("btrim"("formula")) >= 1) AND ("char_length"("btrim"("formula")) <= 500))),
    CONSTRAINT "indicadores_frecuencia_check" CHECK (("frecuencia" = ANY (ARRAY['MENSUAL'::"text", 'TRIMESTRAL'::"text", 'SEMESTRAL'::"text", 'ANUAL'::"text"]))),
    CONSTRAINT "indicadores_limite_check" CHECK (((("sentido" = 'MAYOR_ES_MEJOR'::"text") AND ("limite_aceptable" <= "valor_objetivo")) OR (("sentido" = 'MENOR_ES_MEJOR'::"text") AND ("limite_aceptable" >= "valor_objetivo")))),
    CONSTRAINT "indicadores_nombre_check" CHECK ((("char_length"("btrim"("nombre")) >= 2) AND ("char_length"("btrim"("nombre")) <= 150))),
    CONSTRAINT "indicadores_perspectiva_check" CHECK (("perspectiva" = ANY (ARRAY['CLIENTE'::"text", 'PROCESOS_INTERNOS'::"text", 'APRENDIZAJE_CRECIMIENTO'::"text", 'FINANZAS'::"text"]))),
    CONSTRAINT "indicadores_responsable_check" CHECK ((("char_length"("btrim"("responsable")) >= 2) AND ("char_length"("btrim"("responsable")) <= 150))),
    CONSTRAINT "indicadores_sentido_check" CHECK (("sentido" = ANY (ARRAY['MAYOR_ES_MEJOR'::"text", 'MENOR_ES_MEJOR'::"text"]))),
    CONSTRAINT "indicadores_unidad_check" CHECK (("unidad" = ANY (ARRAY['PORCENTAJE'::"text", 'MONEDA'::"text", 'NUMERO'::"text", 'HORAS'::"text", 'DIAS'::"text", 'CANTIDAD'::"text"])))
);


ALTER TABLE "public"."indicadores" OWNER TO "postgres";


COMMENT ON TABLE "public"."indicadores" IS 'Definiciones de Indicadores (KPI). Los valores se calculan en el backend desde public.movimientos; no se persisten.';



COMMENT ON COLUMN "public"."indicadores"."responsable" IS 'Texto libre: persona, rol, área o dirección responsable.';



COMMENT ON COLUMN "public"."indicadores"."formula" IS 'Fórmula normalizada con identificadores del catálogo de variables (GET /api/indicadores/variables). Validada por el parser restringido del backend.';



COMMENT ON COLUMN "public"."indicadores"."limite_aceptable" IS 'Umbral entre EN_RIESGO y CRITICO, en la misma unidad que valor_objetivo.';



COMMENT ON COLUMN "public"."indicadores"."activo" IS 'Borrado lógico: false = indicador desactivado (DELETE /api/indicadores/:id).';



CREATE TABLE IF NOT EXISTS "public"."integracion_movimientos_financieros" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "movimiento_financiero_id" "uuid",
    "movimiento_salario_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."integracion_movimientos_financieros" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inversiones_historicas" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "migration_batch_id" "uuid",
    "nombre" "text",
    "cantidad" numeric,
    "categoria" "text",
    "monto_usd" numeric,
    "monto_pesos" numeric,
    "cotizacion_utilizada" numeric,
    "fecha_compra" "date",
    "notas" "text",
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."inversiones_historicas" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."migration_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tipo_migracion" "text" NOT NULL,
    "nombre_archivo" "text",
    "usuario_id" "uuid",
    "fecha_importacion" timestamp with time zone DEFAULT "now"() NOT NULL,
    "registros_detectados" integer DEFAULT 0 NOT NULL,
    "registros_creados" integer DEFAULT 0 NOT NULL,
    "registros_rechazados" integer DEFAULT 0 NOT NULL,
    "estado" "text" DEFAULT 'procesando'::"text" NOT NULL,
    "errores" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "migration_batches_estado_check" CHECK (("estado" = ANY (ARRAY['procesando'::"text", 'completado'::"text", 'fallido'::"text", 'revertido'::"text"])))
);


ALTER TABLE "public"."migration_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."modulos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "nombre" "text" NOT NULL,
    "label" "text" NOT NULL,
    "descripcion" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."modulos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."movimientos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "fecha" "date" NOT NULL,
    "descripcion" "text" NOT NULL,
    "categoria" "text" NOT NULL,
    "tipo" "text" NOT NULL,
    "monto" numeric(15,2) NOT NULL,
    "proveedor_cliente" "text",
    "notas" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "cuenta_contrapartida" "text",
    "created_by" "text",
    "updated_by" "text",
    "suscripcion_id" "uuid",
    "migration_batch_id" "uuid",
    CONSTRAINT "movimientos_categoria_check" CHECK (("categoria" = ANY (ARRAY['Tecnología'::"text", 'RRHH'::"text", 'Insumos'::"text", 'Servicios'::"text", 'Inversión'::"text", 'Otros'::"text", 'Suscripción'::"text"]))),
    CONSTRAINT "movimientos_monto_check" CHECK (("monto" > (0)::numeric)),
    CONSTRAINT "movimientos_tipo_check" CHECK (("tipo" = ANY (ARRAY['Ingreso'::"text", 'Gasto'::"text"])))
);


ALTER TABLE "public"."movimientos" OWNER TO "postgres";


COMMENT ON COLUMN "public"."movimientos"."cuenta_contrapartida" IS 'Cuenta contable de contrapartida (fuente/modalidad de pago o cobro). NULL = usar "Caja / Banco" como fallback en el Libro Diario.';



CREATE TABLE IF NOT EXISTS "public"."movimientos_salario" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "empleado_id" "uuid" NOT NULL,
    "categoria_id" "uuid" NOT NULL,
    "monto" numeric(12,2) NOT NULL,
    "fecha" "date" NOT NULL,
    "descripcion" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "cuenta_contrapartida" "text",
    "moneda_origen" "text" DEFAULT 'ARS'::"text",
    "monto_origen" numeric(12,2),
    "cotizacion_usada" numeric(12,4),
    "monto_ars" numeric(12,2),
    "created_by" "text",
    "updated_by" "text"
);


ALTER TABLE "public"."movimientos_salario" OWNER TO "postgres";


COMMENT ON COLUMN "public"."movimientos_salario"."cuenta_contrapartida" IS 'Cuenta contable de contrapartida para el asiento de salario. NULL = usar "Caja / Banco" como fallback en el Libro Diario.';



CREATE TABLE IF NOT EXISTS "public"."nexi_conversaciones" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "usuario_id" "uuid" NOT NULL,
    "titulo" "text" DEFAULT 'Nueva conversación'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "nexi_conversaciones_titulo_check" CHECK ((("char_length"("btrim"("titulo")) >= 1) AND ("char_length"("btrim"("titulo")) <= 120)))
);


ALTER TABLE "public"."nexi_conversaciones" OWNER TO "postgres";


COMMENT ON TABLE "public"."nexi_conversaciones" IS 'Nexi: conversaciones. Cada fila pertenece a un único usuario; el backend filtra siempre por usuario_id.';



CREATE TABLE IF NOT EXISTS "public"."nexi_mensajes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversacion_id" "uuid" NOT NULL,
    "rol" "text" NOT NULL,
    "contenido" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "nexi_mensajes_contenido_check" CHECK ((("char_length"("contenido") >= 1) AND ("char_length"("contenido") <= 20000))),
    CONSTRAINT "nexi_mensajes_rol_check" CHECK (("rol" = ANY (ARRAY['usuario'::"text", 'asistente'::"text"])))
);


ALTER TABLE "public"."nexi_mensajes" OWNER TO "postgres";


COMMENT ON TABLE "public"."nexi_mensajes" IS 'Nexi: mensajes de usuario y asistente. Los resultados de herramientas no se guardan.';



CREATE TABLE IF NOT EXISTS "public"."nexi_reportes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "usuario_id" "uuid",
    "conversacion_id" "uuid",
    "tipo" "text" NOT NULL,
    "titulo" "text" NOT NULL,
    "secciones" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "secciones_excluidas" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "periodo_desde" "date" NOT NULL,
    "periodo_hasta" "date" NOT NULL,
    "periodo_etiqueta" "text" NOT NULL,
    "comparacion_desde" "date",
    "comparacion_hasta" "date",
    "formato" "text" DEFAULT 'pdf'::"text" NOT NULL,
    "estado" "text" NOT NULL,
    "motivo" "text",
    "archivo_path" "text",
    "archivo_bytes" integer,
    "duracion_ms" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finalizado_at" timestamp with time zone,
    CONSTRAINT "nexi_reportes_archivo_check" CHECK ((("estado" <> 'GENERADO'::"text") OR ("archivo_path" IS NOT NULL))),
    CONSTRAINT "nexi_reportes_duracion_check" CHECK (("duracion_ms" >= 0)),
    CONSTRAINT "nexi_reportes_estado_check" CHECK (("estado" = ANY (ARRAY['EN_PROCESO'::"text", 'GENERADO'::"text", 'DENEGADO'::"text", 'ERROR'::"text"]))),
    CONSTRAINT "nexi_reportes_formato_check" CHECK (("formato" = 'pdf'::"text")),
    CONSTRAINT "nexi_reportes_periodo_check" CHECK (("periodo_hasta" > "periodo_desde")),
    CONSTRAINT "nexi_reportes_secciones_check" CHECK (("secciones" <@ ARRAY['finanzas'::"text", 'indicadores'::"text", 'operativo'::"text", 'crm'::"text", 'protocolos'::"text", 'dashboard'::"text", 'organizacion'::"text"])),
    CONSTRAINT "nexi_reportes_tipo_check" CHECK (("tipo" = ANY (ARRAY['financiero'::"text", 'operativo'::"text", 'crm'::"text", 'indicadores'::"text", 'protocolos'::"text", 'dashboard'::"text", 'organizacion'::"text", 'ejecutivo'::"text", 'personalizado'::"text"]))),
    CONSTRAINT "nexi_reportes_titulo_check" CHECK ((("char_length"("titulo") >= 1) AND ("char_length"("titulo") <= 300)))
);


ALTER TABLE "public"."nexi_reportes" OWNER TO "postgres";


COMMENT ON TABLE "public"."nexi_reportes" IS 'Nexi: reportes generados bajo demanda (auditoría y ubicación del archivo en Storage). Nunca guarda el contenido del reporte.';



COMMENT ON COLUMN "public"."nexi_reportes"."periodo_hasta" IS 'Fin del período, EXCLUSIVO ([periodo_desde, periodo_hasta)).';



COMMENT ON COLUMN "public"."nexi_reportes"."motivo" IS 'Código del motivo de DENEGADO/ERROR (ej. SIN_SECCIONES_PERMITIDAS, TIMEOUT_GLOBAL, ERROR_INTERNO).';



COMMENT ON COLUMN "public"."nexi_reportes"."archivo_path" IS 'Ruta en el bucket privado nexi-reportes (<usuario_id>/<id>.pdf).';



CREATE TABLE IF NOT EXISTS "public"."nexi_tool_calls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversacion_id" "uuid",
    "usuario_id" "uuid",
    "herramienta" "text" NOT NULL,
    "argumentos" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "resultado_estado" "text" NOT NULL,
    "motivo" "text",
    "duracion_ms" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "nexi_tool_calls_duracion_check" CHECK (("duracion_ms" >= 0)),
    CONSTRAINT "nexi_tool_calls_herramienta_check" CHECK ((("char_length"("herramienta") >= 1) AND ("char_length"("herramienta") <= 100))),
    CONSTRAINT "nexi_tool_calls_resultado_estado_check" CHECK (("resultado_estado" = ANY (ARRAY['OK'::"text", 'DENEGADO'::"text", 'ERROR'::"text"])))
);


ALTER TABLE "public"."nexi_tool_calls" OWNER TO "postgres";


COMMENT ON TABLE "public"."nexi_tool_calls" IS 'Nexi: auditoría de llamadas a herramientas. Guarda argumentos validados (o solo nombres de claves si la llamada fue rechazada); nunca resultados ni secretos.';



COMMENT ON COLUMN "public"."nexi_tool_calls"."motivo" IS 'Código del motivo de DENEGADO/ERROR (ej. SIN_PERMISO, HERRAMIENTA_NO_REGISTRADA, PARAMETROS_INVALIDOS, ERROR_INTERNO).';



CREATE TABLE IF NOT EXISTS "public"."operativo_etapas" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "nombre" "text" NOT NULL,
    "color" "text" NOT NULL,
    "posicion" integer NOT NULL,
    "tipo_base" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "operativo_etapas_color_check" CHECK (("color" ~ '^#[0-9A-Fa-f]{6}$'::"text")),
    CONSTRAINT "operativo_etapas_nombre_check" CHECK ((("char_length"("btrim"("nombre")) >= 1) AND ("char_length"("btrim"("nombre")) <= 100))),
    CONSTRAINT "operativo_etapas_posicion_check" CHECK (("posicion" >= 0)),
    CONSTRAINT "operativo_etapas_tipo_base_check" CHECK (("tipo_base" = ANY (ARRAY['pendiente'::"text", 'en_curso'::"text", 'en_revision_abierta'::"text", 'completada'::"text", 'cancelada'::"text", 'en_revision_cerrada'::"text"])))
);


ALTER TABLE "public"."operativo_etapas" OWNER TO "postgres";


COMMENT ON TABLE "public"."operativo_etapas" IS 'Etapas personalizables del tablero Operativo. Flujo único global para todas las tareas.';



COMMENT ON COLUMN "public"."operativo_etapas"."color" IS 'Color de la etapa en formato hexadecimal (#RRGGBB), elegido por el usuario.';



COMMENT ON COLUMN "public"."operativo_etapas"."posicion" IS 'Orden de la etapa en el tablero (0 = primera). El backend la mantiene contigua (0..n-1) en cada alta/baja/reordenamiento.';



COMMENT ON COLUMN "public"."operativo_etapas"."tipo_base" IS 'Clasificación interna fija usada para calcular totales y "vencida". Abiertas: pendiente, en_curso, en_revision_abierta. Cerradas: completada, cancelada, en_revision_cerrada. Catálogo en operations/config/etapas.js.';



CREATE TABLE IF NOT EXISTS "public"."operativo_tablero_miembros" (
    "tablero_id" "uuid" NOT NULL,
    "usuario_id" "uuid" NOT NULL
);


ALTER TABLE "public"."operativo_tablero_miembros" OWNER TO "postgres";


COMMENT ON TABLE "public"."operativo_tablero_miembros" IS 'Miembros de cada tablero del Operativo. Un usuario ve los tableros donde es miembro (Dirección y Superadmin ven todos, regla del backend). Quitar a un miembro no modifica sus tareas.';



CREATE TABLE IF NOT EXISTS "public"."operativo_tableros" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "nombre" "text" NOT NULL,
    "descripcion" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "operativo_tableros_nombre_check" CHECK ((("char_length"("btrim"("nombre")) >= 1) AND ("char_length"("btrim"("nombre")) <= 100)))
);


ALTER TABLE "public"."operativo_tableros" OWNER TO "postgres";


COMMENT ON TABLE "public"."operativo_tableros" IS 'Tableros de tareas del módulo Operativo. Cada uno tiene sus miembros (operativo_tablero_miembros) y sus tareas (tareas.tablero_id). Todos comparten las etapas de operativo_etapas.';



COMMENT ON COLUMN "public"."operativo_tableros"."created_by" IS 'Usuario que creó el tablero (NULL si fue creado por la migración o el usuario ya no existe).';



CREATE TABLE IF NOT EXISTS "public"."organigrama" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "usuario_id" "uuid",
    "superior_id" "uuid",
    "nivel" "public"."nivel_organigrama" DEFAULT 'Operarios / Staff'::"public"."nivel_organigrama" NOT NULL,
    "area" "text",
    "cargo" "text",
    "es_externo" boolean DEFAULT false,
    "fecha_inicio" "date",
    "fecha_fin" "date",
    "activo" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "empleado_id" "uuid",
    "nombre_manual" "text",
    "apellido_manual" "text",
    "email_manual" "text",
    "telefono_manual" "text",
    CONSTRAINT "organigrama_persona_check" CHECK ((("usuario_id" IS NOT NULL) OR ("empleado_id" IS NOT NULL) OR (("nombre_manual" IS NOT NULL) AND ("btrim"("nombre_manual") <> ''::"text"))))
);


ALTER TABLE "public"."organigrama" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."protocolo_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "protocolo_id" "uuid" NOT NULL,
    "texto" "text" NOT NULL,
    "orden" integer NOT NULL,
    "activo" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."protocolo_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."protocolo_pruebas" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "protocolo_id" "uuid" NOT NULL,
    "realizado_por" "text",
    "fecha" "date" DEFAULT CURRENT_DATE NOT NULL,
    "resultados" "jsonb" NOT NULL,
    "observaciones" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "text",
    "resultado_texto" "text",
    "action_items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    CONSTRAINT "protocolo_pruebas_action_items_array" CHECK (("jsonb_typeof"("action_items") = 'array'::"text")),
    CONSTRAINT "protocolo_pruebas_observaciones_len" CHECK (("char_length"(COALESCE("observaciones", ''::"text")) <= 800)),
    CONSTRAINT "protocolo_pruebas_resultado_texto_len" CHECK (("char_length"(COALESCE("resultado_texto", ''::"text")) <= 800))
);


ALTER TABLE "public"."protocolo_pruebas" OWNER TO "postgres";


COMMENT ON COLUMN "public"."protocolo_pruebas"."action_items" IS 'Action items propios del registro: array de objetos { "texto": text }. Independiente del checklist del protocolo (resultados) y de los comentarios (observaciones).';



CREATE TABLE IF NOT EXISTS "public"."protocolos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "nombre" "text" NOT NULL,
    "descripcion" "text",
    "categoria" "text" NOT NULL,
    "acceso" "text",
    "activo" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "text",
    "updated_by" "text",
    CONSTRAINT "protocolos_categoria_check" CHECK (("categoria" = ANY (ARRAY['robot'::"text", 'instalacion'::"text", 'hardware'::"text", 'rrhh'::"text"])))
);


ALTER TABLE "public"."protocolos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."proyectos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "nombre" "text" NOT NULL,
    "descripcion" "text",
    "estado" "text" DEFAULT 'Planificado'::"text",
    "fecha_inicio" "date",
    "fecha_fin" "date",
    "responsable" "text",
    "presupuesto" numeric(15,2),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "proyectos_estado_check" CHECK (("estado" = ANY (ARRAY['Planificado'::"text", 'En Curso'::"text", 'Completado'::"text", 'Pausado'::"text", 'Cancelado'::"text"])))
);


ALTER TABLE "public"."proyectos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rol_modulo_permisos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "rol_id" "uuid" NOT NULL,
    "modulo_id" "uuid" NOT NULL,
    "puede_ver" boolean DEFAULT false,
    "puede_editar" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."rol_modulo_permisos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."roles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "nombre" "text" NOT NULL,
    "descripcion" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "nivel_jerarquico" "text" NOT NULL,
    "activo" boolean DEFAULT true NOT NULL,
    CONSTRAINT "roles_nivel_jerarquico_check" CHECK (("nivel_jerarquico" = ANY (ARRAY['HIGH'::"text", 'MEDIUM'::"text", 'LOW'::"text", 'NONE'::"text"])))
);


ALTER TABLE "public"."roles" OWNER TO "postgres";


COMMENT ON COLUMN "public"."roles"."nivel_jerarquico" IS 'Nivel jerárquico interno derivado del rol: HIGH (mando alto), MEDIUM (mando medio), LOW (mando bajo), NONE (sin mando / externos). Fuente de verdad que usa el backend (rbac/config/jerarquia.js). No editable por usuarios finales.';



COMMENT ON COLUMN "public"."roles"."activo" IS 'true = rol vigente y asignable. false = rol legacy: se conserva para los usuarios que aún lo tienen, pero el backend no permite asignarlo.';



CREATE TABLE IF NOT EXISTS "public"."salarios" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "empleado_id" "uuid" NOT NULL,
    "monto" numeric(12,2) NOT NULL,
    "fecha_inicio" "date" NOT NULL,
    "fecha_fin" "date",
    "activo" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "salarios_monto_check" CHECK (("monto" > (0)::numeric))
);


ALTER TABLE "public"."salarios" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sueldos_historicos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "migration_batch_id" "uuid",
    "mes_anio" "date",
    "fijo_usd" numeric,
    "fijo_pesos" numeric,
    "pasantes" numeric,
    "polo_pasan" numeric,
    "por_hora" numeric,
    "total_pesos" numeric,
    "total_usd" numeric,
    "metadata" "jsonb",
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sueldos_historicos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."suscripciones" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "nombre" "text" NOT NULL,
    "detalle" "text",
    "proveedor" "text",
    "monto" numeric(12,2) NOT NULL,
    "moneda" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "dia_vencimiento" integer NOT NULL,
    "frecuencia" "text" DEFAULT 'mensual'::"text" NOT NULL,
    "estado" "text" DEFAULT 'activa'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "text",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "suscripciones_dia_vencimiento_check" CHECK ((("dia_vencimiento" >= 1) AND ("dia_vencimiento" <= 31))),
    CONSTRAINT "suscripciones_estado_check" CHECK (("estado" = ANY (ARRAY['activa'::"text", 'pausada'::"text", 'cancelada'::"text"]))),
    CONSTRAINT "suscripciones_frecuencia_check" CHECK (("frecuencia" = ANY (ARRAY['mensual'::"text", 'trimestral'::"text", 'semestral'::"text", 'anual'::"text"]))),
    CONSTRAINT "suscripciones_moneda_check" CHECK (("moneda" = ANY (ARRAY['ARS'::"text", 'USD'::"text"]))),
    CONSTRAINT "suscripciones_monto_check" CHECK (("monto" >= (0)::numeric))
);


ALTER TABLE "public"."suscripciones" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tarea_asignados" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tarea_id" "uuid" NOT NULL,
    "usuario_id" "uuid" NOT NULL,
    "orden" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "tarea_asignados_orden_check" CHECK (("orden" >= 1))
);


ALTER TABLE "public"."tarea_asignados" OWNER TO "postgres";


COMMENT ON TABLE "public"."tarea_asignados" IS 'Personas (usuarios) asignadas a cada tarea del módulo Operativo. Una persona no puede repetirse en la misma tarea.';



COMMENT ON COLUMN "public"."tarea_asignados"."orden" IS 'Orden en que se enviaron los asignados (1 = primero). Se usa para devolverlos y para componer tareas.asignado_a.';



CREATE TABLE IF NOT EXISTS "public"."tarea_historial" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tarea_id" "uuid" NOT NULL,
    "usuario_id" "text",
    "usuario_nombre" "text" NOT NULL,
    "accion" "text" NOT NULL,
    "campo_modificado" "text",
    "valor_anterior" "text",
    "valor_nuevo" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."tarea_historial" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tareas" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "titulo" "text" NOT NULL,
    "descripcion" "text",
    "estado" "text" DEFAULT 'Pendiente'::"text",
    "prioridad" "text" DEFAULT 'Media'::"text",
    "asignado_a" "text",
    "fecha_limite" "date",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "tipo" "text" DEFAULT 'asignacion'::"text",
    "estado_propuesta" "text",
    "propuesto_por" "text",
    "etapa_id" "uuid",
    "fecha_inicio_planeada" "date",
    "fecha_inicio_real" "date",
    "fecha_fin_real" "date",
    "tablero_id" "uuid",
    CONSTRAINT "tareas_estado_check" CHECK (("estado" = ANY (ARRAY['Pendiente'::"text", 'En Proceso'::"text", 'Completada'::"text", 'Cancelada'::"text"]))),
    CONSTRAINT "tareas_prioridad_check" CHECK (("prioridad" = ANY (ARRAY['Baja'::"text", 'Media'::"text", 'Alta'::"text", 'Urgente'::"text"])))
);


ALTER TABLE "public"."tareas" OWNER TO "postgres";


COMMENT ON COLUMN "public"."tareas"."asignado_a" IS 'Compatibilidad: nombres de los asignados separados por ", ", mantenido por public.tarea_sincronizar_asignados. Fuente de verdad: public.tarea_asignados. En tareas históricas sin vincular conserva el nombre original.';



COMMENT ON COLUMN "public"."tareas"."fecha_inicio_planeada" IS 'Fecha en la que se planea arrancar la tarea. Carga manual del usuario.';



COMMENT ON COLUMN "public"."tareas"."fecha_inicio_real" IS 'Fecha real de inicio de trabajo. La completa el backend automáticamente la primera vez que la tarea entra a una etapa de tipo_base = en_curso; no se pisa en entradas posteriores.';



COMMENT ON COLUMN "public"."tareas"."fecha_fin_real" IS 'Fecha real de fin de trabajo. La completa el backend automáticamente la primera vez que la tarea entra a una etapa de tipo_base = completada; no se pisa en entradas posteriores.';



COMMENT ON COLUMN "public"."tareas"."tablero_id" IS 'Tablero del Operativo al que pertenece la tarea. Nullable mientras convivan backends anteriores que crean tareas sin tablero.';



CREATE TABLE IF NOT EXISTS "public"."usuario_modulo_permisos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "usuario_id" "uuid" NOT NULL,
    "modulo_id" "uuid" NOT NULL,
    "permiso" "public"."tipo_permiso" DEFAULT 'sin_acceso'::"public"."tipo_permiso",
    "alcance" "public"."tipo_alcance" DEFAULT 'propio'::"public"."tipo_alcance",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."usuario_modulo_permisos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."usuarios" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" "text" NOT NULL,
    "nombre" "text" NOT NULL,
    "rol_id" "uuid",
    "estado" "text" DEFAULT 'Activo'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "auth_user_id" "uuid",
    "updated_by" "text",
    CONSTRAINT "usuarios_estado_check" CHECK (("estado" = ANY (ARRAY['Activo'::"text", 'Inactivo'::"text"])))
);


ALTER TABLE "public"."usuarios" OWNER TO "postgres";


ALTER TABLE ONLY "public"."categorias_salariales"
    ADD CONSTRAINT "categorias_salariales_nombre_key" UNIQUE ("nombre");



ALTER TABLE ONLY "public"."categorias_salariales"
    ADD CONSTRAINT "categorias_salariales_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."comprobante_items"
    ADD CONSTRAINT "comprobante_items_orden_unique" UNIQUE ("comprobante_id", "orden");



ALTER TABLE ONLY "public"."comprobante_items"
    ADD CONSTRAINT "comprobante_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."comprobantes"
    ADD CONSTRAINT "comprobantes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conciliaciones_migracion"
    ADD CONSTRAINT "conciliaciones_migracion_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contactos"
    ADD CONSTRAINT "contactos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cotizaciones_dolar"
    ADD CONSTRAINT "cotizaciones_dolar_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cuentas_por_cobrar"
    ADD CONSTRAINT "cuentas_por_cobrar_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dashboard_configuraciones"
    ADD CONSTRAINT "dashboard_configuraciones_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dashboard_configuraciones"
    ADD CONSTRAINT "dashboard_configuraciones_usuario_id_key" UNIQUE ("usuario_id");



ALTER TABLE ONLY "public"."dashboard_vistas"
    ADD CONSTRAINT "dashboard_vistas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deudas"
    ADD CONSTRAINT "deudas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."empleados"
    ADD CONSTRAINT "empleados_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."indicadores"
    ADD CONSTRAINT "indicadores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."integracion_movimientos_financieros"
    ADD CONSTRAINT "integracion_movimientos_financieros_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inversiones_historicas"
    ADD CONSTRAINT "inversiones_historicas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."migration_batches"
    ADD CONSTRAINT "migration_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."modulos"
    ADD CONSTRAINT "modulos_nombre_key" UNIQUE ("nombre");



ALTER TABLE ONLY "public"."modulos"
    ADD CONSTRAINT "modulos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."movimientos"
    ADD CONSTRAINT "movimientos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."movimientos_salario"
    ADD CONSTRAINT "movimientos_salario_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."nexi_conversaciones"
    ADD CONSTRAINT "nexi_conversaciones_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."nexi_mensajes"
    ADD CONSTRAINT "nexi_mensajes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."nexi_reportes"
    ADD CONSTRAINT "nexi_reportes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."nexi_tool_calls"
    ADD CONSTRAINT "nexi_tool_calls_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."operativo_etapas"
    ADD CONSTRAINT "operativo_etapas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."operativo_tablero_miembros"
    ADD CONSTRAINT "operativo_tablero_miembros_pkey" PRIMARY KEY ("tablero_id", "usuario_id");



ALTER TABLE ONLY "public"."operativo_tableros"
    ADD CONSTRAINT "operativo_tableros_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organigrama"
    ADD CONSTRAINT "organigrama_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."protocolo_items"
    ADD CONSTRAINT "protocolo_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."protocolo_pruebas"
    ADD CONSTRAINT "protocolo_pruebas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."protocolos"
    ADD CONSTRAINT "protocolos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."proyectos"
    ADD CONSTRAINT "proyectos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rol_modulo_permisos"
    ADD CONSTRAINT "rol_modulo_permisos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rol_modulo_permisos"
    ADD CONSTRAINT "rol_modulo_permisos_rol_id_modulo_id_key" UNIQUE ("rol_id", "modulo_id");



ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "roles_nombre_key" UNIQUE ("nombre");



ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."salarios"
    ADD CONSTRAINT "salarios_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sueldos_historicos"
    ADD CONSTRAINT "sueldos_historicos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."suscripciones"
    ADD CONSTRAINT "suscripciones_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tarea_asignados"
    ADD CONSTRAINT "tarea_asignados_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tarea_asignados"
    ADD CONSTRAINT "tarea_asignados_tarea_usuario_key" UNIQUE ("tarea_id", "usuario_id");



ALTER TABLE ONLY "public"."tarea_historial"
    ADD CONSTRAINT "tarea_historial_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tareas"
    ADD CONSTRAINT "tareas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."usuario_modulo_permisos"
    ADD CONSTRAINT "usuario_modulo_permisos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."usuario_modulo_permisos"
    ADD CONSTRAINT "usuario_modulo_permisos_usuario_id_modulo_id_key" UNIQUE ("usuario_id", "modulo_id");



ALTER TABLE ONLY "public"."usuarios"
    ADD CONSTRAINT "usuarios_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."usuarios"
    ADD CONSTRAINT "usuarios_email_unique" UNIQUE ("email");



ALTER TABLE ONLY "public"."usuarios"
    ADD CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id");



CREATE INDEX "comprobante_items_comprobante_idx" ON "public"."comprobante_items" USING "btree" ("comprobante_id");



CREATE UNIQUE INDEX "comprobantes_document_fingerprint_unique" ON "public"."comprobantes" USING "btree" ("document_fingerprint") WHERE ("document_fingerprint" IS NOT NULL);



CREATE INDEX "comprobantes_estado_analisis_idx" ON "public"."comprobantes" USING "btree" ("estado_analisis");



CREATE UNIQUE INDEX "empleados_email_unique_idx" ON "public"."empleados" USING "btree" ("email") WHERE (("email" IS NOT NULL) AND ("btrim"("email") <> ''::"text"));



CREATE INDEX "idx_comprobantes_created_at" ON "public"."comprobantes" USING "btree" ("created_at");



CREATE INDEX "idx_comprobantes_movimiento" ON "public"."comprobantes" USING "btree" ("movimiento_id");



CREATE INDEX "idx_comprobantes_storage_path_activos" ON "public"."comprobantes" USING "btree" ("storage_path") WHERE ("storage_path" IS NOT NULL);



CREATE INDEX "idx_conciliaciones_batch" ON "public"."conciliaciones_migracion" USING "btree" ("migration_batch_id");



CREATE INDEX "idx_contactos_proximo_contacto" ON "public"."contactos" USING "btree" ("proximo_contacto");



CREATE INDEX "idx_contactos_tipo" ON "public"."contactos" USING "btree" ("tipo");



CREATE INDEX "idx_cotizaciones_dolar_fecha" ON "public"."cotizaciones_dolar" USING "btree" ("fecha" DESC);



CREATE INDEX "idx_cuentas_cobrar_batch" ON "public"."cuentas_por_cobrar" USING "btree" ("migration_batch_id");



CREATE INDEX "idx_dashboard_vistas_usuario_orden" ON "public"."dashboard_vistas" USING "btree" ("usuario_id", "orden");



CREATE INDEX "idx_deudas_estado" ON "public"."deudas" USING "btree" ("estado");



CREATE INDEX "idx_deudas_vencimiento" ON "public"."deudas" USING "btree" ("vencimiento");



CREATE INDEX "idx_empleados_estado" ON "public"."empleados" USING "btree" ("estado");



CREATE INDEX "idx_empleados_modalidad" ON "public"."empleados" USING "btree" ("modalidad_trabajo");



CREATE INDEX "idx_empleados_permanencia" ON "public"."empleados" USING "btree" ("tipo_permanencia");



CREATE INDEX "idx_empleados_tipo_salario" ON "public"."empleados" USING "btree" ("tipo_salario");



CREATE INDEX "idx_indicadores_activo" ON "public"."indicadores" USING "btree" ("activo");



CREATE INDEX "idx_indicadores_perspectiva" ON "public"."indicadores" USING "btree" ("perspectiva");



CREATE INDEX "idx_integ_mov_fin_id" ON "public"."integracion_movimientos_financieros" USING "btree" ("movimiento_financiero_id");



CREATE INDEX "idx_integ_mov_sal_id" ON "public"."integracion_movimientos_financieros" USING "btree" ("movimiento_salario_id");



CREATE INDEX "idx_inversiones_batch" ON "public"."inversiones_historicas" USING "btree" ("migration_batch_id");



CREATE INDEX "idx_migration_batches_estado" ON "public"."migration_batches" USING "btree" ("estado");



CREATE INDEX "idx_migration_batches_tipo" ON "public"."migration_batches" USING "btree" ("tipo_migracion");



CREATE INDEX "idx_mov_sal_categoria_id" ON "public"."movimientos_salario" USING "btree" ("categoria_id");



CREATE INDEX "idx_mov_sal_empleado_id" ON "public"."movimientos_salario" USING "btree" ("empleado_id");



CREATE INDEX "idx_mov_sal_fecha" ON "public"."movimientos_salario" USING "btree" ("fecha");



CREATE INDEX "idx_movimientos_batch" ON "public"."movimientos" USING "btree" ("migration_batch_id") WHERE ("migration_batch_id" IS NOT NULL);



CREATE INDEX "idx_movimientos_categoria" ON "public"."movimientos" USING "btree" ("categoria");



CREATE INDEX "idx_movimientos_fecha" ON "public"."movimientos" USING "btree" ("fecha");



CREATE INDEX "idx_movimientos_tipo" ON "public"."movimientos" USING "btree" ("tipo");



CREATE INDEX "idx_nexi_conversaciones_usuario_updated" ON "public"."nexi_conversaciones" USING "btree" ("usuario_id", "updated_at" DESC);



CREATE INDEX "idx_nexi_mensajes_conversacion_created" ON "public"."nexi_mensajes" USING "btree" ("conversacion_id", "created_at");



CREATE INDEX "idx_nexi_reportes_usuario_created" ON "public"."nexi_reportes" USING "btree" ("usuario_id", "created_at" DESC);



CREATE INDEX "idx_nexi_tool_calls_conversacion" ON "public"."nexi_tool_calls" USING "btree" ("conversacion_id");



CREATE INDEX "idx_nexi_tool_calls_usuario_created" ON "public"."nexi_tool_calls" USING "btree" ("usuario_id", "created_at" DESC);



CREATE INDEX "idx_operativo_etapas_posicion" ON "public"."operativo_etapas" USING "btree" ("posicion");



CREATE INDEX "idx_operativo_etapas_tipo_base" ON "public"."operativo_etapas" USING "btree" ("tipo_base");



CREATE INDEX "idx_operativo_tablero_miembros_usuario" ON "public"."operativo_tablero_miembros" USING "btree" ("usuario_id");



CREATE INDEX "idx_organigrama_activo" ON "public"."organigrama" USING "btree" ("activo");



CREATE INDEX "idx_organigrama_empleado_id" ON "public"."organigrama" USING "btree" ("empleado_id");



CREATE INDEX "idx_organigrama_fecha_fin" ON "public"."organigrama" USING "btree" ("fecha_fin") WHERE ("fecha_fin" IS NOT NULL);



CREATE INDEX "idx_organigrama_superior_id" ON "public"."organigrama" USING "btree" ("superior_id");



CREATE INDEX "idx_organigrama_usuario_id" ON "public"."organigrama" USING "btree" ("usuario_id");



CREATE INDEX "idx_protocolo_items_protocolo_id" ON "public"."protocolo_items" USING "btree" ("protocolo_id");



CREATE INDEX "idx_protocolo_pruebas_protocolo_id" ON "public"."protocolo_pruebas" USING "btree" ("protocolo_id");



CREATE INDEX "idx_proyectos_estado" ON "public"."proyectos" USING "btree" ("estado");



CREATE INDEX "idx_rmp_modulo_id" ON "public"."rol_modulo_permisos" USING "btree" ("modulo_id");



CREATE INDEX "idx_rmp_rol_id" ON "public"."rol_modulo_permisos" USING "btree" ("rol_id");



CREATE INDEX "idx_salarios_activo" ON "public"."salarios" USING "btree" ("activo");



CREATE INDEX "idx_salarios_empleado_id" ON "public"."salarios" USING "btree" ("empleado_id");



CREATE INDEX "idx_sueldos_batch" ON "public"."sueldos_historicos" USING "btree" ("migration_batch_id");



CREATE INDEX "idx_suscripciones_estado" ON "public"."suscripciones" USING "btree" ("estado");



CREATE INDEX "idx_suscripciones_nombre" ON "public"."suscripciones" USING "btree" ("nombre");



CREATE INDEX "idx_tarea_asignados_usuario_id" ON "public"."tarea_asignados" USING "btree" ("usuario_id");



CREATE INDEX "idx_tarea_historial_created_at" ON "public"."tarea_historial" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_tarea_historial_tarea_id" ON "public"."tarea_historial" USING "btree" ("tarea_id");



CREATE INDEX "idx_tareas_estado" ON "public"."tareas" USING "btree" ("estado");



CREATE INDEX "idx_tareas_etapa_id" ON "public"."tareas" USING "btree" ("etapa_id");



CREATE INDEX "idx_tareas_tablero_id" ON "public"."tareas" USING "btree" ("tablero_id");



CREATE INDEX "idx_ump_modulo_id" ON "public"."usuario_modulo_permisos" USING "btree" ("modulo_id");



CREATE INDEX "idx_ump_usuario_id" ON "public"."usuario_modulo_permisos" USING "btree" ("usuario_id");



CREATE INDEX "idx_usuarios_auth_user_id" ON "public"."usuarios" USING "btree" ("auth_user_id");



CREATE INDEX "idx_usuarios_estado" ON "public"."usuarios" USING "btree" ("estado");



CREATE INDEX "idx_usuarios_rol_id" ON "public"."usuarios" USING "btree" ("rol_id");



CREATE UNIQUE INDEX "organigrama_empleado_id_activo_idx" ON "public"."organigrama" USING "btree" ("empleado_id") WHERE ("activo" AND ("empleado_id" IS NOT NULL));



CREATE UNIQUE INDEX "organigrama_usuario_id_activo_idx" ON "public"."organigrama" USING "btree" ("usuario_id") WHERE ("activo" AND ("usuario_id" IS NOT NULL));



CREATE UNIQUE INDEX "uq_operativo_tableros_nombre" ON "public"."operativo_tableros" USING "btree" ("lower"("btrim"("nombre")));



CREATE OR REPLACE TRIGGER "trigger_contactos_updated_at" BEFORE UPDATE ON "public"."contactos" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_dashboard_configuraciones_updated_at" BEFORE UPDATE ON "public"."dashboard_configuraciones" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_dashboard_vistas_updated_at" BEFORE UPDATE ON "public"."dashboard_vistas" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_deudas_updated_at" BEFORE UPDATE ON "public"."deudas" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_empleados_updated_at" BEFORE UPDATE ON "public"."empleados" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_indicadores_updated_at" BEFORE UPDATE ON "public"."indicadores" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_movimientos_updated_at" BEFORE UPDATE ON "public"."movimientos" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_nexi_conversaciones_updated_at" BEFORE UPDATE ON "public"."nexi_conversaciones" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_operativo_etapas_updated_at" BEFORE UPDATE ON "public"."operativo_etapas" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_operativo_tableros_updated_at" BEFORE UPDATE ON "public"."operativo_tableros" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_organigrama_updated_at" BEFORE UPDATE ON "public"."organigrama" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_proyectos_updated_at" BEFORE UPDATE ON "public"."proyectos" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_tareas_updated_at" BEFORE UPDATE ON "public"."tareas" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_ump_updated_at" BEFORE UPDATE ON "public"."usuario_modulo_permisos" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_usuarios_updated_at" BEFORE UPDATE ON "public"."usuarios" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



ALTER TABLE ONLY "public"."comprobante_items"
    ADD CONSTRAINT "comprobante_items_comprobante_id_fkey" FOREIGN KEY ("comprobante_id") REFERENCES "public"."comprobantes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."comprobantes"
    ADD CONSTRAINT "comprobantes_duplicate_of_id_fkey" FOREIGN KEY ("duplicate_of_id") REFERENCES "public"."comprobantes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."comprobantes"
    ADD CONSTRAINT "comprobantes_movimiento_id_fkey" FOREIGN KEY ("movimiento_id") REFERENCES "public"."movimientos"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."conciliaciones_migracion"
    ADD CONSTRAINT "conciliaciones_migracion_migration_batch_id_fkey" FOREIGN KEY ("migration_batch_id") REFERENCES "public"."migration_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cuentas_por_cobrar"
    ADD CONSTRAINT "cuentas_por_cobrar_migration_batch_id_fkey" FOREIGN KEY ("migration_batch_id") REFERENCES "public"."migration_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dashboard_configuraciones"
    ADD CONSTRAINT "dashboard_configuraciones_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dashboard_vistas"
    ADD CONSTRAINT "dashboard_vistas_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."integracion_movimientos_financieros"
    ADD CONSTRAINT "integracion_movimientos_financier_movimiento_financiero_id_fkey" FOREIGN KEY ("movimiento_financiero_id") REFERENCES "public"."movimientos"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."integracion_movimientos_financieros"
    ADD CONSTRAINT "integracion_movimientos_financieros_movimiento_salario_id_fkey" FOREIGN KEY ("movimiento_salario_id") REFERENCES "public"."movimientos_salario"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inversiones_historicas"
    ADD CONSTRAINT "inversiones_historicas_migration_batch_id_fkey" FOREIGN KEY ("migration_batch_id") REFERENCES "public"."migration_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."migration_batches"
    ADD CONSTRAINT "migration_batches_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."movimientos"
    ADD CONSTRAINT "movimientos_migration_batch_id_fkey" FOREIGN KEY ("migration_batch_id") REFERENCES "public"."migration_batches"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."movimientos_salario"
    ADD CONSTRAINT "movimientos_salario_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "public"."categorias_salariales"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."movimientos_salario"
    ADD CONSTRAINT "movimientos_salario_empleado_id_fkey" FOREIGN KEY ("empleado_id") REFERENCES "public"."empleados"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."movimientos"
    ADD CONSTRAINT "movimientos_suscripcion_id_fkey" FOREIGN KEY ("suscripcion_id") REFERENCES "public"."suscripciones"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."nexi_conversaciones"
    ADD CONSTRAINT "nexi_conversaciones_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."nexi_mensajes"
    ADD CONSTRAINT "nexi_mensajes_conversacion_id_fkey" FOREIGN KEY ("conversacion_id") REFERENCES "public"."nexi_conversaciones"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."nexi_reportes"
    ADD CONSTRAINT "nexi_reportes_conversacion_id_fkey" FOREIGN KEY ("conversacion_id") REFERENCES "public"."nexi_conversaciones"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."nexi_reportes"
    ADD CONSTRAINT "nexi_reportes_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."nexi_tool_calls"
    ADD CONSTRAINT "nexi_tool_calls_conversacion_id_fkey" FOREIGN KEY ("conversacion_id") REFERENCES "public"."nexi_conversaciones"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."nexi_tool_calls"
    ADD CONSTRAINT "nexi_tool_calls_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."operativo_tablero_miembros"
    ADD CONSTRAINT "operativo_tablero_miembros_tablero_id_fkey" FOREIGN KEY ("tablero_id") REFERENCES "public"."operativo_tableros"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."operativo_tablero_miembros"
    ADD CONSTRAINT "operativo_tablero_miembros_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."operativo_tableros"
    ADD CONSTRAINT "operativo_tableros_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."usuarios"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."organigrama"
    ADD CONSTRAINT "organigrama_empleado_id_fkey" FOREIGN KEY ("empleado_id") REFERENCES "public"."empleados"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."organigrama"
    ADD CONSTRAINT "organigrama_superior_id_fkey" FOREIGN KEY ("superior_id") REFERENCES "public"."organigrama"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."organigrama"
    ADD CONSTRAINT "organigrama_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."protocolo_items"
    ADD CONSTRAINT "protocolo_items_protocolo_id_fkey" FOREIGN KEY ("protocolo_id") REFERENCES "public"."protocolos"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."protocolo_pruebas"
    ADD CONSTRAINT "protocolo_pruebas_protocolo_id_fkey" FOREIGN KEY ("protocolo_id") REFERENCES "public"."protocolos"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rol_modulo_permisos"
    ADD CONSTRAINT "rol_modulo_permisos_modulo_id_fkey" FOREIGN KEY ("modulo_id") REFERENCES "public"."modulos"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rol_modulo_permisos"
    ADD CONSTRAINT "rol_modulo_permisos_rol_id_fkey" FOREIGN KEY ("rol_id") REFERENCES "public"."roles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."salarios"
    ADD CONSTRAINT "salarios_empleado_id_fkey" FOREIGN KEY ("empleado_id") REFERENCES "public"."empleados"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sueldos_historicos"
    ADD CONSTRAINT "sueldos_historicos_migration_batch_id_fkey" FOREIGN KEY ("migration_batch_id") REFERENCES "public"."migration_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tarea_asignados"
    ADD CONSTRAINT "tarea_asignados_tarea_id_fkey" FOREIGN KEY ("tarea_id") REFERENCES "public"."tareas"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tarea_asignados"
    ADD CONSTRAINT "tarea_asignados_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tarea_historial"
    ADD CONSTRAINT "tarea_historial_tarea_id_fkey" FOREIGN KEY ("tarea_id") REFERENCES "public"."tareas"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tareas"
    ADD CONSTRAINT "tareas_etapa_id_fkey" FOREIGN KEY ("etapa_id") REFERENCES "public"."operativo_etapas"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."tareas"
    ADD CONSTRAINT "tareas_tablero_id_fkey" FOREIGN KEY ("tablero_id") REFERENCES "public"."operativo_tableros"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."usuario_modulo_permisos"
    ADD CONSTRAINT "usuario_modulo_permisos_modulo_id_fkey" FOREIGN KEY ("modulo_id") REFERENCES "public"."modulos"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."usuario_modulo_permisos"
    ADD CONSTRAINT "usuario_modulo_permisos_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."usuarios"
    ADD CONSTRAINT "usuarios_auth_user_id_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."usuarios"
    ADD CONSTRAINT "usuarios_rol_id_fkey" FOREIGN KEY ("rol_id") REFERENCES "public"."roles"("id") ON DELETE SET NULL;



CREATE POLICY "Allow all for anon" ON "public"."categorias_salariales" USING (true) WITH CHECK (true);



CREATE POLICY "Allow all for anon" ON "public"."empleados" USING (true) WITH CHECK (true);



CREATE POLICY "Allow all for anon" ON "public"."integracion_movimientos_financieros" USING (true) WITH CHECK (true);



CREATE POLICY "Allow all for anon" ON "public"."modulos" USING (true) WITH CHECK (true);



CREATE POLICY "Allow all for anon" ON "public"."movimientos_salario" USING (true) WITH CHECK (true);



CREATE POLICY "Allow all for anon" ON "public"."organigrama" USING (true) WITH CHECK (true);



CREATE POLICY "Allow all for anon" ON "public"."rol_modulo_permisos" USING (true) WITH CHECK (true);



CREATE POLICY "Allow all for anon" ON "public"."roles" USING (true) WITH CHECK (true);



CREATE POLICY "Allow all for anon" ON "public"."salarios" USING (true) WITH CHECK (true);



CREATE POLICY "Allow all for anon" ON "public"."usuario_modulo_permisos" USING (true) WITH CHECK (true);



CREATE POLICY "Allow all for anon" ON "public"."usuarios" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated can read roles" ON "public"."roles" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "Authenticated can read usuarios" ON "public"."usuarios" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "Backend full access" ON "public"."roles" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend full access" ON "public"."usuarios" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."categorias_salariales" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."comprobante_items" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."comprobantes" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."contactos" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."dashboard_configuraciones" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."dashboard_vistas" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."deudas" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."empleados" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."indicadores" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."integracion_movimientos_financieros" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."modulos" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."movimientos" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."movimientos_salario" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."nexi_conversaciones" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."nexi_mensajes" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."nexi_reportes" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."nexi_tool_calls" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."operativo_etapas" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."operativo_tablero_miembros" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."operativo_tableros" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."protocolo_items" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."protocolo_pruebas" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."protocolos" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."proyectos" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."rol_modulo_permisos" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."salarios" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."suscripciones" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."tarea_asignados" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."tareas" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Usuarios autenticados pueden leer cotizaciones" ON "public"."cotizaciones_dolar" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."categorias_salariales" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."comprobante_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."comprobantes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."conciliaciones_migracion" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contactos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cotizaciones_dolar" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cuentas_por_cobrar" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dashboard_configuraciones" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dashboard_vistas" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deudas" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."empleados" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."indicadores" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."integracion_movimientos_financieros" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."inversiones_historicas" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."migration_batches" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."modulos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."movimientos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."movimientos_salario" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."nexi_conversaciones" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."nexi_mensajes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."nexi_reportes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."nexi_tool_calls" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."operativo_etapas" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."operativo_tablero_miembros" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."operativo_tableros" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organigrama" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."protocolo_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."protocolo_pruebas" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."protocolos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."proyectos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rol_modulo_permisos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."roles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."salarios" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sueldos_historicos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."suscripciones" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tarea_asignados" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tarea_historial" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tareas" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."usuario_modulo_permisos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."usuarios" ENABLE ROW LEVEL SECURITY;












GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";











































































































































































REVOKE ALL ON FUNCTION "public"."indicadores_totales_movimientos"("p_desde" "date", "p_hasta" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."indicadores_totales_movimientos"("p_desde" "date", "p_hasta" "date") TO "service_role";



REVOKE ALL ON FUNCTION "public"."protocolo_crear_con_items"("p_nombre" "text", "p_descripcion" "text", "p_categoria" "text", "p_acceso" "text", "p_usuario" "text", "p_items" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."protocolo_crear_con_items"("p_nombre" "text", "p_descripcion" "text", "p_categoria" "text", "p_acceso" "text", "p_usuario" "text", "p_items" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."tarea_sincronizar_asignados"("p_tarea_id" "uuid", "p_usuario_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."tarea_sincronizar_asignados"("p_tarea_id" "uuid", "p_usuario_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "service_role";
























GRANT ALL ON TABLE "public"."categorias_salariales" TO "anon";
GRANT ALL ON TABLE "public"."categorias_salariales" TO "authenticated";
GRANT ALL ON TABLE "public"."categorias_salariales" TO "service_role";



GRANT ALL ON TABLE "public"."comprobante_items" TO "anon";
GRANT ALL ON TABLE "public"."comprobante_items" TO "authenticated";
GRANT ALL ON TABLE "public"."comprobante_items" TO "service_role";



GRANT ALL ON TABLE "public"."comprobantes" TO "anon";
GRANT ALL ON TABLE "public"."comprobantes" TO "authenticated";
GRANT ALL ON TABLE "public"."comprobantes" TO "service_role";



GRANT ALL ON TABLE "public"."conciliaciones_migracion" TO "anon";
GRANT ALL ON TABLE "public"."conciliaciones_migracion" TO "authenticated";
GRANT ALL ON TABLE "public"."conciliaciones_migracion" TO "service_role";



GRANT ALL ON TABLE "public"."contactos" TO "anon";
GRANT ALL ON TABLE "public"."contactos" TO "authenticated";
GRANT ALL ON TABLE "public"."contactos" TO "service_role";



GRANT ALL ON TABLE "public"."cotizaciones_dolar" TO "anon";
GRANT ALL ON TABLE "public"."cotizaciones_dolar" TO "authenticated";
GRANT ALL ON TABLE "public"."cotizaciones_dolar" TO "service_role";



GRANT ALL ON TABLE "public"."cuentas_por_cobrar" TO "anon";
GRANT ALL ON TABLE "public"."cuentas_por_cobrar" TO "authenticated";
GRANT ALL ON TABLE "public"."cuentas_por_cobrar" TO "service_role";



GRANT ALL ON TABLE "public"."dashboard_configuraciones" TO "anon";
GRANT ALL ON TABLE "public"."dashboard_configuraciones" TO "authenticated";
GRANT ALL ON TABLE "public"."dashboard_configuraciones" TO "service_role";



GRANT ALL ON TABLE "public"."dashboard_vistas" TO "anon";
GRANT ALL ON TABLE "public"."dashboard_vistas" TO "authenticated";
GRANT ALL ON TABLE "public"."dashboard_vistas" TO "service_role";



GRANT ALL ON TABLE "public"."deudas" TO "anon";
GRANT ALL ON TABLE "public"."deudas" TO "authenticated";
GRANT ALL ON TABLE "public"."deudas" TO "service_role";



GRANT ALL ON TABLE "public"."empleados" TO "anon";
GRANT ALL ON TABLE "public"."empleados" TO "authenticated";
GRANT ALL ON TABLE "public"."empleados" TO "service_role";



GRANT ALL ON TABLE "public"."indicadores" TO "anon";
GRANT ALL ON TABLE "public"."indicadores" TO "authenticated";
GRANT ALL ON TABLE "public"."indicadores" TO "service_role";



GRANT ALL ON TABLE "public"."integracion_movimientos_financieros" TO "anon";
GRANT ALL ON TABLE "public"."integracion_movimientos_financieros" TO "authenticated";
GRANT ALL ON TABLE "public"."integracion_movimientos_financieros" TO "service_role";



GRANT ALL ON TABLE "public"."inversiones_historicas" TO "anon";
GRANT ALL ON TABLE "public"."inversiones_historicas" TO "authenticated";
GRANT ALL ON TABLE "public"."inversiones_historicas" TO "service_role";



GRANT ALL ON TABLE "public"."migration_batches" TO "anon";
GRANT ALL ON TABLE "public"."migration_batches" TO "authenticated";
GRANT ALL ON TABLE "public"."migration_batches" TO "service_role";



GRANT ALL ON TABLE "public"."modulos" TO "anon";
GRANT ALL ON TABLE "public"."modulos" TO "authenticated";
GRANT ALL ON TABLE "public"."modulos" TO "service_role";



GRANT ALL ON TABLE "public"."movimientos" TO "anon";
GRANT ALL ON TABLE "public"."movimientos" TO "authenticated";
GRANT ALL ON TABLE "public"."movimientos" TO "service_role";



GRANT ALL ON TABLE "public"."movimientos_salario" TO "anon";
GRANT ALL ON TABLE "public"."movimientos_salario" TO "authenticated";
GRANT ALL ON TABLE "public"."movimientos_salario" TO "service_role";



GRANT ALL ON TABLE "public"."nexi_conversaciones" TO "anon";
GRANT ALL ON TABLE "public"."nexi_conversaciones" TO "authenticated";
GRANT ALL ON TABLE "public"."nexi_conversaciones" TO "service_role";



GRANT ALL ON TABLE "public"."nexi_mensajes" TO "anon";
GRANT ALL ON TABLE "public"."nexi_mensajes" TO "authenticated";
GRANT ALL ON TABLE "public"."nexi_mensajes" TO "service_role";



GRANT ALL ON TABLE "public"."nexi_reportes" TO "anon";
GRANT ALL ON TABLE "public"."nexi_reportes" TO "authenticated";
GRANT ALL ON TABLE "public"."nexi_reportes" TO "service_role";



GRANT ALL ON TABLE "public"."nexi_tool_calls" TO "anon";
GRANT ALL ON TABLE "public"."nexi_tool_calls" TO "authenticated";
GRANT ALL ON TABLE "public"."nexi_tool_calls" TO "service_role";



GRANT ALL ON TABLE "public"."operativo_etapas" TO "anon";
GRANT ALL ON TABLE "public"."operativo_etapas" TO "authenticated";
GRANT ALL ON TABLE "public"."operativo_etapas" TO "service_role";



GRANT ALL ON TABLE "public"."operativo_tablero_miembros" TO "anon";
GRANT ALL ON TABLE "public"."operativo_tablero_miembros" TO "authenticated";
GRANT ALL ON TABLE "public"."operativo_tablero_miembros" TO "service_role";



GRANT ALL ON TABLE "public"."operativo_tableros" TO "anon";
GRANT ALL ON TABLE "public"."operativo_tableros" TO "authenticated";
GRANT ALL ON TABLE "public"."operativo_tableros" TO "service_role";



GRANT ALL ON TABLE "public"."organigrama" TO "anon";
GRANT ALL ON TABLE "public"."organigrama" TO "authenticated";
GRANT ALL ON TABLE "public"."organigrama" TO "service_role";



GRANT ALL ON TABLE "public"."protocolo_items" TO "anon";
GRANT ALL ON TABLE "public"."protocolo_items" TO "authenticated";
GRANT ALL ON TABLE "public"."protocolo_items" TO "service_role";



GRANT ALL ON TABLE "public"."protocolo_pruebas" TO "anon";
GRANT ALL ON TABLE "public"."protocolo_pruebas" TO "authenticated";
GRANT ALL ON TABLE "public"."protocolo_pruebas" TO "service_role";



GRANT ALL ON TABLE "public"."protocolos" TO "anon";
GRANT ALL ON TABLE "public"."protocolos" TO "authenticated";
GRANT ALL ON TABLE "public"."protocolos" TO "service_role";



GRANT ALL ON TABLE "public"."proyectos" TO "anon";
GRANT ALL ON TABLE "public"."proyectos" TO "authenticated";
GRANT ALL ON TABLE "public"."proyectos" TO "service_role";



GRANT ALL ON TABLE "public"."rol_modulo_permisos" TO "anon";
GRANT ALL ON TABLE "public"."rol_modulo_permisos" TO "authenticated";
GRANT ALL ON TABLE "public"."rol_modulo_permisos" TO "service_role";



GRANT ALL ON TABLE "public"."roles" TO "anon";
GRANT ALL ON TABLE "public"."roles" TO "authenticated";
GRANT ALL ON TABLE "public"."roles" TO "service_role";



GRANT ALL ON TABLE "public"."salarios" TO "anon";
GRANT ALL ON TABLE "public"."salarios" TO "authenticated";
GRANT ALL ON TABLE "public"."salarios" TO "service_role";



GRANT ALL ON TABLE "public"."sueldos_historicos" TO "anon";
GRANT ALL ON TABLE "public"."sueldos_historicos" TO "authenticated";
GRANT ALL ON TABLE "public"."sueldos_historicos" TO "service_role";



GRANT ALL ON TABLE "public"."suscripciones" TO "anon";
GRANT ALL ON TABLE "public"."suscripciones" TO "authenticated";
GRANT ALL ON TABLE "public"."suscripciones" TO "service_role";



GRANT ALL ON TABLE "public"."tarea_asignados" TO "anon";
GRANT ALL ON TABLE "public"."tarea_asignados" TO "authenticated";
GRANT ALL ON TABLE "public"."tarea_asignados" TO "service_role";



GRANT ALL ON TABLE "public"."tarea_historial" TO "anon";
GRANT ALL ON TABLE "public"."tarea_historial" TO "authenticated";
GRANT ALL ON TABLE "public"."tarea_historial" TO "service_role";



GRANT ALL ON TABLE "public"."tareas" TO "anon";
GRANT ALL ON TABLE "public"."tareas" TO "authenticated";
GRANT ALL ON TABLE "public"."tareas" TO "service_role";



GRANT ALL ON TABLE "public"."usuario_modulo_permisos" TO "anon";
GRANT ALL ON TABLE "public"."usuario_modulo_permisos" TO "authenticated";
GRANT ALL ON TABLE "public"."usuario_modulo_permisos" TO "service_role";



GRANT ALL ON TABLE "public"."usuarios" TO "anon";
GRANT ALL ON TABLE "public"."usuarios" TO "authenticated";
GRANT ALL ON TABLE "public"."usuarios" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































