const { parseBuffer, toNumber } = require('./migradorUtils');

// Columnas esperadas: flexible (resumen financiero)
// Destino: tabla conciliaciones_migracion (solo para auditoría — NO genera movimientos)
// Toda la planilla se guarda como JSONB para comparar contra lo importado al sistema.

function procesar(buffer, params = {}) {
  const filas = parseBuffer(buffer);

  // Intentar detectar columnas de totales conocidas para facilitar la conciliación
  const columnas_detectadas = filas.length > 0 ? Object.keys(filas[0]) : [];

  // Calcular totales numéricos detectados automáticamente
  const totales_calculados = {};
  columnas_detectadas.forEach(col => {
    const vals = filas.map(f => toNumber(f[col])).filter(v => v !== null);
    if (vals.length > 0) {
      totales_calculados[col] = vals.reduce((s, v) => s + v, 0);
    }
  });

  // Un único "registro" que contiene toda la data cruda para la tabla conciliaciones_migracion
  const registro = {
    datos_raw: filas,
    columnas_detectadas,
    totales_calculados,
    filas_count: filas.length,
    _fila: 1,
  };

  return {
    filas_total: filas.length,
    registros: [registro],
    errores: [],
  };
}

module.exports = { procesar };
