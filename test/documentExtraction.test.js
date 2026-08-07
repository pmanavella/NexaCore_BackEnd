const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';
const {
  fingerprintFor, hasAllowedSignature, normalizeExtraction, validateExtraction
} = require('../finance/services/documentExtraction');
const { analyzeDocument } = require('../finance/services/geminiDocumentService');
const comprobantesService = require('../finance/services/comprobantesService');
const movimientosService = require('../finance/services/movimientosService');
const supabase = require('../config/supabase');

function facturaEjemplo() {
  return {
    documentType: 'factura_a',
    issuer: { name: 'TechPlace', cuit: '20-95815672-4' },
    recipient: { name: 'LOCALES COMERCIALES SRL', cuit: '30-60157527-9' },
    pointOfSale: '0006', documentNumber: '00002845', cae: '6261619010019',
    issueDate: '2026-06-25', currency: 'ARS', subtotal: 50473.74,
    discountsTotal: 2856.99, ivaTotal: 9999.52, otherTaxesTotal: 0, total: 57616.26,
    items: [{ code: 'A0085', description: 'FUENTE SWITCHING 12V 2A X5', quantity: 2, unitPrice: 25236.87, discount: 0, ivaRate: 21, lineTotal: 57616.26 }],
    suggestedCategory: 'Tecnología', suggestedTransactionType: 'Gasto', description: 'Compra de fuente switching'
  };
}

test('normaliza y valida la factura de aceptación como gasto automático', () => {
  const extraction = normalizeExtraction(facturaEjemplo());
  const validation = validateExtraction(extraction, '30-60157527-9');
  assert.equal(extraction.issuer.name, 'TechPlace');
  assert.equal(extraction.issueDate, '2026-06-25');
  assert.equal(extraction.total, 57616.26);
  assert.equal(extraction.items[0].description, 'FUENTE SWITCHING 12V 2A X5');
  assert.equal(validation.valid, true);
  assert.equal(validation.movimiento.tipo, 'Gasto');
  assert.equal(validation.movimiento.categoria, 'Tecnología');
});

test('clasifica una factura emitida por la empresa como ingreso', () => {
  const invoice = facturaEjemplo();
  invoice.issuer = { name: 'LOCALES COMERCIALES SRL', cuit: '30-60157527-9' };
  invoice.recipient = { name: 'Cliente SA', cuit: '20-11111111-1' };
  invoice.suggestedTransactionType = 'Ingreso';
  const validation = validateExtraction(normalizeExtraction(invoice), '30601575279');
  assert.equal(validation.valid, true);
  assert.equal(validation.transactionType, 'Ingreso');
});

test('bloquea creación si los importes no concilian, falta CUIT o la categoría es inválida', () => {
  const invoice = facturaEjemplo();
  invoice.total = 60000;
  invoice.issuer.cuit = null;
  invoice.suggestedCategory = 'Sin clasificar';
  const validation = validateExtraction(normalizeExtraction(invoice), '30601575279');
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(' '), /emisor/i);
  assert.match(validation.errors.join(' '), /categoría/i);
  assert.match(validation.errors.join(' '), /concilia/i);
});

test('genera claves de deduplicación fiscal y alternativa estables', () => {
  const fiscal = normalizeExtraction(facturaEjemplo());
  assert.equal(fingerprintFor(fiscal), 'fiscal:20958156724:factura_a:0006:00002845');
  const ticket = normalizeExtraction({ ...facturaEjemplo(), pointOfSale: null, documentNumber: null });
  assert.match(fingerprintFor(ticket), /^simple:[a-f0-9]{64}$/);
});

test('verifica la firma real de PDF, PNG y JPEG', () => {
  assert.equal(hasAllowedSignature(Buffer.from('%PDF-1.7'), 'application/pdf'), true);
  assert.equal(hasAllowedSignature(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png'), true);
  assert.equal(hasAllowedSignature(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'), true);
  assert.equal(hasAllowedSignature(Buffer.from('texto'), 'application/pdf'), false);
});

test('integra Gemini con JSON estructurado y no acepta JSON inválido', async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  global.fetch = async (url, options) => {
    assert.match(url, /gemini-3\.1-flash-lite/);
    const request = JSON.parse(options.body);
    assert.equal(request.generationConfig.responseMimeType, 'application/json');
    assert.ok(request.generationConfig.responseJsonSchema);
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(facturaEjemplo()) }] } }] }) };
  };
  try {
    const result = await analyzeDocument(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');
    assert.equal(result.documentNumber, '00002845');
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('rechaza la respuesta inválida de Gemini', async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  global.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{invalido' }] } }] }) });
  try {
    await assert.rejects(() => analyzeDocument(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'), /JSON inválido/);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('carga, firma el archivo y crea el movimiento al pasar todas las validaciones', async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.GEMINI_API_KEY;
  const previousCuit = process.env.COMPANY_CUIT;
  const previousFrom = supabase.from;
  const previousStorage = supabase.storage;
  const previousCrear = movimientosService.crear;
  const rows = { comprobantes: [], comprobante_items: [] };
  let sequence = 0;

  process.env.GEMINI_API_KEY = 'test-key';
  process.env.COMPANY_CUIT = '30601575279';
  global.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(facturaEjemplo()) }] } }] }) });
  supabase.storage = {
    from: () => ({
      upload: async () => ({ error: null }),
      createSignedUrl: async path => ({ data: { signedUrl: `https://signed.local/${path}` }, error: null }),
      remove: async () => ({ error: null })
    })
  };
  supabase.from = table => {
    if (table === 'comprobante_items') return { insert: values => { rows.comprobante_items.push(...values); return { select: async () => ({ data: values, error: null }) }; } };
    return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      insert: values => ({ select: () => ({ single: async () => {
        const row = { ...values[0], id: `comp-${++sequence}`, comprobante_items: [], movimientos: null };
        rows.comprobantes.push(row);
        return { data: row, error: null };
      } }) }),
      update: values => ({
        eq: () => ({
          select: () => ({
            single: async () => {
              Object.assign(rows.comprobantes[0], values, { movimientos: { id: 'mov-1', tipo: 'Gasto', monto: 57616.26, descripcion: 'Compra de fuente switching', fecha: '2026-06-25' } });
              return { data: rows.comprobantes[0], error: null };
            }
          })
        })
      })
    };
  };
  movimientosService.crear = async body => ({ id: 'mov-1', ...body });

  try {
    const result = await comprobantesService.subirArchivo({
      originalname: 'factura.jpg', mimetype: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    }, 'contabilidad@nexacore.local');
    assert.equal(result.movimiento.tipo, 'Gasto');
    assert.equal(result.analysis.auto_created, true);
    assert.equal(rows.comprobante_items.length, 1);
    assert.match(result.comprobante.archivo_url, /^https:\/\/signed\.local\//);
  } finally {
    global.fetch = previousFetch;
    supabase.from = previousFrom;
    supabase.storage = previousStorage;
    movimientosService.crear = previousCrear;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousCuit === undefined) delete process.env.COMPANY_CUIT;
    else process.env.COMPANY_CUIT = previousCuit;
  }
});
