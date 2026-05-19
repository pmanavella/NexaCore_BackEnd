const excelService = require('../services/excelService');
const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel', 'text/csv'
    ];
    const validExt = ['.xlsx', '.xls', '.csv'].some(e => file.originalname.endsWith(e));
    if (allowed.includes(file.mimetype) || validExt) cb(null, true);
    else cb(new Error('Solo se permiten archivos Excel (.xlsx, .xls) o CSV'));
  }
});

class ExcelController {
  get uploadMiddleware() { return upload.single('archivo'); }

  async validar(req, res, next) {
    try {
      if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
      const result = await excelService.validar(req.file.buffer);
      res.json(result);
    } catch (err) { next(err); }
  }

  async importar(req, res, next) {
    try {
      if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
      const email = req.user?.email ?? null;
      const result = await excelService.importar(req.file.buffer, email);
      res.json(result);
    } catch (err) { next(err); }
  }

  async plantilla(req, res, next) {
    try {
      res.json(excelService.getPlantillaInfo());
    } catch (err) { next(err); }
  }
}

module.exports = new ExcelController();
