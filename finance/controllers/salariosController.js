const salariosService = require('../services/salariosService')

class SalariosController {
  // Empleados
  async listarEmpleados(req, res, next) {
    try {
      const result = await salariosService.listarEmpleados(req.query)
      res.json(result)
    } catch (err) { next(err) }
  }

  async obtenerEmpleado(req, res, next) {
    try {
      const result = await salariosService.obtenerEmpleadoPorId(req.params.id)
      res.json(result)
    } catch (err) { next(err) }
  }

  async crearEmpleado(req, res, next) {
    try {
      const result = await salariosService.crearEmpleado(req.body)
      res.status(201).json(result)
    } catch (err) { next(err) }
  }

  async actualizarEmpleado(req, res, next) {
    try {
      const result = await salariosService.actualizarEmpleado(req.params.id, req.body)
      res.json(result)
    } catch (err) { next(err) }
  }

  async eliminarEmpleado(req, res, next) {
    try {
      const result = await salariosService.eliminarEmpleado(req.params.id)
      res.json(result)
    } catch (err) { next(err) }
  }

  // Categorías
  async listarCategorias(req, res, next) {
    try {
      const result = await salariosService.listarCategorias()
      res.json(result)
    } catch (err) { next(err) }
  }

  async crearCategoria(req, res, next) {
    try {
      const result = await salariosService.crearCategoria(req.body)
      res.status(201).json(result)
    } catch (err) { next(err) }
  }

  async eliminarCategoria(req, res, next) {
    try {
      const result = await salariosService.eliminarCategoria(req.params.id)
      res.json(result)
    } catch (err) { next(err) }
  }

  // Movimientos salariales
  async listarMovimientos(req, res, next) {
    try {
      const result = await salariosService.listarMovimientos(req.query)
      res.json(result)
    } catch (err) { next(err) }
  }

  async crearMovimiento(req, res, next) {
    try {
      const email = req.user?.email ?? null
      const result = await salariosService.crearMovimiento(req.body, email)
      res.status(201).json(result)
    } catch (err) { next(err) }
  }

  async actualizarMovimiento(req, res, next) {
    try {
      const result = await salariosService.actualizarMovimiento(req.params.id, req.body)
      res.json(result)
    } catch (err) { next(err) }
  }

  async eliminarMovimiento(req, res, next) {
    try {
      const result = await salariosService.eliminarMovimiento(req.params.id)
      res.json(result)
    } catch (err) { next(err) }
  }

  // Cotización del dólar
  async getCotizacionDiaria(req, res, next) {
    try {
      const result = await salariosService.getCotizacionDiaria()
      res.json(result)
    } catch (err) { next(err) }
  }

  async guardarCotizacion(req, res, next) {
    try {
      const result = await salariosService.guardarCotizacion(req.body)
      res.status(201).json(result)
    } catch (err) { next(err) }
  }

  // Métricas
  async metricas(req, res, next) {
    try {
      const result = await salariosService.getMetricas()
      res.json(result)
    } catch (err) { next(err) }
  }
}

module.exports = new SalariosController()
