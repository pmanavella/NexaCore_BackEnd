// REQ-FIN-07: moneda y frecuencia inválidas en el alta y la edición de
// suscripciones (hallazgo H-23). Casos en docs/casos/REQ-FIN-07.md.
// Mismo doble de Supabase que test/finanzas.suscripciones.test.js.
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

const valida = { nombre: 'Slack', monto: 1500, moneda: 'USD', dia_vencimiento: 10, frecuencia: 'mensual', estado: 'activa' };

const casos = [
  { id: 'CP-FIN-07-01', operacion: 'alta', cambio: { moneda: 'EUR' }, mensaje: /Moneda inválida/ },
  { id: 'CP-FIN-07-02', operacion: 'alta', cambio: { frecuencia: 'semanal' }, mensaje: /Frecuencia inválida/ },
  { id: 'CP-FIN-07-03', operacion: 'edición', cambio: { moneda: 'EUR' }, mensaje: /Moneda inválida/ },
  { id: 'CP-FIN-07-04', operacion: 'edición', cambio: { frecuencia: 'semanal' }, mensaje: /Frecuencia inválida/ },
];

for (const c of casos) {
  const [campo, valor] = Object.entries(c.cambio)[0];
  test(`${c.id} ${c.operacion} de suscripción con ${campo} "${valor}" → HTTP 400 y no se guarda`, async (t) => {
    // Arrange
    let guardado;
    const from = t.mock.method(supabase, 'from', fakeFrom((st) => {
      guardado = op(st, 'insert')?.[1]?.[0] ?? op(st, 'update')?.[1];
      return { data: { id: 's1' }, error: null };
    }));
    const datos = { ...valida, ...c.cambio };

    // Act
    const r = await (c.operacion === 'alta'
      ? suscripcionesService.crear(datos)
      : suscripcionesService.actualizar('s1', datos)).catch(e => e);

    // Assert
    assert.equal(r.status, 400, `se guardó ${campo}: ${guardado?.[campo]}`);
    assert.match(r.message, c.mensaje);
    assert.equal(from.mock.callCount(), 0);
  });
}