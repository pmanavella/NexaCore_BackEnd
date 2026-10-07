const dashboardService = require('../../dashboard/services/dashboardService');
const dashboardViewsService = require('../../dashboard/services/dashboardViewsService');
const { DASHBOARD_WIDGETS } = require('../../dashboard/config/widgets');
const indicadoresService = require('../../indicators/services/indicadoresService');
const operationsService = require('../../operations/services/operationsService');
const { MESES_POR_VENTANA } = require('../../indicators/config/indicadores');
const nexiPermisos = require('../services/nexiPermisos');
const nexiDatos = require('../services/nexiDatos');
const { totalesDeMeses, totalesDelRango, variacionPct } = require('./finanzasTools');
const { conteosContactos } = require('./crmTools');
const { resumenTareas } = require('./operativoTools');
const { ultimosMeses, redondear } = require('./comunes');

// Herramientas de Dashboard (solo lectura).
//
// Diferencia tres cosas:
//   - catálogo: mosaicos que existen en dashboard/config/widgets.js;
//   - configuración: mosaicos que el USUARIO tiene guardados (Panel General o
//     una vista), leída con dashboardService / dashboardViewsService, que ya
//     filtran mosaicos sin permiso de módulo o de rol;
//   - datos: valores calculados para un mosaico configurado, con las mismas
//     fuentes que usa el mosaico y respetando permiso, rol y alcance de su
//     módulo (se re-verifican acá: no se confía en la configuración guardada).
//
// La configuración es siempre la del usuario de la sesión (nunca de otro).

const TODOS_LOS_ALCANCES = ['propio', 'equipo_directo', 'subarbol', 'global'];
const MAX_WIDGETS_RESUMEN = 12;
const PATRON_UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const PARAM_VISTA = {
  type: 'string',
  pattern: PATRON_UUID,
  description: 'id de una vista de Dashboard (de mi_dashboard). Omitir para el Panel General.',
};

const ETIQUETAS = {
  finanzas_ingresos_mes: 'Ingresos',
  finanzas_gastos_mes: 'Gastos',
  finanzas_resultado_neto: 'Resultado neto',
  finanzas_metricas_movimientos: 'Movimientos por categoría',
  finanzas_metricas_salarios: 'Salarios',
  crm_metricas_contactos: 'Contactos del CRM',
  operativo_metricas_tareas: 'Tareas',
  indicador_kpi: 'Indicador (KPI)',
};
const ETIQUETA_PERIODO = { month: 'Mes en curso', '3m': 'Últimos 3 meses', '6m': 'Últimos 6 meses', '12m': 'Últimos 12 meses' };
const ETIQUETA_GRAFICO = { kpi: 'Tarjeta', area: 'Área', bar: 'Barras', list: 'Lista', line: 'Línea', gauge: 'Medidor' };

// Mosaicos cuyos datos solo pueden mostrarse con alcance global (sus fuentes no
// tienen relación con usuarios). Operativo admite alcances restringidos.
const ALCANCES_POR_MODULO = { operations: TODOS_LOS_ALCANCES };

function idBase(widgetId) {
  return widgetId.replace(/_6m$/, '');
}

function etiqueta(widgetId) {
  const base = ETIQUETAS[idBase(widgetId)] || widgetId;
  return widgetId.endsWith('_6m') ? `${base} (últimos 6 meses)` : base;
}

// Autorización de los DATOS de un mosaico: módulo + módulos adicionales + rol +
// alcance, con la regla única de Nexi (nexiPermisos.evaluarRequisitos) aplicada
// a los requisitos del catálogo de widgets.
const MOTIVOS_WIDGET = {
  SIN_PERMISO: 'Sin permiso sobre el módulo del mosaico (o tu rol no tiene acceso a él).',
  ALCANCE_INSUFICIENTE: 'El alcance de tus permisos no permite ver los datos de este mosaico.',
};

function autorizarWidget(def, { niveles, usuario }) {
  const r = nexiPermisos.evaluarRequisitos({
    requisitos: [def.module, ...(def.requiresModules || [])].map(modulo => ({ modulo, permiso: 'lector' })),
    requisitosRol: def.requiresRole,
    alcancesPermitidos: ALCANCES_POR_MODULO[def.module] || ['global'],
  }, niveles, usuario);
  return r.ok ? r : { ok: false, motivo: MOTIVOS_WIDGET[r.motivo] };
}

// Mosaicos configurados del usuario (Panel General o una vista propia).
async function configuracion(usuario, vistaId) {
  if (vistaId) {
    const vista = await dashboardViewsService.obtenerVista(vistaId, usuario.id, usuario.role);
    return { tablero: { tipo: 'vista', nombre: vista.nombre }, configurado: true, widgets: vista.widgets };
  }
  const config = await dashboardService.obtenerConfiguracion(usuario.id, usuario.role);
  return { tablero: { tipo: 'principal', nombre: config.dashboard.name }, configurado: config.hasConfiguration, widgets: config.dashboard.widgets };
}

async function nombresIndicadores(widgets) {
  const ids = [...new Set(widgets.filter(w => w.indicatorId).map(w => w.indicatorId))];
  const nombres = new Map();
  await Promise.all(ids.map(async id => {
    try {
      const ind = await indicadoresService.obtenerPorId(id);
      nombres.set(id, { nombre: ind.nombre, activo: ind.activo });
    } catch {
      nombres.set(id, null);
    }
  }));
  return nombres;
}

function presentarWidget(w, nombres) {
  const def = DASHBOARD_WIDGETS[w.id];
  const indicador = w.indicatorId ? nombres.get(w.indicatorId) : undefined;
  return {
    instancia: w.instanceId,
    mosaico: w.id,
    titulo: indicador ? `KPI: ${indicador.nombre}` : etiqueta(w.id),
    modulo: def?.module || null,
    periodo: w.period,
    periodo_label: ETIQUETA_PERIODO[w.period] || w.period,
    visualizacion: ETIQUETA_GRAFICO[w.chartType] || w.chartType,
    tamanio: w.size,
    ...(w.indicatorId ? { indicador: indicador ? { nombre: indicador.nombre, activo: indicador.activo } : { nombre: 'Indicador no disponible' } } : {}),
  };
}

// ── Cálculo de datos por mosaico ────────────────────────────────────────────

function ventana(periodo, hoy) {
  const meses = ultimosMeses(MESES_POR_VENTANA[periodo] || 1, hoy);
  return { meses, desde: meses[0].desde, hasta: meses[meses.length - 1].hasta };
}

// Resta meses a una fecha YYYY-MM-DD recortando el día al fin de mes
// (2026-03-31 − 1 mes → 2026-02-28).
function restarMeses(fecha, meses) {
  const [a, m, d] = fecha.split('-').map(Number);
  const base = new Date(Date.UTC(a, m - 1 - meses, 1));
  const ultimoDia = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d, ultimoDia));
  return base.toISOString().slice(0, 10);
}

function diaSiguiente(fecha) {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Tramo comparable: la ventana termina en el mes en curso (datos parciales), así
// que se compara [inicio, hoy] contra el MISMO tramo desplazado N meses
// (ej. 1 al 7 de octubre contra 1 al 7 de septiembre), no contra meses completos.
function tramosComparables(meses, hoy) {
  const desde = meses[0].desde;
  const hasta = diaSiguiente(hoy.fecha) < meses[meses.length - 1].hasta ? diaSiguiente(hoy.fecha) : meses[meses.length - 1].hasta;
  const n = meses.length;
  return { actual: { desde, hasta }, anterior: { desde: restarMeses(desde, n), hasta: restarMeses(hasta, n) } };
}

async function totalesTramo({ desde, hasta }) {
  const t = totalesDelRango(await nexiDatos.totalesMovimientos(desde, hasta), '0000-01-01', '9999-12-31');
  return { ingresos: redondear(t.ingresos), gastos: redondear(t.gastos), balance: redondear(t.ingresos - t.gastos) };
}

const METRICA_FINANZAS = {
  finanzas_ingresos_mes: { campo: 'ingresos', mejora: 'SUBE' },
  finanzas_gastos_mes: { campo: 'gastos', mejora: 'BAJA' },
  finanzas_resultado_neto: { campo: 'balance', mejora: 'SUBE' },
};

async function datosFinanzas(base, periodo, hoy) {
  const { meses } = ventana(periodo, hoy);
  if (base === 'finanzas_metricas_movimientos') {
    const t = await totalesDeMeses(meses);
    return {
      ingresos_por_categoria: t.ingresosPorCategoria.slice(0, 10),
      gastos_por_categoria: t.gastosPorCategoria.slice(0, 10),
    };
  }
  const { campo, mejora } = METRICA_FINANZAS[base];
  const tramos = tramosComparables(meses, hoy);
  const [serie, actual, anterior] = await Promise.all([totalesDeMeses(meses), totalesTramo(tramos.actual), totalesTramo(tramos.anterior)]);
  const variacion = variacionPct(actual[campo], anterior[campo]);
  const direccion = variacion === null || variacion === 0 ? 'ESTABLE' : variacion > 0 ? 'SUBE' : 'BAJA';
  return {
    valor: actual[campo],
    valor_tramo_anterior: anterior[campo],
    comparacion: `mismo tramo del período anterior (${tramos.anterior.desde} al ${diaAnterior(tramos.anterior.hasta)})`,
    variacion_pct: variacion,
    empeora: direccion !== 'ESTABLE' && direccion !== mejora,
    serie: serie.porMes.map(m => ({ mes: m.mes, valor: m[campo] })),
  };
}

function diaAnterior(fecha) {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function datosCrm(periodo, hoy) {
  const { desde, hasta } = ventana(periodo, hoy);
  const [altas, totales] = await Promise.all([conteosContactos({ desde, hasta }), conteosContactos()]);
  return { altas_en_ventana: altas, totales_actuales: totales };
}

// Global: mismo service que el mosaico (operationsService.getMetricas, por
// mes de fecha límite). Alcance restringido: conteos acotados de Nexi.
async function datosOperativo(periodo, { usuario, alcance, hoy }) {
  const { meses, desde, hasta } = ventana(periodo, hoy);
  if (alcance !== 'global') {
    return { criterio: 'fecha límite dentro de la ventana', ...(await resumenTareas({ usuario, alcance, hoy, rango: { desde, hasta } })) };
  }
  const porMes = await Promise.all(meses.map(m => operationsService.getMetricas({ mes: Number(m.clave.slice(5, 7)), anio: Number(m.clave.slice(0, 4)) })));
  const porEtapa = new Map();
  const porTipoBase = {};
  for (const r of porMes) {
    for (const e of r.porEtapa) porEtapa.set(e.nombre, (porEtapa.get(e.nombre) || 0) + e.cantidad);
    for (const [k, v] of Object.entries(r.porTipoBase)) porTipoBase[k] = (porTipoBase[k] || 0) + v;
  }
  return {
    alcance_aplicado: 'global',
    criterio: 'fecha límite dentro de la ventana',
    total: porMes.reduce((a, r) => a + r.total, 0),
    vencidas: porMes.reduce((a, r) => a + r.vencidas, 0),
    por_etapa: Object.fromEntries(porEtapa),
    por_tipo_base: porTipoBase,
  };
}

const EMPEORA_KPI = { MAYOR_ES_MEJOR: 'BAJA', MENOR_ES_MEJOR: 'SUBE' };

async function datosIndicador(indicatorId, periodo, { ahora }) {
  const r = await indicadoresService.calcularHistorico(indicatorId, periodo, { ahora });
  const tendencia = r.tendencia;
  return {
    indicador: { nombre: r.indicador.nombre, unidad: r.indicador.unidad, sentido: r.indicador.sentido, valor_objetivo: r.indicador.valorObjetivo, limite_aceptable: r.indicador.limiteAceptable },
    ultimo_valido: r.ultimoValido ? { periodo: r.ultimoValido.periodo.label, valor: r.ultimoValido.valor, estado: r.ultimoValido.estado } : null,
    tendencia,
    empeora: !!tendencia && tendencia.direccion === EMPEORA_KPI[r.indicador.sentido],
    alerta: r.ultimoValido ? ['EN_RIESGO', 'CRITICO'].includes(r.ultimoValido.estado) : false,
    puntos: r.puntos.map(p => ({ periodo: p.periodo.label, valor: p.valor, estado: p.estado })),
  };
}

// Datos de un mosaico configurado. Nunca lanza por permisos: devuelve
// { disponible: false, motivo } para que el resumen pueda seguir con el resto.
async function datosWidget(widget, ctx) {
  const def = DASHBOARD_WIDGETS[widget.id];
  if (!def) return { disponible: false, motivo: 'Mosaico desconocido.' };
  const base = idBase(widget.id);
  if (base === 'finanzas_metricas_salarios') {
    return { disponible: false, motivo: 'Nexi no accede a información salarial (nómina).' };
  }
  const autorizacion = autorizarWidget(def, ctx);
  if (!autorizacion.ok) return { disponible: false, motivo: autorizacion.motivo };

  let datos;
  if (base.startsWith('finanzas_')) datos = await datosFinanzas(base, widget.period, ctx.hoy);
  else if (base === 'crm_metricas_contactos') datos = await datosCrm(widget.period, ctx.hoy);
  else if (base === 'operativo_metricas_tareas') datos = await datosOperativo(widget.period, { ...ctx, alcance: autorizacion.alcance });
  else if (base === 'indicador_kpi') datos = await datosIndicador(widget.indicatorId, widget.period, ctx);
  else return { disponible: false, motivo: 'Nexi todavía no calcula este mosaico.' };

  return { disponible: true, ventana: ETIQUETA_PERIODO[widget.period] || widget.period, en_curso: true, ...datos };
}

// Versión compacta para el resumen del tablero.
function compactar(datos) {
  if (!datos.disponible) return datos;
  const { serie, puntos, ...resto } = datos;
  if (resto.ingresos_por_categoria) {
    resto.ingresos_por_categoria = resto.ingresos_por_categoria.slice(0, 3);
    resto.gastos_por_categoria = resto.gastos_por_categoria.slice(0, 3);
  }
  return resto;
}

// ── Herramientas ────────────────────────────────────────────────────────────

const REQUISITOS = [{ modulo: 'dashboard', permiso: 'lector' }];

const miDashboard = {
  nombre: 'mi_dashboard',
  descripcion: 'Mosaicos (widgets) que el usuario tiene CONFIGURADOS en su Dashboard: título, módulo, período, visualización y tamaño, más sus vistas guardadas. Sin vista_id = Panel General. No devuelve valores: para eso usar datos_widget_dashboard o resumen_dashboard.',
  parametros: { type: 'object', properties: { vista_id: PARAM_VISTA }, additionalProperties: false },
  requisitos: REQUISITOS,
  alcance: 'PERSONAL',
  alcancesPermitidos: TODOS_LOS_ALCANCES,
  async handler(args, { usuario }) {
    const [config, vistas] = await Promise.all([
      configuracion(usuario, args.vista_id),
      dashboardViewsService.listarVistas(usuario.id),
    ]);
    const nombres = await nombresIndicadores(config.widgets);
    return {
      tablero: config.tablero,
      tiene_configuracion: config.configurado,
      cantidad_mosaicos: config.widgets.length,
      mosaicos: config.widgets.map(w => presentarWidget(w, nombres)),
      vistas: (vistas || []).map(v => ({ id: v.id, nombre: v.nombre })),
    };
  },
};

const catalogoDashboard = {
  nombre: 'catalogo_dashboard',
  descripcion: 'Catálogo de mosaicos que EXISTEN en el Dashboard (no los configurados): para cada uno, módulo, períodos y visualizaciones admitidos, y si el usuario podría agregarlo según sus permisos.',
  parametros: { type: 'object', properties: {}, additionalProperties: false },
  requisitos: REQUISITOS,
  alcance: 'AGREGADA',
  alcancesPermitidos: TODOS_LOS_ALCANCES,
  async handler(args, { niveles, usuario }) {
    const habilitados = [...niveles.entries()].filter(([, v]) => v.nivel !== 'sin_acceso').map(([k]) => k);
    return {
      mosaicos: Object.entries(DASHBOARD_WIDGETS)
        .filter(([id]) => !id.endsWith('_6m')) // variantes legacy: solo compatibilidad
        .map(([id, def]) => ({
          mosaico: id,
          titulo: etiqueta(id),
          modulo: def.module,
          periodos: def.periods.map(p => ETIQUETA_PERIODO[p] || p),
          visualizaciones: def.allowedChartTypes.map(c => ETIQUETA_GRAFICO[c] || c),
          requiere_indicador: !!def.requiresIndicator,
          disponible_para_el_usuario: dashboardService._widgetPermitido(id, habilitados, usuario.role),
        })),
    };
  },
};

const datosWidgetDashboard = {
  nombre: 'datos_widget_dashboard',
  descripcion: 'Valores calculados de UN mosaico configurado del usuario (identificado por `instancia`, obtenida de mi_dashboard): valor de la ventana, comparación con la ventana anterior, serie y, si es un KPI, estado y tendencia.',
  parametros: {
    type: 'object',
    properties: {
      instancia: { type: 'string', maxLength: 100, pattern: '^[A-Za-z0-9:_-]{1,100}$', description: 'Valor `instancia` del mosaico (de mi_dashboard).' },
      vista_id: PARAM_VISTA,
    },
    required: ['instancia'],
    additionalProperties: false,
  },
  requisitos: REQUISITOS,
  alcance: 'PERSONAL',
  alcancesPermitidos: TODOS_LOS_ALCANCES,
  async handler(args, ctx) {
    const config = await configuracion(ctx.usuario, args.vista_id);
    const widget = config.widgets.find(w => w.instanceId === args.instancia);
    if (!widget) {
      throw Object.assign(new Error('Ese mosaico no está configurado en tu Dashboard (o no tenés acceso a él).'), { status: 404 });
    }
    const nombres = await nombresIndicadores([widget]);
    return { mosaico: presentarWidget(widget, nombres), datos: await datosWidget(widget, ctx) };
  },
};

const resumenDashboard = {
  nombre: 'resumen_dashboard',
  descripcion: 'Resumen de los valores actuales de los mosaicos configurados del usuario (máx. 12) con alertas: qué indicadores o métricas empeoraron respecto de la ventana anterior y qué KPI están en riesgo o críticos.',
  parametros: { type: 'object', properties: { vista_id: PARAM_VISTA }, additionalProperties: false },
  requisitos: REQUISITOS,
  alcance: 'PERSONAL',
  alcancesPermitidos: TODOS_LOS_ALCANCES,
  async handler(args, ctx) {
    const config = await configuracion(ctx.usuario, args.vista_id);
    const widgets = config.widgets.slice(0, MAX_WIDGETS_RESUMEN);
    const nombres = await nombresIndicadores(widgets);
    const mosaicos = await Promise.all(widgets.map(async w => {
      const presentado = presentarWidget(w, nombres);
      return { titulo: presentado.titulo, periodo: presentado.periodo_label, ...compactar(await datosWidget(w, ctx)) };
    }));
    return {
      tablero: config.tablero,
      tiene_configuracion: config.configurado,
      mosaicos_totales: config.widgets.length,
      mosaicos_resumidos: mosaicos.length,
      mosaicos,
      empeoraron: mosaicos.filter(m => m.empeora).map(m => m.titulo),
      kpi_en_alerta: mosaicos.filter(m => m.alerta).map(m => `${m.titulo} (${m.ultimo_valido?.estado})`),
    };
  },
};

module.exports = [miDashboard, catalogoDashboard, datosWidgetDashboard, resumenDashboard];
module.exports.datosWidget = datosWidget;
module.exports.configuracion = configuracion;
module.exports.compactar = compactar;
module.exports.presentarWidget = presentarWidget;
module.exports.nombresIndicadores = nombresIndicadores;
