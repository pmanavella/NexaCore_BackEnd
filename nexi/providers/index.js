const { crearGeminiProvider } = require('./geminiProvider');

// Punto único de selección del proveedor de IA de Nexi. Para cambiar de
// proveedor, crear otro archivo en providers/ que cumpla el mismo contrato
// (ver geminiProvider.js) y devolverlo acá.
function crearProveedor() {
  return crearGeminiProvider();
}

module.exports = { crearProveedor };
