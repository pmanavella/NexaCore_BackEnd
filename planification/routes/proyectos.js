const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/planificationController');
const { authenticate } = require('../../middleware/authMiddleware');
const { requireModuleAccess } = require('../../middleware/rbacMiddleware');

router.use(authenticate);

router.get('/',         ctrl.listarProyectos.bind(ctrl));
router.get('/metricas', requireModuleAccess('planification', 'Planificación'), ctrl.metricas.bind(ctrl));
router.post('/',        ctrl.crearProyecto.bind(ctrl));
router.put('/:id',      ctrl.actualizarProyecto.bind(ctrl));
router.delete('/:id',   ctrl.eliminarProyecto.bind(ctrl));

module.exports = router;
