const deudasService = require('../services/deudasService');

const listar = async (req, res, next) => {
  try {
    res.json(await deudasService.listar(req.query));
  } catch (err) { next(err); }
};

const metricas = async (req, res, next) => {
  try {
    res.json(await deudasService.getMetricas());
  } catch (err) { next(err); }
};

const obtener = async (req, res, next) => {
  try {
    res.json(await deudasService.obtenerPorId(req.params.id));
  } catch (err) { next(err); }
};

const crear = async (req, res, next) => {
  try {
    const email = req.user?.email ?? null;
    res.status(201).json(await deudasService.crear(req.body, email));
  } catch (err) { next(err); }
};

const actualizar = async (req, res, next) => {
  try {
    const email = req.user?.email ?? null;
    res.json(await deudasService.actualizar(req.params.id, req.body, email));
  } catch (err) { next(err); }
};

const eliminar = async (req, res, next) => {
  try {
    res.json(await deudasService.eliminar(req.params.id));
  } catch (err) { next(err); }
};

module.exports = { listar, metricas, obtener, crear, actualizar, eliminar };
