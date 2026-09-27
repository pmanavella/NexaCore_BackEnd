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
const WIDGET_PERIODS = ['month', '3m', '6m', '12m'];
const CHART_TYPES = ['kpi', 'area', 'bar', 'list', 'line', 'gauge'];

const DASHBOARD_WIDGETS = {
  finanzas_ingresos_mes: {
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/movimientos/metricas',
    periods: ['month', '3m', '6m', '12m'],
    defaultPeriod: 'month',
    allowedChartTypes: ['kpi', 'area', 'bar'],
    defaultChartType: 'kpi',
  },
  finanzas_gastos_mes: {
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/movimientos/metricas',
    periods: ['month', '3m', '6m', '12m'],
    defaultPeriod: 'month',
    allowedChartTypes: ['kpi', 'area', 'bar'],
    defaultChartType: 'kpi',
  },
  finanzas_resultado_neto: {
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/movimientos/metricas',
    periods: ['month', '3m', '6m', '12m'],
    defaultPeriod: 'month',
    allowedChartTypes: ['kpi', 'area', 'bar'],
    defaultChartType: 'kpi',
  },
  finanzas_metricas_movimientos: {
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/movimientos/metricas',
    periods: ['month', '3m', '6m', '12m'],
    defaultPeriod: 'month',
    allowedChartTypes: ['bar', 'list'],
    defaultChartType: 'bar',
  },
  finanzas_metricas_salarios: {
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/salarios/metricas',
    requiresRole: ['Dirección', 'Superadmin'],
    periods: ['month', '3m', '6m', '12m'],
    defaultPeriod: 'month',
    allowedChartTypes: ['kpi'],
    defaultChartType: 'kpi',
  },
  crm_metricas_contactos: {
    module: 'crm',
    sourceEndpoint: 'GET /api/crm/contactos/metricas',
    periods: ['month', '3m', '6m', '12m'],
    defaultPeriod: 'month',
    allowedChartTypes: ['kpi', 'bar', 'list'],
    defaultChartType: 'kpi',
  },
  operativo_metricas_tareas: {
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
    module: 'indicadores',
    requiresModules: ['finance'],
    requiresIndicator: true,
    sourceEndpoint: 'GET /api/indicadores/:indicatorId/historico?period=<period>',
    periods: ['month', '3m', '6m', '12m'],
    defaultPeriod: 'month',
    allowedChartTypes: ['kpi', 'line', 'bar', 'area', 'gauge'],
    defaultChartType: 'kpi',
  },

  // Variantes "últimos 6 meses": mismo endpoint que su contraparte mensual —
  // el frontend arma el agregado pidiendo el endpoint 6 veces (uno por mes) y
  // sumando client-side. No agregan datos ni lógica nueva en el backend.
  // LEGACY: se conservan para no invalidar configuraciones guardadas; su único
  // período válido es '6m' (defaultPeriod: '6m'). Los mosaicos nuevos usan el
  // ID base + `period: '6m'`.
  finanzas_ingresos_6m: {
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/movimientos/metricas',
    periods: ['6m'],
    defaultPeriod: '6m',
    allowedChartTypes: ['kpi', 'area', 'bar'],
    defaultChartType: 'kpi',
  },
  finanzas_gastos_6m: {
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/movimientos/metricas',
    periods: ['6m'],
    defaultPeriod: '6m',
    allowedChartTypes: ['kpi', 'area', 'bar'],
    defaultChartType: 'kpi',
  },
  finanzas_resultado_neto_6m: {
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/movimientos/metricas',
    periods: ['6m'],
    defaultPeriod: '6m',
    allowedChartTypes: ['kpi', 'area', 'bar'],
    defaultChartType: 'kpi',
  },
  finanzas_metricas_movimientos_6m: {
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/movimientos/metricas',
    periods: ['6m'],
    defaultPeriod: '6m',
    allowedChartTypes: ['bar', 'list'],
    defaultChartType: 'bar',
  },
  finanzas_metricas_salarios_6m: {
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/salarios/metricas',
    requiresRole: ['Dirección', 'Superadmin'],
    periods: ['6m'],
    defaultPeriod: '6m',
    allowedChartTypes: ['kpi'],
    defaultChartType: 'kpi',
  },
  crm_metricas_contactos_6m: {
    module: 'crm',
    sourceEndpoint: 'GET /api/crm/contactos/metricas',
    periods: ['6m'],
    defaultPeriod: '6m',
    allowedChartTypes: ['kpi', 'bar', 'list'],
    defaultChartType: 'kpi',
  },
  operativo_metricas_tareas_6m: {
    module: 'operations',
    sourceEndpoint: 'GET /api/operations/tareas/metricas',
    periods: ['6m'],
    defaultPeriod: '6m',
    allowedChartTypes: ['kpi', 'bar', 'list'],
    defaultChartType: 'kpi',
  },
};

module.exports = { DASHBOARD_WIDGETS, WIDGET_PERIODS, CHART_TYPES };
