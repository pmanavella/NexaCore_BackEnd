// Consultas del módulo Financiero: listado de movimientos con comprobantes,
// métricas del mes, flujo mensual, detalle, trazabilidad y baja
// (finance/services/movimientosService.js). Tests unitarios con Supabase simulado.
// El alta y la edición de movimientos (REQ-FIN-02) se prueban en finanzas.movimientos.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const movimientosService = require('../finance/services/movimientosService');

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
const ops = (st, nombre) => st.ops.filter(o => o[0] === nombre);

// Reemplaza supabase.storage durante el test (en supabase-js puede ser un getter).
function simularStorage(t, bucket) {
  const original = Object.getOwnPropertyDescriptor(supabase, 'storage');
  const llamadas = [];
  Object.defineProperty(supabase, 'storage', {
    configurable: true, writable: true,
    value: { from: (nombre) => { llamadas.push(nombre); return bucket; } },
  });
  t.after(() => {
    if (original) Object.defineProperty(supabase, 'storage', original);
    else delete supabase.storage;
  });
  return llamadas;
}

// ── Listado de movimientos ───────────────────────────────────────────────────

test('listar con filtros → aplica tipo, categoría, rango de fechas y búsqueda', async (t) => {
  // Arrange
  let st;
  t.mock.method(supabase, 'from', fakeFrom((s) => { st = s; return { data: [], error: null }; }));
  simularStorage(t, {});

  // Act
  const r = await movimientosService.listar({
    tipo: 'Gasto', categoria: 'Servicios', fecha_desde: '2026-10-01', fecha_hasta: '2026-10-31', search: 'luz',
  });

  // Assert
  assert.equal(r.total, 0);
  assert.deepEqual(ops(st, 'eq'), [['eq', 'tipo', 'Gasto'], ['eq', 'categoria', 'Servicios']]);
  assert.deepEqual(op(st, 'gte'), ['gte', 'fecha', '2026-10-01']);
  assert.deepEqual(op(st, 'lte'), ['lte', 'fecha', '2026-10-31']);
  assert.deepEqual(op(st, 'ilike'), ['ilike', 'descripcion', '%luz%']);
});

test('listar con "Todos" y sin filtros → no filtra', async (t) => {
  // Arrange
  let st;
  t.mock.method(supabase, 'from', fakeFrom((s) => { st = s; return { data: [], error: null }; }));
  simularStorage(t, {});

  // Act
  await movimientosService.listar({ tipo: 'Todos', categoria: 'Todos' });

  // Assert
  assert.deepEqual(ops(st, 'eq'), []);
  assert.equal(op(st, 'ilike'), undefined);
});

test('listar → los comprobantes guardados reciben una URL firmada de 10 minutos; sin archivo, URL nula', async (t) => {
  // Arrange
  const firmados = [];
  t.mock.method(supabase, 'from', fakeFrom(() => ({
    data: [{ id: 'm1', comprobantes: [{ id: 'c1', storage_path: 'u1/factura.pdf' }, { id: 'c2', storage_path: null }] }, { id: 'm2' }],
    error: null,
  })));
  const buckets = simularStorage(t, {
    createSignedUrl: async (path, segundos) => { firmados.push([path, segundos]); return { data: { signedUrl: `https://firmada/${path}` }, error: null }; },
  });

  // Act
  const r = await movimientosService.listar();

  // Assert
  assert.equal(r.data[0].comprobantes[0].archivo_url, 'https://firmada/u1/factura.pdf');
  assert.equal(r.data[0].comprobantes[1].archivo_url, null);
  assert.deepEqual(r.data[1].comprobantes, []);
  assert.deepEqual(firmados, [['u1/factura.pdf', 600]]);
  assert.deepEqual(buckets, ['comprobantes']);
});

test('listar → si no se puede firmar la URL del comprobante, falla con mensaje claro', async (t) => {
  // Arrange
  t.mock.method(supabase, 'from', fakeFrom(() => ({ data: [{ id: 'm1', comprobantes: [{ storage_path: 'x.pdf' }] }], error: null })));
  simularStorage(t, { createSignedUrl: async () => ({ data: null, error: new Error('bucket inexistente') }) });

  // Act y Assert
  await assert.rejects(movimientosService.listar(), /No se pudo generar acceso seguro al comprobante: bucket inexistente/);
});

test('listar con error de Supabase → se propaga', async (t) => {
  // Arrange
  t.mock.method(supabase, 'from', fakeFrom(() => ({ data: null, error: new Error('Supabase no disponible') })));

  // Act y Assert
  await assert.rejects(movimientosService.listar(), /Supabase no disponible/);
});

// ── Métricas del mes ─────────────────────────────────────────────────────────

test('métricas del mes → totales, balance, variación contra el mes anterior y gastos por categoría', async (t) => {
  // Arrange
  let consultaTotales = 0;
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    if (st.table === 'comprobantes') return { count: 3, data: null, error: null };
    if (op(st, 'select')[1] === 'categoria, monto') {
      return { data: [{ categoria: 'Servicios', monto: '500' }, { categoria: 'Insumos', monto: 300 }, { categoria: 'Servicios', monto: 100 }], error: null };
    }
    consultaTotales += 1;
    return consultaTotales === 1
      ? { data: [{ tipo: 'Ingreso', monto: '2000' }, { tipo: 'Gasto', monto: 600 }, { tipo: 'Gasto', monto: 300 }], error: null }
      : { data: [{ tipo: 'Ingreso', monto: 1000 }, { tipo: 'Gasto', monto: 1000 }], error: null };
  }));

  // Act
  const m = await movimientosService.obtenerMetricas({ mes: '10', anio: '2026' });

  // Assert
  assert.equal(m.ingresos, 2000);
  assert.equal(m.gastos, 900);
  assert.equal(m.balance, 1100);
  assert.equal(m.pctIngreso, 100);
  assert.equal(m.pctGasto, -10);
  assert.equal(m.comprobantesRevision, 3);
  assert.deepEqual(m.gastosPorCategoria, [{ categoria: 'Servicios', total: 600 }, { categoria: 'Insumos', total: 300 }]);
});

test('métricas sin movimientos en el mes anterior → variación 0 (no divide por cero)', async (t) => {
  // Arrange
  let consultaTotales = 0;
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    if (st.table === 'comprobantes') return { count: null, data: null, error: null };
    if (op(st, 'select')[1] === 'categoria, monto') return { data: null, error: null };
    consultaTotales += 1;
    return consultaTotales === 1 ? { data: [{ tipo: 'Ingreso', monto: 500 }], error: null } : { data: null, error: null };
  }));

  // Act
  const m = await movimientosService.obtenerMetricas({ mes: '1', anio: '2026' });

  // Assert
  assert.equal(m.pctIngreso, 0);
  assert.equal(m.pctGasto, 0);
  assert.equal(m.comprobantesRevision, 0);
  assert.deepEqual(m.gastosPorCategoria, []);
});

// ── Flujo mensual ────────────────────────────────────────────────────────────

test('flujo de 3 meses hasta octubre 2026 → ingresos y gastos de agosto, septiembre y octubre', async (t) => {
  // Arrange
  const rangos = [];
  const porMes = {
    '2026-08-01': [{ tipo: 'Ingreso', monto: 100 }],
    '2026-09-01': [{ tipo: 'Gasto', monto: '40' }, { tipo: 'Ingreso', monto: 10 }],
    '2026-10-01': null,
  };
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    const desde = op(st, 'gte')[2];
    rangos.push([desde, op(st, 'lte')[2]]);
    return { data: porMes[desde], error: null };
  }));

  // Act
  const r = await movimientosService.obtenerFlujo({ meses: 3, mes: '10', anio: '2026' });

  // Assert
  assert.deepEqual(rangos, [['2026-08-01', '2026-08-31'], ['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-31']]);
  assert.deepEqual(r.data.map(d => [d.ingresos, d.gastos]), [[100, 0], [10, 40], [0, 0]]);
});

for (const c of [
  { meses: 100, esperado: 24, desc: 'más de 24 meses → se limita a 24' },
  { meses: 0, esperado: 6, desc: '0 meses → usa 6 por defecto' },
  { meses: 'abc', esperado: 6, desc: 'valor no numérico → usa 6 por defecto' },
]) {
  test(`flujo con ${c.desc}`, async (t) => {
    // Arrange
    t.mock.method(supabase, 'from', fakeFrom(() => ({ data: [], error: null })));

    // Act
    const r = await movimientosService.obtenerFlujo({ meses: c.meses, mes: '10', anio: '2026' });

    // Assert
    assert.equal(r.data.length, c.esperado);
  });
}

// ── Detalle, trazabilidad y baja ─────────────────────────────────────────────

test('detalle de un movimiento → lo devuelve con sus comprobantes firmados', async (t) => {
  // Arrange
  t.mock.method(supabase, 'from', fakeFrom(() => ({ data: { id: 'm1', comprobantes: [{ storage_path: 'a.png' }] }, error: null })));
  simularStorage(t, { createSignedUrl: async (p) => ({ data: { signedUrl: `https://firmada/${p}` }, error: null }) });

  // Act
  const m = await movimientosService.obtenerPorId('m1');

  // Assert
  assert.equal(m.comprobantes[0].archivo_url, 'https://firmada/a.png');
});

test('detalle de un movimiento inexistente → 404; con error de Supabase → se propaga', async (t) => {
  // Arrange
  const respuestas = [{ data: null, error: null }, { data: null, error: new Error('falla de red') }];
  t.mock.method(supabase, 'from', fakeFrom(() => respuestas.shift()));

  // Act y Assert
  await assert.rejects(movimientosService.obtenerPorId('m9'), (err) => err.status === 404);
  await assert.rejects(movimientosService.obtenerPorId('m9'), /falla de red/);
});

test('trazabilidad → lista quién creó y modificó cada movimiento, del más reciente al más antiguo', async (t) => {
  // Arrange
  let st;
  const respuestas = [{ data: [{ id: 'm2' }, { id: 'm1' }], error: null }, { data: null, error: new Error('sin permiso') }];
  t.mock.method(supabase, 'from', fakeFrom((s) => { st = s; return respuestas.shift(); }));

  // Act
  const r = await movimientosService.listarTrazabilidad();

  // Assert
  assert.equal(r.total, 2);
  assert.match(op(st, 'select')[1], /created_by.*updated_by/);
  assert.deepEqual(op(st, 'order'), ['order', 'created_at', { ascending: false }]);
  await assert.rejects(movimientosService.listarTrazabilidad(), /sin permiso/);
});

test('eliminar un movimiento con comprobantes → borra primero los archivos y sus registros', async (t) => {
  // Arrange
  const pasos = [];
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    if (st.table === 'comprobantes' && op(st, 'select')) return { data: [{ storage_path: 'a.pdf' }, { storage_path: 'b.png' }], error: null };
    pasos.push(`${op(st, 'delete') ? 'delete' : '?'} ${st.table}`);
    return { error: null };
  }));
  simularStorage(t, { remove: async (paths) => { pasos.push(`remove ${paths.join(',')}`); return { error: null }; } });

  // Act
  const r = await movimientosService.eliminar('m1');

  // Assert
  assert.match(r.message, /eliminado/);
  assert.deepEqual(pasos, ['remove a.pdf,b.png', 'delete comprobantes', 'delete movimientos']);
});

test('eliminar un movimiento sin comprobantes → solo borra el movimiento; con error → se propaga', async (t) => {
  // Arrange
  const borrados = [];
  const respuestasMovimiento = [{ error: null }, { error: new Error('restricción de clave foránea') }];
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    if (st.table === 'comprobantes') return { data: [], error: null };
    borrados.push(st.table);
    return respuestasMovimiento.shift();
  }));

  // Act
  await movimientosService.eliminar('m1');

  // Assert
  assert.deepEqual(borrados, ['movimientos']);
  await assert.rejects(movimientosService.eliminar('m2'), /restricción de clave foránea/);
});
