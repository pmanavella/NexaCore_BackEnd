// RN-01 — Interpretación de montos en importaciones (docs/convencion-identificadores.md, sección 6).
// Devuelve el monto redondeado a 2 decimales, o null si no se puede interpretar.
// El rechazo de montos en 0 o negativos queda a cargo de quien valida la fila.
function parsearMonto(val) {
  if (val === null || val === undefined) return null;

  // Las celdas que Excel entrega como número se toman tal cual
  if (typeof val === 'number') return Number.isFinite(val) ? redondear(val) : null;
  if (typeof val !== 'string') return null;

  let s = val.replace(/\$/g, '').replace(/ARS/gi, '').replace(/\s/g, '');
  let signo = 1;
  if (s.startsWith('-')) { signo = -1; s = s.slice(1); }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  const comas = (s.match(/,/g) || []).length;
  const puntos = (s.match(/\./g) || []).length;
  let normalizado;

  if (comas > 0 && puntos > 0) {
    // El último separador que aparece es el decimal; el otro, de miles
    const decimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    const miles = decimal === ',' ? '.' : ',';
    if ((decimal === ',' ? comas : puntos) > 1) return null;
    normalizado = s.split(miles).join('').replace(decimal, '.');
  } else if (comas > 0) {
    // Solo una coma: decimal. Más de una coma y ningún punto: inválido
    if (comas > 1) return null;
    normalizado = s.replace(',', '.');
  } else if (puntos > 0) {
    const [entera, ...grupos] = s.split('.');
    const sonMiles = grupos.every(g => /^\d{3}$/.test(g)) && /^\d+$/.test(entera) && Number(entera) !== 0;
    if (sonMiles) normalizado = s.split('.').join('');
    else if (puntos === 1) normalizado = s;
    else return null;
  } else {
    normalizado = s;
  }

  const n = Number(normalizado);
  return Number.isFinite(n) ? redondear(signo * n) : null;
}

function redondear(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { parsearMonto };
