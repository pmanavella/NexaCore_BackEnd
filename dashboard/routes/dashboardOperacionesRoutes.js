const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/dashboardOperacionesController');
const { authenticate } = require('../../middleware/authMiddleware');

// La verificación de acceso a módulos (operations / protocolos) ocurre dentro
// del service — no en middleware de ruta — para poder aplicar lógica "al menos uno".
router.use(authenticate);

router.get('/operaciones', ctrl.obtenerResumen.bind(ctrl));

module.exports = router;
