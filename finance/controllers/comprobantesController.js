const comprobantesService = require('../services/comprobantesService');
const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo de archivo no permitido. Solo JPG, PNG o PDF.'));
  }
});

class ComprobantesController {
  get uploadMiddleware() { return upload.single('archivo'); }

  async subir(req, res, next) {
    try {
      if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
      const result = await comprobantesService.subirArchivo(req.file, req.body.movimiento_id);
      res.status(201).json(result);
    } catch (err) { next(err); }
  }

  async listar(req, res, next) {
    try {
      const result = await comprobantesService.listar();
      res.json(result);
    } catch (err) { next(err); }
  }

  async vincular(req, res, next) {
    try {
      const result = await comprobantesService.vincular(req.params.id, req.body.movimiento_id);
      res.json(result);
    } catch (err) { next(err); }
  }

  async eliminar(req, res, next) {
    try {
      const result = await comprobantesService.eliminar(req.params.id);
      res.json(result);
    } catch (err) { next(err); }
  }
}

module.exports = new ComprobantesController();
