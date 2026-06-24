const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/migracionController');
const { authenticate } = require('../../middleware/authMiddleware');
const { requireRole } = require('../../middleware/rbacMiddleware');

router.use(authenticate);

// Tipos disponibles de migración — accesible para todos los usuarios autenticados
router.get('/tipos', ctrl.listarTipos.bind(ctrl));

// Preview (sin escritura en DB) — accesible para todos los autenticados
router.post('/preview', ctrl.uploadMiddleware, ctrl.preview.bind(ctrl));

// Confirmación (escribe en DB) — solo Admin y Superadmin
router.post('/confirmar', requireRole('Admin', 'Superadmin'), ctrl.uploadMiddleware, ctrl.confirmar.bind(ctrl));

// Auditoría de batches
router.get('/batches', ctrl.listarBatches.bind(ctrl));
router.get('/batches/:id', ctrl.obtenerBatch.bind(ctrl));

// Reversión — solo Admin y Superadmin
router.post('/batches/:id/revertir', requireRole('Admin', 'Superadmin'), ctrl.revertirBatch.bind(ctrl));

module.exports = router;
