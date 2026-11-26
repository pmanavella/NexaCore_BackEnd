// Catálogo cerrado de mosaicos disponibles para el Dashboard personalizable.
// Cada ID debe tener respaldo real en un endpoint de métricas existente — no se
// inventan datos. `module` es el slug real de `modulos.nombre` en Supabase
// (mismo valor que usan las rutas de negocio y requireModuleAccess).
//
// finanzas_metricas_salarios conserva, además del acceso al módulo 'finance',
// la restricción de rol que ya tiene GET /api/finance/salarios/metricas
// (soloAdmin en finance/routes/salarios.js) — no se amplía el acceso a nómina.
//
// PERÍODO Y VISUALIZACIÓN (propiedades independientes del ID):
//   - `periods`          : períodos que la métrica puede resolver con los
//                          endpoints actuales (el frontend agrega los datos;
//                          el backend solo persiste/valida el valor elegido).
//   - `defaultPeriod`    : período usado cuando el mosaico no trae `period`.
//                          Para las entradas legacy `_6m` es '6m', de modo que
//                          las configuraciones antiguas mantienen su significado.
//   - `allowedChartTypes`: tipos de gráfico que los datos ya disponibles
//                          soportan sin nuevas consultas. No se listan combos
//                          que la métrica no pueda representar correctamente.
//   - `defaultChartType` : visualización "Recomendada" (default si no se envía).
//
// Valores globales admitidos: WIDGET_PERIODS y CHART_TYPES (abajo).
// Las entradas `_6m` se conservan solo por compatibilidad con configuraciones
// ya guardadas — los mosaicos nuevos usan el ID base + la propiedad `period`.
//
// INDICADORES (KPI):
//   - `requiresIndicator`: la instancia debe llevar `indicatorId` (uuid de
//                          public.indicadores). Solo estos mosaicos lo admiten.
//   - `requiresModules`  : módulos adicionales a `module` que el usuario debe
//                          tener habilitados (los KPI calculan datos de Finanzas).
//
// DEPRECADOS (`deprecated: true`):
//   - No se ofrecen en el catálogo para mosaicos nuevos (GET /api/dashboard/catalogo)
//     y el guardado rechaza instancias NUEVAS (400). Las instancias ya guardadas
//     (mismo `instanceId` + mismo `id`) se siguen leyendo y guardando, y su
//     `sourceEndpoint` sigue respondiendo: no se rompe ningún tablero existente.
//
// HORIZONTE en lugar de período (`usesHorizon: true`, mosaico de Alertas):
//   - La instancia no lleva `period`; lleva `horizonDays` (uno de `horizons`,
//     default `defaultHorizon`) y `alertTypes` (subconjunto no vacío de
//     `alertTypes` del catálogo; default: todos).
//   - `module: null`: no depende de un único módulo; los permisos se aplican por
//     tipo de alerta al consultar los datos (GET /api/alertas/proximas).
//
// `group` / `title`: agrupación y nombre legible para el panel "Crear gráfico
// personalizado" (pasos Módulo → Métrica). Ver CATALOG_GROUPS.
const WIDGET_PERIODS = ['month', '3m', '6m', '12m'];
const CHART_TYPES = ['kpi', 'area', 'bar', 'list', 'line', 'gauge'];
const ALERT_TYPES = ['deudas', 'suscripciones', 'externos'];
const ALERT_HORIZONS = [7, 15, 30];
const DEFAULT_ALERT_HORIZON = 15;

// Módulos del paso "Módulo" del panel, en orden de presentación.
const CATALOG_GROUPS = [
  { key: 'finanzas', label: 'Finanzas' },
  { key: 'operativo', label: 'Operativo' },
  { key: 'indicador', label: 'Indicador' },
  { key: 'protocolos', label: 'Protocolos' },
  { key: 'alertas', label: 'Alertas' },
  { key: 'crm', label: 'CRM' }, // solo deprecados: nunca se ofrece
];

const DASHBOARD_WIDGETS = {
  finanzas_ingresos_mes: {
    group: 'finanzas',
    title: 'Ingresos',
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/movimientos/metricas',
    periods: ['month', '3m', '6m', '12m'],
    defaultPeriod: 'month',
    allowedChartTypes: ['kpi', 'area', 'bar'],
    defaultChartType: 'kpi',
  },
  finanzas_gastos_mes: {
    group: 'finanzas',
    title: 'Gastos',
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/movimientos/metricas',
    periods: ['month', '3m', '6m', '12m'],
    defaultPeriod: 'month',
    allowedChartTypes: ['kpi', 'area', 'bar'],
    defaultChartType: 'kpi',
  },
  finanzas_resultado_neto: {
    group: 'finanzas',
    title: 'Resultado neto',
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/movimientos/metricas',
    periods: ['month', '3m', '6m', '12m'],
    defaultPeriod: 'month',
    allowedChartTypes: ['kpi', 'area', 'bar'],
    defaultChartType: 'kpi',
  },
  finanzas_metricas_movimientos: {
    group: 'finanzas',
    title: 'Movimientos por categoría',
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/movimientos/metricas',
    periods: ['month', '3m', '6m', '12m'],
    defaultPeriod: 'month',
    allowedChartTypes: ['bar', 'list'],
    defaultChartType: 'bar',
  },
  finanzas_metricas_salarios: {
    group: 'finanzas',
    title: 'Salarios',
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/salarios/metricas',
    requiresRole: ['Dirección', 'Superadmin'],
    periods: ['month', '3m', '6m', '12m'],
    defaultPeriod: 'month',
    allowedChartTypes: ['kpi'],
    defaultChartType: 'kpi',
  },
  crm_metricas_contactos: {
    group: 'crm',
    title: 'Contactos del CRM',
    deprecated: true,
    module: 'crm',
    sourceEndpoint: 'GET /api/crm/contactos/metricas',
    requiresRole: ['Superadmin', 'Dirección', 'Director'],
    periods: ['month', '3m', '6m', '12m'],
    defaultPeriod: 'month',
    allowedChartTypes: ['kpi', 'bar', 'list'],
    defaultChartType: 'kpi',
  },
  operativo_metricas_tareas: {
    group: 'operativo',
    title: 'Tareas',
    module: 'operations',
    sourceEndpoint: 'GET /api/operations/tareas/metricas',
    periods: ['month', '3m', '6m', '12m'],
    defaultPeriod: 'month',
    allowedChartTypes: ['kpi', 'bar', 'list'],
    defaultChartType: 'kpi',
  },
  // Un mismo indicador puede aparecer en varias instancias (distinto
  // `instanceId`, `period` y `chartType`). `period` define la ventana del
  // histórico; la granularidad de los puntos es la frecuencia del indicador.
  // 'kpi' y 'gauge' usan `ultimoValido`; 'line', 'bar' y 'area' usan `puntos`.
  indicador_kpi: {
    group: 'indicador',
    title: 'Indicador (KPI)',
    module: 'indicadores',
    requiresModules: ['finance'],
    requiresIndicator: true,
    sourceEndpoint: 'GET /api/indicadores/:indicatorId/historico?period=<period>',
    periods: ['month', '3m', '6m', '12m'],
    defaultPeriod: 'month',
    allowedChartTypes: ['kpi', 'line', 'bar', 'area', 'gauge'],
    defaultChartType: 'kpi',
  },

  // PROTOCOLOS: datos informativos (solo lectura), todos desde un único
  // endpoint. `period` acota los registros: 'month' = mes en curso; '3m'/'6m'/
  // '12m' = últimos N meses calendario contando el actual (hora de Argentina).
  // `protocolos_activos` y `protocolos_sin_registros` no dependen del período
  // (se admite igual para que el paso "Período" del panel sea uniforme).
  protocolos_activos: {
    group: 'protocolos',
    title: 'Protocolos activos',
    module: 'protocolos',
    sourceEndpoint: 'GET /api/dashboard/protocolos?period=<period>',
    periods: ['month', '3m', '6m', '12m'],
    defaultPeriod: 'month',
    allowedChartTypes: ['kpi', 'bar'],
    defaultChartType: 'kpi',
  },
  protocolos_registros: {
    group: 'protocolos',
    title: 'Registros en el período',
    module: 'protocolos',
    sourceEndpoint: 'GET /api/dashboard/protocolos?period=<period>',
    periods: ['month', '3m', '6m', '12m'],
    defaultPeriod: 'month',
    allowedChartTypes: ['kpi', 'bar', 'area'],
    defaultChartType: 'kpi',
  },
  protocolos_incumplimientos: {
    group: 'protocolos',
    title: 'Registros con incumplimientos',
    module: 'protocolos',
    sourceEndpoint: 'GET /api/dashboard/protocolos?period=<period>',
    periods: ['month', '3m', '6m', '12m'],
    defaultPeriod: 'month',
    allowedChartTypes: ['kpi', 'gauge', 'bar'],
    defaultChartType: 'kpi',
  },
  protocolos_ultimos_registros: {
    group: 'protocolos',
    title: 'Últimos registros',
    module: 'protocolos',
    sourceEndpoint: 'GET /api/dashboard/protocolos?period=<period>&limite=<n>',
    periods: ['month', '3m', '6m', '12m'],
    defaultPeriod: 'month',
    allowedChartTypes: ['list'],
    defaultChartType: 'list',
  },
  protocolos_sin_registros: {
    group: 'protocolos',
    title: 'Protocolos sin registros (30 días)',
    module: 'protocolos',
    sourceEndpoint: 'GET /api/dashboard/protocolos?period=<period>',
    periods: ['month', '3m', '6m', '12m'],
    defaultPeriod: 'month',
    allowedChartTypes: ['list'],
    defaultChartType: 'list',
  },

  // ALERTAS: listado de alertas próximas. Usa horizonte (días) en vez de período.
  alertas_proximas: {
    group: 'alertas',
    title: 'Alertas próximas',
    module: null,
    usesHorizon: true,
    alertTypes: ALERT_TYPES,
    horizons: ALERT_HORIZONS,
    defaultHorizon: DEFAULT_ALERT_HORIZON,
    sourceEndpoint: 'GET /api/alertas/proximas?tipos=<alertTypes>&horizonte=<horizonDays>',
    periods: [],
    defaultPeriod: null,
    allowedChartTypes: ['list'],
    defaultChartType: 'list',
  },

  // Variantes "últimos 6 meses": mismo endpoint que su contraparte mensual —
  // el frontend arma el agregado pidiendo el endpoint 6 veces (uno por mes) y
  // sumando client-side. No agregan datos ni lógica nueva en el backend.
  // LEGACY: se conservan para no invalidar configuraciones guardadas; su único
  // período válido es '6m' (defaultPeriod: '6m'). Los mosaicos nuevos usan el
  // ID base + `period: '6m'`.
  finanzas_ingresos_6m: {
    group: 'finanzas',
    title: 'Ingresos (últimos 6 meses)',
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/movimientos/metricas',
    periods: ['6m'],
    defaultPeriod: '6m',
    allowedChartTypes: ['kpi', 'area', 'bar'],
    defaultChartType: 'kpi',
  },
  finanzas_gastos_6m: {
    group: 'finanzas',
    title: 'Gastos (últimos 6 meses)',
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/movimientos/metricas',
    periods: ['6m'],
    defaultPeriod: '6m',
    allowedChartTypes: ['kpi', 'area', 'bar'],
    defaultChartType: 'kpi',
  },
  finanzas_resultado_neto_6m: {
    group: 'finanzas',
    title: 'Resultado neto (últimos 6 meses)',
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/movimientos/metricas',
    periods: ['6m'],
    defaultPeriod: '6m',
    allowedChartTypes: ['kpi', 'area', 'bar'],
    defaultChartType: 'kpi',
  },
  finanzas_metricas_movimientos_6m: {
    group: 'finanzas',
    title: 'Movimientos por categoría (últimos 6 meses)',
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/movimientos/metricas',
    periods: ['6m'],
    defaultPeriod: '6m',
    allowedChartTypes: ['bar', 'list'],
    defaultChartType: 'bar',
  },
  finanzas_metricas_salarios_6m: {
    group: 'finanzas',
    title: 'Salarios (últimos 6 meses)',
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/salarios/metricas',
    requiresRole: ['Dirección', 'Superadmin'],
    periods: ['6m'],
    defaultPeriod: '6m',
    allowedChartTypes: ['kpi'],
    defaultChartType: 'kpi',
  },
  crm_metricas_contactos_6m: {
    group: 'crm',
    title: 'Contactos del CRM (últimos 6 meses)',
    deprecated: true,
    module: 'crm',
    sourceEndpoint: 'GET /api/crm/contactos/metricas',
    requiresRole: ['Superadmin', 'Dirección', 'Director'],
    periods: ['6m'],
    defaultPeriod: '6m',
    allowedChartTypes: ['kpi', 'bar', 'list'],
    defaultChartType: 'kpi',
  },
  operativo_metricas_tareas_6m: {
    group: 'operativo',
    title: 'Tareas (últimos 6 meses)',
    module: 'operations',
    sourceEndpoint: 'GET /api/operations/tareas/metricas',
    periods: ['6m'],
    defaultPeriod: '6m',
    allowedChartTypes: ['kpi', 'bar', 'list'],
    defaultChartType: 'kpi',
  },
};

module.exports = {
  DASHBOARD_WIDGETS, WIDGET_PERIODS, CHART_TYPES, CATALOG_GROUPS,
  ALERT_TYPES, ALERT_HORIZONS, DEFAULT_ALERT_HORIZON,
};
