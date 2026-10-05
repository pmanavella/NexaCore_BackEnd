const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/protocolosController');
const { authenticate } = require('../../middleware/authMiddleware');
const { requireHierarchy } = require('../../middleware/rbacMiddleware');
const { NIVELES_JERARQUICOS } = require('../../rbac/config/jerarquia');

// Eliminar un protocolo completo: exclusivo de mando alto (Superadmin, Dirección).
const soloMandoAlto = requireHierarchy(NIVELES_JERARQUICOS.HIGH);

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
router.delete('/:id', soloMandoAlto, ctrl.eliminarProtocolo.bind(ctrl));

// ── Pruebas de un protocolo ───────────────────────────────────
router.post('/:id/pruebas', ctrl.registrarPrueba.bind(ctrl));
router.get('/:id/pruebas', ctrl.listarPruebas.bind(ctrl));

module.exports = router;
