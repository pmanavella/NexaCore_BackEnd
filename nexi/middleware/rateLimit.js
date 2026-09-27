const { RATE_LIMIT } = require('../config/nexi');

// Rate limit en memoria POR USUARIO (req.user.id) — usar después de authenticate.
// Ventanas deslizantes por minuto y por hora + límite de solicitudes simultáneas.
// Un usuario que agota su cupo no afecta a los demás.
// Alcance: por proceso. Con varias instancias del backend, cada una lleva su
// propio conteo (ver limitaciones en la documentación de Nexi).

const MINUTO_MS = 60 * 1000;
const HORA_MS = 60 * MINUTO_MS;

function crearLimitadorPorUsuario({
  porMinuto = RATE_LIMIT.POR_MINUTO,
  porHora = RATE_LIMIT.POR_HORA,
  concurrentes = RATE_LIMIT.CONCURRENTES,
  reloj = () => Date.now(),
} = {}) {
  // usuarioId → { marcas: number[], enCurso: number }
  const estado = new Map();

  function limpiar(registro, ahora) {
    while (registro.marcas.length && registro.marcas[0] <= ahora - HORA_MS) registro.marcas.shift();
  }

  // Limpieza periódica para no acumular usuarios inactivos.
  const intervalo = setInterval(() => {
    const ahora = reloj();
    for (const [id, registro] of estado) {
      limpiar(registro, ahora);
      if (registro.marcas.length === 0 && registro.enCurso === 0) estado.delete(id);
    }
  }, 10 * MINUTO_MS);
  intervalo.unref?.();

  function rechazar(res, segundos, mensaje) {
    res.set('Retry-After', String(Math.max(1, Math.ceil(segundos))));
    return res.status(429).json({ error: mensaje, codigo: 'RATE_LIMIT' });
  }

  function middleware(req, res, next) {
    const usuarioId = req.user?.id;
    if (!usuarioId) return res.status(401).json({ error: 'No autenticado.' });

    const ahora = reloj();
    const registro = estado.get(usuarioId) || { marcas: [], enCurso: 0 };
    estado.set(usuarioId, registro);
    limpiar(registro, ahora);

    if (registro.enCurso >= concurrentes) {
      return rechazar(res, 5, 'Nexi todavía está respondiendo tu consulta anterior. Esperá la respuesta antes de enviar otra.');
    }
    const ultimoMinuto = registro.marcas.filter(t => t > ahora - MINUTO_MS);
    if (ultimoMinuto.length >= porMinuto) {
      return rechazar(res, (ultimoMinuto[0] + MINUTO_MS - ahora) / 1000, 'Enviaste demasiadas consultas a Nexi. Esperá un momento e intentá nuevamente.');
    }
    if (registro.marcas.length >= porHora) {
      return rechazar(res, (registro.marcas[0] + HORA_MS - ahora) / 1000, 'Alcanzaste el límite de consultas a Nexi por hora. Intentá más tarde.');
    }

    registro.marcas.push(ahora);
    registro.enCurso++;
    let liberado = false;
    const liberar = () => {
      if (liberado) return;
      liberado = true;
      registro.enCurso = Math.max(0, registro.enCurso - 1);
    };
    res.on('finish', liberar);
    res.on('close', liberar);
    next();
  }

  middleware._estado = estado;
  middleware._detener = () => clearInterval(intervalo);
  return middleware;
}

module.exports = { crearLimitadorPorUsuario };
