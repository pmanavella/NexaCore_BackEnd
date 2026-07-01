const { parseBuffer, toNumber, toMoney } = require('./migradorUtils');

// Columnas esperadas: flexible (resumen financiero)
// Destino: tabla conciliaciones_migracion (solo para auditoría — NO genera movimientos)
// Toda la planilla se guarda como un único registro JSONB para conciliación.

const COLUMNAS_CONOCIDAS = [
  'total_gastos_mensuales',
  'total_sueldos',
  'total_compras_internacionales',
  'total_gastos',
  'total_pagos_clientes',
  'total_cobrables_a_polo',
  'total_neto',
];

function procesar(buffer, params = {}) {
  const filas = parseBuffer(buffer);

  const columnas_detectadas = filas.length > 0 ? Object.keys(filas[0]) : [];

  if (columnas_detectadas.length === 0)
    throw Object.assign(new Error('El archivo no contiene columnas reconocibles'), { status: 400 });

  // Sumar columnas numéricas para el resumen de conciliación
  const totales_calculados = {};
  columnas_detectadas.forEach(col => {
    const vals = filas.map(f => toNumber(f[col])).filter(v => v !== null);
    if (vals.length > 0)
      totales_calculados[col] = Math.round(vals.reduce((s, v) => s + v, 0) * 100) / 100;
  });

  const columnas_conocidas_presentes = columnas_detectadas.filter(c => COLUMNAS_CONOCIDAS.includes(c));

  // registros: un único registro JSONB para insertar en conciliaciones_migracion
  const registro = {
    datos_raw: filas,
    columnas_detectadas,
    columnas_conocidas_presentes,
    totales_calculados,
    filas_count: filas.length,
    _fila: 1,
  };

  // preview_rows: filas individuales con importes redondeados a 2 decimales
  const preview_rows = filas.map((f, i) => {
    const fila_redondeada = {};
    for (const [k, v] of Object.entries(f)) {
      const n = toMoney(v);
      fila_redondeada[k] = n !== null ? n : v;
    }
    return { _fila: i + 2, ...fila_redondeada };
  });

  return {
    filas_total: filas.length,
    registros: [registro],
    errores: [],
    preview_rows,
    columnas_detectadas,
    columnas_conocidas_presentes,
    totales_calculados,
  };
}

module.exports = { procesar };
