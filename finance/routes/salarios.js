const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/salariosController')
const { authenticate } = require('../../middleware/authMiddleware')
const { requireRole } = require('../../middleware/rbacMiddleware')

const soloAdmin = requireRole('Dirección', 'Superadmin')

router.use(authenticate)

// Métricas
router.get('/metricas', soloAdmin, ctrl.metricas.bind(ctrl))

// Cotización del dólar
router.get('/cotizacion-dolar',  soloAdmin, ctrl.getCotizacionDiaria.bind(ctrl))
router.post('/cotizacion-dolar', soloAdmin, ctrl.guardarCotizacion.bind(ctrl))

// Empleados
router.get('/empleados',        soloAdmin, ctrl.listarEmpleados.bind(ctrl))
router.get('/empleados/:id',    soloAdmin, ctrl.obtenerEmpleado.bind(ctrl))
router.post('/empleados',       soloAdmin, ctrl.crearEmpleado.bind(ctrl))
router.put('/empleados/:id',    soloAdmin, ctrl.actualizarEmpleado.bind(ctrl))
router.delete('/empleados/:id', soloAdmin, ctrl.eliminarEmpleado.bind(ctrl))

// Categorías
router.get('/categorias',        soloAdmin, ctrl.listarCategorias.bind(ctrl))
router.post('/categorias',       soloAdmin, ctrl.crearCategoria.bind(ctrl))
router.delete('/categorias/:id', soloAdmin, ctrl.eliminarCategoria.bind(ctrl))

// Movimientos salariales
router.get('/movimientos',        soloAdmin, ctrl.listarMovimientos.bind(ctrl))
router.post('/movimientos',       soloAdmin, ctrl.crearMovimiento.bind(ctrl))
router.put('/movimientos/:id',    soloAdmin, ctrl.actualizarMovimiento.bind(ctrl))
router.delete('/movimientos/:id', soloAdmin, ctrl.eliminarMovimiento.bind(ctrl))

module.exports = router
