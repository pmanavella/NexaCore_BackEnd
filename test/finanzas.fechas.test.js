// parsearFecha (finance/utils/fechas.js): fuente única de interpretación de
// fechas de planillas, usada por la importación por Excel y por la migración.
// Cubre cada formato admitido por la plantilla (REQ-FIN-04: YYYY-MM-DD o DD/MM/YYYY).
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsearFecha } = require('../finance/utils/fechas');

const casos = [
  { desc: 'fecha ISO YYYY-MM-DD se conserva', entrada: '2026-12-31', esperado: '2026-12-31' },
  { desc: 'fecha DD/MM/YYYY se convierte a YYYY-MM-DD (CP-FIN-04-03)', entrada: '31/12/2026', esperado: '2026-12-31' },
  { desc: 'espacios alrededor se ignoran', entrada: '  2026-01-15  ', esperado: '2026-01-15' },
  { desc: 'número de serie de Excel se convierte a fecha', entrada: 46022, esperado: '2025-12-31' },
  { desc: 'texto de fecha reconocible por Date se normaliza', entrada: '2026-03-05T10:00:00Z', esperado: '2026-03-05' },
  { desc: 'valor vacío devuelve null', entrada: '', esperado: null },
  { desc: 'valor ausente devuelve null', entrada: undefined, esperado: null },
  { desc: 'texto que no es fecha devuelve null', entrada: 'no es una fecha', esperado: null },
];

for (const c of casos) {
  test(`parsearFecha: ${c.desc}`, () => {
    // Arrange
    const entrada = c.entrada;

    // Act
    const obtenido = parsearFecha(entrada);

    // Assert
    assert.equal(obtenido, c.esperado);
  });
}
