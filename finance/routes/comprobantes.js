const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/comprobantesController');
const { authenticate } = require('../../middleware/authMiddleware');

router.use(authenticate);

router.post('/upload', ctrl.uploadMiddleware, ctrl.subir.bind(ctrl));
router.get('/',               ctrl.listar.bind(ctrl));
router.put('/:id/vincular',   ctrl.vincular.bind(ctrl));
router.delete('/:id',         ctrl.eliminar.bind(ctrl));

module.exports = router;
