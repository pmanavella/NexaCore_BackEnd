const express = require('express');
const router = express.Router();
const { listar, metricas, obtener, crear, actualizar, eliminar } = require('../controllers/deudasController');
const { authenticate } = require('../../middleware/authMiddleware');
const { consultaFinanzas, cargaFinanzas } = require('../config/permisos');

// Deudas sigue RN-02: consulta con permiso de lector, alta/edición/baja con editor.
router.use(authenticate);

router.get('/',         consultaFinanzas, listar);
router.get('/metricas', consultaFinanzas, metricas);
router.get('/:id',      consultaFinanzas, obtener);
router.post('/',        cargaFinanzas, crear);
router.put('/:id',      cargaFinanzas, actualizar);
router.delete('/:id',   cargaFinanzas, eliminar);

module.exports = router;
