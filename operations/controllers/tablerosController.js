const tablerosService = require('../services/tablerosService');

class TablerosController {
  async listarTableros(req, res, next) {
    try { res.json(await tablerosService.listarTableros(req.user)); } catch (err) { next(err); }
  }
  async crearTablero(req, res, next) {
    try { res.status(201).json(await tablerosService.crearTablero(req.body, req.user)); } catch (err) { next(err); }
  }
  async actualizarTablero(req, res, next) {
    try { res.json(await tablerosService.actualizarTablero(req.params.id, req.body)); } catch (err) { next(err); }
  }
}

module.exports = new TablerosController();
