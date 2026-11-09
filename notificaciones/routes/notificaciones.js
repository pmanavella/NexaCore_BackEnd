const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/notificacionesController');
const { authenticate } = require('../../middleware/authMiddleware');

// Notificaciones persistentes del usuario autenticado (menciones). Sin permiso
// de módulo propio, igual que /api/alertas: cada usuario solo alcanza las
// suyas y el acceso a la tarea se revalida (ver notificacionesService).
router.use(authenticate);

router.get('/',                      ctrl.listar.bind(ctrl));
router.get('/no-leidas/cantidad',    ctrl.contarNoLeidas.bind(ctrl));
router.post('/marcar-todas-leidas',  ctrl.marcarTodasLeidas.bind(ctrl));
router.patch('/:id/leida',           ctrl.marcarLeida.bind(ctrl));

module.exports = router;
