const service = require('../services/tareaActualizacionesService');

// Panel "Actualizaciones" de una tarea: comentarios y temporizadores.
// El usuario sale siempre de req.user (authenticate); el body solo aporta
// `contenido` en los comentarios.
class ActualizacionesController {
  async listarActualizaciones(req, res, next) {
    try { res.json(await service.listarActualizaciones(req.params.id, req.user)); } catch (err) { next(err); }
  }

  // ── Comentarios ─────────────────────────────────────────────────────────────
  async listarComentarios(req, res, next) {
    try { res.json(await service.listarComentarios(req.params.id, req.user)); } catch (err) { next(err); }
  }
  async crearComentario(req, res, next) {
    try { res.status(201).json(await service.crearComentario(req.params.id, req.body, req.user)); } catch (err) { next(err); }
  }
  async editarComentario(req, res, next) {
    try { res.json(await service.editarComentario(req.params.id, req.params.comentarioId, req.body, req.user)); } catch (err) { next(err); }
  }
  async eliminarComentario(req, res, next) {
    try { res.json(await service.eliminarComentario(req.params.id, req.params.comentarioId, req.user)); } catch (err) { next(err); }
  }

  // ── Temporizador del usuario autenticado ────────────────────────────────────
  async obtenerTemporizador(req, res, next) {
    try { res.json(await service.obtenerTemporizadorActivo(req.params.id, req.user)); } catch (err) { next(err); }
  }
  async iniciarTemporizador(req, res, next) {
    try { res.status(201).json(await service.iniciarTemporizador(req.params.id, req.user)); } catch (err) { next(err); }
  }
  async detenerTemporizador(req, res, next) {
    try { res.json(await service.detenerTemporizador(req.params.id, req.user)); } catch (err) { next(err); }
  }
}

module.exports = new ActualizacionesController();
