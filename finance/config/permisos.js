// RN-02 — Acceso al módulo Financiero (docs/convencion-identificadores.md, sección 6).
// Se usan DESPUÉS de authenticate.
const { requireHierarchy, requireHierarchyOrModulePermission } = require('../../middleware/rbacMiddleware');
const { NIVELES_JERARQUICOS } = require('../../rbac/config/jerarquia');

const MANDO_ALTO = [NIVELES_JERARQUICOS.HIGH];

// Finanzas: mando alto, o permiso POR USUARIO en el módulo 'finance' de nivel lector (consulta)
// o editor (carga). El permiso cargado por rol no habilita a quien no es mando alto.
const SOLO_PERMISO_USUARIO = { soloPermisoUsuario: true };
const consultaFinanzas = requireHierarchyOrModulePermission(MANDO_ALTO, 'finance', 'lector', 'Finanzas', SOLO_PERMISO_USUARIO);
const cargaFinanzas = requireHierarchyOrModulePermission(MANDO_ALTO, 'finance', 'editor', 'Finanzas', SOLO_PERMISO_USUARIO);

// Sueldos, trazabilidad y confirmar/revertir migraciones: solo mando alto, sin importar el permiso.
const soloMandoAlto = requireHierarchy(...MANDO_ALTO);

module.exports = { consultaFinanzas, cargaFinanzas, soloMandoAlto };
