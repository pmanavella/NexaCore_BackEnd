const { REQUISITOS_ROL_CRM } = require('../tools/crmTools');
const { ROLES_ORGANIGRAMA_COMPLETO } = require('../tools/organizacionTools');

// Configuración central de los reportes que genera Nexi.
//
// Cada SECCIÓN se autoriza por separado con la misma regla que las
// herramientas (nexiPermisos.evaluarRequisitos): un reporte nunca permite ver
// algo que el usuario no podría consultar con la herramienta equivalente.

const TODOS_LOS_ALCANCES = ['propio', 'equipo_directo', 'subarbol', 'global'];

const SECCIONES = {
  finanzas: {
    titulo: 'Finanzas',
    requisitos: [{ modulo: 'finance', permiso: 'lector' }],
    alcancesPermitidos: ['global'],
  },
  indicadores: {
    titulo: 'Indicadores (KPI)',
    // Igual que valor_indicador / historico_indicador: los KPI se calculan con Finanzas.
    requisitos: [{ modulo: 'indicadores', permiso: 'lector' }, { modulo: 'finance', permiso: 'lector' }],
    alcancesPermitidos: ['global'],
  },
  operativo: {
    titulo: 'Operativo',
    requisitos: [{ modulo: 'operations', permiso: 'lector' }],
    alcancesPermitidos: TODOS_LOS_ALCANCES,
  },
  crm: {
    titulo: 'CRM',
    requisitos: [{ modulo: 'crm', permiso: 'lector' }],
    requisitosRol: REQUISITOS_ROL_CRM,
    alcancesPermitidos: ['global'],
  },
  protocolos: {
    titulo: 'Protocolos',
    requisitos: [{ modulo: 'protocolos', permiso: 'lector' }],
    alcancesPermitidos: TODOS_LOS_ALCANCES,
  },
  dashboard: {
    titulo: 'Dashboard',
    requisitos: [{ modulo: 'dashboard', permiso: 'lector' }],
    alcancesPermitidos: TODOS_LOS_ALCANCES,
  },
  organizacion: {
    titulo: 'Organización',
    // Composición de toda la organización: mismas reglas que estructura_organizacion.
    requisitos: [{ modulo: 'organizacion', permiso: 'lector' }],
    requisitosRol: ROLES_ORGANIGRAMA_COMPLETO,
    alcancesPermitidos: ['global'],
  },
};

// Tipo de reporte → secciones. 'personalizado' usa las secciones pedidas.
const TIPOS = {
  financiero: { titulo: 'Reporte financiero', secciones: ['finanzas'] },
  operativo: { titulo: 'Reporte operativo', secciones: ['operativo'] },
  crm: { titulo: 'Reporte de CRM', secciones: ['crm'] },
  indicadores: { titulo: 'Reporte de indicadores (KPI)', secciones: ['indicadores'] },
  protocolos: { titulo: 'Reporte de protocolos', secciones: ['protocolos'] },
  dashboard: { titulo: 'Reporte del Dashboard', secciones: ['dashboard'] },
  organizacion: { titulo: 'Reporte organizacional', secciones: ['organizacion'] },
  ejecutivo: { titulo: 'Reporte ejecutivo', secciones: ['finanzas', 'indicadores', 'operativo', 'crm', 'protocolos'] },
  personalizado: { titulo: 'Reporte', secciones: null },
};

const FORMATOS = ['pdf'];

const LIMITES_REPORTES = {
  // Rango máximo de un reporte (meses calendario).
  MAX_MESES: 12,
  // Reportes generados por usuario por hora (se cuenta en la base: vale para
  // varias instancias del backend).
  MAX_POR_HORA: 10,
  // Reportes por mensaje del chat.
  MAX_POR_MENSAJE: 1,
  // Filas máximas por tabla dentro del PDF.
  MAX_FILAS_TABLA: 15,
  // Indicadores máximos en la sección de KPI.
  MAX_INDICADORES: 12,
  // Mosaicos máximos en la sección de Dashboard.
  MAX_MOSAICOS: 12,
  // Ejecuciones de protocolos analizadas por reporte.
  MAX_EJECUCIONES: 500,
  // Tamaño máximo del PDF generado (bytes).
  MAX_BYTES_ARCHIVO: 5 * 1024 * 1024,
};

// Bucket privado de Supabase Storage para los archivos generados.
const BUCKET_REPORTES = 'nexi-reportes';

module.exports = { SECCIONES, TIPOS, FORMATOS, LIMITES_REPORTES, BUCKET_REPORTES, TODOS_LOS_ALCANCES };
