// Validador cerrado para los parámetros que el modelo envía a una herramienta.
// Soporta el subconjunto de JSON Schema usado por el registro:
// object (properties, required, additionalProperties: false), integer
// (minimum, maximum), string (enum, pattern, maxLength) y array de valores
// simples (items, minItems, maxItems, uniqueItems).
// Rechaza cualquier propiedad no declarada.

function validarValor(valor, esquema, ruta) {
  if (esquema.type === 'integer') {
    if (!Number.isInteger(valor)) return `${ruta} debe ser un número entero.`;
    if (esquema.minimum !== undefined && valor < esquema.minimum) return `${ruta} debe ser mayor o igual a ${esquema.minimum}.`;
    if (esquema.maximum !== undefined && valor > esquema.maximum) return `${ruta} debe ser menor o igual a ${esquema.maximum}.`;
    return null;
  }
  if (esquema.type === 'string') {
    if (typeof valor !== 'string') return `${ruta} debe ser texto.`;
    if (esquema.maxLength !== undefined && valor.length > esquema.maxLength) return `${ruta} es demasiado largo.`;
    if (esquema.enum && !esquema.enum.includes(valor)) return `${ruta} debe ser uno de: ${esquema.enum.join(', ')}.`;
    if (esquema.pattern && !new RegExp(esquema.pattern).test(valor)) return `${ruta} tiene un formato inválido.`;
    return null;
  }
  if (esquema.type === 'array') {
    if (!Array.isArray(valor)) return `${ruta} debe ser una lista.`;
    if (esquema.minItems !== undefined && valor.length < esquema.minItems) return `${ruta} debe tener al menos ${esquema.minItems} elemento(s).`;
    if (esquema.maxItems !== undefined && valor.length > esquema.maxItems) return `${ruta} admite como máximo ${esquema.maxItems} elementos.`;
    if (esquema.uniqueItems && new Set(valor).size !== valor.length) return `${ruta} no admite elementos repetidos.`;
    // Solo listas de valores simples: nunca objetos anidados.
    if (!esquema.items || esquema.items.type === 'array' || esquema.items.type === 'object') return `${ruta} tiene un tipo no admitido.`;
    for (let i = 0; i < valor.length; i++) {
      const error = validarValor(valor[i], esquema.items, `${ruta}[${i}]`);
      if (error) return error;
    }
    return null;
  }
  return `${ruta} tiene un tipo no admitido.`;
}

function validarParametros(argumentos, esquema) {
  if (argumentos === null || typeof argumentos !== 'object' || Array.isArray(argumentos)) {
    return { ok: false, error: 'Los parámetros deben ser un objeto.' };
  }
  const propiedades = esquema.properties || {};
  for (const clave of Object.keys(argumentos)) {
    if (!Object.hasOwn(propiedades, clave)) return { ok: false, error: `Parámetro no admitido: "${clave}".` };
  }
  for (const clave of esquema.required || []) {
    if (argumentos[clave] === undefined) return { ok: false, error: `Falta el parámetro "${clave}".` };
  }
  const limpios = {};
  for (const [clave, subEsquema] of Object.entries(propiedades)) {
    if (argumentos[clave] === undefined || argumentos[clave] === null) continue;
    const error = validarValor(argumentos[clave], subEsquema, `"${clave}"`);
    if (error) return { ok: false, error };
    limpios[clave] = argumentos[clave];
  }
  return { ok: true, valores: limpios };
}

module.exports = { validarParametros };
