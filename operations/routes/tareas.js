const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/operationsController');
const { authenticate } = require('../../middleware/authMiddleware');

router.use(authenticate);

// Rutas fijas ANTES de /:id
router.get('/metricas',                ctrl.metricas.bind(ctrl));
router.get('/propuestas',              ctrl.listarPropuestas.bind(ctrl));
router.post('/propuestas/:id/aprobar',  ctrl.aprobarPropuesta.bind(ctrl));
router.post('/propuestas/:id/rechazar', ctrl.rechazarPropuesta.bind(ctrl));

// Historial de una tarea
router.get('/:id/historial', ctrl.obtenerHistorial.bind(ctrl));

// CRUD tareas
router.get('/',       ctrl.listarTareas.bind(ctrl));
router.post('/',      ctrl.crearTarea.bind(ctrl));
router.put('/:id',    ctrl.actualizarTarea.bind(ctrl));
router.delete('/:id', ctrl.eliminarTarea.bind(ctrl));

module.exports = router;
