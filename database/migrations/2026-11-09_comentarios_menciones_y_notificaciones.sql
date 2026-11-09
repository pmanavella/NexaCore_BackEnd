-- Migración: 2026-11-09_comentarios_menciones_y_notificaciones
-- Módulo: Operativo (public.tarea_comentarios) + notificaciones internas
--
-- Objetivo:
--   Menciones con @ en los comentarios de una tarea y notificaciones
--   persistentes por usuario (complementarias del Centro de Alertas, que sigue
--   calculándose bajo demanda y no se modifica).
--
-- Reglas (definidas por el cliente):
--   - Solo se menciona a miembros ACTIVOS del tablero de la tarea (no hace
--     falta estar asignado; el mando alto que no es miembro NO es mencionable).
--   - Las menciones se identifican por id de usuario; sin duplicados.
--   - La automención no notifica.
--   - Al editar, solo notifican los usuarios mencionados por primera vez en ese
--     comentario (nunca se repite una notificación por el mismo comentario).
--   - Si se elimina el comentario, la notificación se conserva y queda marcada
--     como de comentario eliminado.
--
-- Esta migración:
--   1) Crea public.tarea_comentario_menciones (comentario_id, usuario_id):
--      menciones vigentes de cada comentario. CASCADE con el comentario y con
--      el usuario. El texto visible lleva tokens @[Nombre](uuid) (contrato en
--      docs/operativo-actualizaciones-contratos.md); esta tabla es la fuente
--      de verdad de a quién menciona.
--   2) Crea public.notificaciones (destinatario, tipo, autor, tarea,
--      comentario, leida_at, comentario_eliminado_at).
--        - comentario_id SIN clave foránea, a propósito: la notificación
--          sobrevive a la eliminación del comentario. Un trigger AFTER DELETE
--          en tarea_comentarios completa comentario_eliminado_at.
--        - tarea_id -> tareas ON DELETE CASCADE (mismo criterio que
--          comentarios, tiempos e historial de la tarea).
--        - Único (destinatario_id, tipo, comentario_id): sin duplicados.
--        - Solo leida_at es modificable por el backend (privilegio de columna)
--          y solo de NULL a la hora del servidor.
--   3) Funciones (solo service_role), atómicas:
--        - tarea_comentario_crear(tarea, autor, contenido, mencionados[])
--        - tarea_comentario_editar(comentario, tarea, autor, contenido, mencionados[])
--      Guardan comentario, menciones y notificaciones en una transacción.
--      La membresía activa se verifica con las filas bloqueadas (FOR SHARE).
--      Son SECURITY DEFINER porque son el único camino de escritura de las
--      tablas nuevas (service_role solo tiene SELECT sobre las menciones).
--   4) RLS "Backend service_role only" en las tablas nuevas.
--
-- Requiere: 2026-11-03_tareas_comentarios_y_tiempos,
-- 2026-11-03_tiempos_integridad_y_acceso (tarea_tiempo_tiene_acceso) y
-- 2026-11-02_tableros_administradores. Aborta si faltan.
--
-- No modifica comentarios existentes: quedan sin menciones y se siguen
-- mostrando igual. No cambia la eliminación de comentarios (física, solo el
-- autor, desde el backend).
-- Idempotente: puede correrse más de una vez.
--
-- Orden: después de 2026-11-09_tiempos_carga_manual_y_correcciones y ANTES
-- de desplegar el backend. Primero nexacore_dev, después nexacore_db.
--
-- NO afecta finance, movimientos, comprobantes, OCR, excel, deudas, empleados,
-- salarios, movimientos_salario, suscripciones, migraciones,
-- inversiones_historicas, sueldos_historicos, cuentas_por_cobrar
-- ni conciliaciones_migracion.

BEGIN;

-- ── 0) Prerrequisitos ────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.tarea_comentarios') IS NULL THEN
    RAISE EXCEPTION 'Requiere 2026-11-03_tareas_comentarios_y_tiempos';
  END IF;
  IF to_regprocedure('public.tarea_tiempo_tiene_acceso(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Requiere 2026-11-03_tiempos_integridad_y_acceso';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                 WHERE attrelid = 'public.operativo_tablero_miembros'::regclass
                   AND attname = 'es_admin' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Requiere 2026-11-02_tableros_administradores';
  END IF;
END;
$$;

-- ── 1) Menciones ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tarea_comentario_menciones (
  comentario_id uuid NOT NULL REFERENCES public.tarea_comentarios(id) ON DELETE CASCADE,
  usuario_id    uuid NOT NULL REFERENCES public.usuarios(id)          ON DELETE CASCADE,
  created_at    timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT tarea_comentario_menciones_pkey PRIMARY KEY (comentario_id, usuario_id)
);

COMMENT ON TABLE public.tarea_comentario_menciones IS 'Usuarios mencionados (vigentes) en cada comentario de tarea. Fuente de verdad de las menciones; el texto lleva tokens @[Nombre](uuid). Se escribe solo con tarea_comentario_crear / tarea_comentario_editar.';

CREATE INDEX IF NOT EXISTS idx_tarea_comentario_menciones_usuario
  ON public.tarea_comentario_menciones (usuario_id);

-- ── 2) Notificaciones ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.notificaciones (
  id                      uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  destinatario_id         uuid NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  tipo                    text NOT NULL,
  autor_id                uuid          REFERENCES public.usuarios(id) ON DELETE SET NULL,
  tarea_id                uuid NOT NULL REFERENCES public.tareas(id)   ON DELETE CASCADE,
  comentario_id           uuid NOT NULL,
  comentario_eliminado_at timestamp with time zone,
  created_at              timestamp with time zone NOT NULL DEFAULT now(),
  leida_at                timestamp with time zone,
  CONSTRAINT notificaciones_tipo_check CHECK (tipo IN ('mencion_comentario')),
  CONSTRAINT notificaciones_autonotificacion_check CHECK (autor_id IS NULL OR autor_id <> destinatario_id)
);

COMMENT ON TABLE public.notificaciones IS 'Notificaciones internas persistentes por usuario (hoy: menciones en comentarios de tareas). Complementan al Centro de Alertas. Se crean solo con las funciones tarea_comentario_*; el backend solo marca leida_at.';
COMMENT ON COLUMN public.notificaciones.comentario_id IS 'Comentario que originó la notificación. Sin FK a propósito: la notificación se conserva si el comentario se elimina (ver comentario_eliminado_at).';
COMMENT ON COLUMN public.notificaciones.comentario_eliminado_at IS 'Momento en que se eliminó el comentario (NULL si existe). Lo completa trigger_tarea_comentarios_notificaciones_eliminado.';
COMMENT ON COLUMN public.notificaciones.leida_at IS 'NULL = no leída. Una vez leída no vuelve a NULL; la hora la pone la base.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_notificaciones_destinatario_tipo_comentario
  ON public.notificaciones (destinatario_id, tipo, comentario_id);
CREATE INDEX IF NOT EXISTS idx_notificaciones_destinatario_fecha
  ON public.notificaciones (destinatario_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notificaciones_destinatario_no_leidas
  ON public.notificaciones (destinatario_id) WHERE leida_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notificaciones_comentario
  ON public.notificaciones (comentario_id);
CREATE INDEX IF NOT EXISTS idx_notificaciones_tarea
  ON public.notificaciones (tarea_id);
CREATE INDEX IF NOT EXISTS idx_notificaciones_autor
  ON public.notificaciones (autor_id);

-- Solo cambian: leida_at (de NULL a la hora del servidor, una vez),
-- comentario_eliminado_at (de NULL, una vez) y autor_id a NULL (FK SET NULL).
CREATE OR REPLACE FUNCTION public.notificaciones_proteger()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.destinatario_id IS DISTINCT FROM OLD.destinatario_id
     OR NEW.tipo IS DISTINCT FROM OLD.tipo
     OR NEW.tarea_id IS DISTINCT FROM OLD.tarea_id
     OR NEW.comentario_id IS DISTINCT FROM OLD.comentario_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.autor_id IS DISTINCT FROM OLD.autor_id AND NEW.autor_id IS NOT NULL)
     OR (OLD.leida_at IS NOT NULL AND NEW.leida_at IS DISTINCT FROM OLD.leida_at)
     OR (OLD.comentario_eliminado_at IS NOT NULL
         AND NEW.comentario_eliminado_at IS DISTINCT FROM OLD.comentario_eliminado_at) THEN
    RAISE EXCEPTION 'NX_NOTIFICACION_INMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.leida_at IS NULL AND NEW.leida_at IS NOT NULL THEN
    NEW.leida_at := now();
  END IF;
  IF OLD.comentario_eliminado_at IS NULL AND NEW.comentario_eliminado_at IS NOT NULL THEN
    NEW.comentario_eliminado_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_notificaciones_proteger ON public.notificaciones;
CREATE TRIGGER trigger_notificaciones_proteger
  BEFORE UPDATE ON public.notificaciones
  FOR EACH ROW EXECUTE FUNCTION public.notificaciones_proteger();

-- Al eliminar un comentario, sus notificaciones se conservan marcadas. Si el
-- borrado viene en cascada de la eliminación de la tarea, no se marca nada:
-- esas notificaciones se eliminan con la tarea.
CREATE OR REPLACE FUNCTION public.tarea_comentarios_notificaciones_eliminado()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tareas WHERE id = OLD.tarea_id) THEN
    UPDATE public.notificaciones
    SET comentario_eliminado_at = now()
    WHERE comentario_id = OLD.id AND comentario_eliminado_at IS NULL;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trigger_tarea_comentarios_notificaciones_eliminado ON public.tarea_comentarios;
CREATE TRIGGER trigger_tarea_comentarios_notificaciones_eliminado
  AFTER DELETE ON public.tarea_comentarios
  FOR EACH ROW EXECUTE FUNCTION public.tarea_comentarios_notificaciones_eliminado();

-- ── 3) Funciones de comentarios con menciones ───────────────────────────────

-- Exige que todos los p_usuario_ids sean miembros ACTIVOS del tablero. Bloquea
-- esas membresías y perfiles (FOR SHARE) hasta el fin de la transacción: una
-- baja o desactivación concurrente espera, y si ganó antes, se rechaza.
CREATE OR REPLACE FUNCTION public.tarea_comentario_exigir_mencionables(p_tablero_id uuid, p_usuario_ids uuid[])
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_validos integer;
BEGIN
  IF coalesce(cardinality(p_usuario_ids), 0) = 0 THEN
    RETURN;
  END IF;
  IF p_tablero_id IS NULL THEN
    RAISE EXCEPTION 'NX_MENCION_INVALIDA' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1
  FROM public.operativo_tablero_miembros m
  JOIN public.usuarios u ON u.id = m.usuario_id
  WHERE m.tablero_id = p_tablero_id AND m.usuario_id = ANY (p_usuario_ids)
  FOR SHARE OF m, u;

  SELECT count(*) INTO v_validos
  FROM public.operativo_tablero_miembros m
  JOIN public.usuarios u ON u.id = m.usuario_id
  WHERE m.tablero_id = p_tablero_id AND m.usuario_id = ANY (p_usuario_ids)
    AND u.estado = 'Activo';
  IF v_validos <> cardinality(p_usuario_ids) THEN
    RAISE EXCEPTION 'NX_MENCION_INVALIDA' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Notifica a p_usuario_ids (salvo al autor) por el comentario. ON CONFLICT:
-- nunca dos notificaciones del mismo comentario para la misma persona.
CREATE OR REPLACE FUNCTION public.tarea_comentario_notificar(
  p_comentario_id uuid, p_tarea_id uuid, p_autor_id uuid, p_usuario_ids uuid[])
RETURNS void LANGUAGE sql SET search_path = public AS $$
  INSERT INTO public.notificaciones (destinatario_id, tipo, autor_id, tarea_id, comentario_id)
  SELECT x, 'mencion_comentario', p_autor_id, p_tarea_id, p_comentario_id
  FROM unnest(coalesce(p_usuario_ids, ARRAY[]::uuid[])) AS x
  WHERE x IS DISTINCT FROM p_autor_id
  ON CONFLICT (destinatario_id, tipo, comentario_id) DO NOTHING;
$$;

CREATE OR REPLACE FUNCTION public.tarea_comentario_crear(
  p_tarea_id uuid, p_autor_id uuid, p_contenido text, p_mencionados uuid[])
RETURNS public.tarea_comentarios
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tablero_id uuid;
  v_ids uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(coalesce(p_mencionados, ARRAY[]::uuid[])) AS x WHERE x IS NOT NULL);
  v_comentario public.tarea_comentarios;
BEGIN
  IF p_autor_id IS NULL THEN
    RAISE EXCEPTION 'NX_USUARIO_REQUERIDO' USING ERRCODE = 'P0001';
  END IF;
  SELECT t.tablero_id INTO v_tablero_id FROM public.tareas t WHERE t.id = p_tarea_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NX_TAREA_NO_ENCONTRADA' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.tarea_tiempo_tiene_acceso(v_tablero_id, p_autor_id) THEN
    RAISE EXCEPTION 'NX_SIN_ACCESO_TAREA' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.tarea_comentario_exigir_mencionables(v_tablero_id, v_ids);

  INSERT INTO public.tarea_comentarios (tarea_id, usuario_id, contenido)
  VALUES (p_tarea_id, p_autor_id, p_contenido)
  RETURNING * INTO v_comentario;

  INSERT INTO public.tarea_comentario_menciones (comentario_id, usuario_id)
  SELECT v_comentario.id, x FROM unnest(v_ids) AS x
  ON CONFLICT DO NOTHING;

  PERFORM public.tarea_comentario_notificar(v_comentario.id, p_tarea_id, p_autor_id, v_ids);
  RETURN v_comentario;
END;
$$;

-- Edición por el autor. p_mencionados es la lista COMPLETA de menciones del
-- texto nuevo. Se valida la membresía activa solo de las menciones nuevas
-- (las que ya estaban se conservan aunque la persona haya dejado el tablero,
-- mismo criterio que los responsables de una tarea). Las quitadas del texto
-- dejan de ser menciones; sus notificaciones ya enviadas se conservan.
CREATE OR REPLACE FUNCTION public.tarea_comentario_editar(
  p_comentario_id uuid, p_tarea_id uuid, p_autor_id uuid, p_contenido text, p_mencionados uuid[])
RETURNS public.tarea_comentarios
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tablero_id uuid;
  v_ids uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(coalesce(p_mencionados, ARRAY[]::uuid[])) AS x WHERE x IS NOT NULL);
  v_nuevos uuid[];
  v_comentario public.tarea_comentarios;
BEGIN
  IF p_autor_id IS NULL THEN
    RAISE EXCEPTION 'NX_USUARIO_REQUERIDO' USING ERRCODE = 'P0001';
  END IF;
  SELECT t.tablero_id INTO v_tablero_id FROM public.tareas t WHERE t.id = p_tarea_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NX_TAREA_NO_ENCONTRADA' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.tarea_tiempo_tiene_acceso(v_tablero_id, p_autor_id) THEN
    RAISE EXCEPTION 'NX_SIN_ACCESO_TAREA' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_comentario FROM public.tarea_comentarios
  WHERE id = p_comentario_id AND tarea_id = p_tarea_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NX_COMENTARIO_NO_ENCONTRADO' USING ERRCODE = 'P0001';
  END IF;
  IF v_comentario.usuario_id IS DISTINCT FROM p_autor_id THEN
    RAISE EXCEPTION 'NX_COMENTARIO_AJENO' USING ERRCODE = 'P0001';
  END IF;

  v_nuevos := ARRAY(
    SELECT x FROM unnest(v_ids) AS x
    WHERE NOT EXISTS (SELECT 1 FROM public.tarea_comentario_menciones m
                      WHERE m.comentario_id = p_comentario_id AND m.usuario_id = x));
  PERFORM public.tarea_comentario_exigir_mencionables(v_tablero_id, v_nuevos);

  UPDATE public.tarea_comentarios SET contenido = p_contenido
  WHERE id = p_comentario_id
  RETURNING * INTO v_comentario;

  DELETE FROM public.tarea_comentario_menciones
  WHERE comentario_id = p_comentario_id AND NOT (usuario_id = ANY (v_ids));
  INSERT INTO public.tarea_comentario_menciones (comentario_id, usuario_id)
  SELECT p_comentario_id, x FROM unnest(v_nuevos) AS x
  ON CONFLICT DO NOTHING;

  PERFORM public.tarea_comentario_notificar(p_comentario_id, p_tarea_id, p_autor_id, v_nuevos);
  RETURN v_comentario;
END;
$$;

-- ── 4) Permisos y RLS ────────────────────────────────────────────────────────

ALTER TABLE public.tarea_comentario_menciones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Backend service_role only" ON public.tarea_comentario_menciones;
CREATE POLICY "Backend service_role only" ON public.tarea_comentario_menciones
  USING (auth.role() = 'service_role'::text)
  WITH CHECK (auth.role() = 'service_role'::text);

ALTER TABLE public.notificaciones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Backend service_role only" ON public.notificaciones;
CREATE POLICY "Backend service_role only" ON public.notificaciones
  USING (auth.role() = 'service_role'::text)
  WITH CHECK (auth.role() = 'service_role'::text);

-- service_role: lee ambas tablas y solo puede escribir notificaciones.leida_at.
-- Las altas las hacen las funciones SECURITY DEFINER; las cascadas, el dueño.
REVOKE ALL ON TABLE public.tarea_comentario_menciones, public.notificaciones
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.tarea_comentario_menciones, public.notificaciones TO service_role;
GRANT UPDATE (leida_at) ON TABLE public.notificaciones TO service_role;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.notificaciones_proteger()',
    'public.tarea_comentarios_notificaciones_eliminado()',
    'public.tarea_comentario_exigir_mencionables(uuid, uuid[])',
    'public.tarea_comentario_notificar(uuid, uuid, uuid, uuid[])',
    'public.tarea_comentario_crear(uuid, uuid, text, uuid[])',
    'public.tarea_comentario_editar(uuid, uuid, uuid, text, uuid[])'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.tarea_comentario_crear(uuid, uuid, text, uuid[])',
    'public.tarea_comentario_editar(uuid, uuid, uuid, text, uuid[])'
  ] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END;
$$;

COMMIT;

-- Verificación (solo lectura).
-- a) Tablas con RLS activo.
SELECT c.relname AS tabla, c.relrowsecurity AS rls
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('tarea_comentario_menciones', 'notificaciones');

-- b) notificaciones.comentario_id NO debe tener clave foránea: debe devolver 0.
SELECT count(*) AS fk_comentario
FROM pg_constraint
WHERE conrelid = 'public.notificaciones'::regclass AND contype = 'f'
  AND conkey @> ARRAY[(SELECT attnum FROM pg_attribute
                       WHERE attrelid = 'public.notificaciones'::regclass AND attname = 'comentario_id')];

-- c) Privilegios efectivos de service_role (esperado: SELECT en ambas; UPDATE solo en leida_at).
SELECT table_name, privilege_type FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee = 'service_role'
  AND table_name IN ('tarea_comentario_menciones', 'notificaciones');
SELECT column_name, privilege_type FROM information_schema.column_privileges
WHERE table_schema = 'public' AND table_name = 'notificaciones' AND grantee = 'service_role'
  AND privilege_type = 'UPDATE';
