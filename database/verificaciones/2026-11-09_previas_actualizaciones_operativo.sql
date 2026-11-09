-- Verificaciones PREVIAS a:
--   1) database/migrations/2026-11-09_tiempos_carga_manual_y_correcciones.sql
--   2) database/migrations/2026-11-09_comentarios_menciones_y_notificaciones.sql
--
-- SOLO LECTURA. Ejecutar por separado en nexacore_dev y en nexacore_db (no
-- asumir que tienen el mismo esquema) y guardar los resultados de cada una.
-- Si algún punto marcado [BLOQUEA] no da lo esperado, no aplicar las
-- migraciones: revisar primero qué falta en ese entorno.

-- ── 0) Identificar el entorno (comparar con la referencia administrativa) ──
SELECT current_database() AS base, current_user AS usuario, version() AS servidor, now() AS ahora;

-- ── 1) [BLOQUEA] Tablas y columnas previas ────────────────────────────────
-- Esperado: todas en true.
SELECT
  to_regclass('public.tareas')                     IS NOT NULL AS tareas,
  to_regclass('public.operativo_tableros')         IS NOT NULL AS tableros,
  to_regclass('public.operativo_tablero_miembros') IS NOT NULL AS miembros,
  to_regclass('public.tarea_asignados')            IS NOT NULL AS asignados,
  to_regclass('public.tarea_comentarios')          IS NOT NULL AS comentarios,
  to_regclass('public.tarea_registros_tiempo')     IS NOT NULL AS registros_tiempo;

-- Esperado: 5 filas (es_admin, tablero_id, fecha_finalizacion, nivel_jerarquico
-- con attnotnull = true, duracion_segundos generada con attgenerated = 's').
SELECT c.relname AS tabla, a.attname AS columna, a.attnotnull, a.attgenerated
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT a.attisdropped AND (
     (c.relname = 'operativo_tablero_miembros' AND a.attname = 'es_admin')
  OR (c.relname = 'tareas' AND a.attname IN ('tablero_id', 'fecha_finalizacion'))
  OR (c.relname = 'roles' AND a.attname = 'nivel_jerarquico')
  OR (c.relname = 'tarea_registros_tiempo' AND a.attname = 'duracion_segundos'))
ORDER BY 1, 2;

-- ── 2) [BLOQUEA] Funciones de las migraciones del 2026-11-03 ───────────────
-- Esperado: todas en true. tarea_tiempos_bloquear y tarea_tiempo_tiene_acceso
-- existen solo si se aplicó la correctiva (tiempos_integridad_y_acceso).
SELECT
  to_regprocedure('public.tarea_es_final(uuid,text)')            IS NOT NULL AS tarea_es_final,
  to_regprocedure('public.tarea_tiempo_iniciar(uuid,uuid)')      IS NOT NULL AS iniciar,
  to_regprocedure('public.tarea_tiempo_detener(uuid,uuid)')      IS NOT NULL AS detener,
  to_regprocedure('public.tarea_tiempos_bloquear()')             IS NOT NULL AS correctiva_lock,
  to_regprocedure('public.tarea_tiempo_tiene_acceso(uuid,uuid)') IS NOT NULL AS correctiva_acceso,
  to_regprocedure('public.tarea_tiempos_reconciliar()')          IS NOT NULL AS correctiva_reconciliar;

-- La RPC de inicio vigente debe ser la de la correctiva: esperado true.
-- (Si es false, alguien volvió a ejecutar la migración original después.)
SELECT position('tarea_tiempos_bloquear' IN pg_get_functiondef(p.oid)) > 0 AS iniciar_usa_correctiva
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'tarea_tiempo_iniciar';

-- ── 3) [BLOQUEA] Triggers de tiempos instalados y habilitados ─────────────
-- Esperado: trigger_tarea_registros_tiempo_proteger y
-- trigger_tarea_comentarios_edicion en sus tablas, trigger_tareas_finalizar_tiempos
-- y los diez trigger_tiempos_* de la correctiva, todos con tgenabled = 'O'.
SELECT tgrelid::regclass AS tabla, tgname, tgenabled
FROM pg_trigger
WHERE NOT tgisinternal AND tgrelid IN (
  'public.tarea_registros_tiempo'::regclass, 'public.tarea_comentarios'::regclass,
  'public.tareas'::regclass, 'public.operativo_etapas'::regclass,
  'public.operativo_tablero_miembros'::regclass, 'public.usuarios'::regclass, 'public.roles'::regclass)
ORDER BY 1, 2;

-- CHECK de motivo vigente: esperado el de la correctiva
-- ((fin IS NULL AND motivo IS NULL) OR (fin NOT NULL AND motivo NOT NULL AND motivo IN (...))).
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.tarea_registros_tiempo'::regclass AND contype = 'c'
ORDER BY conname;

-- ── 4) [BLOQUEA] Datos que la migración de tiempos rechaza ────────────────
-- Esperado: 0. La migración aborta si hay cierres sin motivo.
SELECT count(*) AS finalizados_sin_motivo
FROM public.tarea_registros_tiempo
WHERE fin IS NOT NULL AND motivo_finalizacion IS NULL;

-- Esperado: 0 (temporizadores activos de tareas finales o sin acceso).
-- Ejecutar solo si el punto 2 dio correctiva_acceso = true.
SELECT count(*) AS activos_invalidos
FROM public.tarea_registros_tiempo r JOIN public.tareas t ON t.id = r.tarea_id
WHERE r.fin IS NULL AND (public.tarea_es_final(t.etapa_id, t.estado)
  OR NOT public.tarea_tiempo_tiene_acceso(t.tablero_id, r.usuario_id));

-- ── 5) [BLOQUEA] Nombres que crean las migraciones nuevas ─────────────────
-- Esperado: todo false / 0 filas en un entorno donde todavía no se aplicaron.
-- Si ya existen, comparar su definición con las migraciones antes de seguir
-- (son idempotentes, pero no corrigen una definición distinta hecha a mano).
SELECT
  to_regclass('public.tarea_registros_tiempo_auditoria') IS NOT NULL AS auditoria,
  to_regclass('public.tarea_comentario_menciones')       IS NOT NULL AS menciones,
  to_regclass('public.notificaciones')                   IS NOT NULL AS notificaciones;

SELECT a.attname
FROM pg_attribute a
WHERE a.attrelid = 'public.tarea_registros_tiempo'::regclass AND NOT a.attisdropped
  AND a.attname IN ('origen', 'version', 'corregido_at');

SELECT p.proname
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN (
  'tarea_tiempo_registrar_manual', 'tarea_tiempo_corregir', 'tarea_tiempo_validar_intervalo',
  'tarea_registros_tiempo_proteger_alta', 'tarea_registros_tiempo_auditar',
  'tarea_comentario_crear', 'tarea_comentario_editar', 'tarea_comentario_exigir_mencionables',
  'tarea_comentario_notificar', 'notificaciones_proteger', 'tarea_comentarios_notificaciones_eliminado');

-- ── 6) Aislamiento y privilegios por defecto ──────────────────────────────
-- La correctiva exige READ COMMITTED para las RPC de tiempos (también las nuevas).
SHOW transaction_isolation;
SELECT rolname, rolconfig FROM pg_roles WHERE rolname IN ('service_role', 'authenticator', 'postgres');

-- Privilegios por defecto del esquema public: las migraciones nuevas revocan
-- explícitamente lo que estos otorguen a anon/authenticated/service_role.
SELECT defaclrole::regrole AS rol, defaclobjtype AS tipo, defaclacl AS acl
FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE n.nspname = 'public';

-- ── 7) Informativo: volumen y datos existentes ────────────────────────────
SELECT
  (SELECT count(*) FROM public.tarea_registros_tiempo)                   AS registros,
  (SELECT count(*) FROM public.tarea_registros_tiempo WHERE fin IS NULL) AS activos,
  (SELECT count(*) FROM public.tarea_registros_tiempo WHERE usuario_id IS NULL) AS sin_autor,
  (SELECT count(*) FROM public.tarea_comentarios)                        AS comentarios;

-- Comentarios existentes que ya contienen texto con forma de token
-- @[Nombre](uuid): esperado 0. Si hay, seguirán siendo texto (no menciones),
-- porque las menciones las define tarea_comentario_menciones.
SELECT count(*) AS comentarios_con_forma_de_token
FROM public.tarea_comentarios
WHERE contenido ~* '@\[[^][]{1,100}\]\([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)';

-- Superposiciones históricas del mismo usuario (informativo; se permiten).
SELECT count(*) AS pares_superpuestos
FROM public.tarea_registros_tiempo a
JOIN public.tarea_registros_tiempo b
  ON a.usuario_id = b.usuario_id AND a.id < b.id
 AND a.inicio < coalesce(b.fin, now()) AND b.inicio < coalesce(a.fin, now());
