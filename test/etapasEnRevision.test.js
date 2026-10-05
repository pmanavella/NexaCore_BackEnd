const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const etapasService = require('../operations/services/etapasService');
const operationsService = require('../operations/services/operationsService');
const { TIPOS_BASE, TIPOS_BASE_CERRADOS, ESTADO_CANONICO_POR_TIPO_BASE } = require('../operations/config/etapas');

// Query builder falso de Supabase: registra la cadena de llamadas y, al
// awaitearse, responde con handler({ table, ops }).
function fakeFrom(handler, llamadas = []) {
  return (table) => {
    const st = { table, ops: [] };
    llamadas.push(st);
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

// F–K: las 6 combinaciones de "Configurar etapas"
const COMBINACIONES = [
  ['F', 'Abierta · Pendiente',   'pendiente'],
  ['G', 'Abierta · En curso',    'en_curso'],
  ['H', 'Abierta · En Revisión', 'en_revision_abierta'],
  ['I', 'Cerrada · Completada',  'completada'],
  ['J', 'Cerrada · Cancelada',   'cancelada'],
  ['K', 'Cerrada · En Revisión', 'en_revision_cerrada'],
];

test('catálogo: conserva los 4 tipo_base existentes y agrega los 2 de revisión', () => {
  assert.deepEqual([...TIPOS_BASE].sort(), COMBINACIONES.map(c => c[2]).sort());
  assert.deepEqual([...TIPOS_BASE_CERRADOS].sort(), ['cancelada', 'completada', 'en_revision_cerrada']);
  // tareas.estado solo admite estos 4 valores (CHECK preexistente)
  for (const estado of Object.values(ESTADO_CANONICO_POR_TIPO_BASE)) {
    assert.ok(['Pendiente', 'En Proceso', 'Completada', 'Cancelada'].includes(estado), estado);
  }
  // Combinaciones existentes sin cambios
  assert.equal(ESTADO_CANONICO_POR_TIPO_BASE.pendiente, 'Pendiente');
  assert.equal(ESTADO_CANONICO_POR_TIPO_BASE.en_curso, 'En Proceso');
  assert.equal(ESTADO_CANONICO_POR_TIPO_BASE.completada, 'Completada');
  assert.equal(ESTADO_CANONICO_POR_TIPO_BASE.cancelada, 'Cancelada');
});

for (const [caso, label, tipo_base] of COMBINACIONES) {
  test(`${caso}) crear etapa ${label} persiste tipo_base=${tipo_base}`, async (t) => {
    const llamadas = [];
    t.mock.method(supabase, 'from', fakeFrom((st) => {
      const insert = op(st, 'insert');
      if (insert) return { data: insert[1][0], error: null };
      return { data: [{ posicion: 3 }], error: null };
    }, llamadas));
    const out = await etapasService.crearEtapa({ nombre: ' Revisión ', color: '#A855F7', tipo_base });
    assert.deepEqual(out, { nombre: 'Revisión', color: '#A855F7', tipo_base, posicion: 4 });
  });

  test(`${caso}) editar etapa a ${label} persiste tipo_base=${tipo_base}`, async (t) => {
    const llamadas = [];
    t.mock.method(supabase, 'from', fakeFrom((st) => ({ data: { id: 'e1', ...op(st, 'update')[1] }, error: null }), llamadas));
    const out = await etapasService.actualizarEtapa('e1', { tipo_base });
    assert.equal(out.tipo_base, tipo_base);
    assert.deepEqual(op(llamadas[0], 'update'), ['update', { tipo_base }]);
  });
}

test('tipo_base inválido sigue rechazándose con 400 y lista las opciones nuevas', async () => {
  await assert.rejects(
    etapasService.crearEtapa({ nombre: 'X', color: '#000000', tipo_base: 'en_revision' }),
    (err) => err.status === 400 && /en_revision_abierta/.test(err.message) && /en_revision_cerrada/.test(err.message)
  );
});

test('crearTarea en etapa En Revisión guarda el estado canónico permitido por tareas.estado', async (t) => {
  for (const [tipo_base, estadoEsperado] of [['en_revision_abierta', 'En Proceso'], ['en_revision_cerrada', 'Completada']]) {
    let insertado = null;
    t.mock.method(supabase, 'from', fakeFrom((st) => {
      if (st.table === 'operativo_etapas') return { data: [{ id: 'e-rev', tipo_base }], error: null };
      if (st.table === 'tareas' && op(st, 'insert')) { insertado = op(st, 'insert')[1][0]; return { data: { id: 't1', ...insertado }, error: null }; }
      // crearTarea relee la tarea creada (con etapa y asignados) para responder
      if (st.table === 'tareas') return { data: { id: 't1', ...insertado, tarea_asignados: [] }, error: null };
      return { data: null, error: null };
    }));
    await operationsService.crearTarea({ titulo: 'Tarea', etapa_id: 'e-rev' });
    assert.equal(insertado.estado, estadoEsperado, tipo_base);
    // En Revisión no completa fechas reales automáticamente
    assert.equal(insertado.fecha_inicio_real, undefined);
    assert.equal(insertado.fecha_fin_real, undefined);
    t.mock.restoreAll();
  }
});

test('getMetricas: "Cerrada · En Revisión" no cuenta como vencida; "Abierta · En Revisión" sí', async (t) => {
  const etapas = [
    { id: 'a', nombre: 'Revisión interna', color: '#000000', posicion: 0, tipo_base: 'en_revision_abierta' },
    { id: 'c', nombre: 'Revisión cliente',  color: '#000000', posicion: 1, tipo_base: 'en_revision_cerrada' },
    { id: 'p', nombre: 'Pendiente',         color: '#000000', posicion: 2, tipo_base: 'pendiente' },
  ];
  const tareas = [
    { fecha_limite: '2020-01-01', etapa_id: 'a', operativo_etapas: { tipo_base: 'en_revision_abierta' } },
    { fecha_limite: '2020-01-01', etapa_id: 'c', operativo_etapas: { tipo_base: 'en_revision_cerrada' } },
    { fecha_limite: '2020-01-01', etapa_id: 'p', operativo_etapas: { tipo_base: 'pendiente' } },
  ];
  t.mock.method(supabase, 'from', fakeFrom((st) => ({ data: st.table === 'tareas' ? tareas : etapas, error: null })));
  const out = await operationsService.getMetricas();
  assert.equal(out.vencidas, 2);
  assert.deepEqual(out.porTipoBase, {
    pendiente: 1, en_curso: 0, en_revision_abierta: 1, completada: 0, cancelada: 0, en_revision_cerrada: 1,
  });
});
