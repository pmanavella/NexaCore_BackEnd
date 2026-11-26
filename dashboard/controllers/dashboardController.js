const dashboardService = require('../services/dashboardService');
const dashboardProtocolosService = require('../services/dashboardProtocolosService');

class DashboardController {
  async obtenerConfiguracion(req, res, next) {
    try {
      const result = await dashboardService.obtenerConfiguracion(req.user.id, req.user.role);
      res.json(result);
    } catch (err) { next(err); }
  }

  async guardarConfiguracion(req, res, next) {
    try {
      const result = await dashboardService.guardarConfiguracion(req.user.id, req.body?.widgets, req.user.role);
      res.json(result);
    } catch (err) { next(err); }
  }

  async obtenerCatalogo(req, res, next) {
    try {
      res.json(await dashboardService.obtenerCatalogo(req.user));
    } catch (err) { next(err); }
  }

  async obtenerProtocolos(req, res, next) {
    try {
      res.json(await dashboardProtocolosService.obtener(req.user, { period: req.query.period, limite: req.query.limite }));
    } catch (err) { next(err); }
  }
}

module.exports = new DashboardController();
