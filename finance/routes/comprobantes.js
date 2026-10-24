const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/comprobantesController');
const { authenticate } = require('../../middleware/authMiddleware');
const { consultaFinanzas, cargaFinanzas } = require('../config/permisos');

router.use(authenticate);

router.post('/upload', cargaFinanzas, ctrl.uploadMiddleware, ctrl.subir.bind(ctrl));
router.get('/',               consultaFinanzas, ctrl.listar.bind(ctrl));
router.delete('/:id',         cargaFinanzas, ctrl.eliminar.bind(ctrl));

module.exports = router;
