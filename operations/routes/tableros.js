const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/tablerosController');
const { authenticate } = require('../../middleware/authMiddleware');
const { requireHierarchy } = require('../../middleware/rbacMiddleware');
const { NIVELES_JERARQUICOS } = require('../../rbac/config/jerarquia');

// Crear y editar tableros (nombre, descripción, miembros): exclusivo de mando
// alto (Superadmin, Dirección). Listar: cada usuario ve los tableros donde es
// miembro; el mando alto ve todos (lo resuelve tablerosService).
// Gestionar miembros (/:id/miembros): administradores del tablero, sin
// importar el rol jerárquico (lo verifica tablerosService). Regularizar un
// tablero sin administradores activos: mando alto.
const soloMandoAlto = requireHierarchy(NIVELES_JERARQUICOS.HIGH);

router.use(authenticate);

router.get('/',      ctrl.listarTableros.bind(ctrl));
router.post('/',     soloMandoAlto, ctrl.crearTablero.bind(ctrl));
router.patch('/:id', soloMandoAlto, ctrl.actualizarTablero.bind(ctrl));
router.post('/:id/regularizar-administrador', soloMandoAlto, ctrl.regularizarAdministrador.bind(ctrl));

router.post('/:id/miembros',              ctrl.agregarMiembros.bind(ctrl));
router.patch('/:id/miembros/:usuarioId',  ctrl.actualizarMiembro.bind(ctrl));
router.delete('/:id/miembros/:usuarioId', ctrl.quitarMiembro.bind(ctrl));

module.exports = router;
