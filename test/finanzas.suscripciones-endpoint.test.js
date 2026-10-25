// CP-FIN-08-06 y valor por defecto de la alerta de vencimientos, por el endpoint
// GET /api/finance/suscripciones/proximas-vencer (ruta, controlador y servicio reales;
// Supabase simulado). El caso es de nivel integración: el parámetro `dias` llega
// como texto en la URL y lo interpreta el controlador.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const suscripcionesRoutes = require('../finance/routes/suscripciones');
const errorHandler = require('../middleware/errorHandler');

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

// Una suscripción mensual que vence hoy y otra que vence mañana (fechas reales del día
// de ejecución, como en el seed del caso).
function suscripcionesDelCaso() {
  const hoy = new Date();
  const manana = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 1);
  const base = { monto: 1000, moneda: 'ARS', estado: 'activa', frecuencia: 'mensual', proveedor: null, created_at: '2026-01-10T12:00:00Z' };
  return [
    { ...base, id: 'S-HOY', nombre: 'Vence hoy', dia_vencimiento: hoy.getDate() },
    { ...base, id: 'S-MANANA', nombre: 'Vence mañana', dia_vencimiento: manana.getDate() },
  ];
}

function simularSupabase(t) {
  t.mock.method(supabase.auth, 'getUser', async () => ({ data: { user: { email: 'contable@nexacore.test' } }, error: null }));
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    if (st.table === 'usuarios') return { data: { id: 'u1', nombre: 'Contable', roles: { nombre: 'Superadmin' } }, error: null };
    if (st.table === 'suscripciones') return { data: suscripcionesDelCaso(), error: null };
    if (st.table === 'movimientos') return { data: [], error: null };
    throw new Error(`tabla inesperada ${st.table}`);
  }));
}

async function consultar(path) {
  const app = express();
  app.use('/api/finance/suscripciones', suscripcionesRoutes);
  app.use(errorHandler);
  const server = http.createServer(app).listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: 'Bearer token-de-prueba' } });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('CP-FIN-08-06 GET /proximas-vencer?dias=0 → solo las suscripciones que vencen hoy', async (t) => {
  // Arrange
  simularSupabase(t);

  // Act
  const r = await consultar('/api/finance/suscripciones/proximas-vencer?dias=0');

  // Assert
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map(s => s.id), ['S-HOY']);
});

test('GET /proximas-vencer sin dias → usa 7 días por defecto', async (t) => {
  // Arrange
  simularSupabase(t);

  // Act
  const r = await consultar('/api/finance/suscripciones/proximas-vencer');

  // Assert
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map(s => s.id), ['S-HOY', 'S-MANANA']);
});

test('GET /proximas-vencer con dias no numérico → usa 7 días por defecto', async (t) => {
  // Arrange
  simularSupabase(t);

  // Act
  const r = await consultar('/api/finance/suscripciones/proximas-vencer?dias=abc');

  // Assert
  assert.deepEqual(r.body.data.map(s => s.id), ['S-HOY', 'S-MANANA']);
});
