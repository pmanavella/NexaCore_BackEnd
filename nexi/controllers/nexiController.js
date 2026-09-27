const nexiService = require('../services/nexiService');
const conversacionesService = require('../services/conversacionesService');

// El usuario SIEMPRE sale de req.user (authMiddleware). Nunca se lee un
// usuario_id desde body, query o params.

class NexiController {
  async chat(req, res, next) {
    try {
      const { conversationId, mensaje, contextoModulo } = req.body || {};
      const result = await nexiService.chat({ usuario: req.user, conversationId, mensaje, contextoModulo });
      res.json(result);
    } catch (err) { next(err); }
  }

  async listarConversaciones(req, res, next) {
    try {
      res.json(await conversacionesService.listar(req.user.id));
    } catch (err) { next(err); }
  }

  async crearConversacion(req, res, next) {
    try {
      const result = await conversacionesService.crear(req.user.id, req.body?.titulo);
      res.status(201).json(result);
    } catch (err) { next(err); }
  }

  async listarMensajes(req, res, next) {
    try {
      res.json(await conversacionesService.listarMensajes(req.params.id, req.user.id));
    } catch (err) { next(err); }
  }

  async eliminarConversacion(req, res, next) {
    try {
      res.json(await conversacionesService.eliminar(req.params.id, req.user.id));
    } catch (err) { next(err); }
  }
}

module.exports = new NexiController();
