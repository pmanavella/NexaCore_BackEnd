const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const protocolosService = require('../protocolos/services/protocolosService');

// Query builder falso. `ops` registra cada operación (tabla, tipo, filtros, valor).
// `filaPrueba` es el registro que "existe" en protocolo_pruebas (null = no existe
// o no pertenece al protocolo). `rpcError` simula un fallo dentro de la transacción.
function preparar(t, { filaPrueba = { id: 'r1', protocolo_id: 'p1' }, rpcError = null } = {}) {
  const ops = [];
  t.mock.method(supabase, 'rpc', async (fn, args) => {
    ops.push({ rpc: fn, args });
    return rpcError ? { data: null, error: rpcError } : { data: 'p-nuevo', error: null };
  });
  t.mock.method(supabase, 'from', (table) => {
    const st = { table, tipo: 'select', filtros: {}, valor: null };
    const b = {
      select() { return b; },
      order() { return b; },
      eq(col, v) { st.filtros[col] = v; return b; },
      insert(v) { st.tipo = 'insert'; st.valor = v; return b; },
      update(v) { st.tipo = 'update'; st.valor = v; return b; },
      delete() { st.tipo = 'delete'; return b; },
      single() { return b; },
      maybeSingle() { return b; },
      then(res, rej) {
        ops.push(st);
        let data;
        if (table === 'protocolo_items') data = [];
        else if (table === 'protocolos') data = { id: st.filtros.id ?? 'p1' };
        else if (st.tipo === 'insert') data = st.valor[0];
        else {
          const coincide = filaPrueba
            && st.filtros.id === filaPrueba.id
            && st.filtros.protocolo_id === filaPrueba.protocolo_id;
          data = coincide ? { ...filaPrueba, ...(st.valor ?? {}) } : null;
        }
        return Promise.resolve({ data, error: null }).then(res, rej);
      },
    };
    return b;
  });
  return ops;
}

const usuario = { id: 'u1', name: 'Vale' };
const resultados = [{ item_id: 'i1', estado: 'ok', tildado: true }];

// ── Crear protocolo + checklist ──────────────────────────────

test('crearProtocolo acepta ítems como strings (formato que envía el alta) en una sola RPC', async (t) => {
  const ops = preparar(t);
  const protocolo = await protocolosService.crearProtocolo({
    nombre: ' Robot X ', categoria: 'robot', acceso: 'Planta',
    items: ['Verificar carga de batería', ' Calibrar sensores ', 'Registrar tiempo de respuesta'],
  }, 'u1');

  const rpc = ops.filter(o => o.rpc);
  assert.equal(rpc.length, 1);
  assert.equal(rpc[0].rpc, 'protocolo_crear_con_items');
  assert.equal(rpc[0].args.p_nombre, 'Robot X');
  assert.equal(rpc[0].args.p_usuario, 'u1');
  assert.deepEqual(rpc[0].args.p_items, [
    { texto: 'Verificar carga de batería', orden: 0, activo: true },
    { texto: 'Calibrar sensores', orden: 1, activo: true },
    { texto: 'Registrar tiempo de respuesta', orden: 2, activo: true },
  ]);
  // No hay inserts sueltos fuera de la transacción.
  assert.equal(ops.filter(o => o.tipo === 'insert').length, 0);
  assert.equal(protocolo.id, 'p-nuevo');
});

test('crearProtocolo acepta ítems como objetos { texto, orden }', async (t) => {
  const ops = preparar(t);
  await protocolosService.crearProtocolo({
    nombre: 'P', categoria: 'hardware', items: [{ texto: 'A', orden: 5 }, { texto: 'B' }],
  }, 'u1');
  assert.deepEqual(ops.find(o => o.rpc).args.p_items, [
    { texto: 'A', orden: 5, activo: true },
    { texto: 'B', orden: 1, activo: true },
  ]);
});

test('crearProtocolo: ítem inválido → 400 y no se crea nada', async (t) => {
  const ops = preparar(t);
  for (const items of [['ok', ''], ['ok', '   '], [{ nombre: 'x' }], [null], [3], 'no-array']) {
    await assert.rejects(
      protocolosService.crearProtocolo({ nombre: 'P', categoria: 'robot', items }, 'u1'),
      (err) => err.status === 400,
      JSON.stringify(items)
    );
  }
  assert.equal(ops.length, 0);
});

test('crearProtocolo: si la transacción falla se propaga el error', async (t) => {
  preparar(t, { rpcError: { message: 'boom', code: 'XX000' } });
  await assert.rejects(
    protocolosService.crearProtocolo({ nombre: 'P', categoria: 'robot', items: ['A'] }, 'u1'),
    (err) => err.message === 'boom'
  );
});

test('actualizarItems (PUT /:id/items) también acepta strings u objetos', async (t) => {
  const ops = preparar(t);
  await protocolosService.actualizarItems('p1', { items: ['A', { texto: 'B' }] });
  const insert = ops.find(o => o.table === 'protocolo_items' && o.tipo === 'insert');
  assert.deepEqual(insert.valor.map(r => [r.protocolo_id, r.texto, r.orden]), [['p1', 'A', 0], ['p1', 'B', 1]]);
});

// ── Registros: action items ──────────────────────────────────

test('registrarPrueba guarda action_items propios del registro', async (t) => {
  preparar(t);
  const r = await protocolosService.registrarPrueba('p1', {
    resultados, observaciones: 'Comentario',
    action_items: [{ texto: ' Revisar sensor delantero ' }, { texto: 'Cambiar batería', extra: 'x' }],
  }, usuario);
  assert.deepEqual(r.action_items, [{ texto: 'Revisar sensor delantero' }, { texto: 'Cambiar batería' }]);
  assert.equal(r.observaciones, 'Comentario');
});

test('registrarPrueba sin action_items guarda una lista vacía', async (t) => {
  preparar(t);
  const r = await protocolosService.registrarPrueba('p1', { resultados }, usuario);
  assert.deepEqual(r.action_items, []);
});

test('registrarPrueba: action_items inválidos → 400 sin insertar', async (t) => {
  const ops = preparar(t);
  for (const action_items of ['x', [{}], [{ texto: '  ' }], ['texto suelto'], [{ texto: 'a'.repeat(801) }]]) {
    await assert.rejects(
      protocolosService.registrarPrueba('p1', { resultados, action_items }, usuario),
      (err) => err.status === 400,
      JSON.stringify(action_items).slice(0, 40)
    );
  }
  assert.equal(ops.filter(o => o.tipo === 'insert').length, 0);
});

// ── Editar registro ──────────────────────────────────────────

test('actualizarPrueba modifica solo lo enviado y filtra por protocolo', async (t) => {
  const ops = preparar(t);
  const r = await protocolosService.actualizarPrueba('p1', 'r1', {
    observaciones: ' Nuevo comentario ',
    resultados: [{ item_id: 'i1', estado: 'fail' }],
    action_items: [{ texto: 'Recalibrar cámara' }],
  });
  const upd = ops.find(o => o.tipo === 'update');
  assert.equal(upd.table, 'protocolo_pruebas');
  assert.deepEqual(upd.filtros, { id: 'r1', protocolo_id: 'p1' });
  assert.deepEqual(Object.keys(upd.valor).sort(), ['action_items', 'observaciones', 'resultados']);
  assert.equal(r.observaciones, 'Nuevo comentario');
  assert.deepEqual(r.resultados, [{ item_id: 'i1', estado: 'fail', tildado: false }]);
  assert.deepEqual(r.action_items, [{ texto: 'Recalibrar cámara' }]);
});

test('actualizarPrueba: action_items vacío borra los action items del registro', async (t) => {
  preparar(t);
  const r = await protocolosService.actualizarPrueba('p1', 'r1', { action_items: [] });
  assert.deepEqual(r.action_items, []);
});

test('actualizarPrueba: registro de otro protocolo → 404', async (t) => {
  preparar(t, { filaPrueba: { id: 'r1', protocolo_id: 'OTRO' } });
  await assert.rejects(
    protocolosService.actualizarPrueba('p1', 'r1', { observaciones: 'x' }),
    (err) => err.status === 404
  );
});

test('actualizarPrueba: validaciones → 400 sin escribir', async (t) => {
  const ops = preparar(t);
  for (const body of [{}, { resultados: [] }, { resultados: [{ item_id: 'i1', estado: 'mal' }] },
    { observaciones: 'a'.repeat(801) }, { action_items: [{}] }, { fecha: '' }]) {
    await assert.rejects(protocolosService.actualizarPrueba('p1', 'r1', body), (err) => err.status === 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal(ops.length, 0);
});

// ── Eliminar registro ────────────────────────────────────────

test('eliminarPrueba borra solo ese registro, validando que sea del protocolo', async (t) => {
  const ops = preparar(t);
  const r = await protocolosService.eliminarPrueba('p1', 'r1');
  assert.equal(r.id, 'r1');
  assert.equal(ops.length, 1);
  assert.equal(ops[0].table, 'protocolo_pruebas');
  assert.equal(ops[0].tipo, 'delete');
  assert.deepEqual(ops[0].filtros, { id: 'r1', protocolo_id: 'p1' });
});

test('eliminarPrueba: registro inexistente o de otro protocolo → 404', async (t) => {
  preparar(t, { filaPrueba: { id: 'r1', protocolo_id: 'OTRO' } });
  await assert.rejects(protocolosService.eliminarPrueba('p1', 'r1'), (err) => err.status === 404);
});
