const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/etapasController');
const { authenticate } = require('../../middleware/authMiddleware');

router.use(authenticate);

router.get('/',       ctrl.listarEtapas.bind(ctrl));
router.post('/',      ctrl.crearEtapa.bind(ctrl));
router.patch('/:id',  ctrl.actualizarEtapa.bind(ctrl));
router.delete('/:id', ctrl.eliminarEtapa.bind(ctrl));

module.exports = router;
