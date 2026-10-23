const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/salariosController')
const { authenticate } = require('../../middleware/authMiddleware')
const { consultaFinanzas, cargaFinanzas, soloMandoAlto } = require('../config/permisos')

router.use(authenticate)

// Sueldos (todo salarios/* salvo la cotización): solo mando alto, sin importar el permiso manual

// Métricas de nómina
router.get('/metricas', soloMandoAlto, ctrl.metricas.bind(ctrl))

// Cotización del dólar — es parte de Finanzas, no de Sueldos
router.get('/cotizacion-dolar',  consultaFinanzas, ctrl.getCotizacionDiaria.bind(ctrl))
router.post('/cotizacion-dolar', cargaFinanzas, ctrl.guardarCotizacion.bind(ctrl))

// Empleados
router.get('/empleados',        soloMandoAlto, ctrl.listarEmpleados.bind(ctrl))
router.get('/empleados/:id',    soloMandoAlto, ctrl.obtenerEmpleado.bind(ctrl))
router.post('/empleados',       soloMandoAlto, ctrl.crearEmpleado.bind(ctrl))
router.put('/empleados/:id',    soloMandoAlto, ctrl.actualizarEmpleado.bind(ctrl))
router.delete('/empleados/:id', soloMandoAlto, ctrl.eliminarEmpleado.bind(ctrl))

// Categorías
router.get('/categorias',        soloMandoAlto, ctrl.listarCategorias.bind(ctrl))
router.post('/categorias',       soloMandoAlto, ctrl.crearCategoria.bind(ctrl))
router.delete('/categorias/:id', soloMandoAlto, ctrl.eliminarCategoria.bind(ctrl))

// Movimientos salariales
router.get('/movimientos',        soloMandoAlto, ctrl.listarMovimientos.bind(ctrl))
router.post('/movimientos',       soloMandoAlto, ctrl.crearMovimiento.bind(ctrl))
router.put('/movimientos/:id',    soloMandoAlto, ctrl.actualizarMovimiento.bind(ctrl))
router.delete('/movimientos/:id', soloMandoAlto, ctrl.eliminarMovimiento.bind(ctrl))

module.exports = router
