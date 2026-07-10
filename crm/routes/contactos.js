const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/crmController');
const { authenticate } = require('../../middleware/authMiddleware');
const { requireModuleAccess } = require('../../middleware/rbacMiddleware');

router.use(authenticate);

router.get('/',       ctrl.listarContactos.bind(ctrl));
router.get('/metricas', requireModuleAccess('crm', 'CRM'), ctrl.metricas.bind(ctrl));
router.post('/',      ctrl.crearContacto.bind(ctrl));
router.put('/:id',    ctrl.actualizarContacto.bind(ctrl));
router.delete('/:id', ctrl.eliminarContacto.bind(ctrl));

module.exports = router;
