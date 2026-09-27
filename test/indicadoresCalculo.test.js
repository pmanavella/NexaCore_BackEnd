const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const indicadoresService = require('../indicators/services/indicadoresService');
const { calcularEstado } = indicadoresService;
const { VARIABLES, calcularVariables, claveCategoria } = require('../indicators/services/variablesFinancieras');
const { CATEGORIAS_VALIDAS } = require('../finance/config/movimientos');
const {
  hoyArgentina, resolverPeriodoIndicador, periodosDeVentana, parsearClave,
} = require('../indicators/services/periodos');
const { resolverNivelPermiso } = require('../middleware/rbacMiddleware');

// 27/09/2026 12:00 en Argentina (UTC-3).
const AHORA = new Date('2026-09-27T15:00:00Z');
const HOY = hoyArgentina(AHORA);

const baseIndicador = {
  nombre: 'Margen operativo',
  perspectiva: 'FINANZAS',
  responsable: 'Dirección de Finanzas',
  frecuencia: 'MENSUAL',
  formula: '(INGRESOS_TOTAL - GASTOS_TOTAL) / INGRESOS_TOTAL * 100',
  unidad: 'PORCENTAJE',
  sentido: 'MAYOR_ES_MEJOR',
  valor_objetivo: 30,
  limite_aceptable: 20,
};

// ── Estado derivado ─────────────────────────────────────────────────────────

test('estado MAYOR_ES_MEJOR: bordes inclusivos', () => {
  const ind = { sentido: 'MAYOR_ES_MEJOR', valor_objetivo: 30, limite_aceptable: 20 };
  assert.equal(calcularEstado(35, ind), 'EN_OBJETIVO');
  assert.equal(calcularEstado(30, ind), 'EN_OBJETIVO');
  assert.equal(calcularEstado(29.99, ind), 'EN_RIESGO');
  assert.equal(calcularEstado(20, ind), 'EN_RIESGO');
  assert.equal(calcularEstado(19.99, ind), 'CRITICO');
});

test('estado MENOR_ES_MEJOR: lógica invertida con bordes inclusivos', () => {
  const ind = { sentido: 'MENOR_ES_MEJOR', valor_objetivo: '60', limite_aceptable: '75' }; // numeric llega como string
  assert.equal(calcularEstado(50, ind), 'EN_OBJETIVO');
  assert.equal(calcularEstado(60, ind), 'EN_OBJETIVO');
  assert.equal(calcularEstado(60.01, ind), 'EN_RIESGO');
  assert.equal(calcularEstado(75, ind), 'EN_RIESGO');
  assert.equal(calcularEstado(75.01, ind), 'CRITICO');
});

test('estado sin franja de riesgo (límite = objetivo) y sin valor', () => {
  const ind = { sentido: 'MAYOR_ES_MEJOR', valor_objetivo: 10, limite_aceptable: 10 };
  assert.equal(calcularEstado(10, ind), 'EN_OBJETIVO');
  assert.equal(calcularEstado(9, ind), 'CRITICO');
  assert.equal(calcularEstado(null, ind), null);
});

// ── Catálogo de variables ───────────────────────────────────────────────────

test('catálogo: totales + una variable por tipo y categoría de Finanzas', () => {
  assert.equal(VARIABLES.length, 2 * (1 + CATEGORIAS_VALIDAS.length));
  const claves = VARIABLES.map(v => v.key);
  for (const k of ['INGRESOS_TOTAL', 'GASTOS_TOTAL', 'GASTOS_RRHH', 'GASTOS_TECNOLOGIA', 'GASTOS_INSUMOS',
    'GASTOS_SERVICIOS', 'GASTOS_INVERSION', 'GASTOS_SUSCRIPCION', 'GASTOS_OTROS', 'INGRESOS_SUSCRIPCION']) {
    assert.ok(claves.includes(k), k);
  }
  const tec = VARIABLES.find(v => v.key === 'GASTOS_TECNOLOGIA');
  assert.deepEqual(tec, { key: 'GASTOS_TECNOLOGIA', label: 'Gastos · Tecnología', tipo: 'Gasto', categoria: 'Tecnología' });
  assert.equal(claveCategoria('Inversión'), 'INVERSION');
});

test('calcularVariables: filtra por rango [desde, hasta), tipo y categoría exacta', () => {
  const filas = [
    { mes: '2026-08-01', tipo: 'Ingreso', categoria: 'Servicios', total: '1000.10' },
    { mes: '2026-09-01', tipo: 'Ingreso', categoria: 'Servicios', total: '500.20' },
    { mes: '2026-09-01', tipo: 'Gasto', categoria: 'RRHH', total: 100 },
    { mes: '2026-09-01', tipo: 'Gasto', categoria: 'Tecnología', total: 50.05 },
    { mes: '2026-10-01', tipo: 'Gasto', categoria: 'RRHH', total: 999 },
  ];
  const r = calcularVariables(filas, { desde: '2026-09-01', hasta: '2026-10-01' },
    ['INGRESOS_TOTAL', 'GASTOS_TOTAL', 'GASTOS_RRHH', 'GASTOS_TECNOLOGIA', 'GASTOS_OTROS']);
  assert.deepEqual(r, { INGRESOS_TOTAL: 500.2, GASTOS_TOTAL: 150.05, GASTOS_RRHH: 100, GASTOS_TECNOLOGIA: 50.05, GASTOS_OTROS: 0 });
});

// ── Períodos ────────────────────────────────────────────────────────────────

test('hoyArgentina: el cambio de mes respeta America/Argentina/Buenos_Aires', () => {
  // 01/10/2026 02:00 UTC = 30/09/2026 23:00 en Argentina → sigue siendo septiembre.
  assert.deepEqual(hoyArgentina(new Date('2026-10-01T02:00:00Z')), { anio: 2026, mes: 9, fecha: '2026-09-30' });
  assert.deepEqual(hoyArgentina(new Date('2026-10-01T03:00:00Z')), { anio: 2026, mes: 10, fecha: '2026-10-01' });
});

test('período actual (sin clave) según frecuencia, con parcial: true', () => {
  const mes = resolverPeriodoIndicador(undefined, 'MENSUAL', HOY);
  assert.deepEqual({ clave: mes.clave, label: mes.label, desde: mes.desde, hasta: mes.hasta, parcial: mes.parcial },
    { clave: '2026-09', label: 'Septiembre 2026', desde: '2026-09-01', hasta: '2026-10-01', parcial: true });
  const tri = resolverPeriodoIndicador('', 'TRIMESTRAL', HOY);
  assert.equal(tri.clave, '2026-Q3');
  assert.equal(tri.desde, '2026-07-01');
  assert.equal(tri.hasta, '2026-10-01');
  assert.equal(resolverPeriodoIndicador(null, 'SEMESTRAL', HOY).clave, '2026-S2');
  assert.equal(resolverPeriodoIndicador(null, 'ANUAL', HOY).hasta, '2027-01-01');
});

test('períodos cerrados no son parciales', () => {
  const p = resolverPeriodoIndicador('2026-07', 'MENSUAL', HOY);
  assert.equal(p.parcial, false);
  assert.equal(p.label, 'Julio 2026');
  assert.equal(resolverPeriodoIndicador('2025', 'ANUAL', HOY).parcial, false);
});

test('compatibilidad período/frecuencia: igual o más largo sí, más corto no', () => {
  assert.equal(resolverPeriodoIndicador('2026-Q2', 'MENSUAL', HOY).desde, '2026-04-01');
  assert.equal(resolverPeriodoIndicador('2026-S1', 'TRIMESTRAL', HOY).hasta, '2026-07-01');
  assert.throws(() => resolverPeriodoIndicador('2026-08', 'TRIMESTRAL', HOY), err => err.status === 400 && /frecuencia TRIMESTRAL/.test(err.message));
  assert.throws(() => resolverPeriodoIndicador('2026-Q1', 'ANUAL', HOY), err => err.status === 400);
});

test('rechaza períodos futuros y claves mal formadas', () => {
  assert.throws(() => resolverPeriodoIndicador('2026-10', 'MENSUAL', HOY), err => err.status === 400 && /todavía no comenzó/.test(err.message));
  for (const clave of ['2026-13', '2026-00', '2026-Q5', '2026-S3', '26-09', 'actual', '2026-9']) {
    assert.throws(() => parsearClave(clave), err => err.status === 400, clave);
  }
});

test('ventanas del Dashboard → puntos según frecuencia', () => {
  const claves = (ventana, frecuencia) => periodosDeVentana(ventana, frecuencia, HOY).map(p => p.clave);
  assert.deepEqual(claves('6m', 'MENSUAL'), ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
  assert.deepEqual(claves('month', 'MENSUAL'), ['2026-09']);
  assert.deepEqual(claves('12m', 'TRIMESTRAL'), ['2025-Q4', '2026-Q1', '2026-Q2', '2026-Q3']);
  assert.deepEqual(claves('3m', 'TRIMESTRAL'), ['2026-Q3']);
  assert.deepEqual(claves('12m', 'SEMESTRAL'), ['2026-S1', '2026-S2']);
  assert.deepEqual(claves('6m', 'ANUAL'), ['2026']);
  assert.deepEqual(claves('3m', 'MENSUAL'), ['2026-07', '2026-08', '2026-09']);
  // cruce de año en meses
  const enero = hoyArgentina(new Date('2027-01-15T15:00:00Z'));
  assert.deepEqual(periodosDeVentana('3m', 'MENSUAL', enero).map(p => p.clave), ['2026-11', '2026-12', '2027-01']);
  assert.throws(() => periodosDeVentana('custom', 'MENSUAL', HOY), err => err.status === 400);
});

// ── Validación de la definición ─────────────────────────────────────────────

test('_validarDatos: normaliza (trim, fórmula canónica) y acepta números como string', () => {
  const datos = indicadoresService._validarDatos({
    ...baseIndicador,
    nombre: '  Margen operativo  ',
    responsable: ' Operaciones ',
    descripcion: '   ',
    formula: '(INGRESOS_TOTAL-GASTOS_TOTAL)/INGRESOS_TOTAL*100',
    valor_objetivo: '30.5',
  });
  assert.equal(datos.nombre, 'Margen operativo');
  assert.equal(datos.responsable, 'Operaciones');
  assert.equal(datos.descripcion, null);
  assert.equal(datos.formula, '(INGRESOS_TOTAL - GASTOS_TOTAL) / INGRESOS_TOTAL * 100');
  assert.equal(datos.valor_objetivo, 30.5);
  assert.equal('activo' in datos, false);
});

test('_validarDatos: rechaza catálogos cerrados, nombre vacío y números inválidos', () => {
  const invalido = cambios => assert.throws(() => indicadoresService._validarDatos({ ...baseIndicador, ...cambios }), err => err.status === 400, JSON.stringify(cambios));
  invalido({ nombre: '   ' });
  invalido({ nombre: 'x'.repeat(151) });
  invalido({ responsable: '' });
  invalido({ perspectiva: 'OTRA' });
  invalido({ frecuencia: 'SEMANAL' });
  invalido({ unidad: 'EUROS' });
  invalido({ sentido: 'NEUTRO' });
  invalido({ valor_objetivo: 'abc' });
  invalido({ limite_aceptable: null });
  invalido({ activo: 'false' });
  invalido({ formula: 'INGRESOS_TOTAL + X' });
  invalido({ formula: 'eval("1")' });
});

test('_validarDatos: coherencia límite/objetivo según sentido', () => {
  assert.throws(() => indicadoresService._validarDatos({ ...baseIndicador, sentido: 'MAYOR_ES_MEJOR', valor_objetivo: 30, limite_aceptable: 40 }), /menor o igual/);
  assert.throws(() => indicadoresService._validarDatos({ ...baseIndicador, sentido: 'MENOR_ES_MEJOR', valor_objetivo: 60, limite_aceptable: 50 }), /mayor o igual/);
  assert.doesNotThrow(() => indicadoresService._validarDatos({ ...baseIndicador, sentido: 'MENOR_ES_MEJOR', valor_objetivo: 60, limite_aceptable: 75 }));
  assert.doesNotThrow(() => indicadoresService._validarDatos({ ...baseIndicador, valor_objetivo: 10, limite_aceptable: 10 }));
});

test('validarFormula: 200 con valida true/false; 400 solo si no es texto', () => {
  assert.deepEqual(indicadoresService.validarFormula('GASTOS_TOTAL/INGRESOS_TOTAL*100'), {
    valida: true, formula: 'GASTOS_TOTAL / INGRESOS_TOTAL * 100', variables: ['GASTOS_TOTAL', 'INGRESOS_TOTAL'], error: null,
  });
  const r = indicadoresService.validarFormula('GASTOS_TOTAL / FOO');
  assert.equal(r.valida, false);
  assert.match(r.error, /FOO/);
  assert.throws(() => indicadoresService.validarFormula(undefined), err => err.status === 400);
});

// ── Cálculo end-to-end del service (Supabase mockeado) ───────────────────────

const FILA = {
  id: '11111111-1111-4111-8111-111111111111',
  ...baseIndicador,
  valor_objetivo: '30',
  limite_aceptable: '20',
  activo: true,
};

const FILAS_MOVIMIENTOS = [
  { mes: '2026-07-01', tipo: 'Ingreso', categoria: 'Servicios', total: '1000' },
  { mes: '2026-07-01', tipo: 'Gasto', categoria: 'RRHH', total: '800' },
  { mes: '2026-08-01', tipo: 'Ingreso', categoria: 'Servicios', total: '1000' },
  { mes: '2026-08-01', tipo: 'Gasto', categoria: 'Tecnología', total: '750' },
  { mes: '2026-09-01', tipo: 'Ingreso', categoria: 'Servicios', total: '2000' },
  { mes: '2026-09-01', tipo: 'Gasto', categoria: 'Insumos', total: '1000' },
];

test('calcularValor: período en curso, estado y variables; una sola consulta agregada', async (t) => {
  t.mock.method(indicadoresService, '_obtenerFila', async () => FILA);
  const rpc = t.mock.method(indicadoresService, '_totalesMovimientos', async () => FILAS_MOVIMIENTOS);

  const r = await indicadoresService.calcularValor(FILA.id, undefined, { ahora: AHORA });
  assert.deepEqual(rpc.mock.calls[0].arguments, ['2026-09-01', '2026-10-01']);
  assert.equal(r.periodo.clave, '2026-09');
  assert.equal(r.periodo.parcial, true);
  assert.equal(r.valor, 50);
  assert.equal(r.estado, 'EN_OBJETIVO');
  assert.deepEqual(r.variables, { INGRESOS_TOTAL: 2000, GASTOS_TOTAL: 1000 });
  assert.equal(r.error, null);
  assert.equal(r.indicador.valorObjetivo, 30);
});

test('calcularValor trimestral: suma variables del trimestre y luego aplica la fórmula', async (t) => {
  t.mock.method(indicadoresService, '_obtenerFila', async () => FILA);
  t.mock.method(indicadoresService, '_totalesMovimientos', async () => FILAS_MOVIMIENTOS);
  const r = await indicadoresService.calcularValor(FILA.id, '2026-Q3', { ahora: AHORA });
  // (4000 - 2550) / 4000 * 100 = 36.25 (no el promedio de 20, 25 y 50)
  assert.equal(r.valor, 36.25);
  assert.equal(r.periodo.clave, '2026-Q3');
});

test('calcularValor: sin movimientos → división por cero informada, estado null', async (t) => {
  t.mock.method(indicadoresService, '_obtenerFila', async () => FILA);
  t.mock.method(indicadoresService, '_totalesMovimientos', async () => []);
  const r = await indicadoresService.calcularValor(FILA.id, '2026-01', { ahora: AHORA });
  assert.equal(r.valor, null);
  assert.equal(r.estado, null);
  assert.equal(r.error.codigo, 'DIVISION_POR_CERO');
});

test('calcularValor: fórmula guardada con variable ya inexistente → 409', async (t) => {
  t.mock.method(indicadoresService, '_obtenerFila', async () => ({ ...FILA, formula: 'GASTOS_VIEJA / INGRESOS_TOTAL' }));
  await assert.rejects(() => indicadoresService.calcularValor(FILA.id, undefined, { ahora: AHORA }), err => err.status === 409);
});

test('calcularHistorico 3m: puntos mensuales, último válido y tendencia', async (t) => {
  t.mock.method(indicadoresService, '_obtenerFila', async () => FILA);
  const rpc = t.mock.method(indicadoresService, '_totalesMovimientos', async () => FILAS_MOVIMIENTOS);
  const r = await indicadoresService.calcularHistorico(FILA.id, '3m', { ahora: AHORA });

  assert.deepEqual(rpc.mock.calls[0].arguments, ['2026-07-01', '2026-10-01']);
  assert.equal(rpc.mock.callCount(), 1);
  assert.equal(r.period, '3m');
  assert.deepEqual(r.puntos.map(p => [p.periodo.clave, p.valor, p.estado]), [
    ['2026-07', 20, 'EN_RIESGO'],
    ['2026-08', 25, 'EN_RIESGO'],
    ['2026-09', 50, 'EN_OBJETIVO'],
  ]);
  assert.equal(r.ultimoValido.periodo.clave, '2026-09');
  assert.deepEqual(r.tendencia, { variacion: 25, direccion: 'SUBE' });
});

test('calcularHistorico: último válido omite puntos sin valor; default 12m; period inválido → 400', async (t) => {
  t.mock.method(indicadoresService, '_obtenerFila', async () => FILA);
  t.mock.method(indicadoresService, '_totalesMovimientos', async () => FILAS_MOVIMIENTOS.filter(f => f.mes !== '2026-09-01'));
  const r = await indicadoresService.calcularHistorico(FILA.id, undefined, { ahora: AHORA });
  assert.equal(r.period, '12m');
  assert.equal(r.puntos.length, 12);
  assert.equal(r.puntos[11].valor, null);
  assert.equal(r.ultimoValido.periodo.clave, '2026-08');
  await assert.rejects(() => indicadoresService.calcularHistorico(FILA.id, '24m', { ahora: AHORA }), err => err.status === 400);
});

test('calcularHistorico para un indicador inactivo no falla (mosaicos existentes)', async (t) => {
  t.mock.method(indicadoresService, '_obtenerFila', async () => ({ ...FILA, activo: false }));
  t.mock.method(indicadoresService, '_totalesMovimientos', async () => FILAS_MOVIMIENTOS);
  const r = await indicadoresService.calcularHistorico(FILA.id, 'month', { ahora: AHORA });
  assert.equal(r.indicador.activo, false);
  assert.equal(r.puntos.length, 1);
});

test('_obtenerFila: id no-uuid → 404 sin consultar la base', async () => {
  await assert.rejects(() => indicadoresService._obtenerFila('abc'), err => err.status === 404);
});

// ── Permisos ────────────────────────────────────────────────────────────────

test('resolverNivelPermiso: usuario > rol; Superadmin por rol = administrador', () => {
  assert.equal(resolverNivelPermiso(undefined, 'Superadmin'), 'sin_acceso');
  assert.equal(resolverNivelPermiso({ source: 'rol', permiso: 'editor' }, 'Superadmin'), 'administrador');
  assert.equal(resolverNivelPermiso({ source: 'rol', permiso: 'editor' }, 'Dirección'), 'editor');
  assert.equal(resolverNivelPermiso({ source: 'rol', permiso: 'lector' }, 'Empleado'), 'lector');
  // El permiso particular del usuario prevalece también para Superadmin.
  assert.equal(resolverNivelPermiso({ source: 'usuario', permiso: 'lector' }, 'Superadmin'), 'lector');
  assert.equal(resolverNivelPermiso({ source: 'usuario', permiso: 'administrador' }, 'Dirección'), 'administrador');
  assert.equal(resolverNivelPermiso({ source: 'ninguno', permiso: 'sin_acceso' }, 'Superadmin'), 'sin_acceso');
});
