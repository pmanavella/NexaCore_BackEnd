const dashboardService = require('../services/dashboardService');

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
}

module.exports = new DashboardController();
