const service = require('../services/tareaActualizacionesService');

// Panel "Actualizaciones" de una tarea: comentarios (con menciones),
// temporizadores y registros de tiempo. El usuario sale siempre de req.user
// (authenticate); el body solo aporta `contenido` en los comentarios e
// inicio/fin/version en los registros de tiempo.
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
  async listarMencionables(req, res, next) {
    try { res.json(await service.listarMencionables(req.params.id, req.user)); } catch (err) { next(err); }
  }

  // ── Temporizador del usuario autenticado ────────────────────────────────────
  async obtenerTemporizador(req, res, next) {
    try { res.json(await service.obtenerTemporizadorActivo(req.params.id, req.user)); } catch (err) { next(err); }
  }
  async listarTemporizadoresActivos(req, res, next) {
    try { res.json(await service.listarTemporizadoresActivos(req.query, req.user)); } catch (err) { next(err); }
  }
  async iniciarTemporizador(req, res, next) {
    try { res.status(201).json(await service.iniciarTemporizador(req.params.id, req.user)); } catch (err) { next(err); }
  }
  async detenerTemporizador(req, res, next) {
    try { res.json(await service.detenerTemporizador(req.params.id, req.user)); } catch (err) { next(err); }
  }

  // ── Registros de tiempo (carga manual y corrección; no hay eliminación) ────
  async registrarTiempoManual(req, res, next) {
    try { res.status(201).json(await service.registrarTiempoManual(req.params.id, req.body, req.user)); } catch (err) { next(err); }
  }
  async validarRegistroTiempo(req, res, next) {
    try { res.json(await service.validarRegistroTiempo(req.params.id, req.body, req.user)); } catch (err) { next(err); }
  }
  async corregirRegistroTiempo(req, res, next) {
    try { res.json(await service.corregirRegistroTiempo(req.params.id, req.params.registroId, req.body, req.user)); } catch (err) { next(err); }
  }
  async listarCorreccionesRegistro(req, res, next) {
    try { res.json(await service.listarCorreccionesRegistro(req.params.id, req.params.registroId, req.user)); } catch (err) { next(err); }
  }
}

module.exports = new ActualizacionesController();
