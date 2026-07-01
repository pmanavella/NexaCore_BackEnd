const { parsearFecha, mapearCategoria, parseBuffer, toNumber, toMoney, CATEGORIAS_VALIDAS } = require('./migradorUtils');

// Columnas esperadas (normalizadas): nombre, cantidad, concepto, descripcion, total, entregado
// Destino: tabla movimientos (tipo=Gasto)

function validarFila(fila, num) {
  const errores = [];
  const monto = toMoney(fila.total);
  if (monto === null)
    errores.push({ fila: num, campo: 'total', motivo: 'El campo "Total" es requerido y debe ser un número' });
  else if (monto <= 0)
    errores.push({ fila: num, campo: 'total', motivo: `El monto ${monto} debe ser mayor a 0` });

  if (!fila.nombre && !fila.descripcion && !fila.concepto)
    errores.push({ fila: num, campo: 'nombre/descripcion/concepto', motivo: 'Al menos uno de los campos Nombre, Descripción o Concepto es requerido' });

  return errores;
}

function resolverCategoria(fila) {
  const candidato = mapearCategoria(fila.concepto || fila.categoria);
  return CATEGORIAS_VALIDAS.includes(candidato) ? candidato : 'Otros';
}

function mapearFila(fila, num, fecha) {
  const descripcion = String(fila.descripcion || fila.concepto || fila.nombre || '').trim() || 'Sin descripción';
  const categoria = resolverCategoria(fila);
  const monto = toMoney(fila.total);

  const notasParts = [];
  if (fila.cantidad != null) notasParts.push(`Cantidad: ${fila.cantidad}`);
  if (fila.entregado != null) notasParts.push(`Entregado: ${fila.entregado}`);
  if (fila.nombre && fila.descripcion) notasParts.push(`Nombre original: ${fila.nombre}`);

  return {
    fecha,
    descripcion,
    categoria,
    tipo: 'Gasto',
    monto,
    notas: notasParts.length > 0 ? notasParts.join(' | ') : null,
    _fila: num,
  };
}

function procesar(buffer, { fecha_global } = {}) {
  if (!fecha_global)
    throw Object.assign(new Error('El parámetro "fecha_global" es requerido para GASTOS_HISTORICOS (formato YYYY-MM-DD)'), { status: 400 });

  const fecha = parsearFecha(fecha_global);
  if (!fecha)
    throw Object.assign(new Error(`No se pudo interpretar la fecha: "${fecha_global}". Usar formato YYYY-MM-DD o DD/MM/YYYY`), { status: 400 });

  const filas = parseBuffer(buffer);
  const errores = [];
  const registros = [];

  filas.forEach((fila, i) => {
    const num = i + 2;
    const errs = validarFila(fila, num);
    if (errs.length > 0) {
      errores.push(...errs);
    } else {
      registros.push(mapearFila(fila, num, fecha));
    }
  });

  return { filas_total: filas.length, registros, errores };
}

module.exports = { procesar };
