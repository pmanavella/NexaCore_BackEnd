const organizacionService = require('../../organization/services/organizacionService');
const { resolverNivelPermiso } = require('../../middleware/rbacMiddleware');

// Autorización de Nexi sobre la Matriz de permisos real
// (usuario_modulo_permisos > rol_modulo_permisos), con la misma resolución de
// niveles que requireModulePermission. Nunca usa datos provistos por el modelo.

const NIVELES = ['sin_acceso', 'lector', 'editor', 'administrador'];

// Map slug de módulo → { nivel, label } para el usuario autenticado.
async function obtenerNiveles(usuario) {
  if (!usuario?.id) return new Map();
  const permisos = await organizacionService.obtenerPermisosUsuario(usuario.id);
  const niveles = new Map();
  for (const p of permisos || []) {
    if (!p.modulos?.nombre) continue;
    niveles.set(p.modulos.nombre, {
      nivel: resolverNivelPermiso(p, usuario.role),
      label: p.modulos.label || p.modulos.nombre,
    });
  }
  return niveles;
}

// requisitos: [{ modulo, permiso }] — deben cumplirse todos.
function cumpleRequisitos(niveles, requisitos) {
  return requisitos.every(({ modulo, permiso }) => {
    const actual = niveles.get(modulo)?.nivel || 'sin_acceso';
    return NIVELES.indexOf(actual) >= NIVELES.indexOf(permiso);
  });
}

module.exports = { obtenerNiveles, cumpleRequisitos, NIVELES };
