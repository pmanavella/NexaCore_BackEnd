const conversacionesService = require('./conversacionesService');
const nexiPermisos = require('./nexiPermisos');
const { construirInstruccionSistema } = require('./contextoService');
const registry = require('../tools/registry');
const { crearProveedor } = require('../providers');
const { hoyArgentina } = require('../../indicators/services/periodos');
const { LIMITES, MODULOS_CONTEXTO } = require('../config/nexi');
const { errorPublico } = require('../utils/errores');

// Orquestador de Nexi:
// mensaje → historial propio → contexto + herramientas permitidas → proveedor
// → (llamadas a herramientas vía registry.ejecutar, con límite) → respuesta
// final → se guarda el par pregunta/respuesta.

const MAX_CONTENIDO_GUARDADO = 20000;

const MENSAJE_LIMITE_HERRAMIENTAS = 'No pude completar la consulta en una cantidad razonable de pasos. Probá con una pregunta más específica (por ejemplo, indicando el mes o el indicador).';

const ERRORES_PROVEEDOR = {
  TIMEOUT: [504, 'Nexi tardó demasiado en responder. Intentá nuevamente.'],
  LIMITE_PROVEEDOR: [503, 'Nexi está recibiendo muchas consultas. Intentá nuevamente en unos minutos.'],
  SIN_CONFIGURACION: [503, 'Nexi no está disponible en este momento.'],
  SIN_RESPUESTA: [502, 'Nexi no pudo generar una respuesta para esta consulta. Probá reformularla.'],
};

function traducirError(err) {
  if (err.publico) return err;
  if (err.proveedor) {
    console.error(`[Nexi] Error del proveedor (${err.codigo}):`, err.message);
    const [status, mensaje] = ERRORES_PROVEEDOR[err.codigo]
      || [502, 'Nexi no está disponible en este momento. Intentá nuevamente más tarde.'];
    return errorPublico(status, mensaje, 'NEXI_NO_DISPONIBLE');
  }
  return err;
}

function validarMensaje(mensaje) {
  if (typeof mensaje !== 'string' || !mensaje.trim()) {
    throw errorPublico(400, 'El mensaje es obligatorio.', 'MENSAJE_INVALIDO');
  }
  const limpio = mensaje.trim();
  if (limpio.length > LIMITES.MAX_MENSAJE_CARACTERES) {
    throw errorPublico(400, `El mensaje no puede superar los ${LIMITES.MAX_MENSAJE_CARACTERES} caracteres.`, 'MENSAJE_INVALIDO');
  }
  return limpio;
}

// contextoModulo es opcional; si viene, debe ser uno de los slugs admitidos.
function validarContextoModulo(contextoModulo) {
  if (contextoModulo === undefined || contextoModulo === null) return null;
  if (typeof contextoModulo !== 'string' || !MODULOS_CONTEXTO.includes(contextoModulo)) {
    throw errorPublico(400, `contextoModulo inválido. Opciones: ${MODULOS_CONTEXTO.join(', ')}.`, 'CONTEXTO_MODULO_INVALIDO');
  }
  return contextoModulo;
}

class NexiService {
  constructor() {
    this.proveedor = crearProveedor();
  }

  async chat({ usuario, conversationId, mensaje, contextoModulo, ahora = new Date() }) {
    const pregunta = validarMensaje(mensaje);
    const modulo = validarContextoModulo(contextoModulo);
    const preguntaAt = new Date().toISOString();

    // El foco de módulo solo restringe: primero se verifica el permiso real del
    // usuario sobre ese módulo (antes de crear o tocar la conversación).
    let nivelesFoco = null;
    if (modulo) {
      nivelesFoco = await nexiPermisos.obtenerNiveles(usuario);
      if ((nivelesFoco.get(modulo)?.nivel || 'sin_acceso') === 'sin_acceso') {
        throw errorPublico(403, 'No tenés permisos para consultar este módulo con Nexi.', 'SIN_PERMISO_MODULO');
      }
    }

    const existente = conversationId !== undefined && conversationId !== null && conversationId !== '';
    const conversacion = existente
      ? await conversacionesService.obtenerPropia(conversationId, usuario.id)
      : await conversacionesService.crear(usuario.id, pregunta);

    try {
      const historial = existente ? await conversacionesService.historialReciente(conversacion.id) : [];
      const niveles = nivelesFoco || await nexiPermisos.obtenerNiveles(usuario);
      const herramientas = registry.herramientasDisponibles(niveles, modulo);
      const modulosHabilitados = [...niveles.values()].filter(m => m.nivel !== 'sin_acceso').map(m => m.label);
      const moduloFoco = modulo ? niveles.get(modulo).label : null;

      const sistema = construirInstruccionSistema({ usuario, modulosHabilitados, herramientas, hoy: hoyArgentina(ahora), moduloFoco });
      const { texto, herramientasUsadas } = await this._responder({
        sistema, historial, pregunta, herramientas, usuario, conversacionId: conversacion.id, ahora,
        // Con foco, el registry rechaza también cualquier herramienta fuera del
        // conjunto ofrecido (no se confía en que el modelo respete la lista).
        herramientasPermitidas: modulo ? new Set(herramientas.map(h => h.nombre)) : null,
      });

      const nuevoTitulo = historial.length === 0 && conversacion.titulo === conversacionesService.TITULO_POR_DEFECTO
        ? conversacionesService.normalizarTitulo(pregunta)
        : null;
      const mensajeAsistente = await conversacionesService.guardarIntercambio(conversacion.id, {
        pregunta,
        respuesta: texto.slice(0, MAX_CONTENIDO_GUARDADO),
        preguntaAt,
        respuestaAt: new Date().toISOString(),
        nuevoTitulo,
      });

      return {
        conversationId: conversacion.id,
        titulo: nuevoTitulo || conversacion.titulo,
        mensaje: mensajeAsistente,
        herramientasUsadas,
      };
    } catch (err) {
      if (!existente) {
        await conversacionesService.eliminarSiVacia(conversacion.id, usuario.id).catch(() => {});
      }
      throw traducirError(err);
    }
  }

  async _responder({ sistema, historial, pregunta, herramientas, usuario, conversacionId, ahora, herramientasPermitidas = null }) {
    const turnos = historial.map(m => ({ rol: m.rol === 'usuario' ? 'usuario' : 'asistente', texto: m.contenido }));
    turnos.push({ rol: 'usuario', texto: pregunta });

    const declaraciones = registry.declaraciones(herramientas);
    const herramientasUsadas = [];
    let llamadasTotales = 0;

    for (let ronda = 0; ; ronda++) {
      const respuesta = await this.proveedor.generar({ sistema, turnos, herramientas: declaraciones });
      if (respuesta.llamadas.length === 0) return { texto: respuesta.texto, herramientasUsadas };

      if (ronda >= LIMITES.MAX_ITERACIONES_HERRAMIENTAS
        || llamadasTotales + respuesta.llamadas.length > LIMITES.MAX_LLAMADAS_POR_MENSAJE) {
        console.warn(`[Nexi] Límite de herramientas alcanzado (rondas: ${ronda}, llamadas: ${llamadasTotales}).`);
        return { texto: MENSAJE_LIMITE_HERRAMIENTAS, herramientasUsadas };
      }

      turnos.push({ rol: 'asistente', llamadas: respuesta.llamadas, crudo: respuesta.crudo });
      const resultados = [];
      for (const llamada of respuesta.llamadas) {
        llamadasTotales++;
        const ejecucion = await registry.ejecutar({
          nombre: llamada.nombre,
          argumentos: llamada.argumentos,
          usuario,
          conversacionId,
          ahora,
          herramientasPermitidas,
        });
        if (ejecucion.estado === 'OK' && !herramientasUsadas.includes(llamada.nombre)) herramientasUsadas.push(llamada.nombre);
        resultados.push({ id: llamada.id, nombre: String(llamada.nombre || '').slice(0, 100), resultado: ejecucion.resultado });
      }
      turnos.push({ rol: 'herramienta', resultados });
    }
  }
}

const service = new NexiService();
module.exports = service;
module.exports.MENSAJE_LIMITE_HERRAMIENTAS = MENSAJE_LIMITE_HERRAMIENTAS;
module.exports._traducirError = traducirError;
