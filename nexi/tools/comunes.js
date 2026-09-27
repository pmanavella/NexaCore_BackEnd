const { rangoMes, mesAnterior } = require('../../utils/periodo');

// Utilidades compartidas por las herramientas de Nexi.

// Error de dominio que se devuelve al modelo con su mensaje (parámetros
// coherentes pero inválidos: período futuro, mes sin año, etc.).
function errorHerramienta(mensaje) {
  return Object.assign(new Error(mensaje), { status: 400, herramienta: true });
}

// La herramienta no puede garantizar el alcance de los datos para este usuario.
function denegar(mensaje, motivo) {
  return Object.assign(new Error(mensaje), { denegado: true, motivo });
}

const PARAM_MES = { type: 'integer', minimum: 1, maximum: 12, description: 'Mes (1-12). Enviar junto con anio. Omitir ambos para el mes en curso.' };
const PARAM_ANIO = { type: 'integer', minimum: 2000, maximum: 2100, description: 'Año de 4 dígitos. Enviar junto con mes.' };

function claveMes(mes, anio) {
  return `${anio}-${String(mes).padStart(2, '0')}`;
}

// Resuelve { mes, anio } opcionales (ambos o ninguno) contra la fecha de
// Argentina. No admite meses futuros.
function resolverMes({ mes, anio }, hoy) {
  if ((mes === undefined) !== (anio === undefined)) {
    throw errorHerramienta('Debe indicarse "mes" y "anio" juntos, u omitir ambos para el mes en curso.');
  }
  const m = mes ?? hoy.mes;
  const a = anio ?? hoy.anio;
  const { desde, hasta } = rangoMes(m, a);
  if (desde > hoy.fecha) throw errorHerramienta(`El mes ${claveMes(m, a)} todavía no comenzó.`);
  return { mes: m, anio: a, clave: claveMes(m, a), desde, hasta, parcial: hoy.fecha >= desde && hoy.fecha < hasta };
}

// Últimos `cantidad` meses terminando en el mes en curso (orden cronológico).
function ultimosMeses(cantidad, hoy) {
  const meses = [];
  let actual = { mes: hoy.mes, anio: hoy.anio };
  for (let i = 0; i < cantidad; i++) {
    meses.unshift({ ...actual, clave: claveMes(actual.mes, actual.anio), ...rangoMes(actual.mes, actual.anio) });
    actual = mesAnterior(actual.mes, actual.anio);
  }
  return meses;
}

function sumarDias(fecha, dias) {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function redondear(valor) {
  return Math.round(Number(valor) * 100) / 100;
}

module.exports = {
  errorHerramienta, denegar, PARAM_MES, PARAM_ANIO,
  resolverMes, ultimosMeses, sumarDias, redondear, claveMes, mesAnterior, rangoMes,
};
