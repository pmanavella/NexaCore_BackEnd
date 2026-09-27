const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/indicadoresController');
const { authenticate } = require('../../middleware/authMiddleware');
const { requireModuleAccess, requireModulePermission } = require('../../middleware/rbacMiddleware');

// Definiciones de KPI: permiso propio del módulo 'indicadores'.
// Endpoints que exponen o calculan datos financieros: además, acceso a 'finance'.
const verIndicadores = requireModuleAccess('indicadores', 'Indicadores');
const verFinanzas = requireModuleAccess('finance', 'Finanzas');
const editarIndicadores = requireModulePermission('indicadores', 'editor', 'Indicadores');
const administrarIndicadores = requireModulePermission('indicadores', 'administrador', 'Indicadores');

router.use(authenticate);

router.get('/',                 verIndicadores, ctrl.listar.bind(ctrl));
router.get('/variables',        verIndicadores, verFinanzas, ctrl.variables.bind(ctrl));
router.post('/validar-formula', editarIndicadores, ctrl.validarFormula.bind(ctrl));
router.get('/:id/valor',        verIndicadores, verFinanzas, ctrl.valor.bind(ctrl));
router.get('/:id/historico',    verIndicadores, verFinanzas, ctrl.historico.bind(ctrl));
router.get('/:id',              verIndicadores, ctrl.obtener.bind(ctrl));
router.post('/',                editarIndicadores, ctrl.crear.bind(ctrl));
router.put('/:id',              editarIndicadores, ctrl.actualizar.bind(ctrl));
router.delete('/:id',           administrarIndicadores, ctrl.desactivar.bind(ctrl));

module.exports = router;
