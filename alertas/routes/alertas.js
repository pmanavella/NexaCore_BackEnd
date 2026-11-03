const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/alertasController');
const { authenticate } = require('../../middleware/authMiddleware');

// Alertas del usuario autenticado. No hay permiso de módulo propio: cada
// fuente aplica la regla de acceso de su módulo (ver alertasService).
router.use(authenticate);

router.get('/', ctrl.listar.bind(ctrl));

module.exports = router;
