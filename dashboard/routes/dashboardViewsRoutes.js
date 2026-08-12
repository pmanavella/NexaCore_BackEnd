const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/dashboardViewsController');
const { authenticate } = require('../../middleware/authMiddleware');

// Vistas de Dashboard — la autorización por módulo ocurre dentro del service,
// igual que en dashboardService: usuarios autenticados pueden gestionar sus
// propias vistas; los widgets se filtran por la Matriz de permisos al leer.
router.use(authenticate);

router.get('/views',        ctrl.listarVistas.bind(ctrl));
router.post('/views',       ctrl.crearVista.bind(ctrl));
router.get('/views/:id',    ctrl.obtenerVista.bind(ctrl));
router.put('/views/:id',    ctrl.actualizarVista.bind(ctrl));
router.delete('/views/:id', ctrl.eliminarVista.bind(ctrl));

module.exports = router;
