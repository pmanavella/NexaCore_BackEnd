const nexiPermisos = require('../services/nexiPermisos');
const reportesService = require('../services/reportesService');
const repositorio = require('../services/reportesRepositorio');
const { PATRON_CLAVE } = require('../services/reportePeriodo');
const { SECCIONES, TIPOS, FORMATOS, LIMITES_REPORTES, TODOS_LOS_ALCANCES } = require('../config/reportes');

// Herramientas del módulo Reportes.
//
// La vista Reportes del frontend todavía no tiene backend propio: los únicos
// reportes que existen son los que genera Nexi (public.nexi_reportes). Estas
// herramientas nunca inventan reportes: informan los registros reales.
//
// generar_reporte es la ÚNICA herramienta con efecto GENERACION: produce un
// archivo (PDF) a partir de datos que el backend obtiene y calcula con las
// mismas reglas de permisos que las herramientas de lectura. No modifica datos
// de negocio. Requiere permiso de lectura en Reportes y, por cada sección, el
// permiso del módulo correspondiente.

const REQUISITOS = [{ modulo: 'reportes', permiso: 'lector' }];
const PATRON_FECHA = '^\\d{4}-\\d{2}-\\d{2}$';
const ETIQUETA_ESTADO = { GENERADO: 'generado', DENEGADO: 'denegado', ERROR: 'con error', EN_PROCESO: 'en proceso' };

function disponibilidadSecciones(niveles, usuario) {
  return Object.entries(SECCIONES).map(([clave, s]) => {
    const acceso = nexiPermisos.evaluarRequisitos(s, niveles, usuario);
    return { seccion: clave, titulo: s.titulo, disponible: acceso.ok, ...(acceso.ok ? {} : { motivo: acceso.motivo }) };
  });
}

function presentarReporte(r) {
  return {
    id: r.id,
    titulo: r.titulo,
    tipo: r.tipo,
    periodo: r.periodo_etiqueta,
    estado: ETIQUETA_ESTADO[r.estado] || r.estado,
    fecha: String(r.created_at || '').slice(0, 10),
    secciones: r.secciones,
    descargable: r.estado === 'GENERADO',
  };
}

const estadoModuloReportes = {
  nombre: 'estado_modulo_reportes',
  descripcion: 'Estado actual del módulo Reportes: qué contiene (reportes generados por Nexi para el usuario) y qué tipos de reporte se pueden generar.',
  parametros: { type: 'object', properties: {}, additionalProperties: false },
  requisitos: REQUISITOS,
  alcance: 'PERSONAL',
  alcancesPermitidos: TODOS_LOS_ALCANCES,
  async handler(args, { usuario }) {
    const propios = await repositorio.listarPropios(usuario.id, 5);
    return {
      modulo: 'Reportes',
      vista_reportes: 'La vista Reportes todavía no tiene funcionalidades propias: los reportes disponibles son los que genera Nexi a pedido.',
      generacion_de_reportes_por_nexi: true,
      formatos: FORMATOS,
      tipos: Object.keys(TIPOS),
      reportes_generados_recientes: propios.map(presentarReporte),
    };
  },
};

const tiposDeReporte = {
  nombre: 'tipos_de_reporte',
  descripcion: 'Tipos de reporte que Nexi puede generar, sus secciones y cuáles puede incluir este usuario según sus permisos. Usar antes de generar si no está claro qué puede incluirse.',
  parametros: { type: 'object', properties: {}, additionalProperties: false },
  requisitos: REQUISITOS,
  alcance: 'PERSONAL',
  alcancesPermitidos: TODOS_LOS_ALCANCES,
  async handler(args, { niveles, usuario }) {
    return {
      tipos: Object.entries(TIPOS).map(([clave, t]) => ({ tipo: clave, titulo: t.titulo, secciones: t.secciones || 'a elección' })),
      secciones: disponibilidadSecciones(niveles, usuario),
      periodos: 'Mes (2026-09), trimestre (2026-Q3), semestre (2026-S2), año (2026) o rango desde/hasta. Máximo 12 meses.',
      formatos: FORMATOS,
      limites: { reportes_por_hora: LIMITES_REPORTES.MAX_POR_HORA, reportes_por_mensaje: LIMITES_REPORTES.MAX_POR_MENSAJE },
    };
  },
};

const misReportes = {
  nombre: 'mis_reportes',
  descripcion: 'Reportes generados anteriormente por Nexi para el usuario que conversa (título, período, estado y fecha).',
  parametros: {
    type: 'object',
    properties: { limite: { type: 'integer', minimum: 1, maximum: 20, description: 'Cantidad (1-20). Por defecto 10.' } },
    additionalProperties: false,
  },
  requisitos: REQUISITOS,
  alcance: 'PERSONAL',
  alcancesPermitidos: TODOS_LOS_ALCANCES,
  async handler(args, { usuario }) {
    const propios = await repositorio.listarPropios(usuario.id, args.limite ?? 10);
    return { total: propios.length, reportes: propios.map(presentarReporte) };
  },
};

const generarReporte = {
  nombre: 'generar_reporte',
  descripcion: 'Genera un reporte en PDF con datos reales de NexaCore calculados por el backend. Usar SOLO cuando el usuario pide explícitamente un reporte o informe. '
    + 'Tipos: financiero, operativo, crm, indicadores, protocolos, dashboard, organizacion, ejecutivo (integral: finanzas, KPI, operativo, CRM y protocolos) o personalizado (con "secciones"). '
    + 'El período es obligatorio: "periodo" (2026-09, 2026-Q3, 2026-S2, 2026) o "desde"/"hasta". Por defecto compara contra el período anterior; '
    + '"comparar_con" admite "ninguno" o un período específico (ej. reporte de 2026-09 comparado con 2026-08). Las secciones sin permiso se excluyen y se informan.',
  parametros: {
    type: 'object',
    properties: {
      tipo: { type: 'string', enum: Object.keys(TIPOS), description: 'Tipo de reporte.' },
      secciones: {
        type: 'array',
        items: { type: 'string', enum: Object.keys(SECCIONES) },
        minItems: 1,
        maxItems: Object.keys(SECCIONES).length,
        uniqueItems: true,
        description: 'Solo con tipo "personalizado": secciones a incluir.',
      },
      periodo: { type: 'string', pattern: PATRON_CLAVE, description: 'Período calendario: 2026-09 (mes), 2026-Q3 (trimestre), 2026-S2 (semestre) o 2026 (año).' },
      desde: { type: 'string', pattern: PATRON_FECHA, description: 'Inicio de un rango personalizado (YYYY-MM-DD, inclusive). Usar junto con hasta.' },
      hasta: { type: 'string', pattern: PATRON_FECHA, description: 'Fin del rango personalizado (YYYY-MM-DD, inclusive).' },
      comparar_con: { type: 'string', pattern: '^(anterior|ninguno|\\d{4}(-(0[1-9]|1[0-2]|Q[1-4]|S[12]))?)$', description: '"anterior" (por defecto), "ninguno" o un período calendario.' },
      formato: { type: 'string', enum: FORMATOS, description: 'Formato del archivo. Por defecto pdf.' },
    },
    required: ['tipo'],
    additionalProperties: false,
  },
  requisitos: REQUISITOS,
  alcance: 'PERSONAL',
  efecto: 'GENERACION',
  // La autorización real es por sección (permiso, rol y alcance de cada módulo).
  alcancesPermitidos: TODOS_LOS_ALCANCES,
  async handler(args, ctx) {
    return reportesService.generar({ ...ctx, args });
  },
  // Artefacto que el chat devuelve al frontend para ofrecer la descarga.
  artefacto(datos) {
    return {
      tipo: 'reporte',
      id: datos.reporte_id,
      titulo: datos.titulo,
      formato: datos.formato,
      descargaUrl: `/api/nexi/reportes/${datos.reporte_id}/descarga`,
    };
  },
};

module.exports = [estadoModuloReportes, tiposDeReporte, misReportes, generarReporte];
