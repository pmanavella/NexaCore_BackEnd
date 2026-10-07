const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const nexiService = require('../nexi/services/nexiService');
const conversacionesService = require('../nexi/services/conversacionesService');
const auditoriaService = require('../nexi/services/auditoriaService');
const repositorio = require('../nexi/services/reportesRepositorio');
const registry = require('../nexi/tools/registry');
const organizacionService = require('../organization/services/organizacionService');
const { crearGeminiProvider } = require('../nexi/providers/geminiProvider');
const { crearLimitadorPorUsuario } = require('../nexi/middleware/rateLimit');
const nexiErrorHandler = require('../nexi/middleware/nexiErrorHandler');
const { errorTimeoutGlobal } = require('../nexi/utils/plazo');
const { construirInstruccionSistema } = require('../nexi/services/contextoService');
const { PROVEEDOR } = require('../nexi/config/nexi');

const USUARIO = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'm@x.test', name: 'Mariano', role: 'Operativo' };
const CONV_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const RESPUESTA_OK = {
  ok: true,
  status: 200,
  json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }] }),
};

// fetch simulado: cada elemento de `comportamientos` es 'colgar' (no responde
// hasta que el AbortController lo cancela, como el fetch real) o una respuesta.
function fetchSimulado(t, ...comportamientos) {
  const inicios = [];
  const mock = t.mock.method(globalThis, 'fetch', (url, opciones) => {
    inicios.push(Date.now());
    const c = comportamientos[Math.min(inicios.length - 1, comportamientos.length - 1)];
    if (c !== 'colgar') return Promise.resolve(c);
    return new Promise((_, reject) => {
      opciones.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  });
  return { mock, inicios };
}

function proveedor(opciones = {}) {
  return crearGeminiProvider({ obtenerApiKey: () => 'k', reintentosMs: [], timeoutMs: 40, margenMinimoReintentoMs: 20, ...opciones });
}

const ENTRADA = { sistema: 's', turnos: [{ rol: 'usuario', texto: 'hola' }] };

// ── Configuración ───────────────────────────────────────────────────────────

test('config: timeout por intento de 15 s por defecto y 1 reintento por timeout', () => {
  assert.equal(PROVEEDOR.TIMEOUT_MS, Number(process.env.NEXI_PROVIDER_TIMEOUT_MS) || 15000);
  assert.equal(PROVEEDOR.REINTENTOS_POR_TIMEOUT, 1);
  assert.ok(PROVEEDOR.MARGEN_MINIMO_REINTENTO_MS > 0);
});

// ── Proveedor ───────────────────────────────────────────────────────────────

test('Gemini responde antes del timeout → éxito normal, un intento, sin eventos', async (t) => {
  const { mock } = fetchSimulado(t, RESPUESTA_OK);
  const eventos = [];
  const r = await proveedor().generar({ ...ENTRADA, alEvento: (...e) => eventos.push(e) });
  assert.equal(r.texto, 'ok');
  assert.equal(mock.mock.callCount(), 1);
  assert.deepEqual(eventos, []);
});

test('primer intento supera el timeout → se reintenta y el segundo responde', async (t) => {
  const { mock } = fetchSimulado(t, 'colgar', RESPUESTA_OK);
  const eventos = [];
  const r = await proveedor().generar({ ...ENTRADA, venceEn: Date.now() + 5000, alEvento: (tipo, estado, datos) => eventos.push({ tipo, estado, datos }) });
  assert.equal(r.texto, 'ok');
  assert.equal(mock.mock.callCount(), 2);
  assert.deepEqual(eventos.map(e => [e.tipo, e.estado]), [
    ['TIMEOUT_INTENTO', 'ERROR'], ['REINTENTO_TIMEOUT', 'OK'], ['EXITO_TRAS_REINTENTO', 'OK'],
  ]);
  assert.equal(eventos[0].datos.intento, 1);
  assert.equal(eventos[1].datos.intento, 2);
  // Solo datos numéricos: nunca contenido ni claves.
  assert.doesNotMatch(JSON.stringify(eventos), /hola|"k"|sistema/);
});

test('ambos intentos superan el timeout → TIMEOUT tras exactamente 2 intentos (sin loops)', async (t) => {
  const { mock } = fetchSimulado(t, 'colgar');
  const eventos = [];
  await assert.rejects(
    () => proveedor().generar({ ...ENTRADA, venceEn: Date.now() + 5000, alEvento: tipo => eventos.push(tipo) }),
    err => err.proveedor && err.codigo === 'TIMEOUT'
  );
  assert.equal(mock.mock.callCount(), 2);
  assert.deepEqual(eventos, ['TIMEOUT_INTENTO', 'REINTENTO_TIMEOUT', 'TIMEOUT_INTENTO', 'TIMEOUT_DEFINITIVO']);
});

test('sin margen suficiente en el plazo global no se reintenta', async (t) => {
  const { mock } = fetchSimulado(t, 'colgar', RESPUESTA_OK);
  const eventos = [];
  // Tras el primer intento (40 ms) quedan ~20 ms < margen de 50 ms.
  await assert.rejects(
    () => proveedor({ margenMinimoReintentoMs: 50 }).generar({ ...ENTRADA, venceEn: Date.now() + 60, alEvento: (tipo, estado, datos) => eventos.push({ tipo, datos }) }),
    err => err.codigo === 'TIMEOUT'
  );
  assert.equal(mock.mock.callCount(), 1);
  assert.deepEqual(eventos.map(e => e.tipo), ['TIMEOUT_INTENTO', 'TIMEOUT_DEFINITIVO']);
  assert.ok(eventos[1].datos.restante_ms < 50);
});

test('el reintento nunca extiende la consulta más allá del plazo global', async (t) => {
  const { inicios } = fetchSimulado(t, 'colgar');
  const venceEn = Date.now() + 70;
  const eventos = [];
  await assert.rejects(
    () => proveedor({ timeoutMs: 40, margenMinimoReintentoMs: 10 }).generar({ ...ENTRADA, venceEn, alEvento: (tipo, estado, datos) => eventos.push({ tipo, datos }) }),
    err => err.codigo === 'TIMEOUT'
  );
  // El segundo intento se recortó a lo que quedaba (≈30 ms), no a 40 ms.
  assert.equal(inicios.length, 2);
  const segundo = eventos.filter(e => e.tipo === 'TIMEOUT_INTENTO')[1];
  assert.ok(segundo.datos.timeout_ms < 40, `timeout del 2.º intento: ${segundo.datos.timeout_ms}`);
  assert.ok(Date.now() <= venceEn + 25, `terminó ${Date.now() - venceEn} ms después del plazo`);
});

test('plazo global ya agotado → no se llama a Gemini', async (t) => {
  const { mock } = fetchSimulado(t, RESPUESTA_OK);
  await assert.rejects(() => proveedor().generar({ ...ENTRADA, venceEn: Date.now() - 1 }), err => err.codigo === 'TIMEOUT');
  assert.equal(mock.mock.callCount(), 0);
});

test('los reintentos HTTP 503 siguen funcionando y son independientes del reintento por timeout', async (t) => {
  const error503 = { ok: false, status: 503, statusText: 'x', json: async () => ({}) };
  const { mock } = fetchSimulado(t, error503, 'colgar', RESPUESTA_OK);
  const r = await proveedor({ reintentosMs: [1] }).generar({ ...ENTRADA, venceEn: Date.now() + 5000 });
  assert.equal(r.texto, 'ok');
  assert.equal(mock.mock.callCount(), 3);
});

// ── Chat (nexiService) ──────────────────────────────────────────────────────

function prepararChat(t, niveles = { operations: 'lector' }) {
  t.mock.method(conversacionesService, 'obtenerPropia', async () => ({ id: CONV_ID, titulo: 'x' }));
  t.mock.method(conversacionesService, 'historialReciente', async () => []);
  const guardar = t.mock.method(conversacionesService, 'guardarIntercambio', async (id, { respuesta }) => ({ id: 'm', rol: 'asistente', contenido: respuesta }));
  t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => Object.entries(niveles).map(([nombre, permiso]) => ({
    permiso, alcance: 'global', source: 'usuario', modulos: { nombre, label: nombre === 'reportes' ? 'Reportes' : nombre },
  })));
  const auditoria = t.mock.method(auditoriaService, 'registrar', async () => {});
  const original = nexiService.proveedor;
  nexiService.proveedor = proveedor();
  t.after(() => { nexiService.proveedor = original; });
  return { guardar, auditoria };
}

test('chat: timeout en el primer intento y éxito en el reintento → 200 y auditoría del reintento', async (t) => {
  const { auditoria } = prepararChat(t);
  fetchSimulado(t, 'colgar', RESPUESTA_OK);
  const r = await nexiService.chat({ usuario: USUARIO, conversationId: CONV_ID, mensaje: 'hola' });
  assert.equal(r.mensaje.contenido, 'ok');
  const eventos = auditoria.mock.calls.map(c => c.arguments[0]).filter(a => a.herramienta === '(proveedor)');
  assert.deepEqual(eventos.map(e => e.motivo), ['TIMEOUT_INTENTO', 'REINTENTO_TIMEOUT', 'EXITO_TRAS_REINTENTO']);
  assert.ok(eventos.every(e => e.usuarioId === USUARIO.id && e.conversacionId === CONV_ID));
});

test('chat: ambos intentos con timeout → 504 NEXI_TIMEOUT, timeout definitivo auditado, nada guardado', async (t) => {
  const { auditoria, guardar } = prepararChat(t);
  t.mock.method(console, 'warn', () => {});
  fetchSimulado(t, 'colgar');
  await assert.rejects(
    () => nexiService.chat({ usuario: USUARIO, conversationId: CONV_ID, mensaje: 'hola' }),
    err => err.publico && err.status === 504 && err.codigo === 'NEXI_TIMEOUT'
  );
  const motivos = auditoria.mock.calls.map(c => c.arguments[0].motivo);
  assert.ok(motivos.includes('TIMEOUT_DEFINITIVO'));
  assert.ok(motivos.includes('TIMEOUT_PROVEEDOR'));
  assert.equal(guardar.mock.callCount(), 0);
});

test('chat: el plazo global corta aunque el proveedor siga reintentando', async (t) => {
  prepararChat(t);
  t.mock.method(console, 'warn', () => {});
  fetchSimulado(t, 'colgar');
  nexiService.proveedor = proveedor({ timeoutMs: 1000, margenMinimoReintentoMs: 1 });
  const inicio = Date.now();
  await assert.rejects(
    () => nexiService.chat({ usuario: USUARIO, conversationId: CONV_ID, mensaje: 'hola', timeoutTotalMs: 60 }),
    err => err.codigo === 'NEXI_TIMEOUT'
  );
  assert.ok(Date.now() - inicio < 300, `duró ${Date.now() - inicio} ms`);
});

// ── Concurrencia tras timeout (HTTP real con el rate limit y el error handler) ──

test('el estado de concurrencia se libera después de un 504 por timeout', async (t) => {
  const app = express();
  app.use((req, res, next) => { req.user = { id: USUARIO.id }; next(); });
  const limitador = crearLimitadorPorUsuario({ porMinuto: 10, porHora: 10, concurrentes: 1 });
  t.after(() => limitador._detener());
  app.post('/chat', limitador, (req, res, next) => setTimeout(() => next(errorTimeoutGlobal()), 10));
  app.use(nexiErrorHandler);
  const server = http.createServer(app).listen(0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/chat`;

  const r1 = await fetch(url, { method: 'POST' });
  assert.equal(r1.status, 504);
  assert.equal((await r1.json()).codigo, 'NEXI_TIMEOUT');
  // Si la concurrencia no se liberara, este segundo pedido sería 429.
  const r2 = await fetch(url, { method: 'POST' });
  assert.equal(r2.status, 504);
  assert.equal(limitador._estado.get(USUARIO.id).enCurso, 0);
});

// ── Permisos de Reportes ────────────────────────────────────────────────────

test('sin permiso en Reportes: no recibe generar_reporte y el contexto lo informa como permiso, no como incapacidad', async (t) => {
  const niveles = new Map([['operations', { nivel: 'lector', alcance: 'global', label: 'Operativo' }], ['reportes', { nivel: 'sin_acceso', label: 'Reportes' }]]);
  assert.ok(!registry.herramientasDisponibles(niveles, null, USUARIO).some(h => h.nombre === 'generar_reporte'));
  const sinAcceso = registry.modulosSinAcceso(niveles, USUARIO);
  assert.deepEqual(sinAcceso.find(m => m.modulo === 'reportes'), { modulo: 'reportes', label: 'Reportes', motivo: 'SIN_PERMISO' });
  assert.ok(!sinAcceso.some(m => m.modulo === 'operations'));

  const s = construirInstruccionSistema({ usuario: USUARIO, modulosHabilitados: ['Operativo'], herramientas: [], hoy: { fecha: '2026-10-07' }, sinAcceso });
  assert.match(s, /FUNCIONES BLOQUEADAS POR LOS PERMISOS DE ESTE USUARIO \(Nexi sí puede hacerlas/);
  assert.match(s, /- Reportes: consultar reportes y GENERAR reportes en PDF \(el usuario no tiene permisos\)\./);
  assert.match(s, /nunca la atribuyas a Nexi \("no puedo", "no tengo permisos"/);
  assert.match(s, /"No tenés permisos para generar reportes\."/);
  assert.match(s, /ni digas que Nexi no puede hacerlo en general/);
  assert.doesNotMatch(s, /Matriz|rol_modulo|usuario_modulo_permisos/);
});

test('sin permiso en Reportes: el chat no ofrece la tool, no crea reportes y pasa la causa estructurada', async (t) => {
  prepararChat(t, { operations: 'lector', reportes: 'sin_acceso' });
  const crear = t.mock.method(repositorio, 'crear', async () => 'x');
  const generar = t.mock.method(nexiService.proveedor, 'generar', async () => ({ texto: 'No tenés permisos para generar reportes.', llamadas: [], crudo: null, truncado: false }));
  const r = await nexiService.chat({ usuario: USUARIO, conversationId: CONV_ID, mensaje: 'Generame un reporte operativo del tercer trimestre' });
  const { herramientas, sistema } = generar.mock.calls[0].arguments[0];
  assert.ok(!herramientas.some(h => h.nombre === 'generar_reporte'));
  assert.match(sistema, /- Reportes: .*\(el usuario no tiene permisos\)/);
  assert.equal(crear.mock.callCount(), 0);
  assert.deepEqual(r.reportes, []);
});

test('si el modelo invoca generar_reporte sin permiso: DENEGADO con causa SIN_PERMISO y módulo, sin crear nada', async (t) => {
  t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => [
    { permiso: 'sin_acceso', alcance: null, source: 'ninguno', modulos: { nombre: 'reportes', label: 'Reportes' } },
  ]);
  t.mock.method(auditoriaService, 'registrar', async () => {});
  const crear = t.mock.method(repositorio, 'crear', async () => 'x');
  const r = await registry.ejecutar({ nombre: 'generar_reporte', argumentos: { tipo: 'operativo', periodo: '2026-Q3' }, usuario: USUARIO });
  assert.equal(r.estado, 'DENEGADO');
  assert.equal(r.resultado.causa, 'SIN_PERMISO');
  assert.equal(r.resultado.modulo, 'Reportes');
  assert.match(r.resultado.error, /no tiene permisos/);
  assert.match(r.resultado.error, /No es una limitación de Nexi/);
  assert.equal(crear.mock.callCount(), 0);
});
