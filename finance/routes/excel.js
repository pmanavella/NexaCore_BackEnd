const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/excelController');
const { authenticate } = require('../../middleware/authMiddleware');
const { consultaFinanzas, cargaFinanzas } = require('../config/permisos');

router.use(authenticate);

router.post('/validar',   cargaFinanzas, ctrl.uploadMiddleware, ctrl.validar.bind(ctrl));
router.post('/importar',  cargaFinanzas, ctrl.uploadMiddleware, ctrl.importar.bind(ctrl));
router.get('/plantilla',  consultaFinanzas, ctrl.plantilla.bind(ctrl));

module.exports = router;
