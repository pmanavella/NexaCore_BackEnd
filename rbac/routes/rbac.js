const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/rbacController')
const { authenticate } = require('../../middleware/authMiddleware')
const { requireRole } = require('../../middleware/rbacMiddleware')

const soloAdmin      = requireRole('Dirección', 'Superadmin')
const soloSuperadmin = requireRole('Superadmin')

router.use(authenticate)

router.get('/usuarios',              soloAdmin,      ctrl.listarUsuarios.bind(ctrl))
router.get('/usuarios/asignables',                   ctrl.listarUsuariosAsignables.bind(ctrl))
router.get('/usuarios/:id',          soloAdmin,      ctrl.obtenerUsuario.bind(ctrl))
router.post('/usuarios',             soloSuperadmin, ctrl.crearUsuario.bind(ctrl))
router.put('/usuarios/:id',          soloAdmin,      ctrl.actualizarUsuario.bind(ctrl))
router.delete('/usuarios/:id',       soloAdmin,      ctrl.eliminarUsuario.bind(ctrl))

router.get('/roles', soloAdmin, ctrl.listarRoles.bind(ctrl))

module.exports = router
