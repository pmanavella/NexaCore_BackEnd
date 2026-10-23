// Interpretación de fechas de planillas (importación por Excel/CSV y migración).
// Fuente única: antes la misma función estaba copiada en excelService.js y en
// migradores/migradorUtils.js (hallazgo H-02, mejora 6.4).

// Devuelve la fecha en AAAA-MM-DD solo si existe en el calendario
// (DEF-015, H-14: antes se aceptaban fechas como 2026-02-31).
function fechaISOSiExiste(y, m, d) {
  const anio = Number(y), mes = Number(m), dia = Number(d);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  const existe = fecha.getUTCFullYear() === anio
    && fecha.getUTCMonth() === mes - 1
    && fecha.getUTCDate() === dia;
  return existe ? `${y}-${m}-${d}` : null;
}

function parsearFecha(valor) {
  if (!valor) return null;
  if (typeof valor === 'number') {
    const date = new Date((valor - 25569) * 86400 * 1000);
    return date.toISOString().split('T')[0];
  }
  const str = String(valor).trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
    const [d, m, y] = str.split('/');
    return fechaISOSiExiste(y, m, d);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split('-');
    return fechaISOSiExiste(y, m, d);
  }
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().split('T')[0];
  return null;
}

module.exports = { parsearFecha };