


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


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






COMMENT ON SCHEMA "public" IS 'standard public schema';



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


CREATE TABLE IF NOT EXISTS "public"."comprobantes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "movimiento_id" "uuid",
    "nombre_archivo" "text" NOT NULL,
    "tipo_archivo" "text" NOT NULL,
    "url_archivo" "text",
    "storage_path" "text",
    "ocr_estado" "text" DEFAULT 'pendiente'::"text",
    "ocr_texto" "text",
    "ocr_fecha" "date",
    "ocr_monto" numeric(15,2),
    "ocr_proveedor" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "comprobantes_ocr_estado_check" CHECK (("ocr_estado" = ANY (ARRAY['pendiente'::"text", 'procesado'::"text", 'error'::"text"]))),
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
    CONSTRAINT "contactos_estado_check" CHECK (("estado" = ANY (ARRAY['Activo'::"text", 'Inactivo'::"text", 'En negociación'::"text"]))),
    CONSTRAINT "contactos_tipo_check" CHECK (("tipo" = ANY (ARRAY['Cliente'::"text", 'Prospecto'::"text", 'Proveedor'::"text", 'Socio'::"text"])))
);


ALTER TABLE "public"."contactos" OWNER TO "postgres";


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



CREATE TABLE IF NOT EXISTS "public"."organigrama" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "usuario_id" "uuid" NOT NULL,
    "superior_id" "uuid",
    "nivel" "public"."nivel_organigrama" DEFAULT 'Operarios / Staff'::"public"."nivel_organigrama" NOT NULL,
    "area" "text",
    "cargo" "text",
    "es_externo" boolean DEFAULT false,
    "fecha_inicio" "date",
    "fecha_fin" "date",
    "activo" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
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
    "created_by" "text"
);


ALTER TABLE "public"."protocolo_pruebas" OWNER TO "postgres";


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
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."roles" OWNER TO "postgres";


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
    CONSTRAINT "tareas_estado_check" CHECK (("estado" = ANY (ARRAY['Pendiente'::"text", 'En Proceso'::"text", 'Completada'::"text", 'Cancelada'::"text"]))),
    CONSTRAINT "tareas_prioridad_check" CHECK (("prioridad" = ANY (ARRAY['Baja'::"text", 'Media'::"text", 'Alta'::"text", 'Urgente'::"text"])))
);


ALTER TABLE "public"."tareas" OWNER TO "postgres";


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



ALTER TABLE ONLY "public"."deudas"
    ADD CONSTRAINT "deudas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."empleados"
    ADD CONSTRAINT "empleados_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."empleados"
    ADD CONSTRAINT "empleados_pkey" PRIMARY KEY ("id");



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



ALTER TABLE ONLY "public"."organigrama"
    ADD CONSTRAINT "organigrama_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organigrama"
    ADD CONSTRAINT "organigrama_usuario_id_key" UNIQUE ("usuario_id");



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



CREATE INDEX "idx_comprobantes_created_at" ON "public"."comprobantes" USING "btree" ("created_at");



CREATE INDEX "idx_comprobantes_movimiento" ON "public"."comprobantes" USING "btree" ("movimiento_id");



CREATE INDEX "idx_comprobantes_storage_path_activos" ON "public"."comprobantes" USING "btree" ("storage_path") WHERE ("storage_path" IS NOT NULL);



CREATE INDEX "idx_conciliaciones_batch" ON "public"."conciliaciones_migracion" USING "btree" ("migration_batch_id");



CREATE INDEX "idx_contactos_tipo" ON "public"."contactos" USING "btree" ("tipo");



CREATE INDEX "idx_cotizaciones_dolar_fecha" ON "public"."cotizaciones_dolar" USING "btree" ("fecha" DESC);



CREATE INDEX "idx_cuentas_cobrar_batch" ON "public"."cuentas_por_cobrar" USING "btree" ("migration_batch_id");



CREATE INDEX "idx_deudas_estado" ON "public"."deudas" USING "btree" ("estado");



CREATE INDEX "idx_deudas_vencimiento" ON "public"."deudas" USING "btree" ("vencimiento");



CREATE INDEX "idx_empleados_estado" ON "public"."empleados" USING "btree" ("estado");



CREATE INDEX "idx_empleados_modalidad" ON "public"."empleados" USING "btree" ("modalidad_trabajo");



CREATE INDEX "idx_empleados_permanencia" ON "public"."empleados" USING "btree" ("tipo_permanencia");



CREATE INDEX "idx_empleados_tipo_salario" ON "public"."empleados" USING "btree" ("tipo_salario");



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



CREATE INDEX "idx_organigrama_activo" ON "public"."organigrama" USING "btree" ("activo");



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



CREATE INDEX "idx_tarea_historial_created_at" ON "public"."tarea_historial" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_tarea_historial_tarea_id" ON "public"."tarea_historial" USING "btree" ("tarea_id");



CREATE INDEX "idx_tareas_estado" ON "public"."tareas" USING "btree" ("estado");



CREATE INDEX "idx_ump_modulo_id" ON "public"."usuario_modulo_permisos" USING "btree" ("modulo_id");



CREATE INDEX "idx_ump_usuario_id" ON "public"."usuario_modulo_permisos" USING "btree" ("usuario_id");



CREATE INDEX "idx_usuarios_auth_user_id" ON "public"."usuarios" USING "btree" ("auth_user_id");



CREATE INDEX "idx_usuarios_estado" ON "public"."usuarios" USING "btree" ("estado");



CREATE INDEX "idx_usuarios_rol_id" ON "public"."usuarios" USING "btree" ("rol_id");



CREATE OR REPLACE TRIGGER "trigger_contactos_updated_at" BEFORE UPDATE ON "public"."contactos" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_deudas_updated_at" BEFORE UPDATE ON "public"."deudas" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_empleados_updated_at" BEFORE UPDATE ON "public"."empleados" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_movimientos_updated_at" BEFORE UPDATE ON "public"."movimientos" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_organigrama_updated_at" BEFORE UPDATE ON "public"."organigrama" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_proyectos_updated_at" BEFORE UPDATE ON "public"."proyectos" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_tareas_updated_at" BEFORE UPDATE ON "public"."tareas" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_ump_updated_at" BEFORE UPDATE ON "public"."usuario_modulo_permisos" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_usuarios_updated_at" BEFORE UPDATE ON "public"."usuarios" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



ALTER TABLE ONLY "public"."comprobantes"
    ADD CONSTRAINT "comprobantes_movimiento_id_fkey" FOREIGN KEY ("movimiento_id") REFERENCES "public"."movimientos"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."conciliaciones_migracion"
    ADD CONSTRAINT "conciliaciones_migracion_migration_batch_id_fkey" FOREIGN KEY ("migration_batch_id") REFERENCES "public"."migration_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cuentas_por_cobrar"
    ADD CONSTRAINT "cuentas_por_cobrar_migration_batch_id_fkey" FOREIGN KEY ("migration_batch_id") REFERENCES "public"."migration_batches"("id") ON DELETE CASCADE;



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



ALTER TABLE ONLY "public"."tarea_historial"
    ADD CONSTRAINT "tarea_historial_tarea_id_fkey" FOREIGN KEY ("tarea_id") REFERENCES "public"."tareas"("id") ON DELETE CASCADE;



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



CREATE POLICY "Backend service_role only" ON "public"."comprobantes" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."contactos" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."deudas" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."empleados" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."integracion_movimientos_financieros" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."modulos" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."movimientos" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."movimientos_salario" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."proyectos" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."rol_modulo_permisos" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."salarios" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."suscripciones" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Backend service_role only" ON "public"."tareas" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Usuarios autenticados pueden leer cotizaciones" ON "public"."cotizaciones_dolar" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."categorias_salariales" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."comprobantes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."conciliaciones_migracion" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contactos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cotizaciones_dolar" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cuentas_por_cobrar" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deudas" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."empleados" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."integracion_movimientos_financieros" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."inversiones_historicas" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."migration_batches" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."modulos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."movimientos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."movimientos_salario" ENABLE ROW LEVEL SECURITY;


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


ALTER TABLE "public"."tarea_historial" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tareas" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."usuario_modulo_permisos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."usuarios" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";








GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";











































































































































































GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "service_role";
























GRANT ALL ON TABLE "public"."categorias_salariales" TO "anon";
GRANT ALL ON TABLE "public"."categorias_salariales" TO "authenticated";
GRANT ALL ON TABLE "public"."categorias_salariales" TO "service_role";



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



GRANT ALL ON TABLE "public"."deudas" TO "anon";
GRANT ALL ON TABLE "public"."deudas" TO "authenticated";
GRANT ALL ON TABLE "public"."deudas" TO "service_role";



GRANT ALL ON TABLE "public"."empleados" TO "anon";
GRANT ALL ON TABLE "public"."empleados" TO "authenticated";
GRANT ALL ON TABLE "public"."empleados" TO "service_role";



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































