// Validación previa y plantilla del endpoint de Excel (REQ-FIN-04):
// finance/services/excelService.js, métodos validar y getPlantillaInfo, y el
// error de la base durante la importación. La importación completa se prueba en
// finanzas.importacion.test.js y los montos (RN-01) en finanzas.montos.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const excelService = require('../finance/services/excelService');
const { CATEGORIAS_VALIDAS, TIPOS_VALIDOS } = require('../finance/config/movimientos');

const ENCABEZADOS = ['fecha', 'descripcion', 'categoria', 'tipo', 'monto'];

function planilla(filas, encabezados = ENCABEZADOS) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([encabezados, ...filas]), 'Hoja1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('validar un archivo correcto → válido, con la vista previa de fechas y montos ya interpretados', async () => {
  // Arrange
  const buffer = planilla([
    ['2026-12-31', 'Hosting', 'Tecnología', 'Gasto', 1500],
    ['2026-11-05', 'Cobro cliente', 'Servicios', 'Ingreso', 2000],
  ]);

  // Act
  const r = await excelService.validar(buffer);

  // Assert
  assert.equal(r.valido, true);
  assert.equal(r.totalFilas, 2);
  assert.deepEqual(r.errores, []);
  assert.deepEqual(r.preview.map(f => [f.fecha, f.monto]), [['2026-12-31', 1500], ['2026-11-05', 2000]]);
});

test('CP-FIN-04-03 importar una fila con fecha 31/12/2026 (formato que anuncia la plantilla) → se guarda con fecha 2026-12-31', async (t) => {
  // Arrange
  const insertados = [];
  t.mock.method(supabase, 'from', () => ({
    insert: (lote) => ({ select: async () => { insertados.push(...lote); return { data: lote.map((_, i) => ({ id: i })), error: null }; } }),
  }));
  const buffer = planilla([['31/12/2026', 'Hosting anual', 'Tecnología', 'Gasto', 1500]]);

  // Act
  const r = await excelService.importar(buffer, 'contable@nexacore.test').catch(e => e);

  // Assert
  assert.equal(r.insertados, 1, `resultado: ${r.message ?? ''} ${JSON.stringify(r.errores ?? '')}`);
  assert.equal(insertados[0].fecha, '2026-12-31');
});

test('validar → la vista previa muestra como máximo 5 filas', async () => {
  // Arrange
  const filas = Array.from({ length: 8 }, (_, i) => ['2026-10-01', `Fila ${i}`, 'Otros', 'Gasto', 10 + i]);

  // Act
  const r = await excelService.validar(planilla(filas));

  // Assert
  assert.equal(r.totalFilas, 8);
  assert.equal(r.preview.length, 5);
});

test('validar un archivo con filas inválidas → informa cada error con su número de fila', async () => {
  // Arrange
  const buffer = planilla([
    ['2026-10-01', 'Viaje', 'Viáticos', 'Gasto', 100],
    ['2026-10-01', 'Ajuste', 'Otros', 'Egreso', 100],
    ['2026-10-01', 'Monto cero', 'Otros', 'Gasto', 0],
    ['no es fecha', 'Sin fecha', 'Otros', 'Gasto', 100],
    ['2026-10-01', '', 'Otros', 'Gasto', 100],
  ]);

  // Act
  const r = await excelService.validar(buffer);

  // Assert
  assert.equal(r.valido, false);
  const porFila = (n) => r.errores.filter(e => e.startsWith(`Fila ${n}:`));
  assert.match(porFila(2)[0], /categoría "Viáticos" inválida/);
  assert.match(porFila(3)[0], /tipo "Egreso" inválido/);
  assert.match(porFila(4)[0], /monto "0" debe ser un número positivo/);
  assert.match(porFila(5)[0], /fecha "no es fecha" inválida/);
  assert.match(porFila(6)[0], /falta la columna "descripcion"/);
});

test('validar un archivo sin la columna monto → HTTP 400 indicando la columna faltante', async () => {
  // Arrange
  const buffer = planilla([['2026-10-01', 'Hosting', 'Tecnología', 'Gasto']], ['fecha', 'descripcion', 'categoria', 'tipo']);

  // Act y Assert
  await assert.rejects(excelService.validar(buffer), (e) => e.status === 400 && /Columnas faltantes: monto/.test(e.message));
});

test('validar un archivo vacío (solo encabezados) → HTTP 400', async () => {
  // Arrange
  const buffer = planilla([]);

  // Act y Assert
  await assert.rejects(excelService.validar(buffer), (e) => e.status === 400);
});

test('los encabezados se normalizan (mayúsculas y espacios)', async () => {
  // Arrange
  const buffer = planilla([['2026-10-01', 'Hosting', 'Tecnología', 'Gasto', 10]], [' Fecha', 'DESCRIPCION', 'Categoria ', 'Tipo', 'Monto']);

  // Act
  const r = await excelService.validar(buffer);

  // Assert
  assert.equal(r.valido, true);
});

test('plantilla → ofrece exactamente las categorías y tipos de la fuente única (config/movimientos.js)', () => {
  // Arrange y Act
  const info = excelService.getPlantillaInfo();
  const columna = (nombre) => info.columnas.find(c => c.nombre === nombre);

  // Assert
  assert.deepEqual(columna('categoria').opciones, CATEGORIAS_VALIDAS);
  assert.ok(columna('categoria').opciones.includes('Suscripción'));
  assert.deepEqual(columna('tipo').opciones, TIPOS_VALIDOS);
  assert.deepEqual(info.columnas.filter(c => c.requerido).map(c => c.nombre), ENCABEZADOS);
  assert.ok(info.ejemplo.every(e => CATEGORIAS_VALIDAS.includes(e.categoria)));
});

test('importar: la base rechaza una tanda → error que indica el número de tanda', async (t) => {
  // Arrange
  t.mock.method(supabase, 'from', () => ({
    insert: () => ({ select: async () => ({ data: null, error: new Error('violación de restricción') }) }),
  }));
  const buffer = planilla([['2026-10-01', 'Hosting', 'Tecnología', 'Gasto', 10]]);

  // Act y Assert
  await assert.rejects(excelService.importar(buffer, 'u@x'), /Error en lote 1: violación de restricción/);
});

test('CP-FIN-04-04 importar una fila con fecha inexistente 2026-02-31 → se rechaza con 400 y no se graba ninguna fila', async (t) => {
  // Arrange
  const insertados = [];
  t.mock.method(supabase, 'from', () => ({
    insert: (lote) => ({ select: async () => { insertados.push(...lote); return { data: lote.map((_, i) => ({ id: i })), error: null }; } }),
  }));
  const buffer = planilla([
    ['2026-01-15', 'Hosting', 'Tecnología', 'Gasto', 1500],
    ['2026-02-31', 'Fecha inexistente', 'Otros', 'Gasto', 100],
    ['2026-03-10', 'Cobro cliente', 'Servicios', 'Ingreso', 2000],
  ]);

  // Act
  const r = await excelService.importar(buffer, 'contable@nexacore.test').catch(e => e);

  // Assert
  const guardada = insertados.find(m => m.descripcion === 'Fecha inexistente')?.fecha;
  assert.equal(r.status, 400, `fecha guardada: ${guardada}`);
  assert.equal(insertados.length, 0);
});