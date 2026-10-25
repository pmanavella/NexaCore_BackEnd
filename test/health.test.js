// GET /api/health (H-37, plan de contingencia §10.1): debe reflejar el estado real de Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');
const { crearHealthCheck } = require('../utils/healthCheck');

function supabaseQueResponde(resultado) {
  const llamadas = [];
  return {
    llamadas,
    from(tabla) {
      llamadas.push(tabla);
      return { select: () => resultado };
    },
  };
}

function respuestaFalsa() {
  const r = { statusCode: null, cuerpo: null };
  r.status = codigo => { r.statusCode = codigo; return r; };
  r.json = cuerpo => { r.cuerpo = cuerpo; return r; };
  return r;
}

test('health: Supabase responde → 200, db ok y versión desplegada', async () => {
  // Arrange
  const supabase = supabaseQueResponde(Promise.resolve({ count: 11, error: null }));
  const handler = crearHealthCheck({ supabase, version: 'abc1234' });
  const res = respuestaFalsa();

  // Act
  await handler({}, res);

  // Assert
  assert.equal(res.statusCode, 200);
  assert.equal(res.cuerpo.status, 'ok');
  assert.equal(res.cuerpo.db, 'ok');
  assert.equal(res.cuerpo.version, 'abc1234');
  assert.deepEqual(supabase.llamadas, ['modulos']);
});

test('health: Supabase devuelve error → 503 degradado, sin exponer el mensaje técnico', async () => {
  // Arrange
  const supabase = supabaseQueResponde(Promise.resolve({ data: null, error: { message: 'FATAL: password authentication failed for user x' } }));
  const handler = crearHealthCheck({ supabase, version: 'abc1234' });
  const res = respuestaFalsa();

  // Act
  await handler({}, res);

  // Assert
  assert.equal(res.statusCode, 503);
  assert.equal(res.cuerpo.status, 'degradado');
  assert.equal(res.cuerpo.db, 'error');
  assert.doesNotMatch(JSON.stringify(res.cuerpo), /password|FATAL/);
});

test('health: Supabase no contesta (conexión caída) → 503 sin colgarse', async () => {
  // Arrange
  const supabase = supabaseQueResponde(Promise.reject(new TypeError('fetch failed')));
  const handler = crearHealthCheck({ supabase, version: 'abc1234' });
  const res = respuestaFalsa();

  // Act
  await handler({}, res);

  // Assert
  assert.equal(res.statusCode, 503);
  assert.equal(res.cuerpo.db, 'error');
});

test('health: Supabase tarda más que el plazo → 503 por timeout', async () => {
  // Arrange: una consulta que nunca termina y un plazo de 20 ms.
  const supabase = supabaseQueResponde(new Promise(() => {}));
  const handler = crearHealthCheck({ supabase, version: 'abc1234', timeoutMs: 20 });
  const res = respuestaFalsa();

  // Act
  const inicio = Date.now();
  await handler({}, res);

  // Assert
  assert.equal(res.statusCode, 503);
  assert.match(res.cuerpo.detalle, /no respondió a tiempo/);
  assert.ok(Date.now() - inicio < 1000, 'el health no debe quedar colgado');
});
