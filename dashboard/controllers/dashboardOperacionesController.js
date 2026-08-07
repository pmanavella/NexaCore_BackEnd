const dashboardOperacionesService = require('../services/dashboardOperacionesService');

class DashboardOperacionesController {
  async obtenerResumen(req, res, next) {
    try {
      const result = await dashboardOperacionesService.obtenerResumen(req.user.id);
      res.json(result);
    } catch (err) { next(err); }
  }
}

module.exports = new DashboardOperacionesController();
