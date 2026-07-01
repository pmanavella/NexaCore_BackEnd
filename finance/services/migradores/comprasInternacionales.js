const { parsearFecha, mapearCategoria, parseBuffer, toNumber, toMoney } = require('./migradorUtils');

// Columnas esperadas (normalizadas): nombre, cantidad, concepto, total_usd, total_pesos, usd_fecha
// Destino: tabla inversiones_historicas

function resolverMontoUsd(fila) {
  // Cubre: total_usd, monto_usd, usd (ej: encabezado solo "USD")
  return toMoney(fila.total_usd ?? fila.monto_usd ?? fila.usd ?? null);
}

function resolverMontoPesos(fila) {
  return toMoney(fila.total_pesos ?? fila.monto_pesos ?? fila.pesos ?? null);
}

function validarFila(fila, num) {
  const errores = [];

  if (!fila.nombre && !fila.concepto)
    errores.push({ fila: num, campo: 'nombre', motivo: 'Al menos "Nombre" o "Concepto" es requerido' });

  const monto_usd = resolverMontoUsd(fila);
  const monto_pesos = resolverMontoPesos(fila);
  if (monto_usd === null && monto_pesos === null)
    errores.push({ fila: num, campo: 'total_usd / total_pesos', motivo: 'Se requiere al menos un monto (Total USD o Total Pesos)' });

  return errores;
}

function mapearFila(fila, num) {
  const monto_usd = resolverMontoUsd(fila);
  const monto_pesos = resolverMontoPesos(fila);

  let cotizacion_utilizada = null;
  if (monto_usd && monto_usd > 0 && monto_pesos && monto_pesos > 0) {
    cotizacion_utilizada = Math.round((monto_pesos / monto_usd) * 100) / 100;
  }

  const fecha_compra = parsearFecha(fila.usd_fecha || fila.fecha_compra || fila.fecha);

  return {
    nombre: String(fila.nombre || fila.concepto || '').trim(),
    cantidad: toNumber(fila.cantidad),
    categoria: mapearCategoria(fila.concepto || fila.categoria),
    monto_usd,
    monto_pesos,
    cotizacion_utilizada,
    fecha_compra,
    notas: fila.concepto && fila.nombre ? String(fila.concepto).trim() : null,
    _fila: num,
  };
}

function procesar(buffer, params = {}) {
  const filas = parseBuffer(buffer);
  const errores = [];
  const registros = [];

  filas.forEach((fila, i) => {
    const num = i + 2;
    const errs = validarFila(fila, num);
    if (errs.length > 0) {
      errores.push(...errs);
    } else {
      registros.push(mapearFila(fila, num));
    }
  });

  return { filas_total: filas.length, registros, errores };
}

module.exports = { procesar };
