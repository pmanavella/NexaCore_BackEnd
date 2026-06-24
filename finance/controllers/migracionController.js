const multer = require('multer');
const migracionService = require('../services/migracionService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB — planillas históricas pueden ser grandes
  fileFilter: (req, file, cb) => {
    const validExt = ['.xlsx', '.xls', '.csv'].some(e => file.originalname.toLowerCase().endsWith(e));
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv',
      'application/csv',
    ];
    if (allowed.includes(file.mimetype) || validExt) return cb(null, true);
    cb(new Error('Solo se permiten archivos Excel (.xlsx, .xls) o CSV'));
  },
});

class MigracionController {
  get uploadMiddleware() { return upload.single('archivo'); }

  async listarTipos(req, res, next) {
    try {
      res.json(migracionService.listarTipos());
    } catch (err) { next(err); }
  }

  async preview(req, res, next) {
    try {
      if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo. Usar campo "archivo" en multipart/form-data.' });

      const { tipo_migracion, fecha_global } = req.body;
      if (!tipo_migracion) return res.status(400).json({ error: 'El campo "tipo_migracion" es requerido.' });

      const result = await migracionService.preview(req.file.buffer, { tipo_migracion, fecha_global });
      res.json(result);
    } catch (err) { next(err); }
  }

  async confirmar(req, res, next) {
    try {
      if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo. Usar campo "archivo" en multipart/form-data.' });

      const { tipo_migracion, fecha_global } = req.body;
      if (!tipo_migracion) return res.status(400).json({ error: 'El campo "tipo_migracion" es requerido.' });

      const result = await migracionService.confirmar(req.file.buffer, {
        tipo_migracion,
        fecha_global,
        nombre_archivo: req.file.originalname,
        usuario_id: req.user?.id ?? null,
        created_by: req.user?.email ?? null,
      });
      res.status(201).json(result);
    } catch (err) { next(err); }
  }

  async listarBatches(req, res, next) {
    try {
      const { page, limit, tipo_migracion, estado } = req.query;
      const result = await migracionService.listarBatches({
        page: parseInt(page) || 1,
        limit: Math.min(parseInt(limit) || 20, 100),
        tipo_migracion,
        estado,
      });
      res.json(result);
    } catch (err) { next(err); }
  }

  async obtenerBatch(req, res, next) {
    try {
      const result = await migracionService.obtenerBatch(req.params.id);
      res.json(result);
    } catch (err) { next(err); }
  }

  async revertirBatch(req, res, next) {
    try {
      const result = await migracionService.revertirBatch(req.params.id);
      res.json(result);
    } catch (err) { next(err); }
  }
}

module.exports = new MigracionController();
