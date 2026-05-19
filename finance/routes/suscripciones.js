const express = require('express');
const router = express.Router();
const { listar, obtener, crear, actualizar, eliminar, proximasVencer } = require('../controllers/suscripcionesController');
const { authenticate } = require('../../middleware/authMiddleware');

router.use(authenticate);

router.get('/proximas-vencer', proximasVencer); // must be before /:id
router.get('/',                listar);
router.get('/:id',             obtener);
router.post('/',               crear);
router.put('/:id',             actualizar);
router.delete('/:id',          eliminar);

module.exports = router;
