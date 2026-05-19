const movimientosService = require('../services/movimientosService');

class MovimientosController {
  async listar(req, res, next) {
    try {
      const result = await movimientosService.listar(req.query);
      res.json(result);
    } catch (err) { next(err); }
  }

  async metricas(req, res, next) {
    try {
      const result = await movimientosService.obtenerMetricas(req.query);
      res.json(result);
    } catch (err) { next(err); }
  }

  async flujo(req, res, next) {
    try {
      const result = await movimientosService.obtenerFlujo(req.query);
      res.json(result);
    } catch (err) { next(err); }
  }

  async obtener(req, res, next) {
    try {
      const result = await movimientosService.obtenerPorId(req.params.id);
      res.json(result);
    } catch (err) { next(err); }
  }

  async crear(req, res, next) {
    try {
      const email = req.user?.email ?? null;
      const result = await movimientosService.crear(req.body, email);
      res.status(201).json(result);
    } catch (err) { next(err); }
  }

  async actualizar(req, res, next) {
    try {
      const email = req.user?.email ?? null;
      const result = await movimientosService.actualizar(req.params.id, req.body, email);
      res.json(result);
    } catch (err) { next(err); }
  }

  async eliminar(req, res, next) {
    try {
      const result = await movimientosService.eliminar(req.params.id);
      res.json(result);
    } catch (err) { next(err); }
  }

  async trazabilidad(req, res, next) {
    try {
      const result = await movimientosService.listarTrazabilidad();
      res.json(result);
    } catch (err) { next(err); }
  }
}

module.exports = new MovimientosController();
