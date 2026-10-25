// Roles que pueden ver el organigrama completo (GET /api/organizacion/organigrama).
// Fuente única: la usan las rutas de Organización y las herramientas de Nexi
// (nexi/tools/organizacionTools.js).
const ROLES_ORGANIGRAMA = Object.freeze(['Dirección', 'Superadmin', 'Director']);

module.exports = { ROLES_ORGANIGRAMA };
