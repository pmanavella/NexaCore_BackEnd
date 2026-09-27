const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/nexiController');
const { authenticate } = require('../../middleware/authMiddleware');
const { crearLimitadorPorUsuario } = require('../middleware/rateLimit');
const nexiErrorHandler = require('../middleware/nexiErrorHandler');

// Nexi V1 (solo lectura). La autorización por módulo se aplica por herramienta
// en nexi/tools/registry.js; las conversaciones se filtran por req.user.id.
router.use(authenticate);

router.post('/chat', crearLimitadorPorUsuario(), ctrl.chat.bind(ctrl));

router.get('/conversaciones',              ctrl.listarConversaciones.bind(ctrl));
router.post('/conversaciones',             ctrl.crearConversacion.bind(ctrl));
router.get('/conversaciones/:id/mensajes', ctrl.listarMensajes.bind(ctrl));
router.delete('/conversaciones/:id',       ctrl.eliminarConversacion.bind(ctrl));

router.use(nexiErrorHandler);

module.exports = router;
