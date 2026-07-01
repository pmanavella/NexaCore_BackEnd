const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/protocolosController');
const { authenticate } = require('../../middleware/authMiddleware');

router.use(authenticate);

// ── Métricas (antes de /:id para evitar colisión de rutas) ───
router.get('/metrics', ctrl.obtenerMetricas.bind(ctrl));

// ── Pruebas (por id de prueba) ───────────────────────────────
router.get('/pruebas/:pruebaId', ctrl.obtenerPrueba.bind(ctrl));

// ── Protocolos ────────────────────────────────────────────────
router.get('/', ctrl.listarProtocolos.bind(ctrl));
router.get('/:id', ctrl.obtenerProtocolo.bind(ctrl));
router.post('/', ctrl.crearProtocolo.bind(ctrl));
router.put('/:id', ctrl.actualizarProtocolo.bind(ctrl));
router.put('/:id/items', ctrl.actualizarItems.bind(ctrl));

// ── Pruebas de un protocolo ───────────────────────────────────
router.post('/:id/pruebas', ctrl.registrarPrueba.bind(ctrl));
router.get('/:id/pruebas', ctrl.listarPruebas.bind(ctrl));

module.exports = router;
