const planificationService = require('../services/planificationService');

class PlanificationController {
  async listarProyectos(req, res, next) {
    try { res.json(await planificationService.listarProyectos(req.query)); } catch (err) { next(err); }
  }
  async metricas(req, res, next) {
    try { res.json(await planificationService.getMetricas()); } catch (err) { next(err); }
  }
  async crearProyecto(req, res, next) {
    try { res.status(201).json(await planificationService.crearProyecto(req.body)); } catch (err) { next(err); }
  }
  async actualizarProyecto(req, res, next) {
    try { res.json(await planificationService.actualizarProyecto(req.params.id, req.body)); } catch (err) { next(err); }
  }
  async eliminarProyecto(req, res, next) {
    try { res.json(await planificationService.eliminarProyecto(req.params.id)); } catch (err) { next(err); }
  }
}

module.exports = new PlanificationController();
