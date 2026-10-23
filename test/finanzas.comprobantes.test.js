// REQ-FIN-09 — Registro automático de movimientos a partir de comprobantes.
// El movimiento se crea con movimientosService real, así pasa por las mismas
// validaciones que un alta manual (monto con 2 decimales como máximo).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const comprobantesService = require('../finance/services/comprobantesService');

const CUIT_EMPRESA = '30601575279';

// Factura de compra que concilia: 1020.30 + IVA 214.267 = 1234.567.
function facturaConTotal(total) {
  return {
    documentType: 'factura_a',
    issuer: { name: 'Proveedor Prueba SA', cuit: '20-95815672-4' },
    recipient: { name: 'NexaCore', cuit: '30-60157527-9' },
    pointOfSale: '0001', documentNumber: '00000123', cae: '1234567890123',
    issueDate: '2026-10-15', currency: 'ARS', subtotal: 1020.30,
    discountsTotal: 0, ivaTotal: 214.267, otherTaxesTotal: 0, total,
    items: [{ code: 'P1', description: 'Servicio de prueba', quantity: 1, unitPrice: 1020.30, discount: 0, ivaRate: 21, lineTotal: 1020.30 }],
    suggestedCategory: 'Tecnología', suggestedTransactionType: 'Gasto', description: 'TEST comprobante',
  };
}

// ── Dobles de prueba ────────────────────────────────────────────────────────

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

// Gemini devuelve `extraccion`; el storage acepta cualquier archivo; la base
// registra comprobantes (sin duplicados previos), renglones y movimientos.
function simularEntorno(t, extraccion) {
  const base = { comprobantes: [], movimientos: [] };
  for (const [clave, valor] of [['GEMINI_API_KEY', 'test-key'], ['COMPANY_CUIT', CUIT_EMPRESA]]) {
    const previo = process.env[clave];
    process.env[clave] = valor;
    t.after(() => { if (previo === undefined) delete process.env[clave]; else process.env[clave] = previo; });
  }
  t.mock.method(global, 'fetch', async () => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(extraccion) }] } }] }),
  }));
  t.mock.method(supabase.storage, 'from', () => ({
    upload: async () => ({ error: null }),
    createSignedUrl: async (ruta) => ({ data: { signedUrl: `https://signed.local/${ruta}` }, error: null }),
  }));
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    if (st.table === 'comprobantes') {
      if (op(st, 'insert')) {
        const fila = { id: `c${base.comprobantes.length + 1}`, ...op(st, 'insert')[1][0], movimientos: null };
        base.comprobantes.push(fila);
        return { data: fila, error: null };
      }
      if (op(st, 'update')) {
        const fila = base.comprobantes.at(-1);
        Object.assign(fila, op(st, 'update')[1]);
        return { data: fila, error: null };
      }
      return { data: null, error: null };
    }
    if (st.table === 'comprobante_items') return { data: op(st, 'insert')[1], error: null };
    if (st.table === 'movimientos' && op(st, 'insert')) {
      const [fila] = op(st, 'insert')[1];
      base.movimientos.push(fila);
      return { data: { id: `m${base.movimientos.length}`, ...fila }, error: null };
    }
    throw new Error(`tabla inesperada ${st.table}`);
  }));
  return base;
}

// ── Casos ───────────────────────────────────────────────────────────────────

test('CP-FIN-09-01 comprobante válido con total extraído 1234.567 → crea el movimiento con monto 1234.57 y queda "procesado"', async (t) => {
  // Arrange
  const base = simularEntorno(t, facturaConTotal(1234.567));
  const archivo = { originalname: 'factura.jpg', mimetype: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) };

  // Act
  const r = await comprobantesService.subirArchivo(archivo, 'contabilidad@test');

  // Assert
  assert.deepEqual(r.analysis.errors, [], 'el análisis no debe registrar errores');
  assert.equal(base.movimientos.length, 1, 'debe crearse un movimiento');
  assert.equal(base.movimientos[0].monto, 1234.57);
  assert.equal(r.comprobante.estado_analisis, 'procesado');
  assert.equal(r.comprobante.movimiento_id, 'm1', 'el comprobante debe quedar vinculado al movimiento');
});
