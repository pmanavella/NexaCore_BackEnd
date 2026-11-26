// Catálogo de mosaicos para "Crear gráfico personalizado" (GET /api/dashboard/catalogo),
// CRM deprecado (compatibilidad de mosaicos guardados) y el mosaico de Alertas
// (horizonte + tipos) en Panel General y vistas.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const dashboardService = require('../dashboard/services/dashboardService');
const dashboardViewsService = require('../dashboard/services/dashboardViewsService');
const alertasService = require('../alertas/services/alertasService');
const { DASHBOARD_WIDGETS } = require('../dashboard/config/widgets');

const TODOS_LOS_MODULOS = ['finance', 'crm', 'operations', 'indicadores', 'protocolos', 'organizacion'];
const DIRECCION = { id: 'u-dir', role: 'Dirección', hierarchyLevel: 'HIGH' };

function simularCatalogo(t, { modulos = TODOS_LOS_MODULOS, tipos = ['deudas', 'suscripciones', 'externos'] } = {}) {
  t.mock.method(dashboardService, '_modulosHabilitados', async () => modulos);
  t.mock.method(alertasService, 'tiposPermitidos', async () => tipos);
}

const ids = (cat) => cat.modules.flatMap(m => m.metrics.map(x => x.id));

// ── Catálogo ─────────────────────────────────────────────────────────────────

test('catálogo: no ofrece CRM aunque el usuario tenga el módulo y el rol', async (t) => {
  simularCatalogo(t);
  const cat = await dashboardService.obtenerCatalogo(DIRECCION);
  assert.ok(!cat.modules.some(m => m.module === 'crm'));
  assert.ok(!ids(cat).some(id => id.startsWith('crm_')));
  assert.ok(!ids(cat).some(id => id.endsWith('_6m')), 'sin variantes legacy');
});

test('catálogo: módulos en orden con Protocolos y Alertas; CRM fuera', async (t) => {
  simularCatalogo(t);
  const cat = await dashboardService.obtenerCatalogo(DIRECCION);
  assert.deepEqual(cat.modules.map(m => m.module), ['finanzas', 'operativo', 'indicador', 'protocolos', 'alertas']);
  assert.deepEqual(cat.modules.find(m => m.module === 'protocolos').metrics.map(m => m.id), [
    'protocolos_activos', 'protocolos_registros', 'protocolos_incumplimientos',
    'protocolos_ultimos_registros', 'protocolos_sin_registros',
  ]);
  const alertas = cat.modules.find(m => m.module === 'alertas').metrics[0];
  assert.deepEqual(alertas, {
    id: 'alertas_proximas', title: 'Alertas próximas', periods: [], defaultPeriod: null,
    chartTypes: ['list'], defaultChartType: 'list', requiresIndicator: false,
    sourceEndpoint: DASHBOARD_WIDGETS.alertas_proximas.sourceEndpoint,
    usesHorizon: true, alertTypes: ['deudas', 'suscripciones', 'externos'], horizons: [7, 15, 30], defaultHorizon: 15,
  });
});

test('catálogo: respeta permisos (módulos de la Matriz y tipos de alerta visibles)', async (t) => {
  simularCatalogo(t, { modulos: ['operations'], tipos: ['externos'] });
  const cat = await dashboardService.obtenerCatalogo({ id: 'u', role: 'Operativo', hierarchyLevel: 'LOW' });
  assert.deepEqual(cat.modules.map(m => m.module), ['operativo', 'alertas']);
  assert.deepEqual(cat.modules.find(m => m.module === 'alertas').metrics[0].alertTypes, ['externos']);

  simularCatalogo(t, { modulos: ['operations'], tipos: [] });
  const sinAlertas = await dashboardService.obtenerCatalogo({ id: 'u', role: 'Operativo', hierarchyLevel: 'LOW' });
  assert.deepEqual(sinAlertas.modules.map(m => m.module), ['operativo'], 'sin tipos visibles no se ofrece Alertas');
});

test('catálogo: salarios conserva su restricción de rol', async (t) => {
  simularCatalogo(t, { modulos: ['finance'] });
  const contable = await dashboardService.obtenerCatalogo({ id: 'u', role: 'Contable', hierarchyLevel: 'LOW' });
  assert.ok(!ids(contable).includes('finanzas_metricas_salarios'));
  const dir = await dashboardService.obtenerCatalogo(DIRECCION);
  assert.ok(ids(dir).includes('finanzas_metricas_salarios'));
});

// ── CRM deprecado: compatibilidad ────────────────────────────────────────────

// Supabase falso para dashboard_configuraciones (Panel General).
function simularConfig(t, previa) {
  const guardado = { widgets: null };
  t.mock.method(supabase, 'from', () => {
    const b = {
      select: () => b, eq: () => b,
      maybeSingle: async () => ({ data: previa ? { widgets: previa } : null, error: null }),
      upsert: (row) => { guardado.widgets = row.widgets; return b; },
      single: async () => ({ data: { widgets: guardado.widgets }, error: null }),
    };
    return b;
  });
  return guardado;
}

// Supabase falso para dashboard_vistas.
function simularVista(t, previa) {
  const guardado = { widgets: null };
  t.mock.method(supabase, 'from', () => {
    const b = {
      select: () => b, eq: () => b,
      maybeSingle: async () => ({ data: { id: 'v1', widgets: previa }, error: null }),
      update: (row) => { guardado.widgets = row.widgets; return b; },
      single: async () => ({ data: { id: 'v1', nombre: 'V', orden: 0, widgets: guardado.widgets }, error: null }),
    };
    return b;
  });
  return guardado;
}

const CRM_GUARDADO = { id: 'crm_metricas_contactos', instanceId: 'crm-1', size: 'sm', period: 'month', chartType: 'kpi' };
const guardarPanel = (widgets) => dashboardService.guardarConfiguracion('u-dir', widgets, 'Dirección');
const guardarVista = (widgets) => dashboardViewsService.actualizarVista('v1', 'u-dir', { widgets }, 'Dirección');

for (const [nombre, simular, guardar, svc] of [
  ['Panel General', simularConfig, guardarPanel, dashboardService],
  ['Vista', simularVista, guardarVista, dashboardViewsService],
]) {
  test(`${nombre}: un mosaico CRM NUEVO se rechaza (400)`, async (t) => {
    t.mock.method(svc, '_modulosHabilitados', async () => TODOS_LOS_MODULOS);
    simular(t, []);
    await assert.rejects(guardar([CRM_GUARDADO]), e => e.status === 400 && /crm_metricas_contactos/.test(e.message));
  });

  test(`${nombre}: un mosaico CRM ya guardado se conserva al volver a guardar (también legacy y _6m)`, async (t) => {
    t.mock.method(svc, '_modulosHabilitados', async () => TODOS_LOS_MODULOS);
    const guardado = simular(t, [CRM_GUARDADO, 'crm_metricas_contactos_6m']);
    const out = await guardar([
      CRM_GUARDADO,
      'crm_metricas_contactos_6m',
      { id: 'operativo_metricas_tareas', instanceId: 'op-1' },
    ]);
    assert.deepEqual(guardado.widgets.map(w => w.instanceId), ['crm-1', 'legacy:crm_metricas_contactos_6m', 'op-1']);
    assert.ok((out.dashboard?.widgets || out.widgets).some(w => w.id === 'crm_metricas_contactos'));
  });

  test(`${nombre}: no se puede "colar" un CRM nuevo con otro instanceId`, async (t) => {
    t.mock.method(svc, '_modulosHabilitados', async () => TODOS_LOS_MODULOS);
    simular(t, [CRM_GUARDADO]);
    await assert.rejects(guardar([CRM_GUARDADO, { ...CRM_GUARDADO, instanceId: 'crm-2' }]), e => e.status === 400);
  });

  test(`${nombre}: mosaico de Alertas — defaults, validación y sin "period"`, async (t) => {
    t.mock.method(svc, '_modulosHabilitados', async () => []); // no depende de un módulo
    const guardado = simular(t, []);
    await guardar([
      { id: 'alertas_proximas', instanceId: 'al-1' },
      { id: 'alertas_proximas', instanceId: 'al-2', alertTypes: ['externos', 'deudas'], horizonDays: 30, period: 'month' },
    ]);
    assert.deepEqual(guardado.widgets, [
      { id: 'alertas_proximas', instanceId: 'al-1', size: 'sm', chartType: 'list', alertTypes: ['deudas', 'suscripciones', 'externos'], horizonDays: 15 },
      { id: 'alertas_proximas', instanceId: 'al-2', size: 'sm', chartType: 'list', alertTypes: ['deudas', 'externos'], horizonDays: 30 },
    ]);

    await assert.rejects(guardar([{ id: 'alertas_proximas', horizonDays: 10 }]), e => e.status === 400);
    await assert.rejects(guardar([{ id: 'alertas_proximas', alertTypes: [] }]), e => e.status === 400);
    await assert.rejects(guardar([{ id: 'alertas_proximas', alertTypes: ['crm'] }]), e => e.status === 400);
    await assert.rejects(guardar([{ id: 'alertas_proximas', chartType: 'kpi' }]), e => e.status === 400);
    await assert.rejects(guardar([{ id: 'operativo_metricas_tareas', horizonDays: 7 }]), e => e.status === 400);
  });

  test(`${nombre}: mosaicos de Protocolos requieren el módulo protocolos`, async (t) => {
    t.mock.method(svc, '_modulosHabilitados', async () => ['operations']);
    simular(t, []);
    await assert.rejects(guardar([{ id: 'protocolos_activos', instanceId: 'p-1' }]), e => e.status === 403);
    t.mock.method(svc, '_modulosHabilitados', async () => ['protocolos']);
    const guardado = simular(t, []);
    await guardar([{ id: 'protocolos_incumplimientos', instanceId: 'p-1', period: '3m', chartType: 'gauge' }]);
    assert.deepEqual(guardado.widgets, [{ id: 'protocolos_incumplimientos', instanceId: 'p-1', size: 'sm', period: '3m', chartType: 'gauge' }]);
  });
}

test('lectura: los mosaicos CRM guardados se siguen devolviendo (compatibilidad)', async (t) => {
  t.mock.method(dashboardService, '_modulosHabilitados', async () => ['crm']);
  simularConfig(t, [CRM_GUARDADO]);
  const out = await dashboardService.obtenerConfiguracion('u-dir', 'Dirección');
  assert.deepEqual(out.dashboard.widgets, [CRM_GUARDADO]);
});

test('catálogo de widgets: CRM marcado como deprecado y con su endpoint de datos intacto', () => {
  for (const id of ['crm_metricas_contactos', 'crm_metricas_contactos_6m']) {
    assert.equal(DASHBOARD_WIDGETS[id].deprecated, true);
    assert.equal(DASHBOARD_WIDGETS[id].sourceEndpoint, 'GET /api/crm/contactos/metricas');
  }
});
