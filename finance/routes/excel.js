const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/excelController');
const { authenticate } = require('../../middleware/authMiddleware');

router.use(authenticate);

router.post('/validar',   ctrl.uploadMiddleware, ctrl.validar.bind(ctrl));
router.post('/importar',  ctrl.uploadMiddleware, ctrl.importar.bind(ctrl));
router.get('/plantilla',  ctrl.plantilla.bind(ctrl));

module.exports = router;
