const { MODELO_GEMINI, PROVEEDOR } = require('../config/nexi');
const { errorProveedor } = require('../utils/errores');

// Proveedor Gemini para Nexi (conversación + llamadas a herramientas).
// Independiente de finance/services/geminiDocumentService.js (comprobantes).
//
// Contrato neutral que consume nexiService (cualquier proveedor futuro debe
// cumplirlo):
//   generar({ sistema, turnos, herramientas }) → { texto, llamadas, crudo }
//   turnos:
//     { rol: 'usuario', texto }
//     { rol: 'asistente', texto }
//     { rol: 'asistente', llamadas, crudo }   crudo: opaco, devuelto por generar()
//     { rol: 'herramienta', resultados: [{ id, nombre, resultado }] }
//   herramientas: [{ nombre, descripcion, parametros }]  (parametros = JSON Schema)
//   llamadas:     [{ id, nombre, argumentos }]

const RETRYABLE_STATUSES = new Set([429, 500, 503]);

function aContenidos(turnos) {
  return turnos.map(turno => {
    if (turno.rol === 'usuario') return { role: 'user', parts: [{ text: turno.texto }] };
    if (turno.rol === 'asistente' && turno.crudo) return turno.crudo;
    if (turno.rol === 'asistente') return { role: 'model', parts: [{ text: turno.texto }] };
    if (turno.rol === 'herramienta') {
      return {
        role: 'user',
        parts: turno.resultados.map(r => ({
          functionResponse: { ...(r.id ? { id: r.id } : {}), name: r.nombre, response: r.resultado },
        })),
      };
    }
    throw new Error(`Turno desconocido: ${turno.rol}`);
  });
}

function aDeclaraciones(herramientas) {
  return herramientas.map(h => ({
    name: h.nombre,
    description: h.descripcion,
    parametersJsonSchema: h.parametros,
  }));
}

function interpretarRespuesta(result) {
  const candidato = result.candidates?.[0];
  const partes = candidato?.content?.parts || [];

  const llamadas = partes
    .filter(p => p.functionCall)
    .map(p => ({
      id: p.functionCall.id || null,
      nombre: typeof p.functionCall.name === 'string' ? p.functionCall.name : '',
      argumentos: p.functionCall.args ?? {},
    }));

  const texto = partes
    .filter(p => typeof p.text === 'string' && !p.thought)
    .map(p => p.text)
    .join('')
    .trim();

  if (llamadas.length === 0 && !texto) {
    const motivo = result.promptFeedback?.blockReason || candidato?.finishReason || 'desconocido';
    throw errorProveedor('SIN_RESPUESTA', `Gemini no devolvió contenido (motivo: ${motivo}).`);
  }

  return { texto, llamadas, crudo: llamadas.length > 0 ? candidato.content : null };
}

function crearGeminiProvider({
  modelo = MODELO_GEMINI,
  timeoutMs = PROVEEDOR.TIMEOUT_MS,
  reintentosMs = PROVEEDOR.REINTENTOS_MS,
  obtenerApiKey = () => process.env.GEMINI_API_KEY,
} = {}) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`;

  async function llamar(body) {
    const apiKey = obtenerApiKey();
    if (!apiKey) throw errorProveedor('SIN_CONFIGURACION', 'GEMINI_API_KEY no está configurada.');

    let ultimoError;
    for (let intento = 0; intento <= reintentosMs.length; intento++) {
      if (intento > 0) await new Promise(resolve => setTimeout(resolve, reintentosMs[intento - 1]));

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // La clave va en header (no en la URL) para que no quede en logs de URLs.
        const response = await fetch(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          const detalle = `Gemini respondió ${response.status}: ${result.error?.message || response.statusText}`;
          ultimoError = errorProveedor(response.status === 429 ? 'LIMITE_PROVEEDOR' : 'ERROR_PROVEEDOR', detalle);
          if (RETRYABLE_STATUSES.has(response.status) && intento < reintentosMs.length) continue;
          throw ultimoError;
        }

        let result;
        try {
          result = await response.json();
        } catch {
          throw errorProveedor('RESPUESTA_INVALIDA', 'Gemini devolvió una respuesta que no es JSON.');
        }
        return result;
      } catch (err) {
        if (err.name === 'AbortError') throw errorProveedor('TIMEOUT', `Gemini superó ${timeoutMs} ms.`);
        if (err.proveedor) throw err;
        throw errorProveedor('ERROR_RED', `Error de red con Gemini: ${err.message}`);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw ultimoError;
  }

  return {
    nombre: 'gemini',
    modelo,
    async generar({ sistema, turnos, herramientas = [] }) {
      const body = {
        systemInstruction: { parts: [{ text: sistema }] },
        contents: aContenidos(turnos),
        generationConfig: {
          temperature: PROVEEDOR.TEMPERATURA,
          maxOutputTokens: PROVEEDOR.MAX_TOKENS_SALIDA,
        },
      };
      if (herramientas.length > 0) {
        body.tools = [{ functionDeclarations: aDeclaraciones(herramientas) }];
        body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
      }
      return interpretarRespuesta(await llamar(body));
    },
  };
}

module.exports = { crearGeminiProvider, _interpretarRespuesta: interpretarRespuesta, _aContenidos: aContenidos };
