const express = require('express')
const router  = express.Router()
const ctrl    = require('../controllers/organizacionController')
const { authenticate }  = require('../../middleware/authMiddleware')
const { requireRole }   = require('../../middleware/rbacMiddleware')

const soloAdmin      = requireRole('Dirección', 'Superadmin', 'Director')
const soloSuperadmin = requireRole('Superadmin')

// Todas las rutas requieren autenticación
router.use(authenticate)

// ── Organigrama ───────────────────────────────────────────────
router.get('/organigrama',          soloAdmin,       ctrl.obtenerOrganigrama.bind(ctrl))
router.post('/organigrama',         soloSuperadmin,  ctrl.crearNodo.bind(ctrl))
router.put('/organigrama/:id',      soloAdmin,       ctrl.actualizarNodo.bind(ctrl))
router.delete('/organigrama/:id',   soloSuperadmin,  ctrl.eliminarNodo.bind(ctrl))

// ── Personas asignables (usuarios y/o empleados sin nodo activo) ─
router.get('/personas-asignables', soloAdmin, ctrl.obtenerPersonasAsignables.bind(ctrl))

// ── Permisos por usuario ──────────────────────────────────────
router.get('/permisos/:usuarioId',  soloAdmin,       ctrl.obtenerPermisosUsuario.bind(ctrl))
router.put('/permisos/:usuarioId',  soloSuperadmin,  ctrl.actualizarPermisosUsuario.bind(ctrl))

// ── Matriz de permisos ────────────────────────────────────────
router.get('/matriz',               soloAdmin,       ctrl.obtenerMatrizPermisos.bind(ctrl))

// ── Módulos ───────────────────────────────────────────────────
router.get('/modulos',              soloAdmin,       ctrl.obtenerModulos.bind(ctrl))

// ── Roles predefinidos ────────────────────────────────────────
router.get('/roles-predefinidos',   soloAdmin,       ctrl.obtenerRolesPredefinidos.bind(ctrl))

// ── Mantenimiento: inactivar externos vencidos ────────────────
router.post('/inactivar-expirados', soloSuperadmin,  ctrl.inactivarExpirados.bind(ctrl))

module.exports = router
