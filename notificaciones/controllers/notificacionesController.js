const service = require('../services/notificacionesService');

// Notificaciones del usuario autenticado. El destinatario sale siempre de
// req.user (authenticate); no se aceptan ids de usuario del cliente.
class NotificacionesController {
  async listar(req, res, next) {
    try { res.json(await service.listar(req.query, req.user)); } catch (err) { next(err); }
  }
  async contarNoLeidas(req, res, next) {
    try { res.json(await service.contarNoLeidas(req.user)); } catch (err) { next(err); }
  }
  async marcarLeida(req, res, next) {
    try { res.json(await service.marcarLeida(req.params.id, req.user)); } catch (err) { next(err); }
  }
  async marcarTodasLeidas(req, res, next) {
    try { res.json(await service.marcarTodasLeidas(req.user)); } catch (err) { next(err); }
  }
}

module.exports = new NotificacionesController();
