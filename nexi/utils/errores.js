// Errores de Nexi. Solo los errores marcados como `publico` llegan con su
// mensaje al frontend; cualquier otro se responde con un mensaje genérico
// (ver nexi/middleware/nexiErrorHandler.js).

function errorPublico(status, mensaje, codigo) {
  return Object.assign(new Error(mensaje), { status, codigo, publico: true });
}

// Error del proveedor de IA. `detalle` es solo para el log interno.
function errorProveedor(codigo, detalle) {
  return Object.assign(new Error(detalle || codigo), { codigo, proveedor: true });
}

module.exports = { errorPublico, errorProveedor };
