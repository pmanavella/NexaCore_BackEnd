const protocolosService = require('../services/protocolosService');

class ProtocolosController {

  // ── PROTOCOLOS ─────────────────────────────────────────────

  async listarProtocolos(req, res, next) {
    try {
      const { categoria, search } = req.query;
      const data = await protocolosService.listarProtocolos({ categoria, search });
      res.json(data);
    } catch (err) { next(err); }
  }

  async obtenerMetricas(req, res, next) {
    try {
      const data = await protocolosService.obtenerMetricas();
      res.json(data);
    } catch (err) { next(err); }
  }

  async obtenerProtocolo(req, res, next) {
    try {
      const data = await protocolosService.obtenerProtocolo(req.params.id);
      res.json(data);
    } catch (err) { next(err); }
  }

  async crearProtocolo(req, res, next) {
    try {
      const data = await protocolosService.crearProtocolo(req.body, req.user?.id);
      res.status(201).json(data);
    } catch (err) { next(err); }
  }

  async actualizarProtocolo(req, res, next) {
    try {
      const data = await protocolosService.actualizarProtocolo(req.params.id, req.body, req.user?.id);
      res.json(data);
    } catch (err) { next(err); }
  }

  async actualizarItems(req, res, next) {
    try {
      const data = await protocolosService.actualizarItems(req.params.id, req.body);
      res.json({ data });
    } catch (err) { next(err); }
  }

  // ── PRUEBAS ────────────────────────────────────────────────

  async registrarPrueba(req, res, next) {
    try {
      const data = await protocolosService.registrarPrueba(req.params.id, req.body, req.user);
      res.status(201).json(data);
    } catch (err) { next(err); }
  }

  async listarPruebas(req, res, next) {
    try {
      const data = await protocolosService.listarPruebas(req.params.id);
      res.json({ data });
    } catch (err) { next(err); }
  }

  async obtenerPrueba(req, res, next) {
    try {
      const data = await protocolosService.obtenerPrueba(req.params.pruebaId);
      res.json(data);
    } catch (err) { next(err); }
  }
}

module.exports = new ProtocolosController();
