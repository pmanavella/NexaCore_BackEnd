// Reportes de Nexi: redacción del balance en observaciones y conclusiones.
// Un balance que se muestra como $ 0,00 no es "positivo" ni "negativo".
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const nexiDatos = require('../nexi/services/nexiDatos');
const { RECOLECTORES } = require('../nexi/services/reporteSecciones');
const { resumenEjecutivo } = require('../nexi/services/reportesService');
const { resolverPeriodoReporte } = require('../nexi/services/reportePeriodo');
const { hoyArgentina } = require('../indicators/services/periodos');

const AHORA = new Date('2026-09-27T15:00:00Z');
const HOY = hoyArgentina(AHORA);
const USUARIO = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Ana Pérez', role: 'Dirección', hierarchyLevel: 'HIGH' };

// Sección Finanzas de agosto (período cerrado) comparada contra julio, con los
// totales indicados. Sin permiso de Indicadores: no se calculan KPI.
async function seccionFinanzas(t, { ingresos = [], gastos = [] }) {
  const filas = [
    ...ingresos.map(total => ({ mes: '2026-08-01', tipo: 'Ingreso', categoria: 'Servicios', total: String(total) })),
    ...gastos.map(total => ({ mes: '2026-08-01', tipo: 'Gasto', categoria: 'Servicios', total: String(total) })),
  ];
  t.mock.method(nexiDatos, 'totalesMovimientos', async desde => (desde === '2026-08-01' ? filas : []));
  t.mock.method(nexiDatos, 'deudasPorVencer', async () => ({ filas: [], total: 0 }));
  t.mock.method(nexiDatos, 'contarComprobantesEnRevision', async () => 0);
  const ctx = {
    usuario: USUARIO,
    niveles: new Map([['finance', { nivel: 'lector', alcance: 'global' }]]),
    alcance: 'global',
    periodo: resolverPeriodoReporte({ periodo: '2026-08' }, HOY),
    hoy: HOY,
    ahora: AHORA,
  };
  return RECOLECTORES.finanzas(ctx);
}

const SIN_SIGNO = /positivo|negativo/;

test('balance en cero (ingresos = gastos): "El balance del período fue de $ 0,00.", sin positivo ni negativo', async (t) => {
  const s = await seccionFinanzas(t, { ingresos: [1000], gastos: [1000] });
  assert.equal(s.observaciones[0], 'El balance del período fue de $ 0,00.');
  assert.ok(!s.observaciones.some(o => SIN_SIGNO.test(o)), s.observaciones.join(' | '));

  // Conclusiones del resumen ejecutivo (se arman con las observaciones de cada sección).
  const { conclusiones } = resumenEjecutivo([s, { ...s, titulo: 'Otra', variaciones: [] }]);
  assert.ok(conclusiones.includes('Finanzas: El balance del período fue de $ 0,00.'));
  assert.ok(!conclusiones.some(c => SIN_SIGNO.test(c)));
});

test('balance en cero sin movimientos (ingresos y gastos en 0): mismo criterio en todas las observaciones', async (t) => {
  const s = await seccionFinanzas(t, {});
  assert.equal(s.observaciones[0], 'El balance del período fue de $ 0,00.');
  assert.ok(!s.observaciones.some(o => SIN_SIGNO.test(o)), s.observaciones.join(' | '));
  assert.match(s.observaciones[1], /se mantuvieron sin registros/);
});

test('balance con resto de redondeo (0,1 + 0,2 frente a 0,3) se informa como $ 0,00', async (t) => {
  const s = await seccionFinanzas(t, { ingresos: [0.3], gastos: [0.1, 0.2] });
  assert.equal(s.observaciones[0], 'El balance del período fue de $ 0,00.');
});

test('balance distinto de cero conserva positivo / negativo con su monto', async (t) => {
  const positivo = await seccionFinanzas(t, { ingresos: [1500], gastos: [1000] });
  assert.equal(positivo.observaciones[0], 'El balance del período fue positivo: $ 500,00.');
  t.mock.restoreAll();
  const negativo = await seccionFinanzas(t, { ingresos: [1000], gastos: [1500] });
  assert.equal(negativo.observaciones[0], 'El balance del período fue negativo: -$ 500,00.');
});
