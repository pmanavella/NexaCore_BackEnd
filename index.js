require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const comprobantesService = require('./finance/services/comprobantesService');
const errorHandler = require('./middleware/errorHandler');

// Finance module
const movimientosRoutes = require('./finance/routes/movimientos');
const comprobantesRoutes = require('./finance/routes/comprobantes');
const excelRoutes = require('./finance/routes/excel');
const deudasRoutes = require('./finance/routes/deudas');

// Operations module
const tareasRoutes = require('./operations/routes/tareas');

// CRM module
const contactosRoutes = require('./crm/routes/contactos');

// Planification module
const proyectosRoutes = require('./planification/routes/proyectos');

// Finance — Salarios
const salariosRoutes = require('./finance/routes/salarios');

// Finance — Suscripciones
const suscripcionesRoutes = require('./finance/routes/suscripciones');

// RBAC
const rbacRoutes = require('./rbac/routes/rbac');

const app = express();
const PORT = process.env.PORT || 3001;

// ── CORS ────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:5173', 'http://localhost:3000'];

app.use(cors({
  origin: (origin, callback) => {
    // Permitir requests sin origin (ej: Postman, curl en desarrollo)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: Origen no permitido — ${origin}`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// ── Finance ──────────────────────────────────────────
app.use('/api/finance/movimientos', movimientosRoutes);
app.use('/api/finance/comprobantes', comprobantesRoutes);
app.use('/api/finance/excel', excelRoutes);
app.use('/api/finance/deudas', deudasRoutes);

// ── Operations ───────────────────────────────────────
app.use('/api/operations/tareas', tareasRoutes);

// ── CRM ──────────────────────────────────────────────
app.use('/api/crm/contactos', contactosRoutes);

// ── Planification ────────────────────────────────────
app.use('/api/planification/proyectos', proyectosRoutes);

// ── Salarios ──────────────────────────────────────────
app.use('/api/finance/salarios', salariosRoutes);

// ── Suscripciones ─────────────────────────────────────
app.use('/api/finance/suscripciones', suscripcionesRoutes);

// ── RBAC ──────────────────────────────────────────────
app.use('/api/rbac', rbacRoutes);

// Health check (público — sin auth)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'NexaCore', timestamp: new Date().toISOString() });
});

app.use(errorHandler);

// Cron: limpieza de comprobantes vencidos — todos los días a las 02:00
cron.schedule('0 2 * * *', async () => {
  try {
    const result = await comprobantesService.limpiarVencidos();
    console.log(`[NexaCore Cron] Limpieza comprobantes: ${result.eliminados} archivos eliminados.`);
  } catch (err) {
    console.error('[NexaCore Cron] Error en limpieza de comprobantes:', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`✅ NexaCore Backend corriendo en http://localhost:${PORT}`);
});
