const dashboardViewsService = require('../services/dashboardViewsService');

class DashboardViewsController {
  async listarVistas(req, res, next) {
    try {
      const result = await dashboardViewsService.listarVistas(req.user.id);
      res.json(result);
    } catch (err) { next(err); }
  }

  async crearVista(req, res, next) {
    try {
      const result = await dashboardViewsService.crearVista(req.user.id, req.body?.nombre);
      res.status(201).json(result);
    } catch (err) { next(err); }
  }

  async obtenerVista(req, res, next) {
    try {
      const result = await dashboardViewsService.obtenerVista(req.params.id, req.user.id, req.user.role);
      res.json(result);
    } catch (err) { next(err); }
  }

  async actualizarVista(req, res, next) {
    try {
      const result = await dashboardViewsService.actualizarVista(req.params.id, req.user.id, req.body, req.user.role);
      res.json(result);
    } catch (err) { next(err); }
  }

  async eliminarVista(req, res, next) {
    try {
      const result = await dashboardViewsService.eliminarVista(req.params.id, req.user.id);
      res.json(result);
    } catch (err) { next(err); }
  }
}

module.exports = new DashboardViewsController();
