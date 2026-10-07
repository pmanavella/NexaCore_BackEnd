const nexiDatos = require('../services/nexiDatos');
const suscripcionesService = require('../../finance/services/suscripcionesService');
const { TIPOS_VALIDOS, CATEGORIAS_VALIDAS } = require('../../finance/config/movimientos');
const {
  PARAM_MES, PARAM_ANIO, resolverMes, ultimosMeses, sumarDias, redondear, claveMes, mesAnterior, rangoMes,
  errorHerramienta,
} = require('./comunes');

// Herramientas de Finanzas. Solo agregados de public.movimientos (vía la RPC
// de solo lectura) y listados acotados de vencimientos sin texto libre.
// Excluye: movimientos individuales, comprobantes, salarios y movimientos_salario.

const MAX_VENCIMIENTOS = 10;

function totalesDelRango(filas, desde, hasta) {
  const resultado = { ingresos: 0, gastos: 0, ingresosPorCategoria: {}, gastosPorCategoria: {} };
  for (const fila of filas) {
    const mes = String(fila.mes).slice(0, 10);
    if (mes < desde || mes >= hasta) continue;
    const total = Number(fila.total) || 0;
    const porCategoria = fila.tipo === 'Ingreso' ? resultado.ingresosPorCategoria : resultado.gastosPorCategoria;
    if (fila.tipo === 'Ingreso') resultado.ingresos += total;
    else if (fila.tipo === 'Gasto') resultado.gastos += total;
    else continue;
    porCategoria[fila.categoria] = (porCategoria[fila.categoria] || 0) + total;
  }
  return resultado;
}

function aLista(mapa) {
  return Object.entries(mapa)
    .map(([categoria, total]) => ({ categoria, total: redondear(total) }))
    .sort((a, b) => b.total - a.total);
}

// Variación porcentual respecto del valor anterior. Se divide por el valor
// absoluto para que el signo indique siempre si el valor subió o bajó (un
// balance que pasa de -100 a 50 "sube" +150 %, no -150 %).
function variacionPct(actual, anterior) {
  if (!anterior) return null;
  return redondear((actual - anterior) / Math.abs(anterior) * 100);
}

const resumenFinanzas = {
  nombre: 'resumen_finanzas',
  descripcion: 'Totales agregados de Finanzas para un mes: ingresos, gastos, balance, desglose por categoría y variación contra el mes anterior. Sin parámetros = mes en curso.',
  parametros: {
    type: 'object',
    properties: { mes: PARAM_MES, anio: PARAM_ANIO },
    additionalProperties: false,
  },
  requisitos: [{ modulo: 'finance', permiso: 'lector' }],
  alcance: 'AGREGADA',
  async handler(args, { hoy }) {
    const periodo = resolverMes(args, hoy);
    const anterior = mesAnterior(periodo.mes, periodo.anio);
    const rangoAnterior = rangoMes(anterior.mes, anterior.anio);

    const [filas, comprobantesEnRevision] = await Promise.all([
      nexiDatos.totalesMovimientos(rangoAnterior.desde, periodo.hasta),
      nexiDatos.contarComprobantesEnRevision(),
    ]);
    const actual = totalesDelRango(filas, periodo.desde, periodo.hasta);
    const previo = totalesDelRango(filas, rangoAnterior.desde, rangoAnterior.hasta);

    return {
      periodo: { clave: periodo.clave, desde: periodo.desde, hasta_exclusivo: periodo.hasta, en_curso: periodo.parcial },
      ingresos: redondear(actual.ingresos),
      gastos: redondear(actual.gastos),
      balance: redondear(actual.ingresos - actual.gastos),
      ingresos_por_categoria: aLista(actual.ingresosPorCategoria),
      gastos_por_categoria: aLista(actual.gastosPorCategoria),
      mes_anterior: {
        clave: claveMes(anterior.mes, anterior.anio),
        ingresos: redondear(previo.ingresos),
        gastos: redondear(previo.gastos),
        balance: redondear(previo.ingresos - previo.gastos),
      },
      variacion_pct_ingresos: variacionPct(actual.ingresos, previo.ingresos),
      variacion_pct_gastos: variacionPct(actual.gastos, previo.gastos),
      comprobantes_en_revision: comprobantesEnRevision,
    };
  },
};

const flujoFinanciero = {
  nombre: 'flujo_financiero',
  descripcion: 'Evolución mensual de ingresos, gastos y balance de los últimos N meses (incluye el mes en curso).',
  parametros: {
    type: 'object',
    properties: {
      meses: { type: 'integer', minimum: 1, maximum: 12, description: 'Cantidad de meses (1-12). Por defecto 6.' },
    },
    additionalProperties: false,
  },
  requisitos: [{ modulo: 'finance', permiso: 'lector' }],
  alcance: 'AGREGADA',
  async handler(args, { hoy }) {
    const meses = ultimosMeses(args.meses ?? 6, hoy);
    const filas = await nexiDatos.totalesMovimientos(meses[0].desde, meses[meses.length - 1].hasta);
    return {
      meses: meses.map(m => {
        const t = totalesDelRango(filas, m.desde, m.hasta);
        return {
          mes: m.clave,
          ingresos: redondear(t.ingresos),
          gastos: redondear(t.gastos),
          balance: redondear(t.ingresos - t.gastos),
          en_curso: m.clave === claveMes(hoy.mes, hoy.anio),
        };
      }),
    };
  },
};

const proximosVencimientos = {
  nombre: 'proximos_vencimientos',
  descripcion: 'Deudas no pagadas (incluidas las ya vencidas) y suscripciones activas que vencen dentro de los próximos N días. Devuelve como máximo 10 de cada tipo más los totales.',
  parametros: {
    type: 'object',
    properties: {
      dias: { type: 'integer', minimum: 1, maximum: 60, description: 'Ventana en días desde hoy (1-60). Por defecto 15.' },
    },
    additionalProperties: false,
  },
  requisitos: [{ modulo: 'finance', permiso: 'lector' }],
  alcance: 'AGREGADA',
  async handler(args, { hoy }) {
    const dias = args.dias ?? 15;
    const hasta = sumarDias(hoy.fecha, dias);
    const [deudas, suscripciones] = await Promise.all([
      nexiDatos.deudasPorVencer(hasta, MAX_VENCIMIENTOS),
      suscripcionesService.proximasVencer(dias),
    ]);

    return {
      hoy: hoy.fecha,
      hasta,
      deudas: {
        total: deudas.total,
        mostradas: deudas.filas.length,
        items: deudas.filas.map(d => ({
          acreedor: d.acreedor,
          monto: redondear(d.monto),
          vencimiento: d.vencimiento,
          vencida: d.vencimiento < hoy.fecha,
        })),
      },
      suscripciones: {
        total: suscripciones.length,
        mostradas: Math.min(suscripciones.length, MAX_VENCIMIENTOS),
        items: suscripciones.slice(0, MAX_VENCIMIENTOS).map(s => ({
          nombre: s.nombre,
          proveedor: s.proveedor || null,
          monto: redondear(s.monto),
          moneda: s.moneda,
          vencimiento: s.proxima_fecha_vencimiento,
          dias_restantes: s.dias_restantes,
        })),
      },
    };
  },
};

// Rango máximo de total_movimientos_periodo, en meses calendario.
const MAX_MESES_RANGO = 24;
const PATRON_FECHA = '^\\d{4}-\\d{2}-\\d{2}$';

// 'YYYY-MM-DD' que además sea una fecha real (rechaza 2026-02-30).
function fechaValida(texto) {
  const d = new Date(`${texto}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === texto;
}

function sumarMeses(fecha, meses) {
  const [anio, mes, dia] = fecha.split('-').map(Number);
  const d = new Date(Date.UTC(anio, mes - 1 + meses, dia));
  return d.toISOString().slice(0, 10);
}

const totalMovimientosPeriodo = {
  nombre: 'total_movimientos_periodo',
  descripcion: 'Total de ingresos o de gastos en un rango de fechas arbitrario (hasta 24 meses), opcionalmente de una sola categoría, resuelto en UNA llamada. '
    + 'Preferir SIEMPRE esta herramienta frente a resumen_finanzas cuando la pregunta pide un año, un semestre, un trimestre, varios meses, '
    + '"los últimos N meses", un rango de fechas o el total de una categoría en un período amplio: no llamar resumen_finanzas mes por mes. '
    + 'Para comparar dos períodos, llamarla una vez por período. Incluye el desglose mensual del rango. '
    + 'total = 0 significa que no se registraron movimientos de ese tipo/categoría en el período.',
  parametros: {
    type: 'object',
    properties: {
      tipo: { type: 'string', enum: TIPOS_VALIDOS, description: 'Ingreso o Gasto.' },
      categoria: { type: 'string', enum: CATEGORIAS_VALIDAS, description: 'Categoría de Finanzas. Omitir para el total de todas las categorías.' },
      desde: { type: 'string', pattern: PATRON_FECHA, description: 'Fecha inicial inclusive, YYYY-MM-DD (ej. 2026-01-01).' },
      hasta: { type: 'string', pattern: PATRON_FECHA, description: 'Fecha final inclusive, YYYY-MM-DD (ej. 2026-12-31).' },
    },
    required: ['tipo', 'desde', 'hasta'],
    additionalProperties: false,
  },
  requisitos: [{ modulo: 'finance', permiso: 'lector' }],
  alcance: 'AGREGADA',
  async handler(args, { hoy }) {
    const { tipo, categoria = null, desde, hasta } = args;
    if (!fechaValida(desde)) throw errorHerramienta(`"desde" no es una fecha válida: ${desde}.`);
    if (!fechaValida(hasta)) throw errorHerramienta(`"hasta" no es una fecha válida: ${hasta}.`);
    if (desde > hasta) throw errorHerramienta('"desde" debe ser anterior o igual a "hasta".');

    // La RPC trabaja con [p_desde, p_hasta): se pasa el día siguiente a `hasta`.
    const hastaExclusivo = sumarDias(hasta, 1);
    if (hastaExclusivo > sumarMeses(desde, MAX_MESES_RANGO)) {
      throw errorHerramienta(`El rango no puede superar los ${MAX_MESES_RANGO} meses. Dividí la consulta en períodos más cortos.`);
    }

    // La RPC ya filtra por fecha exacta y agrupa por (mes, tipo, categoria):
    // solo se suman las filas agregadas que corresponden al tipo/categoría.
    const filas = await nexiDatos.totalesMovimientos(desde, hastaExclusivo);
    const porMes = new Map();
    let total = 0;
    for (const fila of filas) {
      if (fila.tipo !== tipo) continue;
      if (categoria && fila.categoria !== categoria) continue;
      const monto = Number(fila.total) || 0;
      const mes = String(fila.mes).slice(0, 7);
      total += monto;
      porMes.set(mes, (porMes.get(mes) || 0) + monto);
    }

    return {
      tipo,
      categoria,
      desde,
      hasta,
      total: redondear(total),
      sin_movimientos: total === 0,
      incluye_fechas_futuras: hasta > hoy.fecha,
      datos_hasta: hasta > hoy.fecha ? hoy.fecha : hasta,
      por_mes: [...porMes.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([mes, t]) => ({ mes, total: redondear(t) })),
    };
  },
};

// Totales de un conjunto de meses consecutivos [{ clave, desde, hasta }] en UNA
// consulta agregada: por mes y para todo el bloque (con desglose por categoría).
// Reutilizado por Dashboard y Reportes para no duplicar el cálculo.
async function totalesDeMeses(meses) {
  const filas = await nexiDatos.totalesMovimientos(meses[0].desde, meses[meses.length - 1].hasta);
  const porMes = meses.map(m => {
    const t = totalesDelRango(filas, m.desde, m.hasta);
    return { mes: m.clave, ingresos: redondear(t.ingresos), gastos: redondear(t.gastos), balance: redondear(t.ingresos - t.gastos) };
  });
  const total = totalesDelRango(filas, meses[0].desde, meses[meses.length - 1].hasta);
  return {
    porMes,
    ingresos: redondear(total.ingresos),
    gastos: redondear(total.gastos),
    balance: redondear(total.ingresos - total.gastos),
    ingresosPorCategoria: aLista(total.ingresosPorCategoria),
    gastosPorCategoria: aLista(total.gastosPorCategoria),
  };
}

module.exports = [resumenFinanzas, flujoFinanciero, proximosVencimientos, totalMovimientosPeriodo];
module.exports.totalesDeMeses = totalesDeMeses;
module.exports.variacionPct = variacionPct;
module.exports.totalesDelRango = totalesDelRango;
module.exports.aLista = aLista;
module.exports.MAX_VENCIMIENTOS = MAX_VENCIMIENTOS;
