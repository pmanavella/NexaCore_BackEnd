const indicadoresService = require('../services/indicadoresService');

class IndicadoresController {
  async listar(req, res, next) {
    try {
      const result = await indicadoresService.listar(req.query);
      res.json(result);
    } catch (err) { next(err); }
  }

  async variables(req, res, next) {
    try {
      res.json(indicadoresService.listarVariables());
    } catch (err) { next(err); }
  }

  async validarFormula(req, res, next) {
    try {
      res.json(indicadoresService.validarFormula(req.body?.formula));
    } catch (err) { next(err); }
  }

  async obtener(req, res, next) {
    try {
      const result = await indicadoresService.obtenerPorId(req.params.id);
      res.json(result);
    } catch (err) { next(err); }
  }

  async crear(req, res, next) {
    try {
      const result = await indicadoresService.crear(req.body, req.user?.email ?? null);
      res.status(201).json(result);
    } catch (err) { next(err); }
  }

  async actualizar(req, res, next) {
    try {
      const result = await indicadoresService.actualizar(req.params.id, req.body, req.user?.email ?? null);
      res.json(result);
    } catch (err) { next(err); }
  }

  async desactivar(req, res, next) {
    try {
      const result = await indicadoresService.desactivar(req.params.id, req.user?.email ?? null);
      res.json(result);
    } catch (err) { next(err); }
  }

  async valor(req, res, next) {
    try {
      const result = await indicadoresService.calcularValor(req.params.id, req.query.periodo);
      res.json(result);
    } catch (err) { next(err); }
  }

  async historico(req, res, next) {
    try {
      const result = await indicadoresService.calcularHistorico(req.params.id, req.query.period);
      res.json(result);
    } catch (err) { next(err); }
  }
}

module.exports = new IndicadoresController();
