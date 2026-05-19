const operationsService = require('../services/operationsService');

class OperationsController {
  async listarTareas(req, res, next) {
    try { res.json(await operationsService.listarTareas(req.query)); } catch (err) { next(err); }
  }
  async metricas(req, res, next) {
    try { res.json(await operationsService.getMetricas()); } catch (err) { next(err); }
  }
  async crearTarea(req, res, next) {
    try { res.status(201).json(await operationsService.crearTarea(req.body)); } catch (err) { next(err); }
  }
  async actualizarTarea(req, res, next) {
    try { res.json(await operationsService.actualizarTarea(req.params.id, req.body)); } catch (err) { next(err); }
  }
  async eliminarTarea(req, res, next) {
    try { res.json(await operationsService.eliminarTarea(req.params.id)); } catch (err) { next(err); }
  }

  // Devuelve el historial de cambios de una tarea específica (más reciente primero).
  // Endpoint: GET /api/operations/tareas/:id/historial
  async obtenerHistorial(req, res, next) {
    try { res.json(await operationsService.obtenerHistorial(req.params.id)); } catch (err) { next(err); }
  }

  // ── Propuestas ──────────────────────────────────────────────────────────────
  async listarPropuestas(req, res, next) {
    try { res.json(await operationsService.listarPropuestas(req.query)); } catch (err) { next(err); }
  }
  // req.body puede incluir { usuario_nombre, usuario_id } para registrar quién aprobó
  async aprobarPropuesta(req, res, next) {
    try { res.json(await operationsService.aprobarPropuesta(req.params.id, req.body)); } catch (err) { next(err); }
  }
  // req.body puede incluir { usuario_nombre, usuario_id } para registrar quién rechazó
  async rechazarPropuesta(req, res, next) {
    try { res.json(await operationsService.rechazarPropuesta(req.params.id, req.body)); } catch (err) { next(err); }
  }
}

module.exports = new OperationsController();
