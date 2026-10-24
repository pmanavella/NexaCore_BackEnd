// Smoke test posterior al despliegue (consigna: "smoke en cada despliegue").
//
// Se corre contra una instancia ya desplegada del backend:
//   SMOKE_BASE_URL=http://localhost:3001 npm run test:smoke
// En el pipeline, la instancia es la imagen recién construida, apuntada a nexacore-test.
// Sin SMOKE_BASE_URL las pruebas se omiten (así `npm test` no las ejecuta).
//
// Verifica lo mínimo para dar por bueno un despliegue: que la instancia responde,
// que corre la versión esperada, que llega a Supabase, que exige autenticación y
// que un usuario real puede leer datos financieros.

const test = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.SMOKE_BASE_URL?.replace(/\/+$/, '');
const VERSION = process.env.EXPECTED_VERSION;
const SUPABASE_URL = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const PASSWORD = process.env.TEST_USER_PASSWORD;

const omitir = BASE ? false : 'sin SMOKE_BASE_URL';
const omitirSesion = omitir || (SUPABASE_URL && ANON && PASSWORD ? false : 'sin credenciales de nexacore-test');

async function obtenerJson(ruta, opciones = {}) {
  const respuesta = await fetch(`${BASE}${ruta}`, { signal: AbortSignal.timeout(15000), ...opciones });
  let cuerpo = null;
  try { cuerpo = await respuesta.json(); } catch { /* sin cuerpo JSON */ }
  return { status: respuesta.status, cuerpo };
}

test('smoke · /api/health responde 200 con la base conectada', { skip: omitir }, async () => {
  const { status, cuerpo } = await obtenerJson('/api/health');
  assert.equal(status, 200, `health respondió ${status}: ${JSON.stringify(cuerpo)}`);
  assert.equal(cuerpo.db, 'ok');
});

test('smoke · la instancia corre la versión desplegada', { skip: omitir || (VERSION ? false : 'sin EXPECTED_VERSION') }, async () => {
  const { cuerpo } = await obtenerJson('/api/health');
  assert.equal(cuerpo.version, VERSION, 'la instancia no corre la versión que se acaba de desplegar');
});

test('smoke · la API financiera exige autenticación (401 sin token)', { skip: omitir }, async () => {
  const { status } = await obtenerJson('/api/finance/movimientos');
  assert.equal(status, 401);
});

test('smoke · Dirección inicia sesión y lee los movimientos', { skip: omitirSesion }, async () => {
  // Arrange: sesión real en Supabase Auth con el usuario de prueba U-02.
  const login = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'test.direccion@nexacore.test', password: PASSWORD }),
  });
  const { access_token: token } = await login.json();
  assert.ok(token, `no se pudo iniciar sesión (HTTP ${login.status})`);

  // Act
  const { status, cuerpo } = await obtenerJson('/api/finance/movimientos', {
    headers: { Authorization: `Bearer ${token}` },
  });

  // Assert
  assert.equal(status, 200);
  const lista = Array.isArray(cuerpo) ? cuerpo : cuerpo?.data;
  assert.ok(Array.isArray(lista) && lista.some(m => m.descripcion?.startsWith('TEST')),
    'la respuesta no trae los movimientos sembrados de nexacore-test');
});
