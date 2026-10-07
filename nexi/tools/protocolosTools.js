const protocolosService = require('../../protocolos/services/protocolosService');
const nexiDatos = require('../services/nexiDatos');
const nexiAlcance = require('../services/nexiAlcance');
const { PARAM_MES, PARAM_ANIO, resolverMes, errorHerramienta, sumarDias } = require('./comunes');

// Herramientas de Protocolos (solo lectura). Nexi actúa como interfaz sobre
// protocolosService; solo agrega lecturas por período (nexiDatos) que el
// service no ofrece.
//
// Modelo de datos real del módulo (supabase/protocolos.sql + migraciones):
//   - protocolos: nombre, descripción, categoría, acceso (texto), activo,
//     created_by/updated_by (usuario), fechas. NO existen estados "pendiente",
//     fechas de vencimiento ni un responsable asignado.
//   - protocolo_items: checklist.
//   - protocolo_pruebas (ejecuciones/registros): fecha, realizado_por (texto),
//     resultados por ítem (ok/fail/na), observaciones, resultado_texto,
//     action_items, created_by.
//
// Alcance (permiso sobre 'protocolos'):
//   global → todos; propio/equipo_directo/subarbol → solo protocolos y
//   ejecuciones registrados (created_by) por usuarios del alcance.

const CATEGORIAS = ['robot', 'instalacion', 'hardware', 'rrhh'];
const TODOS_LOS_ALCANCES = ['propio', 'equipo_directo', 'subarbol', 'global'];
const REQUISITOS = [{ modulo: 'protocolos', permiso: 'lector' }];
const PATRON_UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const PATRON_FECHA = '^\\d{4}-\\d{2}-\\d{2}$';
const MAX_MESES_RANGO = 12;

function recortar(texto, max) {
  if (typeof texto !== 'string' || !texto.trim()) return null;
  const limpio = texto.trim();
  return limpio.length > max ? `${limpio.slice(0, max)}…` : limpio;
}

// Mismo criterio que protocolosService.obtenerMetricas: un registro tiene
// incumplimientos si algún ítem quedó en 'fail'.
function resumirResultados(resultados) {
  const lista = Array.isArray(resultados) ? resultados : [];
  const contar = estado => lista.filter(r => r?.estado === estado).length;
  const fail = contar('fail');
  return { ok: contar('ok'), fail, na: contar('na'), total: lista.length, con_incumplimientos: fail > 0 };
}

function presentarEjecucion(p, { nombreProtocolo } = {}) {
  const resultado = resumirResultados(p.resultados);
  return {
    ...(nombreProtocolo ? { protocolo: nombreProtocolo } : {}),
    fecha: p.fecha,
    realizado_por: p.realizado_por || null,
    resultado,
    items_fallidos: (p.resultados || []).filter(r => r?.estado === 'fail').slice(0, 10).map(r => recortar(r.texto, 120)),
    observaciones: recortar(p.observaciones, 300),
    resultado_texto: recortar(p.resultado_texto, 300),
    action_items: (Array.isArray(p.action_items) ? p.action_items : []).slice(0, 5).map(a => recortar(a?.texto, 200)),
  };
}

// Usuarios del alcance (null = global).
async function creadoresEnAlcance(usuario, alcance) {
  return nexiAlcance.usuariosEnAlcance(usuario, alcance);
}

function fechaValida(texto) {
  const d = new Date(`${texto}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === texto;
}

// Rango [desde, hasta) a partir de mes/anio o desde/hasta (inclusive).
// Sin parámetros: mes en curso.
function resolverRango(args, hoy) {
  const conFechas = args.desde !== undefined || args.hasta !== undefined;
  const conMes = args.mes !== undefined || args.anio !== undefined;
  if (conFechas && conMes) throw errorHerramienta('Indicá mes/anio o desde/hasta, no ambos.');
  if (!conFechas) {
    const p = resolverMes(args, hoy);
    return { desde: p.desde, hasta: p.hasta, etiqueta: p.clave };
  }
  if (!args.desde || !args.hasta) throw errorHerramienta('"desde" y "hasta" deben indicarse juntos.');
  if (!fechaValida(args.desde) || !fechaValida(args.hasta)) throw errorHerramienta('Fechas inválidas.');
  if (args.desde > args.hasta) throw errorHerramienta('"desde" debe ser anterior o igual a "hasta".');
  const hasta = sumarDias(args.hasta, 1);
  const [a, m, d] = args.desde.split('-').map(Number);
  const limite = new Date(Date.UTC(a, m - 1 + MAX_MESES_RANGO, d)).toISOString().slice(0, 10);
  if (hasta > limite) throw errorHerramienta(`El rango no puede superar los ${MAX_MESES_RANGO} meses.`);
  return { desde: args.desde, hasta, etiqueta: `${args.desde} a ${args.hasta}` };
}

// Protocolos activos visibles para el alcance.
async function protocolosEnAlcance({ usuario, alcance, categoria, buscar }) {
  const { data } = await protocolosService.listarProtocolos({ categoria, search: buscar });
  const creadores = await creadoresEnAlcance(usuario, alcance);
  const visibles = creadores ? data.filter(p => creadores.includes(p.created_by)) : data;
  return { protocolos: visibles, creadores };
}

// Ejecuciones de un período (reutilizado por Reportes).
async function ejecucionesDelPeriodo({ usuario, alcance, desde, hasta, categoria, protocoloId, limite = 500 }) {
  const creadores = await creadoresEnAlcance(usuario, alcance);
  // Nombres de protocolos (incluye inactivos: una ejecución histórica puede ser
  // de un protocolo desactivado). Se resuelven con el service por id.
  const { filas, total } = await nexiDatos.pruebasProtocolos({
    desde, hasta, creadores: creadores || undefined, protocoloIds: protocoloId ? [protocoloId] : undefined, limite,
  });
  const ids = [...new Set(filas.map(f => f.protocolo_id))];
  const protocolos = new Map();
  await Promise.all(ids.map(async id => {
    try {
      const p = await protocolosService.obtenerProtocolo(id);
      protocolos.set(id, p);
    } catch { /* protocolo eliminado: se informa sin nombre */ }
  }));
  const ejecuciones = filas
    .filter(f => !categoria || protocolos.get(f.protocolo_id)?.categoria === categoria)
    .map(f => ({ fila: f, protocolo: protocolos.get(f.protocolo_id) || null }));
  return { ejecuciones, total, truncado: total > filas.length, creadores };
}

const PARAM_CATEGORIA = { type: 'string', enum: CATEGORIAS, description: 'Categoría del protocolo.' };

const listarProtocolos = {
  nombre: 'listar_protocolos',
  descripcion: 'Protocolos ACTIVOS (checklists) con categoría, acceso, descripción breve, cantidad de ejecuciones registradas y fecha de la última. Usar para obtener el id antes de pedir el detalle. El módulo no maneja estados "pendiente" ni vencimientos.',
  parametros: {
    type: 'object',
    properties: {
      categoria: PARAM_CATEGORIA,
      buscar: { type: 'string', maxLength: 60, pattern: "^[A-Za-zÀ-ÿ0-9 .,&/()'-]{2,60}$", description: 'Texto contenido en el nombre del protocolo.' },
    },
    additionalProperties: false,
  },
  requisitos: REQUISITOS,
  alcance: 'AGREGADA',
  alcancesPermitidos: TODOS_LOS_ALCANCES,
  async handler(args, { usuario, alcance }) {
    const { protocolos, creadores } = await protocolosEnAlcance({ usuario, alcance, categoria: args.categoria, buscar: args.buscar });
    const mostrados = protocolos.slice(0, 30);
    const { filas } = mostrados.length
      ? await nexiDatos.pruebasProtocolos({ protocoloIds: mostrados.map(p => p.id), creadores: creadores || undefined, limite: 1000 })
      : { filas: [] };
    return {
      alcance_aplicado: alcance,
      total: protocolos.length,
      mostrados: mostrados.length,
      protocolos: mostrados.map(p => {
        const propias = filas.filter(f => f.protocolo_id === p.id);
        return {
          id: p.id,
          nombre: p.nombre,
          categoria: p.categoria,
          acceso: p.acceso || null,
          descripcion: recortar(p.descripcion, 200),
          estado: p.activo ? 'activo' : 'inactivo',
          creado: String(p.created_at || '').slice(0, 10) || null,
          ejecuciones_registradas: propias.length,
          ultima_ejecucion: propias[0]?.fecha || null,
        };
      }),
    };
  },
};

const detalleProtocolo = {
  nombre: 'detalle_protocolo',
  descripcion: 'Detalle de un protocolo: descripción, categoría, acceso, quién lo creó, checklist de ítems y sus últimas ejecuciones (fecha, quién la realizó, resultado ok/fail/na, ítems fallidos, observaciones y action items).',
  parametros: {
    type: 'object',
    properties: {
      protocolo_id: { type: 'string', pattern: PATRON_UUID, description: 'id del protocolo (de listar_protocolos).' },
      ejecuciones: { type: 'integer', minimum: 1, maximum: 10, description: 'Cantidad de ejecuciones recientes a incluir (1-10). Por defecto 5.' },
    },
    required: ['protocolo_id'],
    additionalProperties: false,
  },
  requisitos: REQUISITOS,
  alcance: 'AGREGADA',
  alcancesPermitidos: TODOS_LOS_ALCANCES,
  async handler(args, { usuario, alcance }) {
    const protocolo = await protocolosService.obtenerProtocolo(args.protocolo_id);
    const creadores = await creadoresEnAlcance(usuario, alcance);
    if (creadores && !creadores.includes(protocolo.created_by)) {
      // Misma respuesta que un protocolo inexistente: no se revela su existencia.
      throw Object.assign(new Error('Protocolo no encontrado'), { status: 404 });
    }
    const pruebas = (await protocolosService.listarPruebas(protocolo.id))
      .filter(p => !creadores || creadores.includes(p.created_by));
    const nombres = await nexiDatos.nombresUsuarios([protocolo.created_by]);
    return {
      nombre: protocolo.nombre,
      categoria: protocolo.categoria,
      acceso: protocolo.acceso || null,
      estado: protocolo.activo ? 'activo' : 'inactivo',
      descripcion: recortar(protocolo.descripcion, 500),
      creado_por: nombres.get(protocolo.created_by) || null,
      creado: String(protocolo.created_at || '').slice(0, 10) || null,
      actualizado: String(protocolo.updated_at || '').slice(0, 10) || null,
      checklist: (protocolo.items || []).slice(0, 40).map(i => recortar(i.texto, 150)),
      ejecuciones_totales: pruebas.length,
      ultimas_ejecuciones: pruebas.slice(0, args.ejecuciones ?? 5).map(p => presentarEjecucion(p)),
    };
  },
};

const ejecucionesProtocolos = {
  nombre: 'ejecuciones_protocolos',
  descripcion: 'Ejecuciones (registros de prueba) de protocolos en un período: totales, con y sin incumplimientos, por protocolo y las más recientes con su resultado y observaciones. Sin parámetros = mes en curso. Rango máximo: 12 meses.',
  parametros: {
    type: 'object',
    properties: {
      mes: PARAM_MES,
      anio: PARAM_ANIO,
      desde: { type: 'string', pattern: PATRON_FECHA, description: 'Fecha inicial inclusive YYYY-MM-DD (usar junto con hasta).' },
      hasta: { type: 'string', pattern: PATRON_FECHA, description: 'Fecha final inclusive YYYY-MM-DD.' },
      categoria: PARAM_CATEGORIA,
      protocolo_id: { type: 'string', pattern: PATRON_UUID, description: 'Limitar a un protocolo (id de listar_protocolos).' },
      resultado: { type: 'string', enum: ['con_incumplimientos', 'sin_incumplimientos'], description: 'Filtrar por resultado.' },
    },
    additionalProperties: false,
  },
  requisitos: REQUISITOS,
  alcance: 'AGREGADA',
  alcancesPermitidos: TODOS_LOS_ALCANCES,
  async handler(args, { usuario, alcance, hoy }) {
    const rango = resolverRango(args, hoy);
    const { ejecuciones, total, truncado } = await ejecucionesDelPeriodo({
      usuario, alcance, desde: rango.desde, hasta: rango.hasta, categoria: args.categoria, protocoloId: args.protocolo_id,
    });
    const filtradas = ejecuciones.filter(({ fila }) => {
      if (!args.resultado) return true;
      const conFallas = resumirResultados(fila.resultados).con_incumplimientos;
      return args.resultado === 'con_incumplimientos' ? conFallas : !conFallas;
    });
    const porProtocolo = {};
    for (const { fila, protocolo } of filtradas) {
      const nombre = protocolo?.nombre || 'Protocolo eliminado';
      porProtocolo[nombre] ||= { ejecuciones: 0, con_incumplimientos: 0 };
      porProtocolo[nombre].ejecuciones++;
      if (resumirResultados(fila.resultados).con_incumplimientos) porProtocolo[nombre].con_incumplimientos++;
    }
    const conIncumplimientos = filtradas.filter(({ fila }) => resumirResultados(fila.resultados).con_incumplimientos).length;
    return {
      periodo: rango.etiqueta,
      datos_hasta: rango.hasta > hoy.fecha ? hoy.fecha : null,
      alcance_aplicado: alcance,
      total_ejecuciones: filtradas.length,
      con_incumplimientos: conIncumplimientos,
      sin_incumplimientos: filtradas.length - conIncumplimientos,
      resultados_parciales: truncado ? `Se analizaron las ${ejecuciones.length} más recientes de ${total}.` : null,
      por_protocolo: porProtocolo,
      recientes: filtradas.slice(0, 15).map(({ fila, protocolo }) => presentarEjecucion(fila, { nombreProtocolo: protocolo?.nombre || 'Protocolo eliminado' })),
    };
  },
};

const resumenProtocolos = {
  nombre: 'resumen_protocolos',
  descripcion: 'Resumen general del módulo Protocolos: protocolos activos por categoría y totales históricos de ejecuciones con y sin incumplimientos.',
  parametros: { type: 'object', properties: {}, additionalProperties: false },
  requisitos: REQUISITOS,
  alcance: 'AGREGADA',
  alcancesPermitidos: TODOS_LOS_ALCANCES,
  async handler(args, { usuario, alcance }) {
    const { protocolos, creadores } = await protocolosEnAlcance({ usuario, alcance });
    const porCategoria = Object.fromEntries(CATEGORIAS.map(c => [c, protocolos.filter(p => p.categoria === c).length]));
    let metricas;
    if (!creadores) {
      // Global: métricas del propio módulo (protocolosService.obtenerMetricas).
      const m = await protocolosService.obtenerMetricas();
      metricas = { total: m.totalPruebas, sin_incumplimientos: m.pruebasSinIncumplimientos, con_incumplimientos: m.pruebasConIncumplimientos };
    } else {
      const { filas, total } = await nexiDatos.pruebasProtocolos({ creadores, limite: 1000 });
      const con = filas.filter(f => resumirResultados(f.resultados).con_incumplimientos).length;
      metricas = { total, sin_incumplimientos: filas.length - con, con_incumplimientos: con };
    }
    return {
      alcance_aplicado: alcance,
      protocolos_activos: protocolos.length,
      por_categoria: porCategoria,
      ejecuciones_historicas: metricas,
      nota: 'El módulo no registra estados "pendiente" ni fechas de vencimiento de protocolos.',
    };
  },
};

module.exports = [listarProtocolos, detalleProtocolo, ejecucionesProtocolos, resumenProtocolos];
module.exports.ejecucionesDelPeriodo = ejecucionesDelPeriodo;
module.exports.protocolosEnAlcance = protocolosEnAlcance;
module.exports.resumirResultados = resumirResultados;
module.exports.presentarEjecucion = presentarEjecucion;
module.exports.CATEGORIAS = CATEGORIAS;
