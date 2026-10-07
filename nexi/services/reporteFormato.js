// Formato de valores para reportes (es-AR). Solo presenta números ya
// calculados por el backend: nunca calcula.

const NUM = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 });
const DEC = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PCT = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function esNumero(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function moneda(v) {
  if (!esNumero(v)) return 's/d';
  return `${v < 0 ? '-' : ''}$ ${DEC.format(Math.abs(v))}`;
}

function numero(v) {
  return esNumero(v) ? NUM.format(v) : 's/d';
}

function porcentaje(v) {
  return esNumero(v) ? `${PCT.format(v)} %` : 's/d';
}

// Variación porcentual ya calculada (+12,5 % / -3,0 %); null → 's/d'.
function variacion(v) {
  if (!esNumero(v)) return 's/d';
  return `${v > 0 ? '+' : ''}${PCT.format(v)} %`;
}

function formatear(valor, formato) {
  switch (formato) {
    case 'moneda': return moneda(valor);
    case 'porcentaje': return porcentaje(valor);
    case 'variacion': return variacion(valor);
    case 'numero': return numero(valor);
    default: return valor === null || valor === undefined || valor === '' ? '-' : String(valor);
  }
}

// Valor de un KPI según su unidad (public.indicadores.unidad).
function valorIndicador(valor, unidad) {
  if (!esNumero(valor)) return 's/d';
  if (unidad === 'MONEDA') return moneda(valor);
  if (unidad === 'PORCENTAJE') return porcentaje(valor);
  return numero(valor);
}

module.exports = { moneda, numero, porcentaje, variacion, formatear, valorIndicador, esNumero };
