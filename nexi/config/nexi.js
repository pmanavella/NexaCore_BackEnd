// Configuración central de Nexi (asistente de solo lectura). Único lugar donde
// se define el modelo y los límites: el resto del módulo los importa de acá.

// Modelo de Gemini para Nexi. Independiente del modelo de comprobantes.
const MODELO_GEMINI = process.env.NEXI_GEMINI_MODEL || 'gemini-3.1-flash-lite';

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
  // Mensajes devueltos al recuperar una conversación
  MAX_MENSAJES_LISTADO: 200,
};

const PROVEEDOR = {
  TIMEOUT_MS: 30000,
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
const MODULOS_CONTEXTO = ['finance', 'indicadores', 'operations', 'crm'];

module.exports = { MODELO_GEMINI, LIMITES, PROVEEDOR, RATE_LIMIT, MODULOS_CONTEXTO };
