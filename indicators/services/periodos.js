const { rangoMes } = require('../../utils/periodo');
const { MESES_POR_FRECUENCIA, MESES_POR_VENTANA, ZONA_HORARIA } = require('../config/indicadores');

// Períodos de Indicadores. Un período es un bloque calendario alineado a la
// frecuencia: mes (2026-09), trimestre (2026-Q3), semestre (2026-S2) o año
// (2026). Los rangos son [desde, hasta) en 'YYYY-MM-DD', igual que rangoMes.

const NOMBRES_MES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

function errorPeriodo(mensaje) {
  return Object.assign(new Error(mensaje), { status: 400 });
}

// Fecha actual en America/Argentina/Buenos_Aires, independiente de la zona
// horaria del servidor. `ahora` es inyectable para tests.
function hoyArgentina(ahora = new Date()) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_HORARIA, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(ahora);
  const valor = tipo => partes.find(p => p.type === tipo).value;
  const anio = Number(valor('year'));
  const mes = Number(valor('month'));
  return { anio, mes, fecha: `${valor('year')}-${valor('month')}-${valor('day')}` };
}

function claveDe(frecuencia, anio, indice) {
  switch (frecuencia) {
    case 'MENSUAL': return `${anio}-${String(indice).padStart(2, '0')}`;
    case 'TRIMESTRAL': return `${anio}-Q${indice}`;
    case 'SEMESTRAL': return `${anio}-S${indice}`;
    case 'ANUAL': return `${anio}`;
  }
}

function labelDe(frecuencia, anio, indice) {
  switch (frecuencia) {
    case 'MENSUAL': return `${NOMBRES_MES[indice - 1]} ${anio}`;
    case 'TRIMESTRAL': return `T${indice} ${anio}`;
    case 'SEMESTRAL': return `S${indice} ${anio}`;
    case 'ANUAL': return `${anio}`;
  }
}

function construirPeriodo(frecuencia, anio, indice, hoy) {
  const meses = MESES_POR_FRECUENCIA[frecuencia];
  const mesInicio = (indice - 1) * meses + 1;
  const mesFin = mesInicio + meses - 1;
  const { desde } = rangoMes(mesInicio, anio);
  const { hasta } = rangoMes(mesFin, anio);
  return {
    clave: claveDe(frecuencia, anio, indice),
    label: labelDe(frecuencia, anio, indice),
    frecuencia,
    desde,
    hasta,
    parcial: hoy.fecha >= desde && hoy.fecha < hasta,
    anio,
    indice,
  };
}

function periodoActual(frecuencia, hoy) {
  const meses = MESES_POR_FRECUENCIA[frecuencia];
  return construirPeriodo(frecuencia, hoy.anio, Math.floor((hoy.mes - 1) / meses) + 1, hoy);
}

function periodoAnterior(periodo, hoy) {
  const porAnio = 12 / MESES_POR_FRECUENCIA[periodo.frecuencia];
  return periodo.indice === 1
    ? construirPeriodo(periodo.frecuencia, periodo.anio - 1, porAnio, hoy)
    : construirPeriodo(periodo.frecuencia, periodo.anio, periodo.indice - 1, hoy);
}

// '2026-09' | '2026-Q3' | '2026-S2' | '2026' → { frecuencia, anio, indice }.
function parsearClave(clave) {
  const texto = typeof clave === 'string' ? clave.trim().toUpperCase() : '';
  let m;
  if ((m = /^(\d{4})-(\d{2})$/.exec(texto))) {
    const mes = Number(m[2]);
    if (mes >= 1 && mes <= 12) return { frecuencia: 'MENSUAL', anio: Number(m[1]), indice: mes };
  } else if ((m = /^(\d{4})-Q([1-4])$/.exec(texto))) {
    return { frecuencia: 'TRIMESTRAL', anio: Number(m[1]), indice: Number(m[2]) };
  } else if ((m = /^(\d{4})-S([12])$/.exec(texto))) {
    return { frecuencia: 'SEMESTRAL', anio: Number(m[1]), indice: Number(m[2]) };
  } else if ((m = /^(\d{4})$/.exec(texto))) {
    return { frecuencia: 'ANUAL', anio: Number(m[1]), indice: 1 };
  }
  throw errorPeriodo(`Período inválido: "${clave}". Formatos admitidos: 2026-09 (mes), 2026-Q3 (trimestre), 2026-S2 (semestre), 2026 (año).`);
}

// Resuelve el período pedido para un indicador. Sin `clave` → período en curso
// según la frecuencia del indicador. El período pedido debe abarcar al menos la
// frecuencia del indicador (un KPI mensual puede pedirse por trimestre; uno
// trimestral no puede pedirse por mes) y no puede ser futuro.
function resolverPeriodoIndicador(clave, frecuenciaIndicador, hoy) {
  if (clave === undefined || clave === null || clave === '') {
    return periodoActual(frecuenciaIndicador, hoy);
  }
  const { frecuencia, anio, indice } = parsearClave(clave);
  if (MESES_POR_FRECUENCIA[frecuencia] < MESES_POR_FRECUENCIA[frecuenciaIndicador]) {
    throw errorPeriodo(`El indicador tiene frecuencia ${frecuenciaIndicador}: no puede consultarse para un período ${frecuencia}.`);
  }
  const periodo = construirPeriodo(frecuencia, anio, indice, hoy);
  if (periodo.desde > hoy.fecha) {
    throw errorPeriodo(`El período ${periodo.clave} todavía no comenzó.`);
  }
  return periodo;
}

// Períodos (orden cronológico) que cubre una ventana del Dashboard para la
// frecuencia del indicador, terminando en el período en curso:
// MENSUAL + 6m → 6 meses; TRIMESTRAL + 12m → 4 trimestres; ANUAL + 3m → 1 año.
function periodosDeVentana(ventana, frecuencia, hoy) {
  const mesesVentana = MESES_POR_VENTANA[ventana];
  if (!mesesVentana) {
    throw errorPeriodo(`Período inválido: "${ventana}". Opciones: ${Object.keys(MESES_POR_VENTANA).join(', ')}.`);
  }
  const cantidad = Math.max(1, Math.floor(mesesVentana / MESES_POR_FRECUENCIA[frecuencia]));
  const periodos = [periodoActual(frecuencia, hoy)];
  while (periodos.length < cantidad) periodos.unshift(periodoAnterior(periodos[0], hoy));
  return periodos;
}

module.exports = {
  hoyArgentina,
  construirPeriodo,
  periodoActual,
  parsearClave,
  resolverPeriodoIndicador,
  periodosDeVentana,
};
