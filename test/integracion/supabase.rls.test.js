// Pruebas de integración contra Supabase (base nexacore-test).
//
// Verifican que la clave pública (anon), la que usa el frontend y cualquiera
// puede ver en el navegador, no permita leer datos sensibles ni modificar la
// matriz de permisos salteando el backend (RN-02, REQ-FIN-16, DEF-018).
//
// Se ejecutan con:  npm run test:integracion
// Requieren SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY y SUPABASE_TEST_SERVICE_ROLE_KEY
// (en local, .env.test; en el pipeline, secretos de GitHub). Sin esas variables se
// omiten, así `npm test` sigue funcionando sin conexión.
//
// No reinician la base: solo leen y, si una escritura indebida llega a crearse,
// la borran al terminar. Así no interfieren con otras pruebas en curso.

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const envTest = path.resolve(__dirname, '..', '..', '.env.test');
if (fs.existsSync(envTest)) require('dotenv').config({ path: envTest, quiet: true });

const URL_TEST = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const omitir = URL_TEST && ANON && SERVICE ? false : 'sin credenciales de nexacore-test (SUPABASE_TEST_*)';

async function rest(ruta, { clave, metodo = 'GET', cuerpo, prefer } = {}) {
  const respuesta = await fetch(`${URL_TEST}/rest/v1/${ruta}`, {
    method: metodo,
    headers: {
      apikey: clave,
      Authorization: `Bearer ${clave}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await respuesta.text();
  let datos;
  try { datos = JSON.parse(texto); } catch { datos = texto; }
  return { status: respuesta.status, datos };
}

// La lectura está bloqueada si Supabase responde con error o con una lista vacía.
function lecturaBloqueada({ status, datos }) {
  return status >= 400 || (Array.isArray(datos) && datos.length === 0);
}

// Tablas con la política "Allow all for anon" en el esquema de Developer (hallazgo H-50).
const TABLAS_SENSIBLES = [
  'usuarios', 'roles', 'usuario_modulo_permisos', 'rol_modulo_permisos', 'modulos',
  'empleados', 'salarios', 'movimientos_salario', 'categorias_salariales',
  'organigrama', 'integracion_movimientos_financieros',
];

test('CP-FIN-16-09 · control: la clave anon no lee movimientos (tabla solo para el backend)', { skip: omitir }, async () => {
  // Arrange: el seed deja 22 movimientos en nexacore-test.
  const control = await rest('movimientos?select=id&limit=1', { clave: SERVICE });
  assert.equal(control.datos.length, 1, 'la base de pruebas no está sembrada (npm run test:db:reset)');

  // Act
  const resultado = await rest('movimientos?select=id,monto&limit=5', { clave: ANON });

  // Assert
  assert.ok(lecturaBloqueada(resultado), `anon leyó movimientos: ${JSON.stringify(resultado.datos)}`);
});

for (const tabla of TABLAS_SENSIBLES) {
  test(`CP-FIN-16-09 · la clave anon no lee ${tabla}`, { skip: omitir }, async () => {
    // Arrange: nada que preparar; la tabla existe en el esquema y se consulta sin sesión.

    // Act
    const resultado = await rest(`${tabla}?select=*&limit=3`, { clave: ANON });

    // Assert
    assert.ok(
      lecturaBloqueada(resultado),
      `DEF-018: anon leyó ${resultado.datos.length} fila(s) de ${tabla} sin iniciar sesión`
    );
  });
}

test('CP-FIN-16-09 · la clave anon no puede asignarse permiso de editor en Finanzas', { skip: omitir }, async (t) => {
  // Arrange: U-03 (test.contable) no tiene permiso manual en el módulo finance.
  const [usuario] = (await rest('usuarios?select=id&email=eq.test.contable@nexacore.test', { clave: SERVICE })).datos;
  const [modulo] = (await rest('modulos?select=id&nombre=eq.finance', { clave: SERVICE })).datos;
  assert.ok(usuario && modulo, 'faltan U-03 o el módulo finance: correr npm run test:db:reset');
  const filtro = `usuario_modulo_permisos?usuario_id=eq.${usuario.id}&modulo_id=eq.${modulo.id}`;
  const previos = (await rest(`${filtro}&select=id`, { clave: SERVICE })).datos;
  assert.equal(previos.length, 0, 'U-03 ya tenía un permiso manual en finance');

  // Si la escritura indebida llega a crearse, se borra para no dejar la base alterada.
  t.after(async () => {
    await rest(filtro, { clave: SERVICE, metodo: 'DELETE' });
  });

  // Act
  await rest('usuario_modulo_permisos', {
    clave: ANON, metodo: 'POST', prefer: 'return=representation',
    cuerpo: { usuario_id: usuario.id, modulo_id: modulo.id, permiso: 'editor', alcance: 'global' },
  });

  // Assert: el permiso no existe, verificado con la clave del backend.
  const despues = (await rest(`${filtro}&select=id,permiso`, { clave: SERVICE })).datos;
  assert.deepEqual(despues, [], `DEF-018: anon creó un permiso de Finanzas para U-03: ${JSON.stringify(despues)}`);
});
