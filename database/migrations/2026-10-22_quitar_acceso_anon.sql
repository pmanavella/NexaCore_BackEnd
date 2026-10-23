-- DEF-018 (#39) · La clave pública (anon) permitía leer y modificar tablas sensibles.
--
-- Causa: la política "Allow all for anon" (USING true / WITH CHECK true, sin rol
-- destinatario, o sea para todos) más GRANT ALL al rol anon. Como las políticas de
-- RLS se combinan con OR, anulaba a "Backend service_role only" y cualquiera con
-- la clave del frontend podía leer sueldos y asignarse permisos sin iniciar sesión.
--
-- Corrección: se elimina esa política y se quitan los privilegios de anon en esas
-- tablas. No afecta al backend (usa service_role, que no pasa por RLS) ni al
-- frontend: este solo lee `usuarios` y `roles` después de iniciar sesión, y eso lo
-- siguen permitiendo las políticas "Authenticated can read usuarios/roles".
--
-- Se ejecuta en el SQL Editor de Supabase, una vez por base (nexacore-test,
-- Developer y producción), según la convención de database/migrations/.

BEGIN;

DROP POLICY IF EXISTS "Allow all for anon" ON public.usuarios;
DROP POLICY IF EXISTS "Allow all for anon" ON public.roles;
DROP POLICY IF EXISTS "Allow all for anon" ON public.usuario_modulo_permisos;
DROP POLICY IF EXISTS "Allow all for anon" ON public.rol_modulo_permisos;
DROP POLICY IF EXISTS "Allow all for anon" ON public.modulos;
DROP POLICY IF EXISTS "Allow all for anon" ON public.empleados;
DROP POLICY IF EXISTS "Allow all for anon" ON public.salarios;
DROP POLICY IF EXISTS "Allow all for anon" ON public.movimientos_salario;
DROP POLICY IF EXISTS "Allow all for anon" ON public.categorias_salariales;
DROP POLICY IF EXISTS "Allow all for anon" ON public.organigrama;
DROP POLICY IF EXISTS "Allow all for anon" ON public.integracion_movimientos_financieros;

REVOKE ALL ON TABLE
  public.usuarios, public.roles, public.usuario_modulo_permisos, public.rol_modulo_permisos,
  public.modulos, public.empleados, public.salarios, public.movimientos_salario,
  public.categorias_salariales, public.organigrama, public.integracion_movimientos_financieros
FROM anon;

COMMIT;

-- Verificación: debe devolver 0 filas.
SELECT tablename, policyname
FROM pg_policies
WHERE schemaname = 'public' AND policyname = 'Allow all for anon';
