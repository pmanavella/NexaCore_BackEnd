const test = require('node:test');
const assert = require('node:assert/strict');

const { analizarFormula, evaluarFormula, MAX_LONGITUD, MAX_PROFUNDIDAD } = require('../indicators/services/formulaParser');
const { CLAVES_VARIABLES } = require('../indicators/services/variablesFinancieras');

const analizar = texto => analizarFormula(texto, CLAVES_VARIABLES);
const calcular = (texto, valores) => evaluarFormula(analizar(texto).arbol, valores);
const rechaza = (texto, patron) => assert.throws(
  () => analizar(texto),
  err => err.status === 400 && (!patron || patron.test(err.message)),
  `debería rechazar: ${texto}`
);

// ── Casos válidos ────────────────────────────────────────────────────────────

test('margen: (INGRESOS_TOTAL - GASTOS_TOTAL) / INGRESOS_TOTAL * 100', () => {
  const r = calcular('(INGRESOS_TOTAL - GASTOS_TOTAL) / INGRESOS_TOTAL * 100', { INGRESOS_TOTAL: 1000, GASTOS_TOTAL: 250 });
  assert.deepEqual(r, { valor: 75, error: null });
});

test('precedencia: * y / antes que + y -; asociatividad izquierda', () => {
  assert.equal(calcular('INGRESOS_TOTAL + GASTOS_TOTAL * 2', { INGRESOS_TOTAL: 1, GASTOS_TOTAL: 3 }).valor, 7);
  assert.equal(calcular('INGRESOS_TOTAL - GASTOS_TOTAL - 1', { INGRESOS_TOTAL: 10, GASTOS_TOTAL: 3 }).valor, 6);
  assert.equal(calcular('INGRESOS_TOTAL / 2 / 5', { INGRESOS_TOTAL: 100 }).valor, 10);
});

test('paréntesis anidados y decimales', () => {
  assert.equal(calcular('((INGRESOS_TOTAL + 0.5) * (2.5))', { INGRESOS_TOTAL: 1.5 }).valor, 5);
});

test('menos unario', () => {
  assert.equal(calcular('-GASTOS_TOTAL', { GASTOS_TOTAL: 4 }).valor, -4);
  assert.equal(calcular('INGRESOS_TOTAL - -GASTOS_TOTAL', { INGRESOS_TOTAL: 1, GASTOS_TOTAL: 2 }).valor, 3);
  assert.equal(calcular('-(INGRESOS_TOTAL - GASTOS_TOTAL) * 2', { INGRESOS_TOTAL: 1, GASTOS_TOTAL: 3 }).valor, 4);
});

test('variables por categoría del catálogo (con claves sin acentos)', () => {
  const { variables } = analizar('GASTOS_TECNOLOGIA + GASTOS_SUSCRIPCION + INGRESOS_INVERSION');
  assert.deepEqual(variables, ['GASTOS_TECNOLOGIA', 'GASTOS_SUSCRIPCION', 'INGRESOS_INVERSION']);
});

test('normaliza espacios de forma canónica', () => {
  assert.equal(analizar('  (INGRESOS_TOTAL-GASTOS_TOTAL)/INGRESOS_TOTAL*100 ').formula, '(INGRESOS_TOTAL - GASTOS_TOTAL) / INGRESOS_TOTAL * 100');
  assert.equal(analizar('- GASTOS_TOTAL+ -  1').formula, '-GASTOS_TOTAL + -1');
});

test('la fórmula normalizada vuelve a analizarse igual (idempotente)', () => {
  const una = analizar('INGRESOS_TOTAL/(GASTOS_TOTAL+1)*-2').formula;
  assert.equal(analizar(una).formula, una);
});

test('el resultado se redondea a 4 decimales', () => {
  assert.equal(calcular('INGRESOS_TOTAL / 3', { INGRESOS_TOTAL: 1 }).valor, 0.3333);
});

// ── División por cero y errores de evaluación ────────────────────────────────

test('división por cero → valor null con código explícito (no lanza)', () => {
  const r = calcular('GASTOS_TOTAL / INGRESOS_TOTAL * 100', { GASTOS_TOTAL: 10, INGRESOS_TOTAL: 0 });
  assert.equal(r.valor, null);
  assert.equal(r.error.codigo, 'DIVISION_POR_CERO');
});

test('división por una constante 0 también se informa', () => {
  assert.equal(calcular('INGRESOS_TOTAL / (1 - 1)', { INGRESOS_TOTAL: 5 }).error.codigo, 'DIVISION_POR_CERO');
});

test('variable sin valor → error, no NaN', () => {
  assert.equal(calcular('INGRESOS_TOTAL + GASTOS_TOTAL', { INGRESOS_TOTAL: 1 }).error.codigo, 'VARIABLE_SIN_VALOR');
});

// ── Rechazos: validación previa al guardado ─────────────────────────────────

test('rechaza fórmula vacía o no-string', () => {
  rechaza('', /obligatoria/);
  rechaza('   ', /obligatoria/);
  assert.throws(() => analizarFormula(null, CLAVES_VARIABLES), err => err.status === 400);
  assert.throws(() => analizarFormula(42, CLAVES_VARIABLES), err => err.status === 400);
});

test('rechaza variables desconocidas (listándolas) y labels visuales', () => {
  rechaza('INGRESOS_TOTAL + FOO + BAR', /FOO, BAR/);
  rechaza('ingresos_total', /desconocida/);
  rechaza('GASTOS_TECNOLOGÍA', /Carácter no permitido/);
});

test('rechaza código ejecutable y tokens fuera de la lista blanca', () => {
  rechaza('eval(1)', /Se esperaba un operador/);
  rechaza('process.exit()', /Carácter no permitido "\."/);
  rechaza('INGRESOS_TOTAL; DROP TABLE movimientos', /Carácter no permitido ";"/);
  rechaza('constructor["constructor"]("return 1")()', /Carácter no permitido/);
  rechaza('INGRESOS_TOTAL ** 2', /Se esperaba una variable/);
  rechaza('INGRESOS_TOTAL % 2', /Carácter no permitido "%"/);
  rechaza('INGRESOS_TOTAL ^ 2', /Carácter no permitido/);
  rechaza('`INGRESOS_TOTAL`', /Carácter no permitido/);
  rechaza('1e5 * INGRESOS_TOTAL', /Se esperaba un operador/);
});

test('rechaza errores de sintaxis con mensajes comprensibles', () => {
  rechaza('(INGRESOS_TOTAL - GASTOS_TOTAL', /Falta cerrar/);
  rechaza('INGRESOS_TOTAL - GASTOS_TOTAL)', /sin apertura/);
  rechaza('INGRESOS_TOTAL +', /incompleta/);
  rechaza('INGRESOS_TOTAL * / GASTOS_TOTAL', /Se esperaba una variable/);
  rechaza('INGRESOS_TOTAL GASTOS_TOTAL', /Se esperaba un operador/);
  rechaza('()', /Se esperaba una variable/);
  rechaza('+INGRESOS_TOTAL', /Se esperaba una variable/);
});

test('rechaza números mal formados (coma decimal, doble punto, punto inicial)', () => {
  rechaza('INGRESOS_TOTAL * 0,5', /punto como separador/);
  rechaza('INGRESOS_TOTAL * 1.2.3', /punto como separador/);
  rechaza('INGRESOS_TOTAL * .5', /Carácter no permitido/);
});

test('exige al menos una variable', () => {
  rechaza('1 + 2', /al menos una variable/);
});

test('límites de longitud, tokens y profundidad', () => {
  rechaza('INGRESOS_TOTAL' + ' '.repeat(MAX_LONGITUD), /caracteres/);
  rechaza('INGRESOS_TOTAL' + '+1'.repeat(100), /elementos/); // 201 tokens, < 500 caracteres
  const profundo = '('.repeat(MAX_PROFUNDIDAD + 1) + 'INGRESOS_TOTAL' + ')'.repeat(MAX_PROFUNDIDAD + 1);
  rechaza(profundo, /niveles de paréntesis/);
  const justo = '('.repeat(MAX_PROFUNDIDAD) + 'INGRESOS_TOTAL' + ')'.repeat(MAX_PROFUNDIDAD);
  assert.doesNotThrow(() => analizar(justo));
});
