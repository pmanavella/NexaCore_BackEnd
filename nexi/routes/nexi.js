const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/nexiController');
const { authenticate } = require('../../middleware/authMiddleware');
const { crearLimitadorPorUsuario } = require('../middleware/rateLimit');
const nexiErrorHandler = require('../middleware/nexiErrorHandler');

// Nexi (solo lectura + generación de reportes). La autorización por módulo se
// aplica por herramienta en nexi/tools/registry.js; conversaciones y reportes
// se filtran siempre por req.user.id.
router.use(authenticate);

router.post('/chat', crearLimitadorPorUsuario(), ctrl.chat.bind(ctrl));

router.get('/conversaciones',              ctrl.listarConversaciones.bind(ctrl));
router.post('/conversaciones',             ctrl.crearConversacion.bind(ctrl));
router.get('/conversaciones/:id/mensajes', ctrl.listarMensajes.bind(ctrl));
router.delete('/conversaciones/:id',       ctrl.eliminarConversacion.bind(ctrl));

// Reportes generados por Nexi (solo los propios).
router.get('/reportes',                    ctrl.listarReportes.bind(ctrl));
router.get('/reportes/:id/descarga',       ctrl.descargarReporte.bind(ctrl));

router.use(nexiErrorHandler);

module.exports = router;
