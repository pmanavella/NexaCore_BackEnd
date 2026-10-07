const nexiService = require('../services/nexiService');
const conversacionesService = require('../services/conversacionesService');
const reportesRepositorio = require('../services/reportesRepositorio');
const nexiPermisos = require('../services/nexiPermisos');
const { errorPublico } = require('../utils/errores');

// Descargar o listar reportes exige el permiso VIGENTE de lectura en Reportes
// (si fue revocado después de generarlos, ya no se pueden descargar).
async function exigirPermisoReportes(usuario) {
  const niveles = await nexiPermisos.obtenerNiveles(usuario);
  if (!nexiPermisos.cumpleRequisitos(niveles, [{ modulo: 'reportes', permiso: 'lector' }])) {
    throw errorPublico(403, 'No tenés permisos para acceder a los reportes.', 'SIN_PERMISO_MODULO');
  }
}

// Nombre de archivo seguro para Content-Disposition.
function nombreArchivo(titulo, formato) {
  const base = String(titulo || 'reporte').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 _-]+/g, ' ').trim().replace(/\s+/g, '_').slice(0, 80) || 'reporte';
  return `${base}.${formato}`;
}

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

  async listarReportes(req, res, next) {
    try {
      await exigirPermisoReportes(req.user);
      const data = await reportesRepositorio.listarPropios(req.user.id, 50);
      res.json({
        data: data.map(r => ({ ...r, descargaUrl: r.estado === 'GENERADO' ? `/api/nexi/reportes/${r.id}/descarga` : null })),
        total: data.length,
      });
    } catch (err) { next(err); }
  }

  async descargarReporte(req, res, next) {
    try {
      await exigirPermisoReportes(req.user);
      const reporte = await reportesRepositorio.obtenerPropio(req.params.id, req.user.id);
      if (reporte.estado !== 'GENERADO' || !reporte.archivo_path) {
        throw errorPublico(409, 'El reporte no tiene un archivo disponible para descargar.', 'REPORTE_NO_DISPONIBLE');
      }
      const archivo = await reportesRepositorio.descargarArchivo(reporte.archivo_path);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Length': String(archivo.length),
        'Content-Disposition': `attachment; filename="${nombreArchivo(reporte.titulo, reporte.formato)}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(archivo);
    } catch (err) { next(err); }
  }
}

module.exports = new NexiController();
