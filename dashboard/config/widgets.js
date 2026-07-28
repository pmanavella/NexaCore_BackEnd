// Catálogo cerrado de mosaicos disponibles para el Dashboard personalizable.
// Cada ID debe tener respaldo real en un endpoint de métricas existente — no se
// inventan datos. `module` es el slug real de `modulos.nombre` en Supabase
// (mismo valor que usan las rutas de negocio y requireModuleAccess).
//
// finanzas_metricas_salarios conserva, además del acceso al módulo 'finance',
// la restricción de rol que ya tiene GET /api/finance/salarios/metricas
// (soloAdmin en finance/routes/salarios.js) — no se amplía el acceso a nómina.
const DASHBOARD_WIDGETS = {
  finanzas_ingresos_mes: {
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/movimientos/metricas',
  },
  finanzas_gastos_mes: {
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/movimientos/metricas',
  },
  finanzas_resultado_neto: {
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/movimientos/metricas',
  },
  finanzas_metricas_movimientos: {
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/movimientos/metricas',
  },
  finanzas_metricas_salarios: {
    module: 'finance',
    sourceEndpoint: 'GET /api/finance/salarios/metricas',
    requiresRole: ['Dirección', 'Superadmin'],
  },
  crm_metricas_contactos: {
    module: 'crm',
    sourceEndpoint: 'GET /api/crm/contactos/metricas',
  },
  operativo_metricas_tareas: {
    module: 'operations',
    sourceEndpoint: 'GET /api/operations/tareas/metricas',
  },
  planificacion_metricas_proyectos: {
    module: 'planification',
    sourceEndpoint: 'GET /api/planification/proyectos/metricas',
  },
};

module.exports = { DASHBOARD_WIDGETS };
