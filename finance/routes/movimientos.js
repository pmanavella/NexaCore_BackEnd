const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/movimientosController');
const { authenticate } = require('../../middleware/authMiddleware');
const { requireRole } = require('../../middleware/rbacMiddleware');

const soloAdmins = requireRole('Dirección', 'Superadmin');

// Todas las rutas requieren autenticación real
router.use(authenticate);

router.get('/',               ctrl.listar.bind(ctrl));
router.get('/metricas',       ctrl.metricas.bind(ctrl));
router.get('/flujo',          ctrl.flujo.bind(ctrl));
router.get('/trazabilidad',   soloAdmins, ctrl.trazabilidad.bind(ctrl));
router.get('/:id',            ctrl.obtener.bind(ctrl));
router.post('/',              ctrl.crear.bind(ctrl));
router.put('/:id',            ctrl.actualizar.bind(ctrl));
router.delete('/:id',         ctrl.eliminar.bind(ctrl));

module.exports = router;
