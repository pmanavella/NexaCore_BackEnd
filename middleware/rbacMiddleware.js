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
// moduloNombre debe coincidir con la columna `modulos.nombre` (slug: 'finance', 'crm', 'operations', 'planification', ...).
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

module.exports = { requireRole, requireModuleAccess };
