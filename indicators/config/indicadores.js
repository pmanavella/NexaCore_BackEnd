// Catálogos cerrados del módulo Indicadores. Deben coincidir con los CHECK de
// public.indicadores (database/migrations/2026-09-27_crear_indicadores.sql).
const PERSPECTIVAS = ['CLIENTE', 'PROCESOS_INTERNOS', 'APRENDIZAJE_CRECIMIENTO', 'FINANZAS'];
const UNIDADES = ['PORCENTAJE', 'MONEDA', 'NUMERO', 'HORAS', 'DIAS', 'CANTIDAD'];
const SENTIDOS = ['MAYOR_ES_MEJOR', 'MENOR_ES_MEJOR'];
const ESTADOS = ['EN_OBJETIVO', 'EN_RIESGO', 'CRITICO'];

// Frecuencia de medición → cantidad de meses que abarca cada período.
const MESES_POR_FRECUENCIA = {
  MENSUAL: 1,
  TRIMESTRAL: 3,
  SEMESTRAL: 6,
  ANUAL: 12,
};
const FRECUENCIAS = Object.keys(MESES_POR_FRECUENCIA);

// Ventanas del Dashboard (mismos valores que WIDGET_PERIODS) → meses que cubren.
const MESES_POR_VENTANA = {
  month: 1,
  '3m': 3,
  '6m': 6,
  '12m': 12,
};

// Zona horaria usada para resolver el "período actual" (evita que el servidor
// en UTC adelante el cambio de mes entre las 21 y las 24 h de Argentina).
const ZONA_HORARIA = 'America/Argentina/Buenos_Aires';

const MAX_NOMBRE_LENGTH = 150;
const MIN_NOMBRE_LENGTH = 2;
const MAX_RESPONSABLE_LENGTH = 150;
const MAX_DESCRIPCION_LENGTH = 1000;

module.exports = {
  PERSPECTIVAS,
  UNIDADES,
  SENTIDOS,
  ESTADOS,
  FRECUENCIAS,
  MESES_POR_FRECUENCIA,
  MESES_POR_VENTANA,
  ZONA_HORARIA,
  MAX_NOMBRE_LENGTH,
  MIN_NOMBRE_LENGTH,
  MAX_RESPONSABLE_LENGTH,
  MAX_DESCRIPCION_LENGTH,
};
