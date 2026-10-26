const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/indicadoresController');
const { authenticate } = require('../../middleware/authMiddleware');
const { requireModuleAccess, requireModulePermission } = require('../../middleware/rbacMiddleware');
const { consultaFinanzas } = require('../../finance/config/permisos');

// Definiciones de KPI: permiso propio del módulo 'indicadores'.
// Endpoints que exponen o calculan datos financieros: además, consulta de
// Finanzas según RN-02 (mando alto o permiso particular; el de rol no alcanza).
const verIndicadores = requireModuleAccess('indicadores', 'Indicadores');
const verFinanzas = consultaFinanzas;
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
