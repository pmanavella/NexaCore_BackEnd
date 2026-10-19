// Interpretación de fechas de planillas (importación por Excel/CSV y migración).
// Fuente única: antes la misma función estaba copiada en excelService.js y en
// migradores/migradorUtils.js (hallazgo H-02, mejora 6.4).
function parsearFecha(valor) {
  if (!valor) return null;
  if (typeof valor === 'number') {
    const date = new Date((valor - 25569) * 86400 * 1000);
    return date.toISOString().split('T')[0];
  }
  const str = String(valor).trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
    const [d, m, y] = str.split('/');
    return `${y}-${m}-${d}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().split('T')[0];
  return null;
}

module.exports = { parsearFecha };
