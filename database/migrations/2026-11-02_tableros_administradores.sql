-- Migración: 2026-11-02_tableros_administradores
-- Módulo: Operativo (public.operativo_tablero_miembros)
--
-- Objetivo:
--   Administradores por tablero (estilo grupos de WhatsApp). Un administrador
--   puede agregar miembros, quitarlos, promover a otro miembro y quitarle el
--   privilegio a otro administrador. La administración es independiente del
--   rol jerárquico: Dirección y Superadmin siguen viendo todos los tableros,
--   pero no administran ninguno por eso. Las reglas de quién puede hacer qué
--   las aplica el backend (operations/services/tablerosService.js); las
--   funciones de esta migración vuelven a verificarlas con el tablero
--   bloqueado para que dos pedidos simultáneos no lo dejen sin administradores.
--
-- Esta migración:
--   1) Agrega operativo_tablero_miembros.es_admin (boolean NOT NULL DEFAULT
--      false). Las membresías existentes quedan como miembros comunes.
--   2) Índice parcial por tablero_id de los administradores.
--   3) Funciones (solo service_role) que bloquean el tablero (FOR UPDATE)
--      antes de leer y modificar sus miembros:
--        - operativo_tablero_agregar_miembros(tablero, actor, usuarios[])
--        - operativo_tablero_cambiar_admin(tablero, actor, usuario, es_admin)
--        - operativo_tablero_quitar_miembro(tablero, actor, usuario)
--        - operativo_tablero_sincronizar_miembros(tablero, usuarios[])
--          (edición de la lista completa por mando alto, PATCH /tableros/:id)
--        - operativo_tablero_regularizar_admin(tablero, usuario)
--          (mando alto designa un administrador SOLO en tableros sin
--          administradores activos)
--      Regla común: una operación no puede dejar sin administradores activos
--      a un tablero que tenía al menos uno. Errores con ERRCODE P0001 y un
--      mensaje NX_* que el backend traduce a 403/404/409.
--   4) Backfill, solo en tableros sin ningún administrador: el creador
--      (created_by) pasa a ser miembro administrador si existe y está activo
--      (si ya era miembro se lo promueve; si no, se lo agrega).
--   5) Informa (RAISE NOTICE) los tableros que siguen sin administrador
--      activo. Caso típico: "General", creado por la migración
--      2026-10-19_tableros_operativo con created_by NULL. No se elige a nadie
--      arbitrariamente: se regularizan con
--      POST /api/operations/tableros/:id/regularizar-administrador
--      (Dirección o Superadmin).
--
-- No borra datos ni membresías. No modifica tareas, etapas ni tableros.
-- Idempotente: puede correrse más de una vez sin error (DEV y PROD). El
-- backfill solo actúa sobre tableros que todavía no tienen administradores.
--
-- Orden de despliegue: correr ANTES de desplegar el backend que lee es_admin.
--
-- NO afecta finance, movimientos, comprobantes, OCR, excel, deudas, empleados,
-- salarios, movimientos_salario, suscripciones, migraciones,
-- inversiones_historicas, sueldos_historicos, cuentas_por_cobrar
-- ni conciliaciones_migracion.

BEGIN;

-- 1) Columna es_admin
ALTER TABLE public.operativo_tablero_miembros
  ADD COLUMN IF NOT EXISTS es_admin boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.operativo_tablero_miembros.es_admin IS 'Administrador del tablero: puede agregar y quitar miembros y otorgar o quitar este privilegio. Independiente del rol jerárquico. Se modifica solo con las funciones operativo_tablero_*.';

-- 2) Índice de administradores por tablero
CREATE INDEX IF NOT EXISTS idx_operativo_tablero_miembros_admins
  ON public.operativo_tablero_miembros (tablero_id) WHERE es_admin;

-- 3) Funciones

-- Bloquea el tablero (serializa los cambios de miembros del mismo tablero).
CREATE OR REPLACE FUNCTION public.operativo_tablero_bloquear(p_tablero_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM 1 FROM public.operativo_tableros WHERE id = p_tablero_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NX_TABLERO_NO_ENCONTRADO' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.operativo_tablero_admins_activos(p_tablero_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT count(*)::integer
  FROM public.operativo_tablero_miembros m
  JOIN public.usuarios u ON u.id = m.usuario_id
  WHERE m.tablero_id = p_tablero_id AND m.es_admin AND u.estado = 'Activo';
$$;

CREATE OR REPLACE FUNCTION public.operativo_tablero_exigir_admin(p_tablero_id uuid, p_actor_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF p_actor_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.operativo_tablero_miembros
    WHERE tablero_id = p_tablero_id AND usuario_id = p_actor_id AND es_admin
  ) THEN
    RAISE EXCEPTION 'NX_NO_ADMIN' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Si el tablero tenía administradores activos antes del cambio y ya no tiene
-- ninguno, aborta (la transacción de la función que llama se revierte).
CREATE OR REPLACE FUNCTION public.operativo_tablero_exigir_admin_restante(p_tablero_id uuid, p_antes integer)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF p_antes > 0 AND public.operativo_tablero_admins_activos(p_tablero_id) = 0 THEN
    RAISE EXCEPTION 'NX_ULTIMO_ADMIN' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Agrega miembros comunes. Los que ya eran miembros quedan como estaban
-- (no se duplican ni cambian de privilegio).
CREATE OR REPLACE FUNCTION public.operativo_tablero_agregar_miembros(p_tablero_id uuid, p_actor_id uuid, p_usuario_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM public.operativo_tablero_bloquear(p_tablero_id);
  PERFORM public.operativo_tablero_exigir_admin(p_tablero_id, p_actor_id);

  INSERT INTO public.operativo_tablero_miembros (tablero_id, usuario_id, es_admin)
  SELECT p_tablero_id, x.id, false
  FROM (SELECT DISTINCT unnest(p_usuario_ids) AS id) x
  ON CONFLICT (tablero_id, usuario_id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.operativo_tablero_cambiar_admin(p_tablero_id uuid, p_actor_id uuid, p_usuario_id uuid, p_es_admin boolean)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_antes integer;
  v_estado text;
BEGIN
  PERFORM public.operativo_tablero_bloquear(p_tablero_id);
  PERFORM public.operativo_tablero_exigir_admin(p_tablero_id, p_actor_id);

  SELECT u.estado INTO v_estado
  FROM public.operativo_tablero_miembros m
  JOIN public.usuarios u ON u.id = m.usuario_id
  WHERE m.tablero_id = p_tablero_id AND m.usuario_id = p_usuario_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NX_NO_MIEMBRO' USING ERRCODE = 'P0001';
  END IF;
  IF p_es_admin AND v_estado IS DISTINCT FROM 'Activo' THEN
    RAISE EXCEPTION 'NX_USUARIO_INACTIVO' USING ERRCODE = 'P0001';
  END IF;

  v_antes := public.operativo_tablero_admins_activos(p_tablero_id);
  UPDATE public.operativo_tablero_miembros
  SET es_admin = p_es_admin
  WHERE tablero_id = p_tablero_id AND usuario_id = p_usuario_id;
  PERFORM public.operativo_tablero_exigir_admin_restante(p_tablero_id, v_antes);
END;
$$;

CREATE OR REPLACE FUNCTION public.operativo_tablero_quitar_miembro(p_tablero_id uuid, p_actor_id uuid, p_usuario_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_antes integer;
BEGIN
  PERFORM public.operativo_tablero_bloquear(p_tablero_id);
  PERFORM public.operativo_tablero_exigir_admin(p_tablero_id, p_actor_id);

  v_antes := public.operativo_tablero_admins_activos(p_tablero_id);
  DELETE FROM public.operativo_tablero_miembros
  WHERE tablero_id = p_tablero_id AND usuario_id = p_usuario_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NX_NO_MIEMBRO' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.operativo_tablero_exigir_admin_restante(p_tablero_id, v_antes);
END;
$$;

-- Deja el tablero con exactamente esa lista de miembros. Los nuevos entran
-- como miembros comunes; los que siguen conservan su privilegio. Lo usa la
-- edición de tableros de mando alto (sin verificación de administrador).
CREATE OR REPLACE FUNCTION public.operativo_tablero_sincronizar_miembros(p_tablero_id uuid, p_usuario_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_antes integer;
BEGIN
  PERFORM public.operativo_tablero_bloquear(p_tablero_id);

  v_antes := public.operativo_tablero_admins_activos(p_tablero_id);
  DELETE FROM public.operativo_tablero_miembros
  WHERE tablero_id = p_tablero_id AND NOT (usuario_id = ANY (p_usuario_ids));

  INSERT INTO public.operativo_tablero_miembros (tablero_id, usuario_id, es_admin)
  SELECT p_tablero_id, x.id, false
  FROM (SELECT DISTINCT unnest(p_usuario_ids) AS id) x
  ON CONFLICT (tablero_id, usuario_id) DO NOTHING;
  PERFORM public.operativo_tablero_exigir_admin_restante(p_tablero_id, v_antes);
END;
$$;

-- Regularización de mando alto: designa un administrador solo si el tablero
-- no tiene ningún administrador activo. Si el usuario no era miembro, se lo
-- agrega.
CREATE OR REPLACE FUNCTION public.operativo_tablero_regularizar_admin(p_tablero_id uuid, p_usuario_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM public.operativo_tablero_bloquear(p_tablero_id);

  IF public.operativo_tablero_admins_activos(p_tablero_id) > 0 THEN
    RAISE EXCEPTION 'NX_YA_TIENE_ADMIN' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.usuarios WHERE id = p_usuario_id AND estado = 'Activo') THEN
    RAISE EXCEPTION 'NX_USUARIO_INACTIVO' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.operativo_tablero_miembros (tablero_id, usuario_id, es_admin)
  VALUES (p_tablero_id, p_usuario_id, true)
  ON CONFLICT (tablero_id, usuario_id) DO UPDATE SET es_admin = true;
END;
$$;

COMMENT ON FUNCTION public.operativo_tablero_agregar_miembros(uuid, uuid, uuid[]) IS 'Operativo: un administrador agrega miembros comunes a un tablero. Uso exclusivo del backend.';
COMMENT ON FUNCTION public.operativo_tablero_cambiar_admin(uuid, uuid, uuid, boolean) IS 'Operativo: un administrador promueve o degrada a un miembro; nunca deja el tablero sin administradores activos. Uso exclusivo del backend.';
COMMENT ON FUNCTION public.operativo_tablero_quitar_miembro(uuid, uuid, uuid) IS 'Operativo: un administrador quita a un miembro; nunca deja el tablero sin administradores activos. Uso exclusivo del backend.';
COMMENT ON FUNCTION public.operativo_tablero_sincronizar_miembros(uuid, uuid[]) IS 'Operativo: mando alto reemplaza la lista completa de miembros (nuevos como comunes); nunca deja el tablero sin administradores activos. Uso exclusivo del backend.';
COMMENT ON FUNCTION public.operativo_tablero_regularizar_admin(uuid, uuid) IS 'Operativo: mando alto designa un administrador en un tablero sin administradores activos. Uso exclusivo del backend.';

-- Solo el backend (service_role) ejecuta estas funciones
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.operativo_tablero_bloquear(uuid)',
    'public.operativo_tablero_admins_activos(uuid)',
    'public.operativo_tablero_exigir_admin(uuid, uuid)',
    'public.operativo_tablero_exigir_admin_restante(uuid, integer)',
    'public.operativo_tablero_agregar_miembros(uuid, uuid, uuid[])',
    'public.operativo_tablero_cambiar_admin(uuid, uuid, uuid, boolean)',
    'public.operativo_tablero_quitar_miembro(uuid, uuid, uuid)',
    'public.operativo_tablero_sincronizar_miembros(uuid, uuid[])',
    'public.operativo_tablero_regularizar_admin(uuid, uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

-- 4) Backfill: el creador administra los tableros que no tienen administradores
INSERT INTO public.operativo_tablero_miembros (tablero_id, usuario_id, es_admin)
SELECT t.id, t.created_by, true
FROM public.operativo_tableros t
JOIN public.usuarios u ON u.id = t.created_by AND u.estado = 'Activo'
WHERE NOT EXISTS (
  SELECT 1 FROM public.operativo_tablero_miembros m
  WHERE m.tablero_id = t.id AND m.es_admin
)
ON CONFLICT (tablero_id, usuario_id) DO UPDATE SET es_admin = true;

-- 5) Tableros que requieren regularización manual
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT t.id, t.nombre, t.created_by
    FROM public.operativo_tableros t
    WHERE public.operativo_tablero_admins_activos(t.id) = 0
    ORDER BY t.nombre
  LOOP
    RAISE NOTICE 'Tablero sin administrador activo: "%" (id %, created_by %). Regularizar con POST /api/operations/tableros/%/regularizar-administrador.',
      r.nombre, r.id, coalesce(r.created_by::text, 'NULL'), r.id;
  END LOOP;
END $$;

COMMIT;
