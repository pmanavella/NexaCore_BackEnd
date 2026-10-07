const { MODELO_GEMINI, PROVEEDOR } = require('../config/nexi');
const { errorProveedor } = require('../utils/errores');

// Proveedor Gemini para Nexi (conversación + llamadas a herramientas).
// Independiente de finance/services/geminiDocumentService.js (comprobantes).
//
// Contrato neutral que consume nexiService (cualquier proveedor futuro debe
// cumplirlo):
//   generar({ sistema, turnos, herramientas, venceEn }) → { texto, llamadas, crudo, truncado }
//   venceEn (opcional): epoch ms del plazo global; acota timeout y reintentos.
//   alEvento (opcional): callback de auditoría de timeouts/reintentos.
//   truncado: true si el modelo cortó la salida por límite de tokens. El
//   contenido truncado NUNCA debe presentarse como respuesta válida.
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

  // MAX_TOKENS: la salida (texto o llamadas) puede estar incompleta.
  const truncado = candidato?.finishReason === 'MAX_TOKENS';
  if (truncado) return { texto, llamadas, crudo: null, truncado: true };

  if (llamadas.length === 0 && !texto) {
    const motivo = result.promptFeedback?.blockReason || candidato?.finishReason || 'desconocido';
    throw errorProveedor('SIN_RESPUESTA', `Gemini no devolvió contenido (motivo: ${motivo}).`);
  }

  return { texto, llamadas, crudo: llamadas.length > 0 ? candidato.content : null, truncado: false };
}

function crearGeminiProvider({
  modelo = MODELO_GEMINI,
  timeoutMs = PROVEEDOR.TIMEOUT_MS,
  reintentosMs = PROVEEDOR.REINTENTOS_MS,
  reintentosPorTimeout = PROVEEDOR.REINTENTOS_POR_TIMEOUT,
  margenMinimoReintentoMs = PROVEEDOR.MARGEN_MINIMO_REINTENTO_MS,
  obtenerApiKey = () => process.env.GEMINI_API_KEY,
} = {}) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`;

  // venceEn: epoch ms del plazo global (null = sin plazo global).
  // alEvento(tipo, estado, datos): notifica TIMEOUT_INTENTO, REINTENTO_TIMEOUT,
  // TIMEOUT_DEFINITIVO y EXITO_TRAS_REINTENTO. Solo datos numéricos: nunca
  // contenido. No se espera (no agrega latencia) y sus errores se ignoran.
  async function llamar(body, venceEn = null, alEvento = null) {
    const apiKey = obtenerApiKey();
    if (!apiKey) throw errorProveedor('SIN_CONFIGURACION', 'GEMINI_API_KEY no está configurada.');

    const evento = (tipo, estado, datos) => {
      if (!alEvento) return;
      try { Promise.resolve(alEvento(tipo, estado, datos)).catch(() => {}); } catch { /* auditoría best-effort */ }
    };
    const restante = () => (venceEn ? venceEn - Date.now() : Infinity);
    // Un intento nunca dura más que el timeout por llamada NI que lo que queda
    // del plazo global: el plazo global es la autoridad final.
    const disponible = () => Math.min(timeoutMs, restante());

    let ultimoError;
    let reintentosHttp = 0;
    let reintentosTimeout = 0;
    // Bucle acotado: cada vuelta extra consume un reintento HTTP o de timeout.
    for (;;) {
      const limiteMs = disponible();
      if (limiteMs <= 0) throw errorProveedor('TIMEOUT', 'Plazo global de la consulta agotado antes de llamar a Gemini.');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), limiteMs);
      const inicio = Date.now();
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
          if (!RETRYABLE_STATUSES.has(response.status) || reintentosHttp >= reintentosMs.length) throw ultimoError;
          const espera = reintentosMs[reintentosHttp];
          // No se reintenta si la espera agotaría el plazo global.
          if (disponible() <= espera) throw ultimoError;
          reintentosHttp++;
          clearTimeout(timeout);
          await new Promise(resolve => setTimeout(resolve, espera));
          continue;
        }

        let result;
        try {
          result = await response.json();
        } catch {
          throw errorProveedor('RESPUESTA_INVALIDA', 'Gemini devolvió una respuesta que no es JSON.');
        }
        if (reintentosTimeout > 0) {
          evento('EXITO_TRAS_REINTENTO', 'OK', { intento: reintentosTimeout + 1, duracion_ms: Date.now() - inicio });
        }
        return result;
      } catch (err) {
        if (err.name === 'AbortError') {
          // La llamada abortada no vuelve a leerse: su respuesta tardía se descarta.
          evento('TIMEOUT_INTENTO', 'ERROR', { intento: reintentosTimeout + 1, timeout_ms: limiteMs, duracion_ms: Date.now() - inicio });
          const quedaMs = restante();
          if (reintentosTimeout < reintentosPorTimeout && quedaMs >= margenMinimoReintentoMs) {
            reintentosTimeout++;
            evento('REINTENTO_TIMEOUT', 'OK', { intento: reintentosTimeout + 1, restante_ms: Number.isFinite(quedaMs) ? Math.round(quedaMs) : null });
            continue;
          }
          evento('TIMEOUT_DEFINITIVO', 'ERROR', {
            intentos: reintentosTimeout + 1,
            restante_ms: Number.isFinite(quedaMs) ? Math.max(0, Math.round(quedaMs)) : null,
          });
          throw errorProveedor('TIMEOUT', `Gemini superó ${limiteMs} ms (intentos: ${reintentosTimeout + 1}).`);
        }
        if (err.proveedor) throw err;
        throw errorProveedor('ERROR_RED', `Error de red con Gemini: ${err.message}`);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  return {
    nombre: 'gemini',
    modelo,
    async generar({ sistema, turnos, herramientas = [], venceEn = null, alEvento = null }) {
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
      return interpretarRespuesta(await llamar(body, venceEn, alEvento));
    },
  };
}

module.exports = { crearGeminiProvider, _interpretarRespuesta: interpretarRespuesta, _aContenidos: aContenidos };
