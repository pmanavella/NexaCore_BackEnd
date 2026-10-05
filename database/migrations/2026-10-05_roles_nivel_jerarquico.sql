-- Migración: 2026-10-05_roles_nivel_jerarquico
-- Módulos: RBAC (public.roles, public.usuarios, public.rol_modulo_permisos,
--          public.usuario_modulo_permisos) — verificación de Protocolos.
--
-- Objetivo:
--   Separar el ROL FUNCIONAL del usuario de su NIVEL JERÁRQUICO interno, y
--   normalizar los roles redundantes.
--
--   Roles definitivos (seleccionables) y su nivel:
--     Superadmin        -> HIGH    (mando alto)
--     Dirección         -> HIGH    (mando alto)
--     Comercial         -> MEDIUM  (mando medio)
--     Contable          -> LOW     (mando bajo)
--     Operativo         -> LOW     (mando bajo)
--     Auditor / Lector  -> LOW     (mando bajo)
--     Pasante           -> LOW     (mando bajo)
--     Externo           -> NONE    (sin mando)
--
--   Roles legacy:
--     Director    -> se normaliza a "Dirección".
--     Operario    -> se normaliza a "Operativo".
--     Mando Medio -> NO se convierte a ningún rol funcional. Se conserva con
--                    nivel MEDIUM y queda inactivo (no seleccionable) hasta que
--                    sus usuarios sean reasignados manualmente.
--
--   La relación rol -> nivel queda en public.roles.nivel_jerarquico, que es la
--   fuente de verdad que lee el backend (rbac/config/jerarquia.js).
--
-- Esta migración:
--   1) Agrega public.roles.nivel_jerarquico (text, CHECK HIGH/MEDIUM/LOW/NONE,
--      NOT NULL al final) y public.roles.activo (boolean NOT NULL DEFAULT true;
--      false = legacy, se conserva para referencias existentes pero no se
--      puede asignar).
--   2) Si un rol definitivo existe escrito con otra variante (ej. "Direccion",
--      "Auditor/Lector") y no existe con el nombre exacto, lo renombra en el
--      lugar (mismo id: conserva usuarios, permisos y FKs).
--   3) Director / Operario:
--        - Si el rol definitivo NO existe: renombra el legacy en el lugar
--          (mismo id, cero movimiento de FKs).
--        - Si ambos existen: por cada usuario del rol legacy, materializa en
--          usuario_modulo_permisos los accesos del rol legacy que sean MAYORES
--          que los del rol definitivo (para que nadie pierda acceso; nunca
--          pisa un permiso particular ya existente), mueve usuarios.rol_id al
--          rol definitivo y deja el legacy inactivo SIN borrarlo.
--   4) Inserta los roles definitivos que falten (sin permisos de módulo: se
--      configuran desde la Matriz de permisos).
--   5) Backfill de nivel_jerarquico y activo. Cualquier otro rol no previsto
--      queda LOW + inactivo (sus usuarios lo conservan) y se informa.
--   6) Verificaciones: no quedan usuarios en Director/Operario cuando existe el
--      rol definitivo (si los hay, ROLLBACK por excepción); avisa usuarios que
--      siguen en roles legacy, roles definitivos sin permisos y si las FKs de
--      protocolo_items / protocolo_pruebas no son ON DELETE CASCADE (lo que
--      requiere DELETE /api/protocolos/:id).
--
-- No borra filas de roles, usuarios, permisos ni organigrama. No modifica FKs.
-- Idempotente: puede correrse más de una vez sin error (DEV y PROD).
-- Al final hay un SELECT de solo lectura con los usuarios pendientes de
-- reasignación funcional (lo muestra el SQL Editor de Supabase).

BEGIN;

-- Normaliza nombres de rol para comparar variantes: sin espacios, minúsculas y
-- sin tildes. Función temporal: desaparece al cerrar la sesión.
CREATE OR REPLACE FUNCTION pg_temp.nx_norm_rol(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(translate(regexp_replace(coalesce(t, ''), '\s+', '', 'g'),
                         'áéíóúÁÉÍÓÚ', 'aeiouAEIOU'))
$$;

-- 1) Columnas nuevas
ALTER TABLE public.roles
  ADD COLUMN IF NOT EXISTS nivel_jerarquico text;

ALTER TABLE public.roles
  ADD COLUMN IF NOT EXISTS activo boolean NOT NULL DEFAULT true;

-- Catálogo de roles definitivos (solo vive durante la transacción)
CREATE TEMP TABLE nx_roles_definitivos (
  nombre      text PRIMARY KEY,
  nivel       text NOT NULL,
  descripcion text
) ON COMMIT DROP;

INSERT INTO nx_roles_definitivos (nombre, nivel, descripcion) VALUES
  ('Superadmin',       'HIGH',   'Administración total del sistema'),
  ('Dirección',        'HIGH',   'Dirección de la empresa'),
  ('Comercial',        'MEDIUM', 'Área comercial'),
  ('Contable',         'LOW',    'Área contable'),
  ('Operativo',        'LOW',    'Área operativa'),
  ('Auditor / Lector', 'LOW',    'Acceso de consulta / auditoría'),
  ('Pasante',          'LOW',    'Pasantes'),
  ('Externo',          'NONE',   'Personas externas a la organización');

-- 2) Variantes de escritura de roles definitivos -> nombre exacto
DO $$
DECLARE
  d       record;
  v_ids   uuid[];
BEGIN
  FOR d IN SELECT nombre FROM nx_roles_definitivos LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.roles WHERE nombre = d.nombre);

    SELECT array_agg(id) INTO v_ids
    FROM public.roles
    WHERE pg_temp.nx_norm_rol(nombre) = pg_temp.nx_norm_rol(d.nombre);

    IF coalesce(array_length(v_ids, 1), 0) = 1 THEN
      UPDATE public.roles SET nombre = d.nombre WHERE id = v_ids[1];
      RAISE NOTICE 'Rol renombrado a "%" (id %).', d.nombre, v_ids[1];
    ELSIF coalesce(array_length(v_ids, 1), 0) > 1 THEN
      RAISE NOTICE 'Hay % variantes de "%" (ids %). No se renombra ninguna: revisar manualmente.',
        array_length(v_ids, 1), d.nombre, v_ids;
    END IF;
  END LOOP;
END $$;

-- 3) Director -> Dirección, Operario -> Operativo
DO $$
DECLARE
  par           record;
  legacy        record;
  v_canon_id    uuid;
  v_permisos    integer;
  v_usuarios    integer;
BEGIN
  FOR par IN
    SELECT * FROM (VALUES ('Director', 'Dirección'), ('Operario', 'Operativo')) AS p(legacy, canonico)
  LOOP
    SELECT id INTO v_canon_id FROM public.roles WHERE nombre = par.canonico;

    FOR legacy IN
      SELECT id, nombre FROM public.roles
      WHERE pg_temp.nx_norm_rol(nombre) = pg_temp.nx_norm_rol(par.legacy)
        AND id IS DISTINCT FROM v_canon_id
      ORDER BY created_at
    LOOP
      IF v_canon_id IS NULL THEN
        -- No existe el rol definitivo: se renombra el legacy (mismo id).
        UPDATE public.roles SET nombre = par.canonico WHERE id = legacy.id;
        v_canon_id := legacy.id;
        RAISE NOTICE 'Rol "%" renombrado a "%" (id %). Usuarios y permisos intactos.',
          legacy.nombre, par.canonico, legacy.id;
        CONTINUE;
      END IF;

      -- Ambos existen: preservar el acceso efectivo de cada usuario movido.
      -- Nivel por rol = 0 sin acceso, 1 lector, 2 editor (misma lógica que
      -- organizacionService.obtenerPermisosUsuario: requiere puede_ver).
      INSERT INTO public.usuario_modulo_permisos (usuario_id, modulo_id, permiso, alcance)
      SELECT u.id,
             lp.modulo_id,
             (CASE WHEN lp.puede_editar THEN 'editor' ELSE 'lector' END)::public.tipo_permiso,
             'global'::public.tipo_alcance
      FROM public.usuarios u
      JOIN public.rol_modulo_permisos lp
        ON lp.rol_id = legacy.id AND lp.puede_ver IS TRUE
      LEFT JOIN public.rol_modulo_permisos cp
        ON cp.rol_id = v_canon_id AND cp.modulo_id = lp.modulo_id
      WHERE u.rol_id = legacy.id
        AND (CASE WHEN lp.puede_editar THEN 2 ELSE 1 END)
          > (CASE WHEN cp.puede_ver IS TRUE THEN (CASE WHEN cp.puede_editar THEN 2 ELSE 1 END) ELSE 0 END)
      ON CONFLICT (usuario_id, modulo_id) DO NOTHING;
      GET DIAGNOSTICS v_permisos = ROW_COUNT;

      UPDATE public.usuarios SET rol_id = v_canon_id WHERE rol_id = legacy.id;
      GET DIAGNOSTICS v_usuarios = ROW_COUNT;

      UPDATE public.roles
      SET activo = false,
          descripcion = CASE
            WHEN coalesce(descripcion, '') LIKE 'LEGACY%' THEN descripcion
            ELSE 'LEGACY: reemplazado por "' || par.canonico || '". ' || coalesce(descripcion, '')
          END
      WHERE id = legacy.id;

      RAISE NOTICE 'Rol "%" -> "%": % usuario(s) migrado(s), % permiso(s) particular(es) creados para no perder acceso. El rol legacy queda inactivo (id %).',
        legacy.nombre, par.canonico, v_usuarios, v_permisos, legacy.id;
    END LOOP;
  END LOOP;
END $$;

-- 4) Roles definitivos faltantes
INSERT INTO public.roles (nombre, descripcion, nivel_jerarquico, activo)
SELECT d.nombre, d.descripcion, d.nivel, true
FROM nx_roles_definitivos d
WHERE NOT EXISTS (SELECT 1 FROM public.roles r WHERE r.nombre = d.nombre)
ON CONFLICT (nombre) DO NOTHING;

-- 5) Backfill de nivel_jerarquico / activo
-- 5a) Definitivos: nivel según catálogo, seleccionables.
UPDATE public.roles r
SET nivel_jerarquico = d.nivel,
    activo = true
FROM nx_roles_definitivos d
WHERE r.nombre = d.nombre;

-- 5b) Legacy conocidos que sigan existiendo: inactivos con su nivel histórico.
UPDATE public.roles
SET nivel_jerarquico = CASE pg_temp.nx_norm_rol(nombre)
                         WHEN 'director'   THEN 'HIGH'
                         WHEN 'operario'   THEN 'LOW'
                         WHEN 'mandomedio' THEN 'MEDIUM'
                       END,
    activo = false
WHERE pg_temp.nx_norm_rol(nombre) IN ('director', 'operario', 'mandomedio')
  AND nombre NOT IN (SELECT nombre FROM nx_roles_definitivos);

UPDATE public.roles
SET descripcion = 'LEGACY: pendiente de reasignación funcional manual de sus usuarios. ' || coalesce(descripcion, '')
WHERE pg_temp.nx_norm_rol(nombre) = 'mandomedio'
  AND coalesce(descripcion, '') NOT LIKE 'LEGACY%';

-- 5c) Cualquier otro rol no previsto: LOW + inactivo (sus usuarios lo conservan).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT ro.id, ro.nombre, (SELECT count(*) FROM public.usuarios u WHERE u.rol_id = ro.id) AS usuarios
    FROM public.roles ro
    WHERE ro.nivel_jerarquico IS NULL
  LOOP
    RAISE NOTICE 'Rol no previsto "%" (id %, % usuario(s)): queda LOW e inactivo. Reasignar sus usuarios manualmente.',
      r.nombre, r.id, r.usuarios;
  END LOOP;
END $$;

UPDATE public.roles
SET nivel_jerarquico = 'LOW',
    activo = false
WHERE nivel_jerarquico IS NULL;

-- Restricciones finales
ALTER TABLE public.roles
  DROP CONSTRAINT IF EXISTS roles_nivel_jerarquico_check;

ALTER TABLE public.roles
  ADD CONSTRAINT roles_nivel_jerarquico_check
  CHECK (nivel_jerarquico IN ('HIGH', 'MEDIUM', 'LOW', 'NONE'));

ALTER TABLE public.roles
  ALTER COLUMN nivel_jerarquico SET NOT NULL;

COMMENT ON COLUMN public.roles.nivel_jerarquico IS 'Nivel jerárquico interno derivado del rol: HIGH (mando alto), MEDIUM (mando medio), LOW (mando bajo), NONE (sin mando / externos). Fuente de verdad que usa el backend (rbac/config/jerarquia.js). No editable por usuarios finales.';
COMMENT ON COLUMN public.roles.activo IS 'true = rol vigente y asignable. false = rol legacy: se conserva para los usuarios que aún lo tienen, pero el backend no permite asignarlo.';

-- 6) Verificaciones
DO $$
DECLARE
  r          record;
  v_pend     integer;
BEGIN
  -- Director/Operario no deben conservar usuarios si existe el rol definitivo.
  SELECT count(*) INTO v_pend
  FROM public.usuarios u
  JOIN public.roles ro ON ro.id = u.rol_id
  WHERE pg_temp.nx_norm_rol(ro.nombre) IN ('director', 'operario')
    AND ro.nombre NOT IN (SELECT nombre FROM nx_roles_definitivos);
  IF v_pend > 0 THEN
    RAISE EXCEPTION 'Quedaron % usuario(s) en Director/Operario tras la normalización. Se revierte la migración.', v_pend;
  END IF;

  -- Usuarios en roles legacy / inactivos (incluye Mando Medio): requieren reasignación manual.
  FOR r IN
    SELECT u.id, u.nombre, u.email, u.estado, ro.nombre AS rol
    FROM public.usuarios u
    JOIN public.roles ro ON ro.id = u.rol_id
    WHERE ro.activo = false
    ORDER BY ro.nombre, u.nombre
  LOOP
    RAISE NOTICE 'Pendiente de reasignación funcional: % <%> (id %, %) — rol actual "%".',
      r.nombre, r.email, r.id, r.estado, r.rol;
  END LOOP;

  -- Roles definitivos sin ningún permiso de módulo configurado.
  FOR r IN
    SELECT ro.nombre FROM public.roles ro
    WHERE ro.activo = true
      AND NOT EXISTS (SELECT 1 FROM public.rol_modulo_permisos p WHERE p.rol_id = ro.id AND p.puede_ver)
  LOOP
    RAISE NOTICE 'El rol "%" no tiene permisos de módulo: configurarlos desde la Matriz de permisos.', r.nombre;
  END LOOP;

  -- DELETE /api/protocolos/:id depende de que los hijos se borren en cascada.
  FOR r IN
    SELECT c.conname, c.conrelid::regclass AS tabla, c.confdeltype
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.confrelid = 'public.protocolos'::regclass
      AND c.confdeltype <> 'c'
  LOOP
    RAISE NOTICE 'La FK % de % hacia protocolos no es ON DELETE CASCADE (confdeltype=%). DELETE /api/protocolos/:id devolverá 409 mientras haya filas relacionadas.',
      r.conname, r.tabla, r.confdeltype;
  END LOOP;
END $$;

COMMIT;

-- Reporte (solo lectura): usuarios que siguen en un rol legacy/inactivo y
-- deben reasignarse a un rol funcional definitivo desde Administración de usuarios.
SELECT u.id, u.nombre, u.email, u.estado, r.nombre AS rol_actual, r.nivel_jerarquico
FROM public.usuarios u
JOIN public.roles r ON r.id = u.rol_id
WHERE r.activo = false
ORDER BY r.nombre, u.nombre;
