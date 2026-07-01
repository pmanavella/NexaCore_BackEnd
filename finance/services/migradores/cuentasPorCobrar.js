const { parseBuffer, toNumber, toMoney } = require('./migradorUtils');

// Columnas esperadas (normalizadas): nombre, cantidad, costo_total, concepto
// Destino: tabla cuentas_por_cobrar (pendientes de cobro — NO ingresos realizados)

function validarFila(fila, num) {
  const errores = [];

  if (!fila.nombre || String(fila.nombre).trim() === '')
    errores.push({ fila: num, campo: 'nombre', motivo: 'El nombre del cliente es requerido' });

  const monto = toMoney(fila.costo_total);
  if (monto === null)
    errores.push({ fila: num, campo: 'costo_total', motivo: 'El campo "Costo Total" es requerido y debe ser un número' });
  else if (monto <= 0)
    errores.push({ fila: num, campo: 'costo_total', motivo: `El monto ${monto} debe ser mayor a 0` });

  return errores;
}

function mapearFila(fila, num) {
  return {
    nombre_cliente: String(fila.nombre || '').trim(),
    cantidad: toNumber(fila.cantidad),
    concepto: fila.concepto ? String(fila.concepto).trim() : null,
    monto_total: toMoney(fila.costo_total),
    estado: 'pendiente',
    origen_migracion: 'excel',
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
