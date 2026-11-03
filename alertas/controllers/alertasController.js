const alertasService = require('../services/alertasService');

class AlertasController {
  async listar(req, res, next) {
    try { res.json(await alertasService.evaluar(req.user)); } catch (err) { next(err); }
  }
}

module.exports = new AlertasController();
