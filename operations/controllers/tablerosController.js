const tablerosService = require('../services/tablerosService');

class TablerosController {
  async listarTableros(req, res, next) {
    try { res.json(await tablerosService.listarTableros(req.user)); } catch (err) { next(err); }
  }
  async crearTablero(req, res, next) {
    try { res.status(201).json(await tablerosService.crearTablero(req.body, req.user)); } catch (err) { next(err); }
  }
  async actualizarTablero(req, res, next) {
    try { res.json(await tablerosService.actualizarTablero(req.params.id, req.body, req.user)); } catch (err) { next(err); }
  }

  // ── Miembros (administradores del tablero) ──────────────────────────────────
  async agregarMiembros(req, res, next) {
    try { res.json(await tablerosService.agregarMiembros(req.params.id, req.body, req.user)); } catch (err) { next(err); }
  }
  async actualizarMiembro(req, res, next) {
    try { res.json(await tablerosService.actualizarMiembro(req.params.id, req.params.usuarioId, req.body, req.user)); } catch (err) { next(err); }
  }
  async quitarMiembro(req, res, next) {
    try { res.json(await tablerosService.quitarMiembro(req.params.id, req.params.usuarioId, req.user)); } catch (err) { next(err); }
  }
  async regularizarAdministrador(req, res, next) {
    try { res.json(await tablerosService.regularizarAdministrador(req.params.id, req.body, req.user)); } catch (err) { next(err); }
  }
}

module.exports = new TablerosController();
