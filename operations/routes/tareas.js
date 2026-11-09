const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/operationsController');
const actualizaciones = require('../controllers/actualizacionesController');
const { authenticate } = require('../../middleware/authMiddleware');
const { requireModuleAccess } = require('../../middleware/rbacMiddleware');

router.use(authenticate);

// Rutas fijas ANTES de /:id
router.get('/metricas',                requireModuleAccess('operations', 'Operativo'), ctrl.metricas.bind(ctrl));
router.get('/propuestas',              ctrl.listarPropuestas.bind(ctrl));
router.post('/propuestas/:id/aprobar',  ctrl.aprobarPropuesta.bind(ctrl));
router.post('/propuestas/:id/rechazar', ctrl.rechazarPropuesta.bind(ctrl));

// Temporizadores activos del usuario autenticado (indicador en las tarjetas
// del Kanban, una sola llamada). ?tablero_id opcional.
router.get('/temporizadores-activos', actualizaciones.listarTemporizadoresActivos.bind(actualizaciones));

// Historial de una tarea
router.get('/:id/historial', ctrl.obtenerHistorial.bind(ctrl));

// Panel "Actualizaciones": comentarios + registros de tiempo finalizados.
// Acceso: miembros del tablero de la tarea (y mando alto), sin requerir
// asignación (lo verifica tareaActualizacionesService).
router.get('/:id/actualizaciones', actualizaciones.listarActualizaciones.bind(actualizaciones));

router.get('/:id/comentarios',                   actualizaciones.listarComentarios.bind(actualizaciones));
router.post('/:id/comentarios',                  actualizaciones.crearComentario.bind(actualizaciones));
router.patch('/:id/comentarios/:comentarioId',   actualizaciones.editarComentario.bind(actualizaciones));
router.delete('/:id/comentarios/:comentarioId',  actualizaciones.eliminarComentario.bind(actualizaciones));

// Usuarios que se pueden mencionar con @: miembros activos del tablero.
router.get('/:id/mencionables', actualizaciones.listarMencionables.bind(actualizaciones));

// Temporizador del usuario autenticado en la tarea (usuario + tarea).
router.get('/:id/temporizador',          actualizaciones.obtenerTemporizador.bind(actualizaciones));
router.post('/:id/temporizador/iniciar', actualizaciones.iniciarTemporizador.bind(actualizaciones));
router.post('/:id/temporizador/detener', actualizaciones.detenerTemporizador.bind(actualizaciones));

// Registros de tiempo: carga manual y corrección del autor. NO hay DELETE:
// los registros de tiempo no se eliminan.
router.post('/:id/registros-tiempo',                              actualizaciones.registrarTiempoManual.bind(actualizaciones));
router.post('/:id/registros-tiempo/validar',                      actualizaciones.validarRegistroTiempo.bind(actualizaciones));
router.patch('/:id/registros-tiempo/:registroId',                 actualizaciones.corregirRegistroTiempo.bind(actualizaciones));
router.get('/:id/registros-tiempo/:registroId/correcciones',      actualizaciones.listarCorreccionesRegistro.bind(actualizaciones));

// CRUD tareas
router.get('/',       ctrl.listarTareas.bind(ctrl));
router.post('/',      ctrl.crearTarea.bind(ctrl));
router.put('/:id',    ctrl.actualizarTarea.bind(ctrl));
router.delete('/:id', ctrl.eliminarTarea.bind(ctrl));

module.exports = router;
