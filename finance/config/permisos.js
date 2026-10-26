// RN-02 — Acceso al módulo Financiero (docs/convencion-identificadores.md, sección 6).
// Regla ÚNICA: la usan los middlewares de Finanzas, Deudas e Indicadores (REST) y
// Nexi (nexi/services/nexiPermisos.js). Los middlewares se usan DESPUÉS de authenticate.
const organizacionService = require('../../organization/services/organizacionService');
const { requireHierarchy, resolverNivelPermiso } = require('../../middleware/rbacMiddleware');
const { NIVELES_JERARQUICOS } = require('../../rbac/config/jerarquia');

const MANDO_ALTO = [NIVELES_JERARQUICOS.HIGH];
const NIVELES = ['sin_acceso', 'lector', 'editor', 'administrador'];

function esMandoAlto(usuario) {
  return MANDO_ALTO.includes(usuario?.hierarchyLevel);
}

// Permiso particular del usuario en 'finance' (usuario_modulo_permisos), si existe.
// `permisos` es la salida de organizacionService.obtenerPermisosUsuario.
function permisoParticularFinanzas(permisos) {
  return (permisos || []).find(p => p.modulos?.nombre === 'finance' && p.source === 'usuario') || null;
}

// Acceso efectivo a Finanzas según RN-02:
//   - mando alto (req.user.hierarchyLevel, resuelto por authenticate) → administrador, global;
//   - otro usuario → solo su permiso particular de la matriz;
//   - el permiso cargado por rol NO habilita a quien no es mando alto.
// Devuelve { nivel, alcance, origen: 'mando_alto' | 'usuario' | 'ninguno' }.
function accesoFinanzas(usuario, permisos) {
  if (esMandoAlto(usuario)) return { nivel: 'administrador', alcance: 'global', origen: 'mando_alto' };
  const particular = permisoParticularFinanzas(permisos);
  if (!particular) return { nivel: 'sin_acceso', alcance: null, origen: 'ninguno' };
  return { nivel: resolverNivelPermiso(particular, usuario?.role), alcance: particular.alcance ?? null, origen: 'usuario' };
}

function alcanzaNivel(nivel, minimo) {
  return NIVELES.indexOf(nivel) >= NIVELES.indexOf(minimo);
}

function puedeConsultarFinanzas(usuario, permisos) {
  return alcanzaNivel(accesoFinanzas(usuario, permisos).nivel, 'lector');
}

function puedeCargarFinanzas(usuario, permisos) {
  return alcanzaNivel(accesoFinanzas(usuario, permisos).nivel, 'editor');
}

// Middleware a partir de la regla: el mando alto pasa sin consultar la Matriz.
function middlewareFinanzas(puede) {
  return async (req, res, next) => {
    try {
      if (esMandoAlto(req.user)) return next();
      const permisos = req.user?.id ? await organizacionService.obtenerPermisosUsuario(req.user.id) : [];
      if (!puede(req.user, permisos)) {
        return res.status(403).json({ error: 'No tiene permisos suficientes en el módulo Finanzas.' });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Finanzas: consulta (lector) y carga (editor).
const consultaFinanzas = middlewareFinanzas(puedeConsultarFinanzas);
const cargaFinanzas = middlewareFinanzas(puedeCargarFinanzas);

// Sueldos, trazabilidad y confirmar/revertir migraciones: solo mando alto, sin importar el permiso.
const soloMandoAlto = requireHierarchy(...MANDO_ALTO);

module.exports = {
  consultaFinanzas, cargaFinanzas, soloMandoAlto,
  accesoFinanzas, puedeConsultarFinanzas, puedeCargarFinanzas, permisoParticularFinanzas, esMandoAlto,
};
