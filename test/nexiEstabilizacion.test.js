const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const nexiService = require('../nexi/services/nexiService');
const conversacionesService = require('../nexi/services/conversacionesService');
const registry = require('../nexi/tools/registry');
const nexiPermisos = require('../nexi/services/nexiPermisos');
const nexiAlcance = require('../nexi/services/nexiAlcance');
const auditoriaService = require('../nexi/services/auditoriaService');
const nexiDatos = require('../nexi/services/nexiDatos');
const organizacionService = require('../organization/services/organizacionService');
const { crearGeminiProvider, _interpretarRespuesta } = require('../nexi/providers/geminiProvider');
const { crearLimitadorPorUsuario } = require('../nexi/middleware/rateLimit');
const { crearPlazo } = require('../nexi/utils/plazo');
const { LIMITES } = require('../nexi/config/nexi');

const AHORA = new Date('2026-09-27T15:00:00Z');
const USUARIO = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'ana@nexacore.test', name: 'Ana Pérez', role: 'Operativo' };
const CONV_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const U_EQUIPO = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const U_NIETO = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const U_AJENO = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function permisos(niveles) {
  return Object.entries(niveles).map(([nombre, v]) => ({
    permiso: typeof v === 'string' ? v : v.permiso,
    alcance: typeof v === 'string' ? 'global' : v.alcance,
    source: 'usuario',
    modulos: { nombre, label: nombre },
  }));
}

function prepararChat(t, niveles = { finance: 'lector' }) {
  return {
    obtenerPropia: t.mock.method(conversacionesService, 'obtenerPropia', async () => ({ id: CONV_ID, titulo: 'x' })),
    crear: t.mock.method(conversacionesService, 'crear', async () => ({ id: CONV_ID, titulo: 'x' })),
    historial: t.mock.method(conversacionesService, 'historialReciente', async () => []),
    guardar: t.mock.method(conversacionesService, 'guardarIntercambio', async (id, { respuesta }) => ({ id: 'm', rol: 'asistente', contenido: respuesta })),
    eliminarSiVacia: t.mock.method(conversacionesService, 'eliminarSiVacia', async () => {}),
    permisos: t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => permisos(niveles)),
    auditoria: t.mock.method(auditoriaService, 'registrar', async () => {}),
  };
}

function respuestas(t, ...secuencia) {
  let i = 0;
  return t.mock.method(nexiService.proveedor, 'generar', async (entrada) => {
    const r = typeof secuencia[i] === 'function' ? secuencia[i](entrada) : secuencia[i];
    i = Math.min(i + 1, secuencia.length - 1);
    if (r instanceof Error) throw r;
    return r;
  });
}

// ── 2. Listado de mensajes: últimos N en orden cronológico ──────────────────

test('listarMensajes pide los ÚLTIMOS N (orden descendente + límite) y los devuelve en orden cronológico', async (t) => {
  const llamadas = [];
  t.mock.method(conversacionesService, 'obtenerPropia', async () => ({ id: CONV_ID, titulo: 'x' }));
  t.mock.method(supabase, 'from', (tabla) => {
    const builder = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') {
          // La base devuelve en el orden pedido (descendente).
          return (resolve) => resolve({ data: [{ id: 'm3', created_at: '3' }, { id: 'm2', created_at: '2' }], error: null });
        }
        return (...args) => { llamadas.push({ tabla, metodo: prop, args }); return builder; };
      },
    });
    return builder;
  });
  const r = await conversacionesService.listarMensajes(CONV_ID, USUARIO.id);
  const orden = llamadas.find(c => c.metodo === 'order');
  assert.deepEqual(orden.args, ['created_at', { ascending: false }]);
  assert.deepEqual(llamadas.find(c => c.metodo === 'limit').args, [LIMITES.MAX_MENSAJES_LISTADO]);
  assert.deepEqual(r.data.map(m => m.id), ['m2', 'm3']);
  // El contrato público se mantiene: { conversacion, data }.
  assert.deepEqual(Object.keys(r).sort(), ['conversacion', 'data']);
});

// ── 3. MAX_TOKENS ───────────────────────────────────────────────────────────

test('gemini: finishReason MAX_TOKENS se marca como truncado (texto o llamadas)', () => {
  const r = _interpretarRespuesta({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'Los ingresos fueron de $1.2' }] } }] });
  assert.equal(r.truncado, true);
  const sinTexto = _interpretarRespuesta({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] });
  assert.equal(sinTexto.truncado, true);
  const normal = _interpretarRespuesta({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }] });
  assert.equal(normal.truncado, false);
});

test('chat: respuesta truncada → reintento breve; si el reintento es completo se usa ese', async (t) => {
  prepararChat(t);
  const generar = respuestas(t,
    { texto: 'Respuesta larguísima cortada a la mit', llamadas: [], crudo: null, truncado: true },
    { texto: 'Versión breve.', llamadas: [], crudo: null, truncado: false },
  );
  const r = await nexiService.chat({ usuario: USUARIO, conversationId: CONV_ID, mensaje: 'resumen' });
  assert.equal(r.mensaje.contenido, 'Versión breve.');
  assert.equal(generar.mock.callCount(), 2);
  assert.doesNotMatch(generar.mock.calls[0].arguments[0].sistema, /superó el largo máximo/);
  assert.match(generar.mock.calls[1].arguments[0].sistema, /superó el largo máximo/);
});

test('chat: truncada dos veces → mensaje explícito, nunca el texto truncado, sin loop', async (t) => {
  const m = prepararChat(t);
  t.mock.method(console, 'warn', () => {});
  const generar = respuestas(t, () => ({ texto: 'Texto cortado', llamadas: [], crudo: null, truncado: true }));
  const r = await nexiService.chat({ usuario: USUARIO, conversationId: CONV_ID, mensaje: 'todo' });
  assert.equal(r.mensaje.contenido, nexiService.MENSAJE_RESPUESTA_EXTENSA);
  assert.equal(generar.mock.callCount(), 1 + LIMITES.MAX_REINTENTOS_RESPUESTA_TRUNCADA);
  assert.doesNotMatch(m.guardar.mock.calls[0].arguments[1].respuesta, /Texto cortado/);
});

test('chat: llamadas a herramientas truncadas no se ejecutan', async (t) => {
  prepararChat(t);
  t.mock.method(console, 'warn', () => {});
  const ejecutar = t.mock.method(registry, 'ejecutar');
  respuestas(t, () => ({ texto: '', llamadas: [{ id: 'c', nombre: 'resumen_finanzas', argumentos: { mes: 1 } }], crudo: null, truncado: true }));
  const r = await nexiService.chat({ usuario: USUARIO, conversationId: CONV_ID, mensaje: 'x' });
  assert.equal(r.mensaje.contenido, nexiService.MENSAJE_RESPUESTA_EXTENSA);
  assert.equal(ejecutar.mock.callCount(), 0);
});

// ── 4. Timeout global ───────────────────────────────────────────────────────

test('plazo: carrera corta una promesa colgada y verificar falla al vencer', async () => {
  const plazo = crearPlazo(20);
  await assert.rejects(() => plazo.carrera(new Promise(() => {})), err => err.codigo === 'NEXI_TIMEOUT' && err.status === 504 && err.publico);
  assert.throws(() => plazo.verificar(), err => err.codigo === 'NEXI_TIMEOUT');
});

test('timeout global: proveedor colgado → 504 NEXI_TIMEOUT, auditoría y limpieza de la conversación nueva', async (t) => {
  const m = prepararChat(t);
  t.mock.method(console, 'warn', () => {});
  respuestas(t, () => new Promise(() => {}));
  await assert.rejects(
    () => nexiService.chat({ usuario: USUARIO, mensaje: 'hola', timeoutTotalMs: 30 }),
    err => err.status === 504 && err.codigo === 'NEXI_TIMEOUT' && err.publico
  );
  assert.equal(m.eliminarSiVacia.mock.callCount(), 1);
  assert.equal(m.guardar.mock.callCount(), 0);
  const reg = m.auditoria.mock.calls.map(c => c.arguments[0]).find(a => a.motivo === 'TIMEOUT_GLOBAL');
  assert.ok(reg, 'se audita el corte por plazo global');
  assert.equal(reg.usuarioId, USUARIO.id);
});

test('timeout global: herramienta colgada → no se llama más al modelo ni a otras herramientas; se audita', async (t) => {
  const m = prepararChat(t);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(nexiDatos, 'totalesMovimientos', () => new Promise(() => {}));
  t.mock.method(nexiDatos, 'contarComprobantesEnRevision', async () => 0);
  const generar = respuestas(t,
    { texto: '', llamadas: [
      { id: 'c1', nombre: 'resumen_finanzas', argumentos: {} },
      { id: 'c2', nombre: 'flujo_financiero', argumentos: {} },
    ], crudo: {} },
    { texto: 'no debería llegar', llamadas: [], crudo: null },
  );
  await assert.rejects(
    () => nexiService.chat({ usuario: USUARIO, conversationId: CONV_ID, mensaje: 'x', ahora: AHORA, timeoutTotalMs: 40 }),
    err => err.codigo === 'NEXI_TIMEOUT'
  );
  assert.equal(generar.mock.callCount(), 1);
  const auditadas = m.auditoria.mock.calls.map(c => c.arguments[0]);
  assert.ok(auditadas.some(a => a.herramienta === 'resumen_finanzas' && a.motivo === 'TIMEOUT_GLOBAL'));
  assert.ok(!auditadas.some(a => a.herramienta === 'flujo_financiero'), 'no se inicia la segunda herramienta');
});

test('gemini: el timeout por intento nunca supera el plazo global y no reintenta si no hay tiempo', async (t) => {
  let llamadas = 0;
  t.mock.method(globalThis, 'fetch', async (url, opciones) => {
    llamadas++;
    return new Promise((_, reject) => opciones.signal.addEventListener('abort', () => reject(Object.assign(new Error('abort'), { name: 'AbortError' }))));
  });
  const proveedor = crearGeminiProvider({ obtenerApiKey: () => 'k', timeoutMs: 10000, reintentosMs: [5] });
  const inicio = Date.now();
  await assert.rejects(
    () => proveedor.generar({ sistema: 's', turnos: [{ rol: 'usuario', texto: 'x' }], venceEn: Date.now() + 40 }),
    err => err.codigo === 'TIMEOUT'
  );
  assert.ok(Date.now() - inicio < 1000);
  assert.equal(llamadas, 1);
});

test('rate limit: la concurrencia se libera cuando la respuesta termina con error (p. ej. timeout)', () => {
  const limitador = crearLimitadorPorUsuario({ porMinuto: 10, porHora: 10, concurrentes: 1 });
  t_after(limitador);
  const req = { user: { id: USUARIO.id } };
  const res1 = Object.assign(new EventEmitter(), { set() { return this; }, status() { return this; }, json() { return this; } });
  let siguiente = 0;
  limitador(req, res1, () => siguiente++);
  assert.equal(siguiente, 1);
  // Mientras está en curso, una segunda consulta se rechaza.
  let rechazada = false;
  const res2 = Object.assign(new EventEmitter(), { set() { return this; }, status(c) { rechazada = c === 429; return this; }, json() { return this; } });
  limitador(req, res2, () => siguiente++);
  assert.equal(rechazada, true);
  // El error 504 termina la respuesta → se libera.
  res1.emit('finish');
  limitador(req, Object.assign(new EventEmitter(), { set() { return this; }, status() { return this; }, json() { return this; } }), () => siguiente++);
  assert.equal(siguiente, 2);
  function t_after(l) { l._detener(); }
});

// ── 6. Alcance de permisos ──────────────────────────────────────────────────

test('resolverAlcance: rol → global; permiso particular sin alcance o desconocido → propio', () => {
  assert.equal(nexiPermisos.resolverAlcance({ source: 'rol', alcance: 'global' }), 'global');
  assert.equal(nexiPermisos.resolverAlcance({ source: 'usuario', alcance: 'subarbol' }), 'subarbol');
  assert.equal(nexiPermisos.resolverAlcance({ source: 'usuario', alcance: null }), 'propio');
  assert.equal(nexiPermisos.resolverAlcance({ source: 'usuario', alcance: 'todo' }), 'propio');
  assert.equal(nexiPermisos.resolverAlcance(undefined), 'propio');
});

test('alcance propio en Finanzas: las herramientas globales no se ofrecen ni se ejecutan', async (t) => {
  const niveles = new Map([['finance', { nivel: 'lector', alcance: 'propio' }]]);
  assert.deepEqual(registry.herramientasDisponibles(niveles, null, USUARIO).map(h => h.nombre), []);

  t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => permisos({ finance: { permiso: 'lector', alcance: 'propio' } }));
  t.mock.method(auditoriaService, 'registrar', async () => {});
  const datos = t.mock.method(nexiDatos, 'totalesMovimientos', async () => []);
  const r = await registry.ejecutar({ nombre: 'resumen_finanzas', argumentos: {}, usuario: USUARIO, ahora: AHORA });
  assert.equal(r.estado, 'DENEGADO');
  assert.equal(r.motivo, 'ALCANCE_INSUFICIENTE');
  assert.equal(datos.mock.callCount(), 0);
});

test('alcance propio en Operativo: resumen_operativo NO devuelve conteos globales', async (t) => {
  t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => permisos({ operations: { permiso: 'lector', alcance: 'propio' } }));
  t.mock.method(auditoriaService, 'registrar', async () => {});
  const global = t.mock.method(nexiDatos, 'contarTareas', async () => 999);
  t.mock.method(nexiDatos, 'contarUsuariosConNombre', async () => 1);
  const ids = t.mock.method(nexiDatos, 'idsTareasDeUsuarios', async () => ['t1', 't2', 't3']);
  t.mock.method(nexiDatos, 'filasTareasPorIds', async () => [
    { id: 't1', estado: 'Pendiente', prioridad: 'Alta', fecha_limite: '2026-09-01', tipo: 'asignacion' },
    { id: 't2', estado: 'Completada', prioridad: 'Baja', fecha_limite: '2026-10-10', tipo: null },
    { id: 't3', estado: 'Pendiente', prioridad: 'Media', fecha_limite: null, tipo: 'propuesta' },
  ]);

  const r = await registry.ejecutar({ nombre: 'resumen_operativo', argumentos: {}, usuario: USUARIO, ahora: AHORA });
  assert.equal(r.estado, 'OK');
  assert.equal(global.mock.callCount(), 0, 'nunca se consultan conteos globales');
  assert.deepEqual(ids.mock.calls[0].arguments, [[USUARIO.id], USUARIO.name]);
  const d = r.resultado.datos;
  assert.equal(d.alcance_aplicado, 'propio');
  assert.equal(d.total_asignadas, 2);
  assert.equal(d.por_estado.Pendiente, 1);
  assert.equal(d.abiertas_vencidas, 1);
  assert.equal(d.propuestas_pendientes, null);
});

test('alcance propio con nombre duplicado: solo tareas vinculadas por id (reduce, no amplía)', async (t) => {
  t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => permisos({ operations: { permiso: 'lector', alcance: 'propio' } }));
  t.mock.method(auditoriaService, 'registrar', async () => {});
  t.mock.method(nexiDatos, 'contarUsuariosConNombre', async () => 2);
  const ids = t.mock.method(nexiDatos, 'idsTareasDeUsuarios', async () => []);
  const r = await registry.ejecutar({ nombre: 'resumen_operativo', argumentos: {}, usuario: USUARIO, ahora: AHORA });
  assert.equal(r.estado, 'OK');
  assert.deepEqual(ids.mock.calls[0].arguments, [[USUARIO.id], null]);
  assert.equal(r.resultado.datos.total_asignadas, 0);
  assert.equal(r.resultado.datos.incluye_asignaciones_historicas_por_nombre, false);
});

test('alcance global en Operativo: mismo comportamiento previo (conteos globales)', async (t) => {
  t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => permisos({ operations: 'lector' }));
  t.mock.method(auditoriaService, 'registrar', async () => {});
  t.mock.method(nexiDatos, 'contarTareas', async () => 5);
  const ids = t.mock.method(nexiDatos, 'idsTareasDeUsuarios', async () => []);
  const r = await registry.ejecutar({ nombre: 'resumen_operativo', argumentos: {}, usuario: USUARIO, ahora: AHORA });
  assert.equal(r.resultado.datos.alcance_aplicado, 'global');
  assert.equal(r.resultado.datos.total_asignadas, 5);
  assert.equal(ids.mock.callCount(), 0);
});

// Organigrama: Ana → (Equipo) → (Nieto); Ajeno es par de Ana. Incluye un ciclo.
function organigrama() {
  return [
    { id: 'n-jefe', usuario_id: U_AJENO, superior_id: null, activo: true, usuarios: { nombre: 'Jefa' } },
    { id: 'n-ana', usuario_id: USUARIO.id, superior_id: 'n-jefe', activo: true, usuarios: { nombre: 'Ana' } },
    { id: 'n-eq', usuario_id: U_EQUIPO, superior_id: 'n-ana', activo: true, usuarios: { nombre: 'Equipo' } },
    { id: 'n-emp', usuario_id: null, empleado_id: 'e1', superior_id: 'n-ana', activo: true, empleados: { nombre: 'Emp', apellido: 'Leado' } },
    { id: 'n-nieto', usuario_id: U_NIETO, superior_id: 'n-eq', activo: true, usuarios: { nombre: 'Nieto' } },
    { id: 'n-baja', usuario_id: 'gggggggg-gggg-4ggg-8ggg-gggggggggggg', superior_id: 'n-ana', activo: false, usuarios: { nombre: 'Baja' } },
  ];
}

test('usuariosEnAlcance: usa el organigrama real (superior_id), solo nodos activos y con usuario', async (t) => {
  t.mock.method(organizacionService, 'obtenerOrganigrama', async () => organigrama());
  assert.equal(await nexiAlcance.usuariosEnAlcance(USUARIO, 'global'), null);
  assert.deepEqual(await nexiAlcance.usuariosEnAlcance(USUARIO, 'propio'), [USUARIO.id]);
  assert.deepEqual((await nexiAlcance.usuariosEnAlcance(USUARIO, 'equipo_directo')).sort(), [USUARIO.id, U_EQUIPO].sort());
  assert.deepEqual((await nexiAlcance.usuariosEnAlcance(USUARIO, 'subarbol')).sort(), [USUARIO.id, U_EQUIPO, U_NIETO].sort());
  // Nunca incluye al superior ni a pares.
  assert.ok(!(await nexiAlcance.usuariosEnAlcance(USUARIO, 'subarbol')).includes(U_AJENO));
});

test('usuariosEnAlcance: sin nodo en el organigrama → solo el propio usuario; ciclos no cuelgan', async (t) => {
  t.mock.method(organizacionService, 'obtenerOrganigrama', async () => [
    { id: 'a', usuario_id: USUARIO.id, superior_id: 'b', activo: true },
    { id: 'b', usuario_id: U_EQUIPO, superior_id: 'a', activo: true },
  ]);
  assert.deepEqual((await nexiAlcance.usuariosEnAlcance(USUARIO, 'subarbol')).sort(), [USUARIO.id, U_EQUIPO].sort());
  assert.deepEqual(await nexiAlcance.usuariosEnAlcance({ id: U_AJENO }, 'subarbol'), [U_AJENO]);
});

test('alcance equipo_directo en Operativo: cuenta tareas del usuario y sus reportes directos', async (t) => {
  t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => permisos({ operations: { permiso: 'lector', alcance: 'equipo_directo' } }));
  t.mock.method(organizacionService, 'obtenerOrganigrama', async () => organigrama());
  t.mock.method(auditoriaService, 'registrar', async () => {});
  t.mock.method(nexiDatos, 'contarUsuariosConNombre', async () => 1);
  const ids = t.mock.method(nexiDatos, 'idsTareasDeUsuarios', async () => []);
  const r = await registry.ejecutar({ nombre: 'resumen_operativo', argumentos: {}, usuario: USUARIO, ahora: AHORA });
  assert.equal(r.resultado.datos.alcance_aplicado, 'equipo_directo');
  assert.deepEqual(ids.mock.calls[0].arguments[0].sort(), [USUARIO.id, U_EQUIPO].sort());
});

test('mis_tareas_pendientes (PERSONAL) funciona con cualquier alcance', async (t) => {
  t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => permisos({ operations: { permiso: 'lector', alcance: 'propio' } }));
  t.mock.method(auditoriaService, 'registrar', async () => {});
  t.mock.method(nexiDatos, 'contarUsuariosConNombre', async () => 1);
  t.mock.method(nexiDatos, 'tareasAbiertasAsignadasA', async () => ({ filas: [], total: 0 }));
  const r = await registry.ejecutar({ nombre: 'mis_tareas_pendientes', argumentos: {}, usuario: USUARIO, ahora: AHORA });
  assert.equal(r.estado, 'OK');
});

test('registro: alcancesPermitidos se valida y por defecto solo admite global (fail-closed)', () => {
  const base = {
    nombre: 'resumen_x', descripcion: 'x',
    parametros: { type: 'object', properties: {}, additionalProperties: false },
    requisitos: [{ modulo: 'finance', permiso: 'lector' }], alcance: 'AGREGADA', handler: async () => ({}),
  };
  assert.deepEqual(registry._crearRegistro([base]).get('resumen_x').alcancesPermitidos, ['global']);
  assert.throws(() => registry._crearRegistro([{ ...base, alcancesPermitidos: ['todo'] }]), /alcancesPermitidos/);
  assert.throws(() => registry._crearRegistro([{ ...base, alcancesPermitidos: [] }]), /alcancesPermitidos/);
});
