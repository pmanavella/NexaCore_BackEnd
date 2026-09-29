const etapasService = require('../services/etapasService');

class EtapasController {
  async listarEtapas(req, res, next) {
    try { res.json(await etapasService.listarEtapas()); } catch (err) { next(err); }
  }
  async crearEtapa(req, res, next) {
    try { res.status(201).json(await etapasService.crearEtapa(req.body)); } catch (err) { next(err); }
  }
  async actualizarEtapa(req, res, next) {
    try { res.json(await etapasService.actualizarEtapa(req.params.id, req.body)); } catch (err) { next(err); }
  }
  async eliminarEtapa(req, res, next) {
    try { res.json(await etapasService.eliminarEtapa(req.params.id)); } catch (err) { next(err); }
  }
}

module.exports = new EtapasController();
