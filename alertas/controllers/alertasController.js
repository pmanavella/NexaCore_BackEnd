const alertasService = require('../services/alertasService');

class AlertasController {
  async listar(req, res, next) {
    try { res.json(await alertasService.evaluar(req.user)); } catch (err) { next(err); }
  }

  // Detalle para el mosaico "Alertas" del Dashboard. Solo lee `tipos` y
  // `horizonte` de la query; la identidad sale siempre de la sesión.
  async proximas(req, res, next) {
    try {
      res.json(await alertasService.proximas(req.user, { tipos: req.query.tipos, horizonte: req.query.horizonte }));
    } catch (err) { next(err); }
  }
}

module.exports = new AlertasController();
