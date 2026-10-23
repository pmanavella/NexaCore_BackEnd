// REQ-FIN-02 — Registrar gastos e ingresos con datos válidos.
// Los resultados esperados salen de la regla del requisito, no del código actual:
// varios casos deben fallar mientras POST /movimientos no valide cada campo.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const movimientosRoutes = require('../finance/routes/movimientos');
const errorHandler = require('../middleware/errorHandler');

const CATEGORIAS = ['Tecnología', 'RRHH', 'Insumos', 'Servicios', 'Inversión', 'Otros', 'Suscripción'];
const TIPOS = ['Gasto', 'Ingreso'];
const BASE = { fecha: '2026-10-15', descripcion: 'TEST alta', categoria: 'Servicios', tipo: 'Gasto', monto: 1000 };

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

// Sesión de un usuario Dirección (mando alto) para aislar la validación de los
// permisos. La tabla `movimientos` acepta cualquier inserción y la registra.
function simularBase(t) {
  const insertados = [];
  t.mock.method(supabase.auth, 'getUser', async () => ({ data: { user: { email: 'direccion@test' } }, error: null }));
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    if (st.table === 'usuarios') return { data: { id: 'u1', nombre: 'Dirección Prueba', roles: { nombre: 'Dirección' } }, error: null };
    if (st.table === 'movimientos' && op(st, 'insert')) {
      const [fila] = op(st, 'insert')[1];
      insertados.push(fila);
      return { data: { id: `m${insertados.length}`, ...fila }, error: null };
    }
    throw new Error(`tabla inesperada ${st.table}`);
  }));
  return insertados;
}

function appMovimientos() {
  const app = express();
  app.use(express.json());
  app.use('/api/finance/movimientos', movimientosRoutes);
  app.use(errorHandler);
  return app;
}

async function crearMovimiento(app, body) {
  const server = http.createServer(app).listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/finance/movimientos`, {
      method: 'POST',
      headers: { authorization: 'Bearer token-de-prueba', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

// ── Tabla de casos ──────────────────────────────────────────────────────────
// Cada caso cambia un solo campo de BASE.
// Válido:   { guardado: { campo: valor } } → 201 y la fila insertada lo contiene.
// Inválido: { rechazo: true, mensaje? }   → 400, mensaje que cumple el criterio
//                                           y ninguna inserción.

const casos = [];

for (const categoria of CATEGORIAS) {
  for (const tipo of TIPOS) {
    casos.push({ id: 'CP-FIN-02-01', cambio: { categoria, tipo }, guardado: { categoria, tipo } });
  }
}

const listaCategorias = (msg) => CATEGORIAS.every(c => msg.includes(c));
// "Faltan campos obligatorios: …, monto" no indica que el problema sea el valor del monto.
const hablaDelMonto = (msg) => /monto/i.test(msg) && !/faltan campos/i.test(msg);

casos.push(
  { id: 'CP-FIN-02-02', cambio: { categoria: 'rrhh' },           rechazo: true },
  { id: 'CP-FIN-02-03', cambio: { categoria: 'Viáticos' },       rechazo: true, mensaje: listaCategorias, criterio: 'menciona las 7 categorías válidas' },
  { id: 'CP-FIN-02-04', cambio: { monto: 0 },                    rechazo: true, mensaje: hablaDelMonto, criterio: 'habla del monto' },
  { id: 'CP-FIN-02-05', cambio: { monto: -100 },                 rechazo: true },
  { id: 'CP-FIN-02-06', cambio: { monto: 'abc' },                rechazo: true },
  { id: 'CP-FIN-02-07', cambio: { tipo: 'Egreso' },              rechazo: true },
  { id: 'CP-FIN-02-08', cambio: { fecha: '2026-02-31' },         rechazo: true },
  { id: 'CP-FIN-02-09', cambio: { descripcion: '   ' },          rechazo: true },
  { id: 'CP-FIN-02-10', cambio: { monto: 0.01 },                 guardado: { monto: 0.01 } },
  { id: 'CP-FIN-02-11', cambio: { monto: 0.001 },                rechazo: true },
  { id: 'CP-FIN-02-12', cambio: { monto: 9999999999999.99 },     guardado: { monto: 9999999999999.99 } },
  { id: 'CP-FIN-02-13', cambio: { monto: 10000000000000 },       rechazo: true },
);

const describir = (cambio) => Object.entries(cambio).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(', ');

for (const c of casos) {
  const resultado = c.rechazo ? '400 sin inserción' : `201 y guarda ${describir(c.guardado)}`;

  test(`${c.id} POST /api/finance/movimientos con ${describir(c.cambio)} → ${resultado}`, async (t) => {
    // Arrange
    const insertados = simularBase(t);
    const body = { ...BASE, ...c.cambio };

    // Act
    const r = await crearMovimiento(appMovimientos(), body);

    // Assert
    const detalle = `HTTP ${r.status}: ${JSON.stringify(r.body.error ?? r.body)}`;
    if (c.rechazo) {
      assert.equal(r.status, 400, `se esperaba HTTP 400; se obtuvo ${detalle}`);
      assert.equal(insertados.length, 0, 'no debe llegar ninguna inserción a la base');
      if (c.mensaje) assert.ok(c.mensaje(r.body.error ?? ''), `el mensaje debe indicar el problema (${c.criterio}); se obtuvo "${r.body.error}"`);
    } else {
      assert.equal(r.status, 201, `se esperaba HTTP 201; se obtuvo ${detalle}`);
      assert.equal(insertados.length, 1);
      for (const [campo, valor] of Object.entries(c.guardado)) assert.equal(insertados[0][campo], valor);
    }
  });
}
