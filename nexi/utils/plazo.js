const { errorPublico } = require('./errores');

// Plazo global de una consulta a Nexi (POST /api/nexi/chat). Se crea una vez
// por mensaje y se consulta antes de cada llamada al modelo o herramienta.
// `carrera` acota además cualquier promesa en curso: si el plazo vence, la
// consulta termina aunque la operación subyacente siga ejecutándose (su propia
// auditoría se registra igual cuando finalice).

const MENSAJE_TIMEOUT = 'Nexi superó el tiempo máximo para responder esta consulta. Probá con una pregunta más acotada.';

function errorTimeoutGlobal() {
  return errorPublico(504, MENSAJE_TIMEOUT, 'NEXI_TIMEOUT');
}

function crearPlazo(totalMs, reloj = () => Date.now()) {
  const venceEn = reloj() + totalMs;
  const plazo = {
    venceEn,
    restante: () => Math.max(0, venceEn - reloj()),
    vencido: () => reloj() >= venceEn,
    verificar() {
      if (plazo.vencido()) throw errorTimeoutGlobal();
    },
    async carrera(promesa) {
      plazo.verificar();
      let timer;
      const limite = new Promise((_, reject) => {
        // Sin unref(): el timer siempre se limpia en `finally`.
        timer = setTimeout(() => reject(errorTimeoutGlobal()), plazo.restante());
      });
      try {
        return await Promise.race([promesa, limite]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
  return plazo;
}

module.exports = { crearPlazo, errorTimeoutGlobal, MENSAJE_TIMEOUT };
