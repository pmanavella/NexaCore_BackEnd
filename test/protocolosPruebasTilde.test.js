const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const protocolosService = require('../protocolos/services/protocolosService');

// Query builder falso: el protocolo siempre existe y el insert de la prueba
// devuelve lo insertado. `insertados` acumula lo que se mandó a protocolo_pruebas.
function preparar(t) {
  const insertados = [];
  t.mock.method(supabase, 'from', (table) => {
    const st = { table, insert: null };
    const b = {
      select() { return b; },
      eq() { return b; },
      insert(v) { st.insert = v; return b; },
      single() { return b; },
      maybeSingle() { return b; },
      then(res, rej) {
        if (st.insert) insertados.push(...st.insert);
        const data = st.insert ? st.insert[0] : { id: 'p1' };
        return Promise.resolve({ data, error: null }).then(res, rej);
      },
    };
    return b;
  });
  return insertados;
}

const usuario = { id: 'u1', name: 'Vale' };

test('registrarPrueba guarda el tilde de cada ítem junto a su estado ok/fail/na', async (t) => {
  const insertados = preparar(t);
  const prueba = await protocolosService.registrarPrueba('p1', { resultados: [
    { item_id: 'i1', texto: 'Verificar carga de bateria', estado: 'ok', tildado: true },
    { item_id: 'i2', texto: 'Calibrar sensores', estado: 'fail', tildado: false },
    { item_id: 'i3', texto: 'Registrar tiempo de respuesta', estado: 'na' },
  ] }, usuario);

  assert.deepEqual(prueba.resultados.map(r => [r.item_id, r.estado, r.tildado]), [
    ['i1', 'ok', true],
    ['i2', 'fail', false],
    ['i3', 'na', false],
  ]);
  assert.equal(insertados.length, 1);
  assert.equal(insertados[0].resultados[0].texto, 'Verificar carga de bateria');
});

test('registrarPrueba: "tildado" no booleano → 400 y no se inserta nada', async (t) => {
  const insertados = preparar(t);
  for (const tildado of ['true', 1, null, {}]) {
    await assert.rejects(
      protocolosService.registrarPrueba('p1', { resultados: [{ item_id: 'i1', estado: 'ok', tildado }] }, usuario),
      (err) => err.status === 400 && /tildado/.test(err.message),
      JSON.stringify(tildado)
    );
  }
  assert.equal(insertados.length, 0);
});

test('registrarPrueba: las validaciones existentes de estado siguen igual', async (t) => {
  preparar(t);
  await assert.rejects(
    protocolosService.registrarPrueba('p1', { resultados: [{ item_id: 'i1', estado: 'bien', tildado: true }] }, usuario),
    (err) => err.status === 400 && /Estado inválido/.test(err.message)
  );
  await assert.rejects(
    protocolosService.registrarPrueba('p1', { resultados: [{ item_id: 'i1', tildado: true }] }, usuario),
    (err) => err.status === 400
  );
});
