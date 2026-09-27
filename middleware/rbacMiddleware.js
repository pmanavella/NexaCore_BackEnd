const organizacionService = require('../organization/services/organizacionService');

// requireRole debe usarse DESPUÉS de authenticate.
// Lee req.user.role que fue verificado y seteado por authMiddleware.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role || !allowedRoles.includes(role)) {
      return res.status(403).json({ error: 'No tenés permisos para acceder a este recurso.' });
    }
    next();
  };
}

// requireModuleAccess debe usarse DESPUÉS de authenticate.
// Consulta la Matriz de permisos real (usuario_modulo_permisos > rol_modulo_permisos) para
// req.user.id — nunca confía en rol/módulo enviado por query, body o headers del cliente.
// moduloNombre debe coincidir con la columna `modulos.nombre` (slug: 'finance', 'crm', 'operations', ...).
// moduloLabel es solo el texto legible para el mensaje de error (ej. "Finanzas").
function requireModuleAccess(moduloNombre, moduloLabel = moduloNombre) {
  return async (req, res, next) => {
    try {
      const tieneAcceso = await organizacionService.usuarioTieneAccesoModulo(req.user?.id, moduloNombre);
      if (!tieneAcceso) {
        return res.status(403).json({ error: `No tiene permisos para acceder al módulo ${moduloLabel}.` });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Niveles de `tipo_permiso`, de menor a mayor.
const NIVELES_PERMISO = ['sin_acceso', 'lector', 'editor', 'administrador'];

// Nivel efectivo a partir de una entrada de organizacionService.obtenerPermisosUsuario
// (misma precedencia: usuario_modulo_permisos > rol_modulo_permisos > sin acceso).
// rol_modulo_permisos solo expresa lector/editor: cuando el acceso proviene del
// rol y el rol es Superadmin, se lo considera 'administrador'. Un permiso
// particular del usuario siempre prevalece.
function resolverNivelPermiso(permiso, rol) {
  if (!permiso) return 'sin_acceso';
  if (permiso.source === 'rol' && rol === 'Superadmin') return 'administrador';
  return NIVELES_PERMISO.includes(permiso.permiso) ? permiso.permiso : 'sin_acceso';
}

// requireModulePermission debe usarse DESPUÉS de authenticate.
// Igual que requireModuleAccess, consulta la Matriz de permisos real, pero exige
// un nivel mínimo ('lector' | 'editor' | 'administrador').
function requireModulePermission(moduloNombre, nivelMinimo, moduloLabel = moduloNombre) {
  const minimo = NIVELES_PERMISO.indexOf(nivelMinimo);
  if (minimo <= 0) throw new Error(`Nivel de permiso inválido: ${nivelMinimo}`);

  return async (req, res, next) => {
    try {
      const permisos = req.user?.id ? await organizacionService.obtenerPermisosUsuario(req.user.id) : [];
      const permiso = permisos.find(p => p.modulos?.nombre === moduloNombre);
      const nivel = resolverNivelPermiso(permiso, req.user?.role);
      if (NIVELES_PERMISO.indexOf(nivel) < minimo) {
        return res.status(403).json({ error: `No tiene permisos suficientes en el módulo ${moduloLabel}.` });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireRole, requireModuleAccess, requireModulePermission, resolverNivelPermiso };
