const { EXTRACTION_JSON_SCHEMA, normalizeExtraction } = require('./documentExtraction');

const MODEL = 'gemini-3.1-flash-lite';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const INSTRUCTION = `Extraé datos de un comprobante financiero argentino. Respondé exclusivamente el JSON definido por el esquema. No inventes: usá null cuando un dato no esté visible. Normalizá fechas como YYYY-MM-DD, importes como números sin símbolo ni separadores, CUIT con 11 dígitos y moneda ISO. documentType solo puede ser factura_a, factura_b, factura_c, ticket u otro. suggestedCategory solo puede ser Tecnología, RRHH, Insumos, Servicios, Inversión, Otros o Suscripción. suggestedTransactionType debe ser Ingreso o Gasto según la relación entre emisor y receptor.

Reglas de importes (sin excepción, independientemente del formato de la factura):
- lineTotal de cada renglón es SIEMPRE el importe neto (precio unitario × cantidad, sin IVA ni impuestos), nunca el importe con impuestos incluidos, aunque la columna de la factura muestre otra cosa.
- subtotal es la suma de todos los lineTotal antes de descuentos e impuestos.
- ivaTotal es el monto total de IVA de todo el comprobante: tomarlo del recuadro de totales si existe, o calcularlo como total − subtotal si no está explícito.
- Si la factura discrimina IVA por renglón, extraer ivaRate; si no lo discrimina, dejar ivaRate en null sin inventar un valor.
- total es siempre el importe final a pagar, incluyendo todos los impuestos.
- discountsTotal y otherTaxesTotal deben ser 0 si figuran explícitamente como cero, o null si no aparecen en el comprobante.`;

const RETRYABLE_STATUSES = new Set([429, 503]);
const RETRY_DELAYS_MS = [1000, 3000, 9000];

async function analyzeDocument(buffer, mimeType) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY no está configurada.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  const body = {
    contents: [{ parts: [
      { inlineData: { mimeType, data: buffer.toString('base64') } },
      { text: INSTRUCTION }
    ] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: EXTRACTION_JSON_SCHEMA,
      temperature: 0
    }
  };

  try {
    let lastError;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
      }

      const response = await fetch(`${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        const message = `Gemini rechazó el análisis: ${result.error?.message || response.statusText}`;
        if (RETRYABLE_STATUSES.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
          lastError = new Error(message);
          continue;
        }
        throw new Error(message);
      }

      const result = await response.json();
      const text = result.candidates?.[0]?.content?.parts?.find(part => part.text)?.text;
      if (!text) throw new Error('Gemini no devolvió contenido estructurado.');
      return normalizeExtraction(JSON.parse(text));
    }
    throw lastError;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Gemini superó el tiempo máximo de análisis.');
    if (error instanceof SyntaxError) throw new Error('Gemini devolvió JSON inválido.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { analyzeDocument, MODEL };
