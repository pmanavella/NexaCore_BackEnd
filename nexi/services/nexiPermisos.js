const organizacionService = require('../../organization/services/organizacionService');
const { resolverNivelPermiso } = require('../../middleware/rbacMiddleware');
const { accesoFinanzas, permisoParticularFinanzas } = require('../../finance/config/permisos');
const { ROLES } = require('../../rbac/config/jerarquia');
const { ALCANCES, MODULOS_CONTEXTO } = require('../config/nexi');

// Autorización de Nexi sobre la Matriz de permisos real
// (usuario_modulo_permisos > rol_modulo_permisos), con la misma resolución de
// niveles que requireModulePermission. Nunca usa datos provistos por el modelo.
// Finanzas sigue RN-02 con la misma regla que la API (finance/config/permisos.js).

const NIVELES = ['sin_acceso', 'lector', 'editor', 'administrador'];

function nivelMenor(a, b) {
  return NIVELES.indexOf(a) <= NIVELES.indexOf(b) ? a : b;
}

// Entrada de 'finance' según RN-02 (accesoFinanzas): el permiso heredado del rol
// no cuenta para quien no es mando alto; el mando alto accede aunque no tenga
// fila en la matriz. Restricción adicional de Nexi: si el usuario tiene un
// permiso particular de Finanzas, su nivel y su alcance acotan el acceso
// (también para el mando alto). Nunca amplía lo que permite la API.
function entradaFinanzas(usuario, permisos, label) {
  const acceso = accesoFinanzas(usuario, permisos);
  const particular = permisoParticularFinanzas(permisos);
  if (acceso.origen === 'mando_alto' && particular) {
    return {
      nivel: nivelMenor(acceso.nivel, resolverNivelPermiso(particular, usuario?.role)),
      label,
      alcance: resolverAlcance(particular),
    };
  }
  return {
    nivel: acceso.nivel,
    label,
    alcance: acceso.origen === 'mando_alto' ? 'global' : resolverAlcance(particular),
  };
}

// Alcance efectivo de una entrada de obtenerPermisosUsuario:
// - permiso heredado del rol → 'global' (así lo expone organizacionService);
// - permiso particular → su `alcance`; si falta o es desconocido, 'propio'
//   (default de la columna). Nunca se amplía.
function resolverAlcance(permiso) {
  if (!permiso) return 'propio';
  if (permiso.source === 'rol') return 'global';
  return ALCANCES.includes(permiso.alcance) ? permiso.alcance : 'propio';
}

// Map slug de módulo → { nivel, label, alcance } para el usuario autenticado.
async function obtenerNiveles(usuario) {
  if (!usuario?.id) return new Map();
  const permisos = await organizacionService.obtenerPermisosUsuario(usuario.id);
  const niveles = new Map();
  for (const p of permisos || []) {
    if (!p.modulos?.nombre) continue;
    niveles.set(p.modulos.nombre, {
      nivel: resolverNivelPermiso(p, usuario.role),
      label: p.modulos.label || p.modulos.nombre,
      alcance: resolverAlcance(p),
    });
  }
  // Finanzas: RN-02 (también cuando el usuario no tiene ninguna fila del módulo).
  const label = niveles.get('finance')?.label || 'Finanzas';
  niveles.set('finance', entradaFinanzas(usuario, permisos, label));

  // Superadmin (solo ese rol, no el resto del mando alto): administrador con
  // alcance global en todos los módulos de Nexi, aunque no tenga fila en la
  // matriz o tenga un permiso particular que lo restrinja. Las restricciones
  // fijas de Nexi (solo lectura, sin sueldos, sin datos individuales, identidad
  // de la sesión, auditoría) no dependen de los niveles y no cambian.
  if (usuario.role === ROLES.SUPERADMIN) {
    for (const modulo of MODULOS_CONTEXTO) {
      niveles.set(modulo, { nivel: 'administrador', label: niveles.get(modulo)?.label || modulo, alcance: 'global' });
    }
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

// Alcance efectivo del usuario en un módulo ('propio' si no hay entrada).
function alcanceDe(niveles, modulo) {
  const alcance = niveles.get(modulo)?.alcance;
  return ALCANCES.includes(alcance) ? alcance : 'propio';
}

// Regla única de autorización de Nexi, compartida por herramientas y por las
// secciones de reportes. `definicion`: { requisitos, requisitosRol?,
// alcancesPermitidos? (por defecto solo 'global') }. Exige nivel mínimo en
// TODOS los módulos requeridos, el rol (si se declara) y un alcance admitido en
// todos los módulos. Devuelve { ok, motivo, alcance } (alcance del módulo
// principal). Sin usuario/rol, un requisito de rol nunca se cumple.
function evaluarRequisitos(definicion, niveles, usuario) {
  if (!cumpleRequisitos(niveles, definicion.requisitos)) return { ok: false, motivo: 'SIN_PERMISO' };
  if (definicion.requisitosRol && !definicion.requisitosRol.includes(usuario?.role)) {
    return { ok: false, motivo: 'SIN_PERMISO' };
  }
  const admitidos = definicion.alcancesPermitidos || ['global'];
  const alcances = definicion.requisitos.map(r => alcanceDe(niveles, r.modulo));
  if (alcances.some(a => !admitidos.includes(a))) return { ok: false, motivo: 'ALCANCE_INSUFICIENTE' };
  return { ok: true, motivo: null, alcance: alcances[0] };
}

module.exports = { obtenerNiveles, cumpleRequisitos, alcanceDe, resolverAlcance, evaluarRequisitos, NIVELES };
