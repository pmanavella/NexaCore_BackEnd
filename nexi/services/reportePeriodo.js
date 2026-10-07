const { parsearClave, construirPeriodo } = require('../../indicators/services/periodos');
const { LIMITES_REPORTES } = require('../config/reportes');

// Período de un reporte. Reutiliza los períodos calendario de Indicadores
// (2026-09 mes, 2026-Q3 trimestre, 2026-S2 semestre, 2026 año) y admite
// rangos personalizados (desde/hasta inclusive). Siempre se trabaja con
// [desde, hasta) en 'YYYY-MM-DD'.
//
// Reglas: el período es obligatorio (nunca "sin rango"), no puede empezar en el
// futuro y no puede superar LIMITES_REPORTES.MAX_MESES meses.

function errorPeriodo(mensaje) {
  return Object.assign(new Error(mensaje), { status: 400, herramienta: true });
}

function fechaValida(texto) {
  if (typeof texto !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
  const d = new Date(`${texto}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === texto;
}

function sumarDias(fecha, dias) {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function sumarMeses(fecha, meses) {
  const [a, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1 + meses, d)).toISOString().slice(0, 10);
}

// Meses calendario entre dos primeros de mes (YYYY-MM-01).
function mesesEntre(desde, hasta) {
  const [a1, m1] = desde.split('-').map(Number);
  const [a2, m2] = hasta.split('-').map(Number);
  return (a2 - a1) * 12 + (m2 - m1);
}

// Resta meses recortando el día al fin de mes (31/03 − 1 mes → 28/02).
function restarMeses(fecha, meses) {
  const [a, m, d] = fecha.split('-').map(Number);
  const base = new Date(Date.UTC(a, m - 1 - meses, 1));
  const ultimoDia = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d, ultimoDia));
  return base.toISOString().slice(0, 10);
}

function diasEntre(desde, hasta) {
  return Math.round((new Date(`${hasta}T00:00:00Z`) - new Date(`${desde}T00:00:00Z`)) / 86400000);
}

function formatoFecha(fecha) {
  const [a, m, d] = fecha.split('-');
  return `${d}/${m}/${a}`;
}

// Meses calendario (recortados al rango) que cubre [desde, hasta).
function mesesDelRango(desde, hasta) {
  const meses = [];
  let [anio, mes] = desde.split('-').map(Number);
  for (;;) {
    const inicioMes = `${anio}-${String(mes).padStart(2, '0')}-01`;
    if (inicioMes >= hasta) break;
    const siguiente = mes === 12 ? `${anio + 1}-01-01` : `${anio}-${String(mes + 1).padStart(2, '0')}-01`;
    meses.push({
      clave: inicioMes.slice(0, 7),
      desde: inicioMes < desde ? desde : inicioMes,
      hasta: siguiente > hasta ? hasta : siguiente,
    });
    if (mes === 12) { mes = 1; anio += 1; } else { mes += 1; }
  }
  return meses;
}

function completar({ desde, hasta, etiqueta, clave = null }, hoy) {
  return {
    desde,
    hasta,
    etiqueta,
    clave,
    meses: mesesDelRango(desde, hasta),
    en_curso: hoy.fecha >= desde && hoy.fecha < hasta,
    // Último día con datos posibles (hoy si el período sigue en curso).
    datos_hasta: hasta > hoy.fecha ? hoy.fecha : sumarDias(hasta, -1),
  };
}

function desdeClave(clave, hoy) {
  let partes;
  try {
    partes = parsearClave(clave);
  } catch (err) {
    throw errorPeriodo(err.message);
  }
  const p = construirPeriodo(partes.frecuencia, partes.anio, partes.indice, hoy);
  return { desde: p.desde, hasta: p.hasta, etiqueta: p.label, clave: p.clave, frecuencia: p.frecuencia, anio: p.anio, indice: p.indice };
}

function validarNoFuturo(p, hoy) {
  if (p.desde > hoy.fecha) throw errorPeriodo(`El período ${p.etiqueta} todavía no comenzó.`);
}

function validarLargo(desde, hasta) {
  if (hasta > sumarMeses(desde, LIMITES_REPORTES.MAX_MESES)) {
    throw errorPeriodo(`El período de un reporte no puede superar los ${LIMITES_REPORTES.MAX_MESES} meses. Dividilo en reportes más cortos.`);
  }
}

// Período anterior equivalente: misma unidad calendario si viene de una clave;
// mismo largo en días si es un rango personalizado.
function anterior(base, hoy) {
  if (base.frecuencia) {
    const porAnio = { MENSUAL: 12, TRIMESTRAL: 4, SEMESTRAL: 2, ANUAL: 1 }[base.frecuencia];
    const [anio, indice] = base.indice === 1 ? [base.anio - 1, porAnio] : [base.anio, base.indice - 1];
    const p = construirPeriodo(base.frecuencia, anio, indice, hoy);
    return { desde: p.desde, hasta: p.hasta, etiqueta: p.label, clave: p.clave };
  }
  const largo = diasEntre(base.desde, base.hasta);
  const desde = sumarDias(base.desde, -largo);
  return { desde, hasta: base.desde, etiqueta: `${formatoFecha(desde)} al ${formatoFecha(sumarDias(base.desde, -1))}` };
}

// args: { periodo?, desde?, hasta?, comparar_con? } — ya validados por esquema.
function resolverPeriodoReporte(args, hoy) {
  const conClave = args.periodo !== undefined;
  const conRango = args.desde !== undefined || args.hasta !== undefined;
  if (conClave && conRango) throw errorPeriodo('Indicá el período con "periodo" o con "desde"/"hasta", no ambos.');
  if (!conClave && !conRango) {
    throw errorPeriodo('Falta el período del reporte: indicá un mes, trimestre, semestre, año o un rango de fechas.');
  }

  let base;
  if (conClave) {
    base = desdeClave(args.periodo, hoy);
  } else {
    if (!args.desde || !args.hasta) throw errorPeriodo('"desde" y "hasta" deben indicarse juntos.');
    if (!fechaValida(args.desde) || !fechaValida(args.hasta)) throw errorPeriodo('Las fechas del período no son válidas (formato YYYY-MM-DD).');
    if (args.desde > args.hasta) throw errorPeriodo('"desde" debe ser anterior o igual a "hasta".');
    base = { desde: args.desde, hasta: sumarDias(args.hasta, 1), etiqueta: `${formatoFecha(args.desde)} al ${formatoFecha(args.hasta)}` };
  }
  validarNoFuturo(base, hoy);
  validarLargo(base.desde, base.hasta);

  const comparar = args.comparar_con ?? 'anterior';
  let comparacion = null;
  if (comparar === 'anterior') {
    comparacion = anterior(base, hoy);
    // Período en curso: se compara el tramo transcurrido contra el MISMO tramo
    // del período anterior (ej. 1-7 de octubre contra 1-7 de septiembre), no
    // contra el período anterior completo.
    const manana = sumarDias(hoy.fecha, 1);
    if (base.desde <= hoy.fecha && manana < base.hasta) {
      // Períodos calendario: mismo desplazamiento en meses (1/1-7/4 frente a
      // 1/7-7/10). Rangos personalizados: misma cantidad de días.
      const hasta = base.frecuencia
        ? restarMeses(manana, mesesEntre(comparacion.desde, base.desde))
        : sumarDias(comparacion.desde, diasEntre(base.desde, manana));
      if (hasta < comparacion.hasta) {
        comparacion = {
          desde: comparacion.desde,
          hasta,
          etiqueta: `${comparacion.etiqueta} (mismo tramo: ${formatoFecha(comparacion.desde)} al ${formatoFecha(sumarDias(hasta, -1))})`,
        };
      }
    }
  } else if (comparar !== 'ninguno') {
    comparacion = desdeClave(comparar, hoy);
    validarNoFuturo(comparacion, hoy);
    validarLargo(comparacion.desde, comparacion.hasta);
  }

  return {
    ...completar(base, hoy),
    comparacion: comparacion ? completar(comparacion, hoy) : null,
  };
}

module.exports = { resolverPeriodoReporte, mesesDelRango, formatoFecha, PATRON_CLAVE: '^\\d{4}(-(0[1-9]|1[0-2]|Q[1-4]|S[12]))?$' };
