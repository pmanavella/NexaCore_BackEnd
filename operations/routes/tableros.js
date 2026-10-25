const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/tablerosController');
const { authenticate } = require('../../middleware/authMiddleware');
const { requireHierarchy } = require('../../middleware/rbacMiddleware');
const { NIVELES_JERARQUICOS } = require('../../rbac/config/jerarquia');

// Crear y editar tableros (nombre, descripción, miembros): exclusivo de mando
// alto (Superadmin, Dirección). Listar: cada usuario ve los tableros donde es
// miembro; el mando alto ve todos (lo resuelve tablerosService).
const soloMandoAlto = requireHierarchy(NIVELES_JERARQUICOS.HIGH);

router.use(authenticate);

router.get('/',      ctrl.listarTableros.bind(ctrl));
router.post('/',     soloMandoAlto, ctrl.crearTablero.bind(ctrl));
router.patch('/:id', soloMandoAlto, ctrl.actualizarTablero.bind(ctrl));

module.exports = router;
