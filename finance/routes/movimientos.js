const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/movimientosController');
const { authenticate } = require('../../middleware/authMiddleware');
const { consultaFinanzas, cargaFinanzas, soloMandoAlto } = require('../config/permisos');

// Todas las rutas requieren autenticación real
router.use(authenticate);

router.get('/',               consultaFinanzas, ctrl.listar.bind(ctrl));
router.get('/metricas',       consultaFinanzas, ctrl.metricas.bind(ctrl));
router.get('/flujo',          consultaFinanzas, ctrl.flujo.bind(ctrl));
router.get('/trazabilidad',   soloMandoAlto, ctrl.trazabilidad.bind(ctrl));
router.get('/:id',            consultaFinanzas, ctrl.obtener.bind(ctrl));
router.post('/',              cargaFinanzas, ctrl.crear.bind(ctrl));
router.put('/:id',            cargaFinanzas, ctrl.actualizar.bind(ctrl));
router.delete('/:id',         cargaFinanzas, ctrl.eliminar.bind(ctrl));

module.exports = router;
