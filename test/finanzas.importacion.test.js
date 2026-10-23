// CP-FIN-04-01 — Importación por Excel con las 7 categorías válidas.
// El resultado esperado sale del caso de prueba (docs/casos/REQ-FIN-04.md):
// un archivo con una fila por cada categoría, incluida Suscripción, se importa
// completo. No sale del comportamiento actual del código.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const XLSX = require('xlsx');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const excelRoutes = require('../finance/routes/excel');
const errorHandler = require('../middleware/errorHandler');

// Las 7 categorías que el caso CP-FIN-04-01 exige aceptar.
const CATEGORIAS_DEL_CASO = [
  'Tecnología', 'RRHH', 'Insumos', 'Servicios', 'Inversión', 'Otros', 'Suscripción',
];

// Query builder falso de Supabase (mismo patrón que finanzas.montos.test.js):
// registra la cadena de llamadas y, al awaitearse, responde con handler(st).
function fakeFrom(handler) {
  return (table) => {
    const st = { table, ops: [] };
    const builder = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve(handler(st)).then(res, rej);
        return (...args) => { st.ops.push([prop, ...args]); return builder; };
      },
    });
    return builder;
  };
}
const op = (st, nombre) => st.ops.find(o => o[0] === nombre);

// Planilla .xlsx con varias filas de datos.
function planilla(encabezados, filas) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([encabezados, ...filas]), 'Hoja1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function subirExcel(app, path, buffer) {
  const server = http.createServer(app).listen(0);
  try {
    const { port } = server.address();
    const form = new FormData();
    form.append('archivo', new Blob([buffer]), 'movimientos.xlsx');
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer token-de-prueba' },
      body: form,
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

function appExcel() {
  const app = express();
  app.use(express.json());
  app.use('/api/finance/excel', excelRoutes);
  app.use(errorHandler);
  return app;
}

test('CP-FIN-04-01 endpoint Excel: archivo con las 7 categorías (incluida Suscripción) → HTTP 200 y 7 registros nuevos', async (t) => {
  // Arrange
  // El usuario se resuelve como Superadmin, igual que en finanzas.montos.test.js:
  // los permisos se prueban aparte, en finanzas.permisos.test.js.
  const insertados = [];
  t.mock.method(supabase.auth, 'getUser', async () => ({ data: { user: { email: 'contable@nexacore.test' } }, error: null }));
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    if (st.table === 'usuarios') return { data: { id: 'u1', nombre: 'Contable', roles: { nombre: 'Superadmin' } }, error: null };
    if (st.table === 'movimientos' && op(st, 'insert')) {
      const lote = op(st, 'insert')[1];
      insertados.push(...lote);
      return { data: lote.map((_, i) => ({ id: `m${i}` })), error: null };
    }
    throw new Error(`tabla inesperada ${st.table}`);
  }));
  const filas = CATEGORIAS_DEL_CASO.map((categoria, i) => (
    ['2025-01-15', `Movimiento de ${categoria}`, categoria, 'Gasto', 1000 + i]
  ));
  const buffer = planilla(['fecha', 'descripcion', 'categoria', 'tipo', 'monto'], filas);

  // Act
  const r = await subirExcel(appExcel(), '/api/finance/excel/importar', buffer);

  // Assert
  assert.equal(r.status, 200, `HTTP ${r.status}: ${JSON.stringify(r.body.errores ?? r.body.error)}`);
  assert.equal(insertados.length, 7);
  assert.deepEqual(insertados.map(m => m.categoria), CATEGORIAS_DEL_CASO);
});