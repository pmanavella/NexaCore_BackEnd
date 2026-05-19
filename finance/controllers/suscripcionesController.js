const suscripcionesService = require('../services/suscripcionesService');

const listar = async (req, res, next) => {
  try {
    res.json(await suscripcionesService.listar(req.query));
  } catch (err) { next(err); }
};

const obtener = async (req, res, next) => {
  try {
    res.json(await suscripcionesService.obtenerPorId(req.params.id));
  } catch (err) { next(err); }
};

const crear = async (req, res, next) => {
  try {
    const email = req.user?.email ?? null;
    res.status(201).json(await suscripcionesService.crear(req.body, email));
  } catch (err) { next(err); }
};

const actualizar = async (req, res, next) => {
  try {
    const email = req.user?.email ?? null;
    res.json(await suscripcionesService.actualizar(req.params.id, req.body, email));
  } catch (err) { next(err); }
};

const eliminar = async (req, res, next) => {
  try {
    res.json(await suscripcionesService.eliminar(req.params.id));
  } catch (err) { next(err); }
};

const proximasVencer = async (req, res, next) => {
  try {
    const dias = parseInt(req.query.dias) || 7;
    const data = await suscripcionesService.proximasVencer(dias);
    res.json({ data });
  } catch (err) { next(err); }
};

module.exports = { listar, obtener, crear, actualizar, eliminar, proximasVencer };
