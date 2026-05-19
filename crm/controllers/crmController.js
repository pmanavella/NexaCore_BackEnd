const crmService = require('../services/crmService');

class CrmController {
  async listarContactos(req, res, next) {
    try { res.json(await crmService.listarContactos(req.query)); } catch (err) { next(err); }
  }
  async metricas(req, res, next) {
    try { res.json(await crmService.getMetricas()); } catch (err) { next(err); }
  }
  async crearContacto(req, res, next) {
    try { res.status(201).json(await crmService.crearContacto(req.body)); } catch (err) { next(err); }
  }
  async actualizarContacto(req, res, next) {
    try { res.json(await crmService.actualizarContacto(req.params.id, req.body)); } catch (err) { next(err); }
  }
  async eliminarContacto(req, res, next) {
    try { res.json(await crmService.eliminarContacto(req.params.id)); } catch (err) { next(err); }
  }
}

module.exports = new CrmController();
