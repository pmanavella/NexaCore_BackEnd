// RN-01 — Interpretación de montos escritos como texto.
// Los resultados esperados salen de la regla del requisito, no del código actual:
// varios casos deben fallar mientras el parseo no implemente RN-01.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const XLSX = require('xlsx');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const migracionService = require('../finance/services/migracionService');
const excelRoutes = require('../finance/routes/excel');
const errorHandler = require('../middleware/errorHandler');

const RECHAZADA = 'fila rechazada';

// Query builder falso de Supabase: registra la cadena de llamadas y, al
// awaitearse, responde con handler({ table, ops }).
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

// Planilla .xlsx con una sola fila de datos. Un string JS queda como celda de
// texto y un number como celda numérica, igual que lo entregaría Excel.
function planilla(encabezados, fila) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([encabezados, fila]), 'Hoja1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ── Migración de gastos históricos (finance/services/migradores/) ──────────
// toMoney/toNumber se usan vía migracionService.preview → gastosHistoricos.procesar,
// que es el camino público por el que la migración interpreta la columna "Total".

const casosMigracion = [
  { id: 'CP-FIN-03-01', entrada: '1.234,56',   esperado: 1234.56 },
  { id: 'CP-FIN-03-02', entrada: '1,5',        esperado: 1.5 },
  { id: 'CP-FIN-03-03', entrada: '$ 1,234.50', esperado: 1234.50 },
  { id: 'CP-FIN-03-04', entrada: '0.004',      esperado: RECHAZADA },
  { id: 'CP-FIN-03-11', entrada: '1.234',      esperado: 1234 },
  { id: 'CP-FIN-03-12', entrada: '1.234.567',  esperado: 1234567 },
  { id: 'CP-FIN-03-13', entrada: '1.5',        esperado: 1.5 },
  { id: 'CP-FIN-03-14', entrada: '1,2,3',      esperado: RECHAZADA },
  { id: 'CP-FIN-03-15', entrada: 1234.56,      esperado: 1234.56 },
];

for (const c of casosMigracion) {
  const desc = typeof c.entrada === 'number' ? `número ${c.entrada}` : `"${c.entrada}"`;
  const resultado = c.esperado === RECHAZADA ? 'rechaza la fila' : `interpreta como ${c.esperado}`;

  test(`${c.id} migración de gastos históricos: ${desc} → ${resultado}`, async () => {
    // Arrange
    const buffer = planilla(['Nombre', 'Total'], ['Gasto de prueba', c.entrada]);

    // Act
    const r = await migracionService.preview(buffer, {
      tipo_migracion: 'GASTOS_HISTORICOS',
      fecha_global: '2025-01-15',
    });

    // Assert
    const obtenido = r.registros_rechazados > 0 ? RECHAZADA : r.preview[0]?.monto;
    assert.equal(obtenido, c.esperado);
  });
}

// ── Endpoint de Excel (finance/services/excelService.js) ───────────────────
// Se ejercita POST /api/finance/excel/importar con la ruta real; authenticate
// y la inserción en `movimientos` se resuelven contra un Supabase simulado.

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

const casosExcel = [
  { id: 'CP-FIN-04-10', entrada: '1.234,56', esperado: 1234.56 },
  { id: 'CP-FIN-04-11', entrada: '1.234',    esperado: 1234 },
  { id: 'CP-FIN-04-12', entrada: '1,5',      esperado: 1.5 },
];

for (const c of casosExcel) {
  test(`${c.id} endpoint Excel: monto "${c.entrada}" → ${c.esperado}`, async (t) => {
    // Arrange
    const insertados = [];
    t.mock.method(supabase.auth, 'getUser', async () => ({ data: { user: { email: 'u@x' } }, error: null }));
    t.mock.method(supabase, 'from', fakeFrom((st) => {
      if (st.table === 'usuarios') return { data: { id: 'u1', nombre: 'U', roles: { nombre: 'Superadmin' } }, error: null };
      if (st.table === 'movimientos' && op(st, 'insert')) {
        const lote = op(st, 'insert')[1];
        insertados.push(...lote);
        return { data: lote.map((_, i) => ({ id: `m${i}` })), error: null };
      }
      throw new Error(`tabla inesperada ${st.table}`);
    }));
    const buffer = planilla(
      ['fecha', 'descripcion', 'categoria', 'tipo', 'monto'],
      ['2025-01-15', 'Compra de prueba', 'Insumos', 'Gasto', c.entrada],
    );

    // Act
    const r = await subirExcel(appExcel(), '/api/finance/excel/importar', buffer);

    // Assert
    const obtenido = r.status === 200
      ? insertados[0]?.monto
      : `HTTP ${r.status}: ${JSON.stringify(r.body.errores ?? r.body.error)}`;
    assert.equal(obtenido, c.esperado);
  });
}
