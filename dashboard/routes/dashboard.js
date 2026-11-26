const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/dashboardController');
const { authenticate } = require('../../middleware/authMiddleware');

// La vista Dashboard es accesible para cualquier usuario autenticado y activo.
// La autorización real ocurre por mosaico, dentro de dashboardService, contra
// la Matriz de permisos por módulo — no hay requireRole/requireModuleAccess acá.
router.use(authenticate);

router.get('/config', ctrl.obtenerConfiguracion.bind(ctrl));
router.put('/config', ctrl.guardarConfiguracion.bind(ctrl));

// Catálogo para "Crear gráfico personalizado" (filtrado por permisos del usuario).
router.get('/catalogo', ctrl.obtenerCatalogo.bind(ctrl));

// Datos de los mosaicos de Protocolos (el permiso de módulo se verifica en el service).
router.get('/protocolos', ctrl.obtenerProtocolos.bind(ctrl));

module.exports = router;
