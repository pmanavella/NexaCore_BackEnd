const express = require('express');
const router = express.Router();
const { listar, obtener, crear, actualizar, eliminar, proximasVencer } = require('../controllers/suscripcionesController');
const { authenticate } = require('../../middleware/authMiddleware');
const { consultaFinanzas, cargaFinanzas } = require('../config/permisos');

router.use(authenticate);

router.get('/proximas-vencer', consultaFinanzas, proximasVencer); // must be before /:id
router.get('/',                consultaFinanzas, listar);
router.get('/:id',             consultaFinanzas, obtener);
router.post('/',               cargaFinanzas, crear);
router.put('/:id',             cargaFinanzas, actualizar);
router.delete('/:id',          cargaFinanzas, eliminar);

module.exports = router;
