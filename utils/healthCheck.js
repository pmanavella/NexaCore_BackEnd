// GET /api/health · verificación real del estado del backend (plan de contingencia,
// sección 10, mejora 1; hallazgo H-37).
//
// Antes respondía "ok" aunque Supabase estuviera caído. Ahora hace una consulta
// mínima a la base (cuenta de módulos, sin traer filas) con un plazo máximo, e
// informa la versión desplegada para verificar cada instancia después de un
// despliegue. Responde 200 si la base contesta y 503 si no; nunca expone el
// mensaje técnico del error.

const { version: versionPaquete } = require('../package.json');

function conPlazo(promesa, ms) {
  let temporizador;
  const plazo = new Promise((_, rechazar) => {
    temporizador = setTimeout(() => rechazar(Object.assign(new Error('timeout'), { codigo: 'TIMEOUT' })), ms);
  });
  return Promise.race([Promise.resolve(promesa), plazo]).finally(() => clearTimeout(temporizador));
}

function crearHealthCheck({
  supabase,
  timeoutMs = Number(process.env.HEALTH_TIMEOUT_MS) || 5000,
  version = process.env.APP_VERSION || versionPaquete,
  reloj = () => Date.now(),
}) {
  return async function healthCheck(req, res) {
    const inicio = reloj();
    let db = 'ok';
    let detalle;

    try {
      const consulta = supabase.from('modulos').select('id', { head: true, count: 'exact' });
      const { error } = await conPlazo(consulta, timeoutMs);
      if (error) throw error;
    } catch (err) {
      db = 'error';
      detalle = err.codigo === 'TIMEOUT' ? 'la base de datos no respondió a tiempo' : 'no se pudo consultar la base de datos';
    }

    res.status(db === 'ok' ? 200 : 503).json({
      status: db === 'ok' ? 'ok' : 'degradado',
      app: 'NexaCore',
      version,
      db,
      ...(detalle ? { detalle } : {}),
      latencia_ms: reloj() - inicio,
      timestamp: new Date().toISOString(),
    });
  };
}

module.exports = { crearHealthCheck };
