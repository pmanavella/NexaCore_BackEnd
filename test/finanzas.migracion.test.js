// Migración de datos históricos (REQ-FIN-03 y REQ-FIN-17): tipos, vista previa,
// confirmación con lote de auditoría, historial y reversión.
// Tests unitarios de finance/services/migracionService.js. El parseo de cada planilla
// (migradores) se simula; la interpretación de montos se prueba en finanzas.montos.test.js
// y los permisos de confirmar y revertir, en finanzas.permisos.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const migracionService = require('../finance/services/migracionService');
const gastosHistoricos = require('../finance/services/migradores/gastosHistoricos');
const totalesFinancieros = require('../finance/services/migradores/totalesFinancieros');

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

const buffer = Buffer.from('planilla');
const gastos = (n) => Array.from({ length: n }, (_, i) => ({ _fila: i + 2, descripcion: `Gasto ${i + 1}`, monto: 100 + i }));

// ── Tipos y vista previa ─────────────────────────────────────────────────────

test('tipos de migración → los 4 habilitados, con su tabla destino', () => {
  // Arrange y Act
  const { tipos } = migracionService.listarTipos();

  // Assert
  assert.deepEqual(tipos.map(t => [t.id, t.destino]), [
    ['GASTOS_HISTORICOS', 'movimientos'],
    ['COMPRAS_INTERNACIONALES', 'inversiones_historicas'],
    ['CUENTAS_POR_COBRAR', 'cuentas_por_cobrar'],
    ['TOTALES_FINANCIEROS', 'conciliaciones_migracion'],
  ]);
});

for (const [tipo, mensaje] of [['SUELDOS_HISTORICOS', /no soportado/], ['OTRA_COSA', /desconocido/], [undefined, /desconocido/]]) {
  test(`vista previa y confirmación con tipo ${tipo} → HTTP 400 sin tocar la base`, async (t) => {
    // Arrange
    const from = t.mock.method(supabase, 'from', fakeFrom(() => ({ data: null, error: null })));

    // Act y Assert
    await assert.rejects(migracionService.preview(buffer, { tipo_migracion: tipo }), (e) => e.status === 400 && mensaje.test(e.message));
    await assert.rejects(migracionService.confirmar(buffer, { tipo_migracion: tipo }), (e) => e.status === 400 && mensaje.test(e.message));
    assert.equal(from.mock.callCount(), 0);
  });
}

test('vista previa → muestra hasta 10 filas, cuenta válidas y rechazadas y traduce los errores', async (t) => {
  // Arrange
  const procesar = t.mock.method(gastosHistoricos, 'procesar', () => ({
    filas_total: 14,
    registros: gastos(12),
    errores: [
      { fila: 3, campo: 'total', motivo: 'Monto inválido' },
      { row: 9, field: 'fecha', message: 'Fecha inválida' },
      {},
    ],
  }));
  const from = t.mock.method(supabase, 'from', fakeFrom(() => ({ data: null, error: null })));

  // Act
  const r = await migracionService.preview(buffer, { tipo_migracion: 'GASTOS_HISTORICOS', fecha_global: '2025-01-15' });

  // Assert
  assert.deepEqual(procesar.mock.calls[0].arguments[1], { fecha_global: '2025-01-15' });
  assert.equal(r.destino, 'movimientos');
  assert.equal(r.registros_validos, 12);
  assert.equal(r.registros_rechazados, 3);
  assert.equal(r.preview.length, 10);
  assert.deepEqual(r.preview[0], { fila: 2, descripcion: 'Gasto 1', monto: 100 });
  assert.deepEqual(r.errores, [
    { row: 3, field: 'Total', message: 'Monto inválido' },
    { row: 9, field: 'fecha', message: 'Fecha inválida' },
    { row: null, field: null, message: 'Error desconocido' },
  ]);
  assert.equal(from.mock.callCount(), 0, 'la vista previa no escribe en la base');
});

test('vista previa de totales financieros → usa sus filas de vista previa e informa columnas y totales', async (t) => {
  // Arrange
  t.mock.method(totalesFinancieros, 'procesar', () => ({
    filas_total: 3, registros: [{ _fila: 1, archivo: 'completo' }], errores: [],
    preview_rows: [{ _fila: 2, total: 10 }, { _fila: 3, total: 20 }],
    columnas_detectadas: ['Total'], columnas_conocidas_presentes: ['Total'], totales_calculados: { total: 30 },
  }));

  // Act
  const r = await migracionService.preview(buffer, { tipo_migracion: 'TOTALES_FINANCIEROS' });

  // Assert
  assert.equal(r.registros_validos, 3);
  assert.deepEqual(r.preview, [{ fila: 2, total: 10 }, { fila: 3, total: 20 }]);
  assert.deepEqual(r.columnas_detectadas, ['Total']);
  assert.deepEqual(r.columnas_conocidas_presentes, ['Total']);
  assert.deepEqual(r.totales_calculados, { total: 30 });
});

// ── Confirmación ─────────────────────────────────────────────────────────────

function simularConfirmacion(t, { errorBatch = null, errorLote = null } = {}) {
  const lotes = [];
  const cambiosBatch = [];
  let batchCreado;
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    if (st.table === 'migration_batches' && op(st, 'insert')) {
      batchCreado = op(st, 'insert')[1][0];
      return errorBatch ? { data: null, error: errorBatch } : { data: { id: 'b1' }, error: null };
    }
    if (st.table === 'migration_batches' && op(st, 'update')) { cambiosBatch.push(op(st, 'update')[1]); return { error: null }; }
    const lote = op(st, 'insert')[1];
    lotes.push({ tabla: st.table, lote });
    if (errorLote && lotes.length === 2) return { data: null, error: errorLote };
    return { data: lote.map((_, i) => ({ id: i })), error: null };
  }));
  return { lotes, cambiosBatch, batch: () => batchCreado };
}

test('confirmar 250 gastos → crea el lote de auditoría, inserta en tandas de 100 y lo marca completado', async (t) => {
  // Arrange
  t.mock.method(gastosHistoricos, 'procesar', () => ({ filas_total: 251, registros: gastos(250), errores: [{ fila: 5, motivo: 'x' }] }));
  const { lotes, cambiosBatch, batch } = simularConfirmacion(t);

  // Act
  const r = await migracionService.confirmar(buffer, {
    tipo_migracion: 'GASTOS_HISTORICOS', nombre_archivo: 'gastos.xlsx', usuario_id: 'u1', created_by: 'dir@nexacore.test',
  });

  // Assert
  assert.deepEqual(batch(), {
    tipo_migracion: 'GASTOS_HISTORICOS', nombre_archivo: 'gastos.xlsx', usuario_id: 'u1',
    registros_detectados: 251, registros_creados: 0, registros_rechazados: 1, estado: 'procesando', errores: [{ fila: 5, motivo: 'x' }],
  });
  assert.deepEqual(lotes.map(l => l.lote.length), [100, 100, 50]);
  assert.ok(lotes.every(l => l.tabla === 'movimientos'));
  assert.deepEqual(lotes[0].lote[0], { descripcion: 'Gasto 1', monto: 100, migration_batch_id: 'b1', created_by: 'dir@nexacore.test' });
  assert.deepEqual(cambiosBatch, [{ registros_creados: 250, estado: 'completado' }]);
  assert.equal(r.registros_creados, 250);
  assert.equal(r.batch_id, 'b1');
});

test('confirmar un archivo sin registros válidos → lote completado con 0 creados', async (t) => {
  // Arrange
  t.mock.method(gastosHistoricos, 'procesar', () => ({ filas_total: 2, registros: [], errores: [] }));
  const { lotes, cambiosBatch, batch } = simularConfirmacion(t);

  // Act
  const r = await migracionService.confirmar(buffer, { tipo_migracion: 'GASTOS_HISTORICOS' });

  // Assert
  assert.equal(r.registros_creados, 0);
  assert.deepEqual(lotes, []);
  assert.equal(batch().nombre_archivo, null);
  assert.equal(batch().errores, null);
  assert.deepEqual(cambiosBatch, [{ registros_creados: 0, estado: 'completado' }]);
});

test('no se puede registrar el lote de auditoría → error y no se inserta nada', async (t) => {
  // Arrange
  t.mock.method(gastosHistoricos, 'procesar', () => ({ filas_total: 1, registros: gastos(1), errores: [] }));
  const { lotes } = simularConfirmacion(t, { errorBatch: new Error('sin conexión') });

  // Act y Assert
  await assert.rejects(migracionService.confirmar(buffer, { tipo_migracion: 'GASTOS_HISTORICOS' }), /Error al registrar el batch: sin conexión/);
  assert.deepEqual(lotes, []);
});

test('falla una tanda a mitad de la carga → el lote queda fallido con el motivo y se informa el error', async (t) => {
  // Arrange
  t.mock.method(gastosHistoricos, 'procesar', () => ({ filas_total: 150, registros: gastos(150), errores: [] }));
  const { cambiosBatch } = simularConfirmacion(t, { errorLote: new Error('valor fuera de rango') });

  // Act y Assert
  await assert.rejects(
    migracionService.confirmar(buffer, { tipo_migracion: 'GASTOS_HISTORICOS' }),
    /Error al insertar en "movimientos" \(lote 2\): valor fuera de rango/,
  );
  assert.equal(cambiosBatch[0].estado, 'fallido');
  assert.match(cambiosBatch[0].errores[0].mensaje, /lote 2/);
});

// ── Historial de lotes ───────────────────────────────────────────────────────

test('historial de lotes → página 2 de 20, filtrado por tipo y estado, del más reciente al más antiguo', async (t) => {
  // Arrange
  let st;
  t.mock.method(supabase, 'from', fakeFrom((s) => { st = s; return { data: [{ id: 'b1' }], error: null, count: 41 }; }));

  // Act
  const r = await migracionService.listarBatches({ page: 2, limit: 20, tipo_migracion: 'GASTOS_HISTORICOS', estado: 'completado' });

  // Assert
  assert.deepEqual(op(st, 'range'), ['range', 20, 39]);
  assert.deepEqual(ops(st, 'eq'), [['eq', 'tipo_migracion', 'GASTOS_HISTORICOS'], ['eq', 'estado', 'completado']]);
  assert.deepEqual(op(st, 'order'), ['order', 'fecha_importacion', { ascending: false }]);
  assert.deepEqual(r, { data: [{ id: 'b1' }], total: 41, page: 2, limit: 20 });
});

test('historial sin filtros → primera página; con error de Supabase → se propaga', async (t) => {
  // Arrange
  let st;
  const respuestas = [{ data: [], error: null, count: 0 }, { data: null, error: new Error('timeout') }];
  t.mock.method(supabase, 'from', fakeFrom((s) => { st = s; return respuestas.shift(); }));

  // Act
  await migracionService.listarBatches();

  // Assert
  assert.deepEqual(op(st, 'range'), ['range', 0, 19]);
  assert.deepEqual(ops(st, 'eq'), []);
  await assert.rejects(migracionService.listarBatches(), /timeout/);
});

test('detalle de un lote inexistente o con error → 404', async (t) => {
  // Arrange
  const respuestas = [{ data: null, error: null }, { data: null, error: new Error('falla') }, { data: { id: 'b1' }, error: null }];
  t.mock.method(supabase, 'from', fakeFrom(() => respuestas.shift()));

  // Act y Assert
  await assert.rejects(migracionService.obtenerBatch('b9'), (e) => e.status === 404);
  await assert.rejects(migracionService.obtenerBatch('b9'), (e) => e.status === 404);
  assert.equal((await migracionService.obtenerBatch('b1')).id, 'b1');
});

// ── Reversión ────────────────────────────────────────────────────────────────

function simularReversion(t, batch, { errorBorrado = null } = {}) {
  const pasos = [];
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    if (st.table === 'migration_batches' && op(st, 'single')) return { data: batch, error: null };
    if (st.table === 'migration_batches' && op(st, 'update')) { pasos.push(['update', op(st, 'update')[1], op(st, 'eq')[2]]); return { error: null }; }
    pasos.push(['delete', st.table, op(st, 'eq')]);
    return { error: errorBorrado };
  }));
  return pasos;
}

test('revertir un lote completado de gastos → borra solo los registros de ese lote y lo marca revertido', async (t) => {
  // Arrange
  const pasos = simularReversion(t, { id: 'b1', tipo_migracion: 'GASTOS_HISTORICOS', estado: 'completado' });

  // Act
  const r = await migracionService.revertirBatch('b1');

  // Assert
  assert.deepEqual(pasos, [
    ['delete', 'movimientos', ['eq', 'migration_batch_id', 'b1']],
    ['update', { estado: 'revertido' }, 'b1'],
  ]);
  assert.equal(r.success, true);
  assert.equal(r.tabla_afectada, 'movimientos');
});

test('revertir un lote fallido → también se puede (limpia lo que haya quedado a medias)', async (t) => {
  // Arrange
  const pasos = simularReversion(t, { id: 'b2', tipo_migracion: 'CUENTAS_POR_COBRAR', estado: 'fallido' });

  // Act
  const r = await migracionService.revertirBatch('b2');

  // Assert
  assert.equal(pasos[0][1], 'cuentas_por_cobrar');
  assert.equal(r.tabla_afectada, 'cuentas_por_cobrar');
});

for (const [estado, status, mensaje] of [['revertido', 400, /ya fue revertido/], ['procesando', 409, /siendo procesado/]]) {
  test(`revertir un lote ${estado} → HTTP ${status} y no se borra nada`, async (t) => {
    // Arrange
    const pasos = simularReversion(t, { id: 'b3', tipo_migracion: 'GASTOS_HISTORICOS', estado });

    // Act y Assert
    await assert.rejects(migracionService.revertirBatch('b3'), (e) => e.status === status && mensaje.test(e.message));
    assert.deepEqual(pasos, []);
  });
}

test('revertir un lote inexistente → 404', async (t) => {
  // Arrange
  simularReversion(t, null);

  // Act y Assert
  await assert.rejects(migracionService.revertirBatch('b9'), (e) => e.status === 404);
});

test('falla el borrado al revertir → error claro y el lote no se marca revertido', async (t) => {
  // Arrange
  const pasos = simularReversion(t, { id: 'b4', tipo_migracion: 'GASTOS_HISTORICOS', estado: 'completado' }, { errorBorrado: new Error('permiso denegado') });

  // Act y Assert
  await assert.rejects(migracionService.revertirBatch('b4'), /Error al revertir registros en "movimientos": permiso denegado/);
  assert.equal(pasos.some(p => p[0] === 'update'), false);
});
