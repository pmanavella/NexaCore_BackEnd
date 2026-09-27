// Manejador de errores exclusivo de /api/nexi. Nunca devuelve stack traces,
// mensajes de Supabase/SQL ni respuestas del proveedor: solo errores marcados
// como públicos pasan su mensaje; el resto se registra y se responde genérico.

function nexiErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err.publico) {
    return res.status(err.status || 400).json({ error: err.message, codigo: err.codigo });
  }
  console.error('[Nexi] Error interno:', err.message);
  return res.status(500).json({
    error: 'Nexi no pudo procesar la solicitud. Intentá nuevamente.',
    codigo: 'ERROR_INTERNO',
  });
}

module.exports = nexiErrorHandler;
