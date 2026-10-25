const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/migracionController');
const { authenticate } = require('../../middleware/authMiddleware');
const { consultaFinanzas, cargaFinanzas, soloMandoAlto } = require('../config/permisos');

router.use(authenticate);

// Tipos disponibles de migración — consulta de Finanzas
router.get('/tipos', consultaFinanzas, ctrl.listarTipos.bind(ctrl));

// Preview (sin escritura en DB) — carga de Finanzas
router.post('/preview', cargaFinanzas, ctrl.uploadMiddleware, ctrl.preview.bind(ctrl));

// Confirmación (escribe en DB) — solo mando alto
router.post('/confirmar', soloMandoAlto, ctrl.uploadMiddleware, ctrl.confirmar.bind(ctrl));

// Auditoría de batches — consulta de Finanzas
router.get('/batches', consultaFinanzas, ctrl.listarBatches.bind(ctrl));
router.get('/batches/:id', consultaFinanzas, ctrl.obtenerBatch.bind(ctrl));

// Reversión — solo mando alto
router.post('/batches/:id/revertir', soloMandoAlto, ctrl.revertirBatch.bind(ctrl));

module.exports = router;
