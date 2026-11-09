function errorHandler(err, req, res, next) {
  console.error('Error:', err.message);
  const body = { error: err.message || 'Error interno del servidor' };
  // `codigo` (opcional, aditivo): identificador estable que solo agregan los
  // servicios que lo definen explícitamente (Actualizaciones del Operativo y
  // notificaciones). Sin él, la respuesta queda igual que antes.
  if (typeof err.codigo === 'string' && err.codigo) body.codigo = err.codigo;
  res.status(err.status || 500).json(body);
}

module.exports = errorHandler;
