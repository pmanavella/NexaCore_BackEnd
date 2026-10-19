// Suscripciones (REQ-FIN-07) y alertas de vencimiento (REQ-FIN-08).
// Tests unitarios de finance/services/suscripcionesService.js con Supabase simulado.
// Los casos CP-FIN-08 se ejecutan acá como unitarios: la fecha de "hoy" se fija
// con el reloj simulado y las suscripciones del seed se reemplazan por datos en memoria.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const suscripcionesService = require('../finance/services/suscripcionesService');

// Query builder falso de Supabase: registra la cadena de llamadas y, al
// awaitearse, responde con handler(st).
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

// "Hoy" es el lunes 19/10/2026 al mediodía (hora local).
const HOY = new Date(2026, 9, 19, 12, 0, 0);
function fijarHoy(t, fecha = HOY) {
  t.mock.timers.enable({ apis: ['Date'], now: fecha.getTime() });
}

function suscripcion(datos) {
  return {
    id: datos.id, nombre: datos.nombre ?? `Suscripción ${datos.id}`, proveedor: datos.proveedor ?? null,
    monto: 1000, moneda: 'ARS', estado: 'activa', frecuencia: 'mensual',
    created_at: '2026-01-10T12:00:00Z', ...datos,
  };
}

// Simula la consulta de suscripciones activas y las dos de gastos (vinculados y sin vincular).
function simularVencimientos(t, { suscripciones, vinculados = [], sinVincular = [] }) {
  const consultas = [];
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    consultas.push(st);
    if (st.table === 'suscripciones') return { data: suscripciones, error: null };
    if (st.table === 'movimientos' && op(st, 'in')) return { data: vinculados, error: null };
    if (st.table === 'movimientos' && op(st, 'is')) return { data: sinVincular, error: null };
    throw new Error(`consulta inesperada a ${st.table}`);
  }));
  return consultas;
}
const ids = (r) => r.map(s => s.id);

// ── REQ-FIN-08 · Alertas de vencimiento (valores límite) ─────────────────────

test('CP-FIN-08-01 vence hoy → aparece con 0 días restantes', async (t) => {
  // Arrange
  fijarHoy(t);
  simularVencimientos(t, { suscripciones: [suscripcion({ id: 'S-01', dia_vencimiento: 19 })] });

  // Act
  const r = await suscripcionesService.proximasVencer();

  // Assert
  assert.deepEqual(ids(r), ['S-01']);
  assert.equal(r[0].dias_restantes, 0);
  assert.equal(r[0].proxima_fecha_vencimiento, '2026-10-19');
});

test('CP-FIN-08-02 y 08-03 vence en 7 días → aparece; en 8 días → no aparece', async (t) => {
  // Arrange
  fijarHoy(t);
  simularVencimientos(t, { suscripciones: [
    suscripcion({ id: 'S-02', dia_vencimiento: 26 }),
    suscripcion({ id: 'S-03', dia_vencimiento: 27 }),
  ] });

  // Act
  const r = await suscripcionesService.proximasVencer(7);

  // Assert
  assert.deepEqual(ids(r), ['S-02']);
  assert.equal(r[0].dias_restantes, 7);
});

test('CP-FIN-08-04 venció ayer (mensual) → no aparece: el próximo vencimiento es el mes siguiente', async (t) => {
  // Arrange
  fijarHoy(t);
  simularVencimientos(t, { suscripciones: [suscripcion({ id: 'S-04', dia_vencimiento: 18 })] });

  // Act
  const conAvisoDe7Dias = await suscripcionesService.proximasVencer(7);
  const conAvisoDe30Dias = await suscripcionesService.proximasVencer(30);

  // Assert
  assert.deepEqual(ids(conAvisoDe7Dias), []);
  assert.equal(conAvisoDe30Dias[0].proxima_fecha_vencimiento, '2026-11-18');
});

test('CP-FIN-08-05 día de vencimiento 31 evaluado en febrero → vence el último día de febrero', async (t) => {
  // Arrange
  fijarHoy(t, new Date(2026, 1, 20, 12, 0, 0));
  simularVencimientos(t, { suscripciones: [suscripcion({ id: 'S-31', dia_vencimiento: 31 })] });

  // Act
  const r = await suscripcionesService.proximasVencer(10);

  // Assert
  assert.equal(r[0].proxima_fecha_vencimiento, '2026-02-28');
});

test('CP-FIN-08-06 dias=0 → solo las que vencen hoy', async (t) => {
  // Arrange
  fijarHoy(t);
  simularVencimientos(t, { suscripciones: [
    suscripcion({ id: 'S-01', dia_vencimiento: 19 }),
    suscripcion({ id: 'S-02', dia_vencimiento: 20 }),
  ] });

  // Act
  const r = await suscripcionesService.proximasVencer(0);

  // Assert
  assert.deepEqual(ids(r), ['S-01']);
});

// ── REQ-FIN-08 · Suscripciones ya pagadas (clases de equivalencia) ──────────

test('CP-FIN-08-07 gasto vinculado dentro del período → no aparece (ya pagada)', async (t) => {
  // Arrange
  fijarHoy(t);
  simularVencimientos(t, {
    suscripciones: [suscripcion({ id: 'S-05', dia_vencimiento: 22 })],
    vinculados: [{ id: 'g1', suscripcion_id: 'S-05', fecha: '2026-10-02' }],
  });

  // Act
  const r = await suscripcionesService.proximasVencer();

  // Assert
  assert.deepEqual(ids(r), []);
});

test('gasto vinculado de un período anterior → la suscripción sigue apareciendo', async (t) => {
  // Arrange
  fijarHoy(t);
  simularVencimientos(t, {
    suscripciones: [suscripcion({ id: 'S-05', dia_vencimiento: 22 })],
    vinculados: [{ id: 'g1', suscripcion_id: 'S-05', fecha: '2026-09-22' }],
  });

  // Act
  const r = await suscripcionesService.proximasVencer();

  // Assert
  assert.deepEqual(ids(r), ['S-05']);
});

test('gasto sin vincular del mismo proveedor (sin importar mayúsculas ni espacios) → no aparece', async (t) => {
  // Arrange
  fijarHoy(t);
  simularVencimientos(t, {
    suscripciones: [suscripcion({ id: 'S-07', dia_vencimiento: 21, proveedor: 'Google' })],
    sinVincular: [{ id: 'g2', descripcion: 'Workspace', proveedor_cliente: '  google ', fecha: '2026-10-05' }],
  });

  // Act
  const r = await suscripcionesService.proximasVencer();

  // Assert
  assert.deepEqual(ids(r), []);
});

test('gasto sin vincular cuya descripción empieza con el nombre → no aparece', async (t) => {
  // Arrange
  fijarHoy(t);
  simularVencimientos(t, {
    suscripciones: [suscripcion({ id: 'S-08', dia_vencimiento: 23, nombre: 'Netflix Premium' })],
    sinVincular: [{ id: 'g3', descripcion: 'NETFLIX premium octubre', proveedor_cliente: null, fecha: '2026-10-10' }],
  });

  // Act
  const r = await suscripcionesService.proximasVencer();

  // Assert
  assert.deepEqual(ids(r), []);
});

test('proveedor o nombre demasiado cortos no se usan para deducir el pago → sigue apareciendo', async (t) => {
  // Arrange
  fijarHoy(t);
  simularVencimientos(t, {
    suscripciones: [suscripcion({ id: 'S-09', dia_vencimiento: 21, proveedor: 'AB', nombre: 'Zoom' })],
    sinVincular: [{ id: 'g4', descripcion: 'Zoom mensual', proveedor_cliente: 'AB', fecha: '2026-10-05' }],
  });

  // Act
  const r = await suscripcionesService.proximasVencer();

  // Assert
  assert.deepEqual(ids(r), ['S-09']);
});

test('CP-FIN-08-08 solo se consultan suscripciones activas', async (t) => {
  // Arrange
  fijarHoy(t);
  const consultas = simularVencimientos(t, { suscripciones: [] });

  // Act
  const r = await suscripcionesService.proximasVencer();

  // Assert
  assert.deepEqual(r, []);
  assert.deepEqual(op(consultas[0], 'eq'), ['eq', 'estado', 'activa']);
  assert.equal(consultas.length, 1, 'sin candidatas no se consultan gastos');
});

test('frecuencias trimestral y anual → próximo vencimiento según el ciclo desde la creación', async (t) => {
  // Arrange
  fijarHoy(t);
  simularVencimientos(t, { suscripciones: [
    suscripcion({ id: 'T-1', dia_vencimiento: 21, frecuencia: 'trimestral', created_at: '2026-07-21T12:00:00' }),
    suscripcion({ id: 'A-1', dia_vencimiento: 25, frecuencia: 'anual', created_at: '2025-10-25T12:00:00' }),
    suscripcion({ id: 'X-1', dia_vencimiento: 20, frecuencia: 'semanal' }),
    suscripcion({ id: 'X-2', dia_vencimiento: null }),
  ] });

  // Act
  const r = await suscripcionesService.proximasVencer();

  // Assert
  assert.deepEqual(ids(r), ['T-1', 'A-1'], 'ordenadas por días restantes; las inválidas se ignoran');
  assert.equal(r[0].proxima_fecha_vencimiento, '2026-10-21');
  assert.equal(r[1].proxima_fecha_vencimiento, '2026-10-25');
});

test('trimestral con gasto vinculado dentro de la ventana de 3 meses → no aparece', async (t) => {
  // Arrange
  fijarHoy(t);
  simularVencimientos(t, {
    suscripciones: [suscripcion({ id: 'T-2', dia_vencimiento: 21, frecuencia: 'trimestral', created_at: '2026-07-21T12:00:00' })],
    vinculados: [{ id: 'g5', suscripcion_id: 'T-2', fecha: '2026-08-15' }],
  });

  // Act
  const r = await suscripcionesService.proximasVencer();

  // Assert
  assert.deepEqual(ids(r), []);
});

test('error de Supabase al consultar vencimientos → se propaga', async (t) => {
  // Arrange
  fijarHoy(t);
  t.mock.method(supabase, 'from', fakeFrom(() => ({ data: null, error: new Error('Supabase no disponible') })));

  // Act y Assert
  await assert.rejects(suscripcionesService.proximasVencer(), /Supabase no disponible/);
});

// ── REQ-FIN-07 · Alta y edición: validaciones ────────────────────────────────

const valida = { nombre: 'Slack', monto: 1500, moneda: 'USD', dia_vencimiento: 10, frecuencia: 'mensual', estado: 'activa' };

const invalidas = [
  { desc: 'nombre vacío', cambio: { nombre: '   ' }, mensaje: /nombre es obligatorio/ },
  { desc: 'monto vacío', cambio: { monto: '' }, mensaje: /monto es obligatorio/ },
  { desc: 'monto negativo', cambio: { monto: -1 }, mensaje: /mayor o igual a 0/ },
  { desc: 'día de vencimiento 0', cambio: { dia_vencimiento: 0 }, mensaje: /entre 1 y 31/ },
  { desc: 'día de vencimiento 32', cambio: { dia_vencimiento: 32 }, mensaje: /entre 1 y 31/ },
  { desc: 'estado inexistente', cambio: { estado: 'suspendida' }, mensaje: /Estado/ },
];

for (const c of invalidas) {
  test(`alta de suscripción con ${c.desc} → HTTP 400 y no se guarda`, async (t) => {
    // Arrange
    const from = t.mock.method(supabase, 'from', fakeFrom(() => ({ data: {}, error: null })));

    // Act y Assert
    await assert.rejects(suscripcionesService.crear({ ...valida, ...c.cambio }), (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, c.mensaje);
      return true;
    });
    assert.equal(from.mock.callCount(), 0);
  });
}

for (const dia of [1, 31]) {
  test(`alta de suscripción con día de vencimiento ${dia} (límite válido) → se guarda`, async (t) => {
    // Arrange
    let insertado;
    t.mock.method(supabase, 'from', fakeFrom((st) => { insertado = op(st, 'insert')[1][0]; return { data: { id: 's1', ...insertado }, error: null }; }));

    // Act
    await suscripcionesService.crear({ ...valida, dia_vencimiento: dia });

    // Assert
    assert.equal(insertado.dia_vencimiento, dia);
  });
}

test('alta de suscripción válida → guarda los datos normalizados y el autor', async (t) => {
  // Arrange
  let insertado;
  t.mock.method(supabase, 'from', fakeFrom((st) => { insertado = op(st, 'insert')[1][0]; return { data: { id: 's1' }, error: null }; }));

  // Act
  await suscripcionesService.crear({ nombre: '  Slack  ', detalle: ' Plan Pro ', proveedor: ' Slack Inc ', monto: '1500', dia_vencimiento: '10' }, 'contable@nexacore.test');

  // Assert
  assert.deepEqual(insertado, {
    nombre: 'Slack', detalle: 'Plan Pro', proveedor: 'Slack Inc', monto: 1500, moneda: 'ARS',
    dia_vencimiento: 10, frecuencia: 'mensual', estado: 'activa', created_by: 'contable@nexacore.test',
  });
});

test('edición de suscripción → actualiza por id con los datos normalizados', async (t) => {
  // Arrange
  let st;
  t.mock.method(supabase, 'from', fakeFrom((s) => { st = s; return { data: { id: 's1' }, error: null }; }));

  // Act
  await suscripcionesService.actualizar('s1', { ...valida, frecuencia: 'anual', estado: 'pausada' });

  // Assert
  const cambios = op(st, 'update')[1];
  assert.equal(cambios.frecuencia, 'anual');
  assert.equal(cambios.estado, 'pausada');
  assert.equal(cambios.moneda, 'USD');
  assert.deepEqual(op(st, 'eq'), ['eq', 'id', 's1']);
});

test('error de Supabase al crear o editar → se propaga', async (t) => {
  // Arrange
  t.mock.method(supabase, 'from', fakeFrom(() => ({ data: null, error: new Error('violación de restricción') })));

  // Act y Assert
  await assert.rejects(suscripcionesService.crear(valida), /violación de restricción/);
  await assert.rejects(suscripcionesService.actualizar('s1', valida), /violación de restricción/);
});

// ── REQ-FIN-07 · Consultas y baja ────────────────────────────────────────────

test('listar con estado y búsqueda → filtra por estado y busca en nombre, detalle y proveedor', async (t) => {
  // Arrange
  let st;
  t.mock.method(supabase, 'from', fakeFrom((s) => { st = s; return { data: [{ id: 's1' }, { id: 's2' }], error: null }; }));

  // Act
  const r = await suscripcionesService.listar({ estado: 'activa', search: 'goo' });

  // Assert
  assert.equal(r.total, 2);
  assert.deepEqual(op(st, 'eq'), ['eq', 'estado', 'activa']);
  assert.match(op(st, 'or')[1], /nombre\.ilike\.%goo%.*proveedor\.ilike\.%goo%/);
});

test('listar con estado "Todas" y sin búsqueda → no filtra', async (t) => {
  // Arrange
  let st;
  t.mock.method(supabase, 'from', fakeFrom((s) => { st = s; return { data: [], error: null }; }));

  // Act
  const r = await suscripcionesService.listar({ estado: 'Todas' });

  // Assert
  assert.equal(r.total, 0);
  assert.equal(op(st, 'eq'), undefined);
  assert.equal(op(st, 'or'), undefined);
});

test('obtener por id: existente → la devuelve; inexistente → 404; error → se propaga', async (t) => {
  // Arrange
  const respuestas = [
    { data: { id: 's1', nombre: 'Slack' }, error: null },
    { data: null, error: null },
    { data: null, error: new Error('falla de red') },
  ];
  t.mock.method(supabase, 'from', fakeFrom(() => respuestas.shift()));

  // Act y Assert
  assert.equal((await suscripcionesService.obtenerPorId('s1')).nombre, 'Slack');
  await assert.rejects(suscripcionesService.obtenerPorId('s9'), (err) => err.status === 404);
  await assert.rejects(suscripcionesService.obtenerPorId('s1'), /falla de red/);
});

test('listar con error de Supabase → se propaga', async (t) => {
  // Arrange
  t.mock.method(supabase, 'from', fakeFrom(() => ({ data: null, error: new Error('timeout') })));

  // Act y Assert
  await assert.rejects(suscripcionesService.listar(), /timeout/);
});

test('eliminar → borra por id y confirma; con error → se propaga', async (t) => {
  // Arrange
  const borrados = [];
  const respuestas = [{ error: null }, { error: new Error('no se pudo borrar') }];
  t.mock.method(supabase, 'from', fakeFrom((st) => { borrados.push(op(st, 'eq')[2]); return respuestas.shift(); }));

  // Act
  const r = await suscripcionesService.eliminar('s1');

  // Assert
  assert.match(r.message, /eliminada/);
  assert.deepEqual(borrados, ['s1']);
  await assert.rejects(suscripcionesService.eliminar('s2'), /no se pudo borrar/);
});
