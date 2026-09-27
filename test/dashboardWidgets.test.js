const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const dashboardService = require('../dashboard/services/dashboardService');
const dashboardViewsService = require('../dashboard/services/dashboardViewsService');
const { DASHBOARD_WIDGETS } = require('../dashboard/config/widgets');
const indicadoresService = require('../indicators/services/indicadoresService');

const IND_1 = '11111111-1111-4111-8111-111111111111';
const IND_2 = '22222222-2222-4222-8222-222222222222';
const IND_3 = '33333333-3333-4333-8333-333333333333';

// Ambos servicios duplican los helpers a propósito (son independientes); cada
// caso se corre contra los dos para garantizar que los contratos quedan alineados.
const servicios = [
  ['dashboardService', dashboardService],
  ['dashboardViewsService', dashboardViewsService],
];

for (const [nombre, svc] of servicios) {

  // ── Normalización: formatos legacy ───────────────────────────────────────────

  test(`${nombre}: array legacy de strings → {id, instanceId, size, period, chartType} con defaults`, () => {
    const out = svc._normalizarWidgets(['finanzas_ingresos_mes']);
    assert.deepEqual(out, [{
      id: 'finanzas_ingresos_mes',
      instanceId: 'legacy:finanzas_ingresos_mes',
      size: 'sm',
      period: 'month',
      chartType: 'kpi',
    }]);
  });

  test(`${nombre}: CASO 5 — legacy {id, size} → instanceId estable + defaults`, () => {
    const out = svc._normalizarWidgets([{ id: 'finanzas_metricas_movimientos', size: 'lg' }]);
    assert.deepEqual(out, [{
      id: 'finanzas_metricas_movimientos',
      instanceId: 'legacy:finanzas_metricas_movimientos',
      size: 'lg',
      period: 'month',
      chartType: 'bar',
    }]);
  });

  test(`${nombre}: CASO 4 — legacy string, instanceId estable entre lecturas`, () => {
    const a = svc._normalizarWidgets(['crm_metricas_contactos']);
    const b = svc._normalizarWidgets(['crm_metricas_contactos']);
    assert.equal(a[0].instanceId, 'legacy:crm_metricas_contactos');
    assert.equal(a[0].instanceId, b[0].instanceId); // determinista, no aleatorio
  });

  test(`${nombre}: CASO 6 — legacy _6m conserva period '6m' + instanceId estable`, () => {
    const out = svc._normalizarWidgets([{ id: 'finanzas_ingresos_6m', size: 'md' }]);
    assert.deepEqual(out, [{
      id: 'finanzas_ingresos_6m',
      instanceId: 'legacy:finanzas_ingresos_6m',
      size: 'md',
      period: '6m',
      chartType: 'kpi',
    }]);
  });

  // ── Normalización: formato actual con instanceId ─────────────────────────────

  test(`${nombre}: CASO 1 — dos widgets mismo id, distinta instancia → se conservan ambos`, () => {
    const out = svc._normalizarWidgets([
      { id: 'finanzas_ingresos_mes', instanceId: 'A', size: 'sm', period: 'month', chartType: 'kpi' },
      { id: 'finanzas_ingresos_mes', instanceId: 'B', size: 'md', period: '6m', chartType: 'area' },
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { id: 'finanzas_ingresos_mes', instanceId: 'A', size: 'sm', period: 'month', chartType: 'kpi' });
    assert.deepEqual(out[1], { id: 'finanzas_ingresos_mes', instanceId: 'B', size: 'md', period: '6m', chartType: 'area' });
  });

  test(`${nombre}: CASO 2 — mismo instanceId repetido → dedup defensiva conservando la primera`, () => {
    const out = svc._normalizarWidgets([
      { id: 'finanzas_ingresos_mes', instanceId: 'A', size: 'sm', period: 'month', chartType: 'kpi' },
      { id: 'finanzas_ingresos_mes', instanceId: 'A', size: 'lg', period: '12m', chartType: 'bar' },
    ]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { id: 'finanzas_ingresos_mes', instanceId: 'A', size: 'sm', period: 'month', chartType: 'kpi' });
  });

  test(`${nombre}: CASO 3 — dos instancias mismo id, distinto size → sizes independientes`, () => {
    const out = svc._normalizarWidgets([
      { id: 'finanzas_ingresos_mes', instanceId: 'kpi-mes', size: 'sm', period: 'month', chartType: 'kpi' },
      { id: 'finanzas_ingresos_mes', instanceId: 'area-12m', size: 'lg', period: '12m', chartType: 'area' },
    ]);
    assert.equal(out[0].size, 'sm');
    assert.equal(out[1].size, 'lg');
  });

  test(`${nombre}: orden preservado con instancias del mismo id intercaladas`, () => {
    const out = svc._normalizarWidgets([
      { id: 'finanzas_ingresos_mes', instanceId: 'X' },
      { id: 'crm_metricas_contactos', instanceId: 'Y' },
      { id: 'finanzas_ingresos_mes', instanceId: 'Z' },
    ]);
    assert.deepEqual(out.map(w => w.instanceId), ['X', 'Y', 'Z']);
    assert.deepEqual(out.map(w => w.id), ['finanzas_ingresos_mes', 'crm_metricas_contactos', 'finanzas_ingresos_mes']);
  });

  test(`${nombre}: instanceId se recorta (trim) y los vacíos caen a legacy:<id>`, () => {
    assert.equal(svc._normalizarWidgets([{ id: 'finanzas_gastos_mes', instanceId: '  ' }])[0].instanceId, 'legacy:finanzas_gastos_mes');
    assert.equal(svc._normalizarWidgets([{ id: 'finanzas_gastos_mes', instanceId: ' abc ' }])[0].instanceId, 'abc');
  });

  test(`${nombre}: normalización tolerante — period/chartType inválidos caen al default`, () => {
    const out = svc._normalizarWidgets([{ id: 'finanzas_ingresos_mes', instanceId: 'A', size: 'sm', period: 'daily', chartType: 'pie' }]);
    assert.deepEqual(out, [{ id: 'finanzas_ingresos_mes', instanceId: 'A', size: 'sm', period: 'month', chartType: 'kpi' }]);
  });

  test(`${nombre}: size desconocido → 'sm'`, () => {
    assert.equal(svc._normalizarWidgets([{ id: 'finanzas_ingresos_mes', instanceId: 'A', size: 'xl' }])[0].size, 'sm');
  });

  // ── Validación estricta ─────────────────────────────────────────────────────

  test(`${nombre}: _validarEntradasWidgets acepta legacy (strings y {id,size})`, () => {
    assert.doesNotThrow(() => svc._validarEntradasWidgets(['finanzas_ingresos_mes']));
    assert.doesNotThrow(() => svc._validarEntradasWidgets([{ id: 'finanzas_ingresos_mes', size: 'sm' }]));
  });

  test(`${nombre}: _validarEntradasWidgets rechaza instanceId vacío o no-string → 400`, () => {
    assert.throws(() => svc._validarEntradasWidgets([{ id: 'finanzas_ingresos_mes', instanceId: '' }]), err => err.status === 400);
    assert.throws(() => svc._validarEntradasWidgets([{ id: 'finanzas_ingresos_mes', instanceId: '   ' }]), err => err.status === 400);
    assert.throws(() => svc._validarEntradasWidgets([{ id: 'finanzas_ingresos_mes', instanceId: 123 }]), err => err.status === 400);
  });

  test(`${nombre}: _validarEntradasWidgets acepta instanceId string no vacío`, () => {
    assert.doesNotThrow(() => svc._validarEntradasWidgets([{ id: 'finanzas_ingresos_mes', instanceId: 'uuid-1' }]));
  });

  test(`${nombre}: CASO 8 — period inválido → 400`, () => {
    assert.throws(
      () => svc._validarEntradasWidgets([{ id: 'finanzas_ingresos_mes', instanceId: 'A', period: '9m' }]),
      err => err.status === 400 && /Período inválido/.test(err.message)
    );
  });

  test(`${nombre}: CASO 8 — chartType no soportado por la métrica → 400`, () => {
    assert.throws(
      () => svc._validarEntradasWidgets([{ id: 'finanzas_metricas_salarios', instanceId: 'A', chartType: 'area' }]),
      err => err.status === 400 && /Visualización inválida/.test(err.message)
    );
  });

  test(`${nombre}: _validarEntradasWidgets — period != '6m' en ID legacy _6m → 400`, () => {
    assert.throws(() => svc._validarEntradasWidgets([{ id: 'finanzas_ingresos_6m', instanceId: 'A', period: '3m' }]), err => err.status === 400);
    assert.doesNotThrow(() => svc._validarEntradasWidgets([{ id: 'finanzas_ingresos_6m', instanceId: 'A', period: '6m' }]));
  });

  test(`${nombre}: _validarEntradasWidgets acepta los 4 períodos en familia que los soporta`, () => {
    for (const period of ['month', '3m', '6m', '12m']) {
      assert.doesNotThrow(() => svc._validarEntradasWidgets([{ id: 'finanzas_gastos_mes', instanceId: 'A', period }]));
    }
  });

  test(`${nombre}: _validarEntradasWidgets acepta chartType permitido`, () => {
    assert.doesNotThrow(() => svc._validarEntradasWidgets([{ id: 'finanzas_ingresos_mes', instanceId: 'A', chartType: 'area' }]));
    assert.doesNotThrow(() => svc._validarEntradasWidgets([{ id: 'operativo_metricas_tareas', instanceId: 'A', chartType: 'list' }]));
  });

  test(`${nombre}: CASO 7 — dos instancias de un widget se validan igual (mismo id, mismas reglas)`, () => {
    // Ambas instancias del mismo id desconocido deberían reportarse como desconocidas.
    const out = svc._normalizarWidgets([
      { id: 'widget_inexistente', instanceId: 'A' },
      { id: 'widget_inexistente', instanceId: 'B' },
    ]);
    assert.equal(out.length, 2);
    assert.ok(out.every(w => !DASHBOARD_WIDGETS[w.id]));
  });

  // ── Mosaicos de indicador (indicador_kpi) ───────────────────────────────────

  test(`${nombre}: indicador_kpi conserva indicatorId (trim) y admite line/gauge`, () => {
    const out = svc._normalizarWidgets([
      { id: 'indicador_kpi', instanceId: 'A', size: 'md', period: '6m', chartType: 'line', indicatorId: ` ${IND_1} ` },
    ]);
    assert.deepEqual(out, [{ id: 'indicador_kpi', instanceId: 'A', size: 'md', period: '6m', chartType: 'line', indicatorId: IND_1 }]);
  });

  test(`${nombre}: mismo indicador en varias instancias (sin dedup por indicatorId)`, () => {
    const out = svc._normalizarWidgets([
      { id: 'indicador_kpi', instanceId: 'A', period: 'month', chartType: 'kpi', indicatorId: IND_1 },
      { id: 'indicador_kpi', instanceId: 'B', period: '12m', chartType: 'bar', indicatorId: IND_1 },
      { id: 'indicador_kpi', instanceId: 'C', period: '3m', chartType: 'gauge', indicatorId: IND_2 },
    ]);
    assert.deepEqual(out.map(w => [w.instanceId, w.indicatorId, w.period, w.chartType]), [
      ['A', IND_1, 'month', 'kpi'],
      ['B', IND_1, '12m', 'bar'],
      ['C', IND_2, '3m', 'gauge'],
    ]);
  });

  test(`${nombre}: los mosaicos existentes NO reciben indicatorId`, () => {
    const out = svc._normalizarWidgets([{ id: 'finanzas_ingresos_mes', instanceId: 'A', indicatorId: IND_1 }]);
    assert.deepEqual(out, [{ id: 'finanzas_ingresos_mes', instanceId: 'A', size: 'sm', period: 'month', chartType: 'kpi' }]);
  });

  test(`${nombre}: indicador_kpi sin indicatorId válido se descarta al normalizar`, () => {
    assert.deepEqual(svc._normalizarWidgets(['indicador_kpi', { id: 'indicador_kpi', instanceId: 'A', indicatorId: 'no-uuid' }]), []);
  });

  test(`${nombre}: _validarEntradasWidgets exige indicatorId en indicador_kpi → 400`, () => {
    assert.throws(() => svc._validarEntradasWidgets(['indicador_kpi']), err => err.status === 400 && /indicatorId/.test(err.message));
    assert.throws(() => svc._validarEntradasWidgets([{ id: 'indicador_kpi', instanceId: 'A' }]), err => err.status === 400);
    assert.throws(() => svc._validarEntradasWidgets([{ id: 'indicador_kpi', instanceId: 'A', indicatorId: 'abc' }]), err => err.status === 400);
    assert.doesNotThrow(() => svc._validarEntradasWidgets([{ id: 'indicador_kpi', instanceId: 'A', indicatorId: IND_1, chartType: 'gauge', period: '12m' }]));
  });

  test(`${nombre}: _validarEntradasWidgets rechaza indicatorId en otros mosaicos y chartType no permitido`, () => {
    assert.throws(() => svc._validarEntradasWidgets([{ id: 'finanzas_ingresos_mes', instanceId: 'A', indicatorId: IND_1 }]), err => err.status === 400);
    assert.throws(() => svc._validarEntradasWidgets([{ id: 'indicador_kpi', instanceId: 'A', indicatorId: IND_1, chartType: 'list' }]), err => err.status === 400);
    assert.throws(() => svc._validarEntradasWidgets([{ id: 'finanzas_ingresos_mes', instanceId: 'A', chartType: 'gauge' }]), err => err.status === 400);
  });

  test(`${nombre}: _widgetPermitido indicador_kpi requiere 'indicadores' y 'finance'`, () => {
    assert.equal(svc._widgetPermitido('indicador_kpi', ['indicadores', 'finance'], 'Empleado'), true);
    assert.equal(svc._widgetPermitido('indicador_kpi', ['indicadores'], 'Empleado'), false);
    assert.equal(svc._widgetPermitido('indicador_kpi', ['finance'], 'Superadmin'), false);
    // Los mosaicos existentes no cambian.
    assert.equal(svc._widgetPermitido('finanzas_ingresos_mes', ['finance'], 'Empleado'), true);
  });

  test(`${nombre}: _validarIndicadores — inexistente → 400; inactivo nuevo → 400; inactivo ya guardado → OK`, () => {
    const estado = new Map([[IND_1, true], [IND_2, false]]);
    const kpi = (instanceId, indicatorId) => ({ id: 'indicador_kpi', instanceId, size: 'sm', period: 'month', chartType: 'kpi', indicatorId });

    assert.doesNotThrow(() => svc._validarIndicadores([kpi('A', IND_1)], estado, []));
    assert.throws(() => svc._validarIndicadores([kpi('A', IND_3)], estado, []), err => err.status === 400 && /inexistente/.test(err.message));
    assert.throws(() => svc._validarIndicadores([kpi('B', IND_2)], estado, []), err => err.status === 400 && /inactivo/.test(err.message));
    // La instancia ya existía con ese indicador: volver a guardar el tablero no falla.
    assert.doesNotThrow(() => svc._validarIndicadores([kpi('B', IND_2), kpi('A', IND_1)], estado, [kpi('B', IND_2)]));
    // Una instancia NUEVA con el mismo indicador inactivo sigue rechazándose.
    assert.throws(() => svc._validarIndicadores([kpi('B', IND_2), kpi('C', IND_2)], estado, [kpi('B', IND_2)]), err => err.status === 400);
  });
}

// ── CASO 7 (permisos, end-to-end del service): dos instancias de un widget no
//    autorizado siguen rechazándose ────────────────────────────────────────────

test('dashboardService.guardarConfiguracion: dos instancias de un widget no autorizado → 403', async (t) => {
  const svc = dashboardService;
  t.mock.method(svc, '_modulosHabilitados', async () => []); // sin acceso a ningún módulo
  const supabase = require('../config/supabase');
  t.mock.method(supabase, 'from', () => { throw new Error('no debería llegar a persistir'); });

  await assert.rejects(
    () => svc.guardarConfiguracion('user-1', [
      { id: 'finanzas_ingresos_mes', instanceId: 'A', period: 'month', chartType: 'kpi' },
      { id: 'finanzas_ingresos_mes', instanceId: 'B', period: '6m', chartType: 'area' },
    ], 'Empleado'),
    err => err.status === 403 && /finanzas_ingresos_mes/.test(err.message)
  );
});

test('dashboardService.guardarConfiguracion: period inválido → 400 antes de tocar permisos/DB', async (t) => {
  const svc = dashboardService;
  t.mock.method(svc, '_modulosHabilitados', async () => { throw new Error('no debería consultar permisos'); });

  await assert.rejects(
    () => svc.guardarConfiguracion('user-1', [
      { id: 'finanzas_ingresos_mes', instanceId: 'A', period: 'daily', chartType: 'kpi' },
    ], 'Superadmin'),
    err => err.status === 400
  );
});

test('dashboardService.guardarConfiguracion: indicador inactivo en instancia nueva → 400 sin persistir', async (t) => {
  const svc = dashboardService;
  t.mock.method(svc, '_modulosHabilitados', async () => ['indicadores', 'finance']);
  t.mock.method(indicadoresService, 'obtenerEstadoIndicadores', async () => new Map([[IND_2, false]]));
  const supabase = require('../config/supabase');
  const from = t.mock.method(supabase, 'from', () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { widgets: [] }, error: null }) }) }),
    upsert: () => { throw new Error('no debería persistir'); },
  }));

  await assert.rejects(
    () => svc.guardarConfiguracion('user-1', [
      { id: 'indicador_kpi', instanceId: 'A', period: 'month', chartType: 'kpi', indicatorId: IND_2 },
    ], 'Dirección'),
    err => err.status === 400 && /inactivo/.test(err.message)
  );
  assert.equal(from.mock.callCount(), 1); // solo leyó la configuración previa
});

test('dashboardService.guardarConfiguracion: indicador_kpi sin acceso a finance → 403', async (t) => {
  const svc = dashboardService;
  t.mock.method(svc, '_modulosHabilitados', async () => ['indicadores']);
  const supabase = require('../config/supabase');
  t.mock.method(supabase, 'from', () => { throw new Error('no debería llegar a persistir'); });

  await assert.rejects(
    () => svc.guardarConfiguracion('user-1', [
      { id: 'indicador_kpi', instanceId: 'A', period: 'month', chartType: 'kpi', indicatorId: IND_1 },
    ], 'Dirección'),
    err => err.status === 403
  );
});

test('dashboardService.obtenerConfiguracion: un mosaico de indicador guardado se devuelve con indicatorId', async (t) => {
  const svc = dashboardService;
  t.mock.method(svc, '_modulosHabilitados', async () => ['indicadores', 'finance']);
  const supabase = require('../config/supabase');
  const guardados = [
    { id: 'finanzas_ingresos_mes', instanceId: 'X', size: 'sm', period: 'month', chartType: 'kpi' },
    { id: 'indicador_kpi', instanceId: 'A', size: 'md', period: '6m', chartType: 'line', indicatorId: IND_2 },
  ];
  t.mock.method(supabase, 'from', () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { widgets: guardados }, error: null }) }) }),
  }));

  const out = await svc.obtenerConfiguracion('user-1', 'Dirección');
  // El indicador IND_2 puede estar inactivo: la lectura no consulta su estado ni falla.
  assert.deepEqual(out.dashboard.widgets, guardados);
});

// ── Catálogo ────────────────────────────────────────────────────────────────

test('catálogo: default chartType/period dentro de sus listas permitidas', () => {
  for (const [id, w] of Object.entries(DASHBOARD_WIDGETS)) {
    assert.ok(w.allowedChartTypes.includes(w.defaultChartType), `${id}: default ${w.defaultChartType} fuera de allowed`);
    assert.ok(w.periods.includes(w.defaultPeriod), `${id}: defaultPeriod ${w.defaultPeriod} fuera de periods`);
  }
});

test('catálogo: IDs base soportan los 4 períodos; los _6m solo 6m', () => {
  for (const [id, w] of Object.entries(DASHBOARD_WIDGETS)) {
    if (id.endsWith('_6m')) {
      assert.deepEqual(w.periods, ['6m'], `${id} debería ser solo 6m`);
      assert.equal(w.defaultPeriod, '6m');
    } else {
      assert.deepEqual(w.periods, ['month', '3m', '6m', '12m'], `${id} debería soportar los 4 períodos`);
    }
  }
});
