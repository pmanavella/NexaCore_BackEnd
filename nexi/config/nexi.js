// Configuración central de Nexi (asistente de solo lectura). Único lugar donde
// se define el modelo y los límites: el resto del módulo los importa de acá.

// Modelo de Gemini para Nexi. Independiente del modelo de comprobantes.
const MODELO_GEMINI = process.env.NEXI_GEMINI_MODEL || 'gemini-3.1-flash-lite';

function enteroPositivo(valor, porDefecto) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : porDefecto;
}

const LIMITES = {
  // Mensaje del usuario
  MAX_MENSAJE_CARACTERES: 2000,
  // Mensajes previos de la conversación que se envían al modelo como historial
  MAX_MENSAJES_HISTORIAL: 20,
  // Rondas modelo → herramientas por mensaje del usuario (evita loops)
  MAX_ITERACIONES_HERRAMIENTAS: 4,
  // Llamadas a herramientas totales por mensaje del usuario
  MAX_LLAMADAS_POR_MENSAJE: 8,
  // Tamaño máximo (JSON) del resultado de una herramienta enviado al modelo
  MAX_RESULTADO_CARACTERES: 12000,
  // Longitud del título autogenerado de una conversación
  MAX_TITULO_CARACTERES: 80,
  // Conversaciones devueltas por el listado
  MAX_CONVERSACIONES_LISTADO: 50,
  // Mensajes devueltos al recuperar una conversación (los últimos N)
  MAX_MENSAJES_LISTADO: 200,
  // Tiempo total máximo de POST /api/nexi/chat (modelo + herramientas), en ms.
  TIMEOUT_TOTAL_MS: enteroPositivo(process.env.NEXI_TIMEOUT_TOTAL_MS, 60000),
  // Reintentos cuando el modelo corta la respuesta por MAX_TOKENS: se le pide
  // una versión más breve; si vuelve a cortarse, se responde un mensaje explícito.
  MAX_REINTENTOS_RESPUESTA_TRUNCADA: 1,
};

const PROVEEDOR = {
  // Timeout de UN intento de llamada a Gemini (independiente del plazo global
  // de la consulta, LIMITES.TIMEOUT_TOTAL_MS, que sigue siendo la autoridad final).
  TIMEOUT_MS: enteroPositivo(process.env.NEXI_PROVIDER_TIMEOUT_MS, 15000),
  // Reintentos adicionales cuando un intento supera TIMEOUT_MS.
  REINTENTOS_POR_TIMEOUT: 1,
  // Tiempo mínimo que debe quedar del plazo global para reintentar tras un
  // timeout (por debajo de esto el reintento no tendría chance real).
  MARGEN_MINIMO_REINTENTO_MS: 5000,
  // Esperas antes de reintentar ante HTTP 429/500/503.
  REINTENTOS_MS: [1000, 3000],
  TEMPERATURA: 0.2,
  MAX_TOKENS_SALIDA: 1024,
};

// Rate limit por usuario (en memoria, por proceso) para POST /api/nexi/chat.
const RATE_LIMIT = {
  POR_MINUTO: 8,
  POR_HORA: 60,
  // Solicitudes simultáneas por usuario
  CONCURRENTES: 1,
};

// Valores admitidos para `contextoModulo` en POST /api/nexi/chat (slugs de
// public.modulos). Solo restringen herramientas; nunca otorgan permisos.
const MODULOS_CONTEXTO = ['finance', 'indicadores', 'operations', 'crm', 'dashboard', 'organizacion', 'protocolos', 'reportes'];

// Alcances de public.usuario_modulo_permisos (enum tipo_alcance), de menor a
// mayor. Un permiso sin alcance se interpreta como 'propio' (default de la
// columna): nunca se amplía.
const ALCANCES = ['propio', 'equipo_directo', 'subarbol', 'global'];

module.exports = { MODELO_GEMINI, LIMITES, PROVEEDOR, RATE_LIMIT, MODULOS_CONTEXTO, ALCANCES };
