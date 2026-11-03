// Deudas: una deuda pagada no se puede editar (PUT /api/finance/deudas/:id → 409).
// Pagar (PUT con estado 'Pagada' sobre una deuda no pagada) sigue funcionando.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const errorHandler = require('../middleware/errorHandler');
const deudasService = require('../finance/services/deudasService');

// ── Tabla deudas en memoria ─────────────────────────────────────────────────
// Implementa lo que usa deudasService: select/insert/update/delete con
// eq/neq, order, single y maybeSingle. `antesDeEscribir` permite simular otro
// pedido que llega entre la lectura y el UPDATE.
function crearBase(t, { antesDeEscribir } = {}) {
  const db = {
    deudas: [
      { id: 'd-pend', acreedor: 'Proveedor A', descripcion: 'Insumos', monto: 1000, vencimiento: '2099-01-10', estado: 'Pendiente', notas: null },
      { id: 'd-venc', acreedor: 'Proveedor B', descripcion: null, monto: 2500, vencimiento: '2020-01-10', estado: 'Vencida', notas: null },
      { id: 'd-paga', acreedor: 'Proveedor C', descripcion: 'Alquiler', monto: 5000, vencimiento: '2026-01-10', estado: 'Pagada', notas: 'ok' },
    ],
  };
  const updates = [];

  t.mock.method(supabase, 'from', (tabla) => {
    assert.equal(tabla, 'deudas');
    const st = { filtros: [], accion: 'select', single: false };
    const ejecutar = async () => {
      if (st.accion === 'update' && antesDeEscribir) await antesDeEscribir(db);
      let filas = db.deudas.filter(f => st.filtros.every(fn => fn(f)));
      if (st.accion === 'update') {
        updates.push(st.valores);
        filas.forEach(f => Object.assign(f, st.valores));
      } else if (st.accion === 'delete') {
        db.deudas = db.deudas.filter(f => !filas.includes(f));
        return { data: null, error: null };
      } else if (st.accion === 'insert') {
        filas = st.valores.map(v => ({ id: `d-${db.deudas.length + 1}`, ...v }));
        db.deudas.push(...filas);
      }
      const data = filas.map(f => ({ ...f }));
      if (st.single === 'maybe') return { data: data[0] ?? null, error: null };
      if (st.single) return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'not found' } };
      return { data, error: null };
    };
    const b = {
      select() { return b; },
      insert(v) { st.accion = 'insert'; st.valores = v; return b; },
      update(v) { st.accion = 'update'; st.valores = v; return b; },
      delete() { st.accion = 'delete'; return b; },
      eq(c, v) { st.filtros.push(f => f[c] === v); return b; },
      neq(c, v) { st.filtros.push(f => f[c] !== v); return b; },
      order() { return b; },
      single() { st.single = true; return b; },
      maybeSingle() { st.single = 'maybe'; return b; },
      then(res, rej) { return ejecutar().then(res, rej); },
    };
    return b;
  });
  return { db, updates, deuda: (id) => db.deudas.find(d => d.id === id) };
}

// Mismo cuerpo que envía el frontend al editar (formulario) o al pagar ({ ...deuda, estado }).
const cuerpo = (deuda, cambios = {}) => ({ ...deuda, ...cambios });

// ── Servicio ────────────────────────────────────────────────────────────────

test('deudas: una deuda pendiente se edita normalmente', async (t) => {
  const { deuda } = crearBase(t);
  const editada = await deudasService.actualizar('d-pend', cuerpo(deuda('d-pend'), { monto: 1200, acreedor: 'Proveedor A2' }), 'u@x');
  assert.deepEqual([editada.monto, editada.acreedor, editada.estado, editada.updated_by], [1200, 'Proveedor A2', 'Pendiente', 'u@x']);
});

test('deudas: una deuda vencida no pagada se edita normalmente', async (t) => {
  const { deuda } = crearBase(t);
  const editada = await deudasService.actualizar('d-venc', cuerpo(deuda('d-venc'), { vencimiento: '2099-12-31', estado: 'Pendiente' }));
  assert.deepEqual([editada.vencimiento, editada.estado], ['2099-12-31', 'Pendiente']);
});

test('deudas: pagar una deuda pendiente o vencida sigue funcionando', async (t) => {
  const { deuda } = crearBase(t);
  for (const id of ['d-pend', 'd-venc']) {
    const antes = { ...deuda(id) };
    const pagada = await deudasService.actualizar(id, cuerpo(antes, { estado: 'Pagada' }), 'u@x');
    assert.equal(pagada.estado, 'Pagada');
    assert.deepEqual([pagada.monto, pagada.acreedor, pagada.vencimiento], [antes.monto, antes.acreedor, antes.vencimiento]);
  }
});

test('deudas: una deuda pagada no se puede editar (409) y no cambia nada', async (t) => {
  const { deuda, updates } = crearBase(t);
  const original = { ...deuda('d-paga') };
  const intentos = [
    { monto: 1 },                                   // bajar el monto
    { acreedor: 'Otro', descripcion: 'Otra' },      // acreedor y descripción
    { vencimiento: '2099-01-01', notas: 'x' },      // vencimiento y notas
    { estado: 'Pendiente', monto: 1 },              // "despagar" para poder editar
    { estado: 'Pagada' },                           // reenviar el pago
    {},                                             // mismo cuerpo sin cambios
  ];
  for (const cambios of intentos) {
    await assert.rejects(
      deudasService.actualizar('d-paga', cuerpo(original, cambios)),
      (err) => err.status === 409 && err.message === 'La deuda ya está pagada y no se puede modificar.',
      JSON.stringify(cambios)
    );
  }
  assert.deepEqual(deuda('d-paga'), original);
  assert.equal(updates.length, 0, 'no se intentó ningún UPDATE');
});

test('deudas: el bloqueo usa el estado guardado, no el del body', async (t) => {
  const { deuda } = crearBase(t);
  // Body manipulado que dice "Pendiente" (o no trae estado) sobre una deuda pagada
  await assert.rejects(deudasService.actualizar('d-paga', { acreedor: 'X', monto: 1, vencimiento: '2099-01-01', estado: 'Pendiente' }), (err) => err.status === 409);
  await assert.rejects(deudasService.actualizar('d-paga', { acreedor: 'X', monto: 1, vencimiento: '2099-01-01' }), (err) => err.status === 409);
  // Y un body que dice "Pagada" no impide editar una deuda que en la base no lo está
  // (es justamente la operación de pago)
  assert.equal((await deudasService.actualizar('d-pend', cuerpo(deuda('d-pend'), { estado: 'Pagada' }))).estado, 'Pagada');
});

test('deudas: si otro pedido paga la deuda entre la lectura y el UPDATE, la edición no se aplica (409)', async (t) => {
  let pagarEnElMedio = true;
  const { deuda } = crearBase(t, {
    antesDeEscribir: (db) => {
      if (pagarEnElMedio) db.deudas.find(d => d.id === 'd-pend').estado = 'Pagada';
      pagarEnElMedio = false;
    },
  });
  await assert.rejects(deudasService.actualizar('d-pend', cuerpo(deuda('d-pend'), { monto: 1 })), (err) => err.status === 409);
  assert.deepEqual([deuda('d-pend').monto, deuda('d-pend').estado], [1000, 'Pagada']);
});

test('deudas: editar una deuda inexistente da 404; las validaciones de campos siguen igual', async (t) => {
  const { deuda } = crearBase(t);
  await assert.rejects(deudasService.actualizar('no-existe', { acreedor: 'X', monto: 1, vencimiento: '2099-01-01' }), (err) => err.status === 404);
  await assert.rejects(deudasService.actualizar('d-pend', cuerpo(deuda('d-pend'), { monto: 0 })), (err) => err.status === 400);
  await assert.rejects(deudasService.actualizar('d-pend', cuerpo(deuda('d-pend'), { estado: 'Anulada' })), (err) => err.status === 400);
  await assert.rejects(deudasService.actualizar('d-pend', cuerpo(deuda('d-pend'), { acreedor: '' })), (err) => err.status === 400);
});

test('deudas: crear, listar, métricas y eliminar no cambian', async (t) => {
  const { db } = crearBase(t);
  const nueva = await deudasService.crear({ acreedor: 'D', monto: 10, vencimiento: '2099-01-01' }, 'u@x');
  assert.deepEqual([nueva.estado, nueva.created_by], ['Pendiente', 'u@x']);
  assert.equal((await deudasService.listar()).total, 4);
  const m = await deudasService.getMetricas();
  assert.deepEqual([m.cantPendientes, m.totalPendiente], [3, 3510]);
  await deudasService.eliminar(nueva.id);
  assert.equal(db.deudas.length, 3);
});

// ── HTTP: contrato de error ─────────────────────────────────────────────────

async function llamarPut(t, id, body) {
  t.mock.method(supabase.auth, 'getUser', async () => ({ data: { user: { email: 'dir@x' } }, error: null }));
  const fromDeudas = supabase.from;
  // authenticate lee `usuarios`; el resto va a la tabla en memoria.
  t.mock.method(supabase, 'from', (tabla) => {
    if (tabla !== 'usuarios') return fromDeudas(tabla);
    const perfil = { data: { id: 'u1', nombre: 'Dora', roles: { nombre: 'Dirección', nivel_jerarquico: 'HIGH' } }, error: null };
    const b = { select: () => b, eq: () => b, single: () => b, then: (res) => res(perfil) };
    return b;
  });

  const app = express();
  app.use(express.json());
  app.use('/api/finance/deudas', require('../finance/routes/deudas'));
  app.use(errorHandler);
  const server = http.createServer(app).listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/finance/deudas/${id}`, {
      method: 'PUT',
      headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('HTTP: PUT directo a la API sobre una deuda pagada → 409 { error }; pagar una pendiente → 200', async (t) => {
  const { deuda } = crearBase(t);
  t.mock.method(console, 'error', () => {});
  const rechazo = await llamarPut(t, 'd-paga', cuerpo(deuda('d-paga'), { monto: 1 }));
  assert.deepEqual(rechazo, { status: 409, body: { error: 'La deuda ya está pagada y no se puede modificar.' } });
  assert.equal(deuda('d-paga').monto, 5000);

  const pago = await llamarPut(t, 'd-pend', cuerpo(deuda('d-pend'), { estado: 'Pagada' }));
  assert.equal(pago.status, 200);
  assert.equal(pago.body.estado, 'Pagada');
});
