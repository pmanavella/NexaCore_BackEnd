const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const { NIVELES_JERARQUICOS, resolverNivelJerarquico, rolEsSeleccionable } = require('../rbac/config/jerarquia');
const { requireHierarchy } = require('../middleware/rbacMiddleware');
const organizacionService = require('../organization/services/organizacionService');
const rbacService = require('../rbac/services/rbacService');
const protocolosRoutes = require('../protocolos/routes/protocolosRoutes');
const errorHandler = require('../middleware/errorHandler');

const { HIGH, MEDIUM, LOW, NONE } = NIVELES_JERARQUICOS;

// Query builder falso de Supabase: registra la cadena de llamadas y, al
// awaitearse, responde con handler({ table, ops }).
function fakeFrom(handler, llamadas = []) {
  return (table) => {
    const st = { table, ops: [] };
    llamadas.push(st);
    const builder = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve(handler(st)).then(res, rej);
        return (...args) => { st.ops.push([prop, ...args]); return builder; };
      },
    });
    return builder;
  };
}
const op = (st, nombre) => st.ops.find(o => o[0] === nombre);

// ── Fuente de verdad rol -> jerarquía ───────────────────────────────────────

test('resolverNivelJerarquico: roles definitivos por nombre (respaldo previo a la migración)', () => {
  assert.equal(resolverNivelJerarquico('Superadmin'), HIGH);
  assert.equal(resolverNivelJerarquico('Dirección'), HIGH);
  assert.equal(resolverNivelJerarquico('Comercial'), MEDIUM);
  assert.equal(resolverNivelJerarquico('Contable'), LOW);
  assert.equal(resolverNivelJerarquico('Operativo'), LOW);
  assert.equal(resolverNivelJerarquico('Auditor / Lector'), LOW);
  assert.equal(resolverNivelJerarquico('Pasante'), LOW);
  assert.equal(resolverNivelJerarquico('Externo'), NONE);
});

test('resolverNivelJerarquico: legacy y casos borde', () => {
  assert.equal(resolverNivelJerarquico({ nombre: 'Mando Medio' }), MEDIUM);
  assert.equal(resolverNivelJerarquico({ nombre: 'Director' }), HIGH);
  assert.equal(resolverNivelJerarquico({ nombre: 'Operario' }), LOW);
  assert.equal(resolverNivelJerarquico({ nombre: 'Rol Desconocido' }), LOW);
  assert.equal(resolverNivelJerarquico(null), null);
  assert.equal(resolverNivelJerarquico({}), null);
});

test('resolverNivelJerarquico: la columna roles.nivel_jerarquico prevalece sobre el nombre', () => {
  assert.equal(resolverNivelJerarquico({ nombre: 'Comercial', nivel_jerarquico: 'HIGH' }), HIGH);
  // Valor inválido en la fila -> se ignora y se usa el respaldo por nombre
  assert.equal(resolverNivelJerarquico({ nombre: 'Comercial', nivel_jerarquico: 'FOO' }), MEDIUM);
});

test('rolEsSeleccionable: activo=false (legacy) no es asignable; sin columna sí', () => {
  assert.equal(rolEsSeleccionable({ nombre: 'Mando Medio', activo: false }), false);
  assert.equal(rolEsSeleccionable({ nombre: 'Comercial', activo: true }), true);
  assert.equal(rolEsSeleccionable({ nombre: 'Comercial' }), true);
  assert.equal(rolEsSeleccionable(null), false);
});

// ── requireHierarchy ────────────────────────────────────────────────────────

test('requireHierarchy(HIGH): 403 para MEDIUM/LOW/NONE/sin nivel, next() para HIGH', () => {
  const mw = requireHierarchy(HIGH);
  for (const nivel of [MEDIUM, LOW, NONE, null, undefined]) {
    let status = null;
    const res = { status(s) { status = s; return this; }, json() { return this; } };
    mw({ user: { hierarchyLevel: nivel } }, res, () => assert.fail('no debía pasar'));
    assert.equal(status, 403, String(nivel));
  }
  let paso = false;
  mw({ user: { hierarchyLevel: HIGH } }, {}, () => { paso = true; });
  assert.ok(paso);
});

// ── DELETE /api/protocolos/:id (rutas reales + authenticate real) ──────────

async function llamar(app, method, path, headers = {}) {
  const server = http.createServer(app).listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

function appProtocolos() {
  const app = express();
  app.use(express.json());
  app.use('/api/protocolos', protocolosRoutes);
  app.use(errorHandler);
  return app;
}

function prepararDelete(t, rol, llamadas = []) {
  t.mock.method(supabase.auth, 'getUser', async () => ({ data: { user: { email: 'u@x' } }, error: null }));
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    if (st.table === 'usuarios') return { data: { id: 'u1', nombre: 'U', roles: rol }, error: null };
    if (st.table === 'protocolo_pruebas') return { count: 3, error: null };
    if (st.table === 'protocolos' && op(st, 'delete')) return { error: null };
    if (st.table === 'protocolos') return { data: { id: 'p1', nombre: 'Proto' }, error: null };
    throw new Error(`tabla inesperada ${st.table}`);
  }, llamadas));
}

test('DELETE protocolo: 401 sin token', async () => {
  const r = await llamar(appProtocolos(), 'DELETE', '/api/protocolos/p1');
  assert.equal(r.status, 401);
});

for (const rol of [
  { nombre: 'Comercial', nivel_jerarquico: 'MEDIUM' },
  { nombre: 'Mando Medio', nivel_jerarquico: 'MEDIUM', activo: false },
  { nombre: 'Operativo', nivel_jerarquico: 'LOW' },
  { nombre: 'Externo', nivel_jerarquico: 'NONE' },
]) {
  test(`DELETE protocolo: 403 para ${rol.nombre} y no borra nada`, async (t) => {
    const llamadas = [];
    prepararDelete(t, rol, llamadas);
    const r = await llamar(appProtocolos(), 'DELETE', '/api/protocolos/p1', { Authorization: 'Bearer tok' });
    assert.equal(r.status, 403);
    assert.ok(!llamadas.some(st => st.table === 'protocolos'));
  });
}

for (const rol of [{ nombre: 'Superadmin', nivel_jerarquico: 'HIGH' }, { nombre: 'Dirección' }]) {
  test(`DELETE protocolo: 200 para ${rol.nombre} (borrado único en protocolos, hijos por CASCADE)`, async (t) => {
    const llamadas = [];
    prepararDelete(t, rol, llamadas);
    const r = await llamar(appProtocolos(), 'DELETE', '/api/protocolos/p1', { Authorization: 'Bearer tok' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { message: 'Protocolo eliminado correctamente', id: 'p1', nombre: 'Proto', registrosEliminados: 3 });
    const deletes = llamadas.filter(st => op(st, 'delete'));
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].table, 'protocolos');
    assert.deepEqual(op(deletes[0], 'eq'), ['eq', 'id', 'p1']);
  });
}

test('DELETE protocolo: 404 si no existe', async (t) => {
  t.mock.method(supabase.auth, 'getUser', async () => ({ data: { user: { email: 'u@x' } }, error: null }));
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    if (st.table === 'usuarios') return { data: { id: 'u1', nombre: 'U', roles: { nombre: 'Superadmin' } }, error: null };
    return { data: null, error: null };
  }));
  const r = await llamar(appProtocolos(), 'DELETE', '/api/protocolos/nope', { Authorization: 'Bearer tok' });
  assert.equal(r.status, 404);
});

// ── Organigrama: hierarchyLevel ─────────────────────────────────────────────

test('obtenerOrganigrama: expone rol y hierarchyLevel sin alterar superior_id', async (t) => {
  const nodos = [
    { id: 'n1', usuario_id: 'u1', superior_id: null, es_externo: false, usuarios: { nombre: 'A', roles: { nombre: 'Dirección', nivel_jerarquico: 'HIGH' } } },
    { id: 'n2', usuario_id: 'u2', superior_id: 'n1', es_externo: false, usuarios: { nombre: 'B', roles: { nombre: 'Mando Medio', nivel_jerarquico: 'MEDIUM', activo: false } } },
    { id: 'n3', usuario_id: 'u3', superior_id: 'n2', es_externo: true, usuarios: { nombre: 'C', roles: { nombre: 'Externo', nivel_jerarquico: 'NONE' } } },
    { id: 'n4', usuario_id: null, empleado_id: 'e1', superior_id: 'n1', es_externo: false, usuarios: null, empleados: { nombre: 'D' } },
    { id: 'n5', usuario_id: null, superior_id: 'n2', es_externo: true, nombre_manual: 'E', usuarios: null },
    { id: 'n6', usuario_id: 'u6', superior_id: 'n1', es_externo: false, usuarios: { nombre: 'F', roles: { nombre: 'Comercial' } } },
  ];
  t.mock.method(supabase, 'from', fakeFrom(() => ({ data: nodos, error: null })));
  const out = await organizacionService.obtenerOrganigrama();
  assert.deepEqual(out.map(n => [n.id, n.superior_id, n.rol, n.hierarchyLevel]), [
    ['n1', null, 'Dirección', HIGH],
    ['n2', 'n1', 'Mando Medio', MEDIUM],
    ['n3', 'n2', 'Externo', NONE],
    ['n4', 'n1', null, null],
    ['n5', 'n2', null, NONE],
    ['n6', 'n1', 'Comercial', MEDIUM],
  ]);
  // Campos previos se mantienen (contrato backwards-compatible)
  assert.equal(out[0].origen, 'usuario');
  assert.equal(out[0].usuarios.roles.nombre, 'Dirección');
});

// ── Usuarios: roles legacy no asignables ────────────────────────────────────

test('crearUsuario: rechaza rol legacy inactivo antes de crear el auth user', async (t) => {
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    if (st.table === 'roles') return { data: { id: 'r-mm', nombre: 'Mando Medio', activo: false }, error: null };
    throw new Error(`no debía consultar ${st.table}`);
  }));
  const createUser = t.mock.method(supabase.auth.admin, 'createUser', async () => assert.fail('no debía crear'));
  await assert.rejects(
    rbacService.crearUsuario({ email: 'n@x.com', nombre: 'Nuevo Usuario', rol_id: 'r-mm', password: 'secreta123' }),
    (err) => err.status === 400 && /no está disponible/.test(err.message)
  );
  assert.equal(createUser.mock.callCount(), 0);
});

test('actualizarUsuario: un usuario legacy puede editarse conservando su rol', async (t) => {
  const llamadas = [];
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    if (st.table === 'usuarios' && op(st, 'update')) return { data: { id: 'u1', rol_id: 'r-mm' }, error: null };
    if (st.table === 'usuarios') return { data: { rol_id: 'r-mm' }, error: null };
    throw new Error(`no debía consultar ${st.table}`);
  }, llamadas));
  const out = await rbacService.actualizarUsuario('u1', { rol_id: 'r-mm', estado: 'Activo' });
  assert.equal(out.rol_id, 'r-mm');
  assert.ok(!llamadas.some(st => st.table === 'roles'));
});

test('actualizarUsuario: no permite cambiar a un rol legacy', async (t) => {
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    if (st.table === 'usuarios' && op(st, 'update')) return assert.fail('no debía actualizar');
    if (st.table === 'usuarios') return { data: { rol_id: 'r-com' }, error: null };
    if (st.table === 'roles') return { data: { id: 'r-mm', nombre: 'Mando Medio', activo: false }, error: null };
  }));
  await assert.rejects(rbacService.actualizarUsuario('u1', { rol_id: 'r-mm' }), (err) => err.status === 400);
});

// ── GET /api/rbac/perfil ────────────────────────────────────────────────────

function appRbac() {
  const app = express();
  app.use('/api/rbac', require('../rbac/routes/rbac'));
  app.use(errorHandler);
  return app;
}

// Sesión simulada: el token 'tok-ana' pertenece a ana@x.com.
function prepararSesion(t, llamadas = []) {
  t.mock.method(supabase.auth, 'getUser', async (token) => token === 'tok-ana'
    ? { data: { user: { id: 'auth-uid-ana', email: 'ana@x.com' } }, error: null }
    : { data: { user: null }, error: { message: 'invalid' } });
  const perfiles = {
    'ana@x.com':  { id: 'usr-ana',  nombre: 'Ana',  roles: { id: 'r1', nombre: 'Dirección', nivel_jerarquico: 'HIGH', descripcion: 'x' } },
    'beto@x.com': { id: 'usr-beto', nombre: 'Beto', roles: { id: 'r2', nombre: 'Operativo', nivel_jerarquico: 'LOW' } },
  };
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    const email = st.ops.find(o => o[0] === 'eq' && o[1] === 'email')?.[2];
    return perfiles[email] ? { data: perfiles[email], error: null } : { data: null, error: { code: 'PGRST116' } };
  }, llamadas));
}

test('A) perfil sin token → 401 (y con token inválido también)', async (t) => {
  prepararSesion(t);
  assert.equal((await llamar(appRbac(), 'GET', '/api/rbac/perfil')).status, 401);
  assert.equal((await llamar(appRbac(), 'GET', '/api/rbac/perfil?email=ana@x.com')).status, 401);
  assert.equal((await llamar(appRbac(), 'GET', '/api/rbac/perfil', { Authorization: 'Bearer otro' })).status, 401);
});

test('B) perfil con token válido → 200 con id (usuarios.id), nombre, rol y hierarchyLevel; nada más', async (t) => {
  prepararSesion(t);
  const r = await llamar(appRbac(), 'GET', '/api/rbac/perfil', { Authorization: 'Bearer tok-ana' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { id: 'usr-ana', nombre: 'Ana', rol: 'Dirección', hierarchyLevel: HIGH });
});

test('C) ?email= de otro usuario se ignora: siempre devuelve el perfil de la sesión', async (t) => {
  const llamadas = [];
  prepararSesion(t, llamadas);
  const r = await llamar(appRbac(), 'GET', '/api/rbac/perfil?email=beto@x.com', { Authorization: 'Bearer tok-ana' });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, 'usr-ana');
  assert.equal(r.body.nombre, 'Ana');
  // Ninguna consulta usó el email de la URL
  assert.ok(llamadas.every(st => !st.ops.some(o => o[0] === 'eq' && o[2] === 'beto@x.com')));
});

test('perfil: sesión válida pero usuario inexistente o inactivo en el sistema → 403 sin perfil parcial', async (t) => {
  t.mock.method(supabase.auth, 'getUser', async () => ({ data: { user: { email: 'baja@x.com' } }, error: null }));
  t.mock.method(supabase, 'from', fakeFrom(() => ({ data: null, error: { code: 'PGRST116' } })));
  const r = await llamar(appRbac(), 'GET', '/api/rbac/perfil', { Authorization: 'Bearer tok' });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { error: 'Usuario no encontrado o inactivo en el sistema.' });
});

test('D) el resto de las rutas RBAC siguen exigiendo sesión y rol', async (t) => {
  prepararSesion(t);
  assert.equal((await llamar(appRbac(), 'GET', '/api/rbac/usuarios')).status, 401);
  assert.equal((await llamar(appRbac(), 'GET', '/api/rbac/roles')).status, 401);
  // Ana es Dirección: puede listar roles (soloAdmin) pero no crear usuarios (soloSuperadmin)
  t.mock.method(supabase, 'from', fakeFrom((st) => st.table === 'roles'
    ? { data: [{ id: 'r1', nombre: 'Dirección' }], error: null }
    : { data: { id: 'usr-ana', nombre: 'Ana', roles: { nombre: 'Dirección', nivel_jerarquico: 'HIGH' } }, error: null }));
  assert.equal((await llamar(appRbac(), 'GET', '/api/rbac/roles', { Authorization: 'Bearer tok-ana' })).status, 200);
  assert.equal((await llamar(appRbac(), 'POST', '/api/rbac/usuarios', { Authorization: 'Bearer tok-ana' })).status, 403);
});
