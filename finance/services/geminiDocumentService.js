const { EXTRACTION_JSON_SCHEMA, normalizeExtraction } = require('./documentExtraction');

const MODEL = 'gemini-3.1-flash-lite';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const INSTRUCTION = `Extraé datos de un comprobante financiero argentino. Respondé exclusivamente el JSON definido por el esquema. No inventes: usá null cuando un dato no esté visible. Normalizá fechas como YYYY-MM-DD, importes como números sin símbolo ni separadores, CUIT con 11 dígitos y moneda ISO. documentType solo puede ser factura_a, factura_b, factura_c, ticket u otro. suggestedCategory solo puede ser Tecnología, RRHH, Insumos, Servicios, Inversión, Otros o Suscripción. suggestedTransactionType debe ser Ingreso o Gasto según la relación entre emisor y receptor. subtotal debe ser el total de renglones antes de descuentos e impuestos; discountsTotal, ivaTotal y otherTaxesTotal deben ser cero si figuran explícitamente como cero.`;

async function analyzeDocument(buffer, mimeType) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY no está configurada.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(`${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { inlineData: { mimeType, data: buffer.toString('base64') } },
          { text: INSTRUCTION }
        ] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: EXTRACTION_JSON_SCHEMA,
          temperature: 0
        }
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`Gemini rechazó el análisis: ${result.error?.message || response.statusText}`);
    const text = result.candidates?.[0]?.content?.parts?.find(part => part.text)?.text;
    if (!text) throw new Error('Gemini no devolvió contenido estructurado.');
    return normalizeExtraction(JSON.parse(text));
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Gemini superó el tiempo máximo de análisis.');
    if (error instanceof SyntaxError) throw new Error('Gemini devolvió JSON inválido.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { analyzeDocument, MODEL };
