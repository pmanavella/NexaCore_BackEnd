const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const tablerosService = require('../operations/services/tablerosService');
const operationsService = require('../operations/services/operationsService');
const tablerosRouter = require('../operations/routes/tableros');
const tareasRouter = require('../operations/routes/tareas');
const { esTareaAbierta, TIPOS_BASE } = require('../operations/config/etapas');

// ── Supabase en memoria ──────────────────────────────────────────────────────
// Implementa solo lo que usan tablerosService / operationsService: filtros
// eq/in/or(tipo), order, count head, insert/update/delete, embeds de miembros,
// etapas y asignados, el índice único de nombre de tablero, la RPC
// tarea_sincronizar_asignados y las RPC operativo_tablero_* (misma lógica que
// la migración 2026-11-02_tableros_administradores).

function crearBase() {
  const db = {
    usuarios: [], tareas: [], tarea_asignados: [], tarea_historial: [],
    operativo_tableros: [], operativo_tablero_miembros: [],
    operativo_etapas: [
      { id: 'e-pend', nombre: 'Pendiente', tipo_base: 'pendiente', posicion: 0 },
      { id: 'e-curso', nombre: 'En curso', tipo_base: 'en_curso', posicion: 1 },
      { id: 'e-rev', nombre: 'Revisión', tipo_base: 'en_revision_abierta', posicion: 2 },
      { id: 'e-ok', nombre: 'Completada', tipo_base: 'completada', posicion: 3 },
      { id: 'e-canc', nombre: 'Cancelada', tipo_base: 'cancelada', posicion: 4 },
      { id: 'e-revc', nombre: 'Revisión final', tipo_base: 'en_revision_cerrada', posicion: 5 },
    ],
  };
  const usuarioPublico = (u) => ({ id: u.id, nombre: u.nombre, email: u.email, estado: u.estado });

  function embeber(tabla, fila, select) {
    const out = { ...fila };
    if (tabla === 'tareas' && select.includes('operativo_etapas(')) {
      out.operativo_etapas = db.operativo_etapas.find(e => e.id === fila.etapa_id) ?? null;
    }
    if (tabla === 'tareas' && select.includes('tarea_asignados(')) {
      out.tarea_asignados = db.tarea_asignados.filter(a => a.tarea_id === fila.id)
        .map(a => ({ orden: a.orden, usuarios: usuarioPublico(db.usuarios.find(u => u.id === a.usuario_id)) }));
    }
    if (tabla === 'operativo_tableros' && select.includes('operativo_tablero_miembros(')) {
      out.operativo_tablero_miembros = db.operativo_tablero_miembros.filter(m => m.tablero_id === fila.id)
        .map(m => ({ es_admin: m.es_admin ?? false, usuarios: usuarioPublico(db.usuarios.find(u => u.id === m.usuario_id)) }));
    }
    if (tabla === 'operativo_tablero_miembros') {
      out.es_admin = fila.es_admin ?? false;
      if (select.includes('usuarios(')) out.usuarios = usuarioPublico(db.usuarios.find(u => u.id === fila.usuario_id));
    }
    return out;
  }

  const nombreTomado = (nombre, excepto) => db.operativo_tableros
    .some(t => t.id !== excepto && t.nombre.trim().toLowerCase() === nombre.trim().toLowerCase());

  function from(tabla) {
    const st = { filtros: [], accion: 'select', select: '*', single: false, head: false, orden: null };
    const ejecutar = () => {
      let filas = db[tabla].filter(f => st.filtros.every(fn => fn(f)));
      if (st.accion === 'insert') {
        if (tabla === 'operativo_tableros' && st.valores.some(v => nombreTomado(v.nombre))) {
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        const nuevas = st.valores.map(v => ({ id: randomUUID(), created_at: new Date().toISOString(), ...v }));
        db[tabla].push(...nuevas);
        filas = nuevas;
      } else if (st.accion === 'update') {
        if (tabla === 'operativo_tableros' && st.valores.nombre && filas.some(f => nombreTomado(st.valores.nombre, f.id))) {
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        filas.forEach(f => Object.assign(f, st.valores));
      } else if (st.accion === 'delete') {
        db[tabla] = db[tabla].filter(f => !filas.includes(f));
        if (tabla === 'tareas') db.tarea_asignados = db.tarea_asignados.filter(a => !filas.some(t => t.id === a.tarea_id));
        if (tabla === 'operativo_tableros') db.operativo_tablero_miembros = db.operativo_tablero_miembros.filter(m => !filas.some(t => t.id === m.tablero_id));
        return { data: null, error: null };
      }
      if (st.head) return { data: null, error: null, count: filas.length };
      if (st.orden) {
        const [col, asc] = st.orden;
        filas = [...filas].sort((a, b) => (asc ? 1 : -1) * String(a[col]).localeCompare(String(b[col]), undefined, { numeric: true }));
      }
      const data = filas.map(f => embeber(tabla, f, st.select));
      if (st.single === 'maybe') return { data: data[0] ?? null, error: null };
      if (st.single) return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'not found' } };
      return { data, error: null, count: data.length };
    };
    const b = {
      select(cols = '*', opts = {}) { st.select = cols; st.head = !!opts.head; return b; },
      insert(v) { st.accion = 'insert'; st.valores = v; return b; },
      update(v) { st.accion = 'update'; st.valores = v; return b; },
      delete() { st.accion = 'delete'; return b; },
      eq(c, v) { st.filtros.push(f => f[c] === v); return b; },
      in(c, vs) { st.filtros.push(f => vs.includes(f[c])); return b; },
      or(expr) {
        const soportados = {
          'tipo.is.null,tipo.eq.asignacion': f => f.tipo == null || f.tipo === 'asignacion',
          'estado_propuesta.is.null,estado_propuesta.eq.pendiente': f => f.estado_propuesta == null || f.estado_propuesta === 'pendiente',
        };
        assert.ok(expr in soportados, `or() no soportado: ${expr}`);
        st.filtros.push(soportados[expr]);
        return b;
      },
      order(col, { ascending } = {}) { st.orden = [col, ascending !== false]; return b; },
      limit() { return b; },
      single() { st.single = true; return b; },
      maybeSingle() { st.single = 'maybe'; return b; },
      then(res, rej) { return Promise.resolve().then(ejecutar).then(res, rej); },
    };
    return b;
  }

  // Funciones operativo_tablero_*: cada una corre "en una transacción" (si
  // falla, se restauran las membresías del tablero).
  const falla = (message) => { throw Object.assign(new Error(message), { rpc: { code: 'P0001', message } }); };
  const miembrosDe = (tab) => db.operativo_tablero_miembros.filter(m => m.tablero_id === tab);
  const activo = (id) => db.usuarios.find(u => u.id === id)?.estado === 'Activo';
  const adminsActivos = (tab) => miembrosDe(tab).filter(m => m.es_admin && activo(m.usuario_id)).length;
  const bloquear = (tab) => { if (!db.operativo_tableros.some(t => t.id === tab)) falla('NX_TABLERO_NO_ENCONTRADO'); };
  const exigirAdmin = (tab, actor) => { if (!miembrosDe(tab).some(m => m.usuario_id === actor && m.es_admin)) falla('NX_NO_ADMIN'); };
  const exigirRestante = (tab, antes) => { if (antes > 0 && adminsActivos(tab) === 0) falla('NX_ULTIMO_ADMIN'); };
  const insertarComunes = (tab, ids) => [...new Set(ids)].forEach(usuario_id => {
    if (!miembrosDe(tab).some(m => m.usuario_id === usuario_id)) db.operativo_tablero_miembros.push({ tablero_id: tab, usuario_id, es_admin: false });
  });
  const rpcs = {
    tarea_sincronizar_asignados({ p_tarea_id, p_usuario_ids }) {
      db.tarea_asignados = db.tarea_asignados.filter(a => a.tarea_id !== p_tarea_id);
      p_usuario_ids.forEach((usuario_id, i) => db.tarea_asignados.push({ tarea_id: p_tarea_id, usuario_id, orden: i + 1 }));
      const nombres = p_usuario_ids.map(id => db.usuarios.find(u => u.id === id).nombre);
      db.tareas.find(t => t.id === p_tarea_id).asignado_a = nombres.length ? nombres.join(', ') : null;
    },
    operativo_tablero_agregar_miembros({ p_tablero_id, p_actor_id, p_usuario_ids }) {
      bloquear(p_tablero_id);
      exigirAdmin(p_tablero_id, p_actor_id);
      insertarComunes(p_tablero_id, p_usuario_ids);
    },
    operativo_tablero_cambiar_admin({ p_tablero_id, p_actor_id, p_usuario_id, p_es_admin }) {
      bloquear(p_tablero_id);
      exigirAdmin(p_tablero_id, p_actor_id);
      const m = miembrosDe(p_tablero_id).find(x => x.usuario_id === p_usuario_id);
      if (!m) falla('NX_NO_MIEMBRO');
      if (p_es_admin && !activo(p_usuario_id)) falla('NX_USUARIO_INACTIVO');
      const antes = adminsActivos(p_tablero_id);
      m.es_admin = p_es_admin;
      exigirRestante(p_tablero_id, antes);
    },
    operativo_tablero_quitar_miembro({ p_tablero_id, p_actor_id, p_usuario_id }) {
      bloquear(p_tablero_id);
      exigirAdmin(p_tablero_id, p_actor_id);
      const antes = adminsActivos(p_tablero_id);
      const m = miembrosDe(p_tablero_id).find(x => x.usuario_id === p_usuario_id);
      if (!m) falla('NX_NO_MIEMBRO');
      db.operativo_tablero_miembros = db.operativo_tablero_miembros.filter(x => x !== m);
      exigirRestante(p_tablero_id, antes);
    },
    operativo_tablero_sincronizar_miembros({ p_tablero_id, p_usuario_ids }) {
      bloquear(p_tablero_id);
      const antes = adminsActivos(p_tablero_id);
      db.operativo_tablero_miembros = db.operativo_tablero_miembros
        .filter(m => m.tablero_id !== p_tablero_id || p_usuario_ids.includes(m.usuario_id));
      insertarComunes(p_tablero_id, p_usuario_ids);
      exigirRestante(p_tablero_id, antes);
    },
    operativo_tablero_regularizar_admin({ p_tablero_id, p_usuario_id }) {
      bloquear(p_tablero_id);
      if (adminsActivos(p_tablero_id) > 0) falla('NX_YA_TIENE_ADMIN');
      if (!activo(p_usuario_id)) falla('NX_USUARIO_INACTIVO');
      const m = miembrosDe(p_tablero_id).find(x => x.usuario_id === p_usuario_id);
      if (m) m.es_admin = true;
      else db.operativo_tablero_miembros.push({ tablero_id: p_tablero_id, usuario_id: p_usuario_id, es_admin: true });
    },
  };

  const llamadasRpc = [];
  async function rpc(nombre, params) {
    assert.ok(nombre in rpcs, `RPC no soportada: ${nombre}`);
    llamadasRpc.push(nombre);
    const copia = db.operativo_tablero_miembros.map(m => ({ ...m }));
    try {
      rpcs[nombre](params);
      return { error: null };
    } catch (err) {
      if (!err.rpc) throw err;
      db.operativo_tablero_miembros = copia;
      return { error: err.rpc };
    }
  }

  return { db, from, rpc, rpcs, llamadasRpc };
}

// Dirección (mando alto) crea dos tableros: "Mantenimiento" con Ana y Beto, y
// "Compras" solo con Caro. Ana, Beto y Caro son mando bajo. Dora (Dirección)
// queda como miembro administrador de los dos por haberlos creado.
async function preparar(t) {
  const base = crearBase();
  t.mock.method(supabase, 'from', base.from);
  t.mock.method(supabase, 'rpc', base.rpc);
  const usuario = (nombre, estado = 'Activo') => {
    const u = { id: randomUUID(), nombre, email: `${nombre.toLowerCase()}@x.com`, estado };
    base.db.usuarios.push(u);
    return u;
  };
  const sesion = (u, hierarchyLevel = 'LOW') => ({ id: u.id, name: u.nombre, hierarchyLevel });

  const dir = usuario('Dora'), ana = usuario('Ana'), beto = usuario('Beto'), caro = usuario('Caro');
  const DIR = sesion(dir, 'HIGH'), ANA = sesion(ana), BETO = sesion(beto), CARO = sesion(caro);
  const mant = await tablerosService.crearTablero({ nombre: 'Mantenimiento', miembros: [ana.id, beto.id] }, DIR);
  const compras = await tablerosService.crearTablero({ nombre: 'Compras', descripcion: ' Proveedores ', miembros: [caro.id] }, DIR);
  return { ...base, usuario, dir, ana, beto, caro, DIR, ANA, BETO, CARO, mant, compras };
}

// ── Tableros ─────────────────────────────────────────────────────────────────

test('crear tablero: guarda nombre, descripción, creador y miembros; el creador queda como único administrador', async (t) => {
  const { compras, dir, caro } = await preparar(t);
  assert.equal(compras.nombre, 'Compras');
  assert.equal(compras.descripcion, 'Proveedores');
  assert.equal(compras.created_by, dir.id);
  assert.deepEqual(compras.miembros.map(m => [m.id, m.es_admin]), [[caro.id, false], [dir.id, true]]);
  assert.equal(compras.cantidad_tareas, 0);
  assert.equal(compras.permisos.es_admin, true);
});

test('crear tablero: el creador incluido en `miembros` no se duplica y sigue siendo administrador', async (t) => {
  const { DIR, dir, ana, db } = await preparar(t);
  const nuevo = await tablerosService.crearTablero({ nombre: 'Logística', miembros: [dir.id, ana.id, ana.id] }, DIR);
  assert.deepEqual(nuevo.miembros.map(m => [m.nombre, m.es_admin]), [['Ana', false], ['Dora', true]]);
  assert.equal(db.operativo_tablero_miembros.filter(m => m.tablero_id === nuevo.id).length, 2);
});

test('crear tablero: validaciones (nombre vacío o repetido sin distinguir mayúsculas, miembros inválidos)', async (t) => {
  const { DIR, usuario, db } = await preparar(t);
  const inactivo = usuario('Ivo', 'Inactivo');
  await assert.rejects(tablerosService.crearTablero({ nombre: '  ' }, DIR), (err) => err.status === 400);
  await assert.rejects(tablerosService.crearTablero({ nombre: ' mantenimiento ' }, DIR), (err) => err.status === 409);
  for (const miembros of ['abc', ['no-uuid'], [randomUUID()], [inactivo.id]]) {
    await assert.rejects(tablerosService.crearTablero({ nombre: 'Nuevo', miembros }, DIR), (err) => err.status === 400, JSON.stringify(miembros));
  }
  assert.equal(db.operativo_tableros.length, 2);
});

test('listar: cada usuario ve los tableros donde es miembro; Dirección ve todos', async (t) => {
  const { DIR, ANA, CARO, usuario } = await preparar(t);
  const nadie = usuario('Nadia');
  assert.deepEqual((await tablerosService.listarTableros(DIR)).data.map(x => x.nombre), ['Compras', 'Mantenimiento']);
  assert.deepEqual((await tablerosService.listarTableros(ANA)).data.map(x => x.nombre), ['Mantenimiento']);
  assert.deepEqual((await tablerosService.listarTableros(CARO)).data.map(x => x.nombre), ['Compras']);
  assert.deepEqual(await tablerosService.listarTableros({ id: nadie.id, hierarchyLevel: 'LOW' }), { data: [], total: 0 });
});

test('listar: incluye miembros y la cantidad de tareas (sin contar propuestas)', async (t) => {
  const { DIR, ANA, mant, ana } = await preparar(t);
  await operationsService.crearTarea({ titulo: 'T1', tablero_id: mant.id, asignados: [ana.id] }, ANA);
  await operationsService.crearTarea({ titulo: 'T2', tablero_id: mant.id }, ANA);
  await operationsService.crearTarea({ titulo: 'P', tipo: 'propuesta', estado_propuesta: 'pendiente', tablero_id: mant.id }, ANA);
  const [m] = (await tablerosService.listarTableros(ANA)).data;
  assert.deepEqual(m.miembros.map(x => x.nombre), ['Ana', 'Beto', 'Dora']);
  assert.equal(m.cantidad_tareas, 2);
  const compras = (await tablerosService.listarTableros(DIR)).data.find(x => x.nombre === 'Compras');
  assert.equal(compras.cantidad_tareas, 0);
});

test('editar tablero: nombre, descripción y miembros como lista completa', async (t) => {
  const { mant, caro, ana, dir } = await preparar(t);
  const editado = await tablerosService.actualizarTablero(mant.id, { nombre: 'Mantenimiento planta', descripcion: '', miembros: [ana.id, caro.id, dir.id] });
  assert.equal(editado.nombre, 'Mantenimiento planta');
  assert.equal(editado.descripcion, null);
  assert.deepEqual(editado.miembros.map(m => [m.nombre, m.es_admin]), [['Ana', false], ['Caro', false], ['Dora', true]]);
});

test('editar tablero: validaciones (inexistente 404, vacío 400, nombre repetido 409, nuevo miembro inactivo 400)', async (t) => {
  const { mant, usuario, beto, dir, db } = await preparar(t);
  const inactivo = usuario('Ivo', 'Inactivo');
  await assert.rejects(tablerosService.actualizarTablero(randomUUID(), { nombre: 'X' }), (err) => err.status === 404);
  await assert.rejects(tablerosService.actualizarTablero('no-uuid', { nombre: 'X' }), (err) => err.status === 404);
  await assert.rejects(tablerosService.actualizarTablero(mant.id, {}), (err) => err.status === 400);
  await assert.rejects(tablerosService.actualizarTablero(mant.id, { nombre: 'COMPRAS' }), (err) => err.status === 409);
  await assert.rejects(tablerosService.actualizarTablero(mant.id, { miembros: [inactivo.id] }), (err) => err.status === 400);
  // Un miembro que ya estaba puede seguir aunque esté inactivo
  db.usuarios.find(u => u.id === beto.id).estado = 'Inactivo';
  const editado = await tablerosService.actualizarTablero(mant.id, { miembros: [beto.id, dir.id] });
  assert.deepEqual(editado.miembros.map(m => m.nombre), ['Beto', 'Dora']);
});

test('quitar a un miembro: sus tareas conservan el responsable y él deja de ver el tablero', async (t) => {
  const { ANA, BETO, DIR, mant, ana, beto, dir } = await preparar(t);
  const tarea = await operationsService.crearTarea({ titulo: 'T', tablero_id: mant.id, asignados: [beto.id] }, ANA);

  await tablerosService.actualizarTablero(mant.id, { miembros: [ana.id, dir.id] });

  const [enTablero] = (await operationsService.listarTareas({ tablero_id: mant.id }, ANA)).data;
  assert.deepEqual(enTablero.asignados.map(a => a.id), [beto.id]);
  assert.equal(enTablero.asignado_a, 'Beto');
  assert.deepEqual((await tablerosService.listarTableros(BETO)).data, []);
  await assert.rejects(operationsService.listarTareas({ tablero_id: mant.id }, BETO), (err) => err.status === 403);
  await assert.rejects(operationsService.actualizarTarea(tarea.id, { titulo: 'X' }, BETO), (err) => err.status === 403);

  // Editar la tarea mantiene a Beto como responsable aunque ya no sea miembro…
  const editada = await operationsService.actualizarTarea(tarea.id, { asignados: [beto.id, ana.id] }, DIR);
  assert.deepEqual(editada.asignados.map(a => a.nombre), ['Beto', 'Ana']);
  // …pero no se lo puede volver a agregar a otra tarea
  await assert.rejects(operationsService.crearTarea({ titulo: 'T2', tablero_id: mant.id, asignados: [beto.id] }, DIR), (err) => err.status === 400);
});

test('rutas: crear y editar tableros es solo para mando alto; listar es para cualquier usuario autenticado', () => {
  const ruta = (metodo, path) => tablerosRouter.stack.find(l => l.route?.path === path && l.route.methods[metodo]).route;
  const ejecutarPrimerHandler = (route, user) => {
    let status = null;
    let siguio = false;
    const res = { status(c) { status = c; return this; }, json() { return this; } };
    route.stack[0].handle({ user }, res, () => { siguio = true; });
    return { status, siguio };
  };
  for (const [metodo, path] of [['post', '/'], ['patch', '/:id']]) {
    const route = ruta(metodo, path);
    assert.equal(route.stack.length, 2, `${metodo} ${path} tiene el middleware de mando alto`);
    assert.deepEqual(ejecutarPrimerHandler(route, { hierarchyLevel: 'LOW' }), { status: 403, siguio: false });
    assert.deepEqual(ejecutarPrimerHandler(route, { hierarchyLevel: 'MEDIUM' }), { status: 403, siguio: false });
    assert.deepEqual(ejecutarPrimerHandler(route, { hierarchyLevel: 'HIGH' }), { status: null, siguio: true });
  }
  assert.equal(ruta('get', '/').stack.length, 1);
});

test('rutas: gestionar miembros no exige rol jerárquico (lo decide el service); regularizar es solo para mando alto', () => {
  const ruta = (metodo, path) => tablerosRouter.stack.find(l => l.route?.path === path && l.route.methods[metodo])?.route;
  assert.equal(ruta('post', '/:id/miembros').stack.length, 1);
  assert.equal(ruta('patch', '/:id/miembros/:usuarioId').stack.length, 1);
  assert.equal(ruta('delete', '/:id/miembros/:usuarioId').stack.length, 1);
  const regularizar = ruta('post', '/:id/regularizar-administrador');
  assert.equal(regularizar.stack.length, 2);
  let status = null;
  regularizar.stack[0].handle({ user: { hierarchyLevel: 'LOW' } }, { status(c) { status = c; return this; }, json() { return this; } }, () => {});
  assert.equal(status, 403);
});

// ── Tareas por tablero ───────────────────────────────────────────────────────

test('listar tareas: requiere tablero_id visible y solo trae las de ese tablero', async (t) => {
  const { ANA, CARO, DIR, mant, compras } = await preparar(t);
  await operationsService.crearTarea({ titulo: 'de-mant', tablero_id: mant.id }, ANA);
  await operationsService.crearTarea({ titulo: 'de-compras', tablero_id: compras.id }, CARO);

  await assert.rejects(operationsService.listarTareas({}, ANA), (err) => err.status === 400);
  await assert.rejects(operationsService.listarTareas({ tablero_id: 'no-uuid' }, ANA), (err) => err.status === 400);
  await assert.rejects(operationsService.listarTareas({ tablero_id: randomUUID() }, ANA), (err) => err.status === 404);
  await assert.rejects(operationsService.listarTareas({ tablero_id: compras.id }, ANA), (err) => err.status === 403);

  assert.deepEqual((await operationsService.listarTareas({ tablero_id: mant.id }, ANA)).data.map(x => x.titulo), ['de-mant']);
  assert.deepEqual((await operationsService.listarTareas({ tablero_id: compras.id }, DIR)).data.map(x => x.titulo), ['de-compras']);
});

test('crear tarea: requiere tablero_id visible; el responsable debe ser miembro', async (t) => {
  const { ANA, mant, compras, beto, caro, db } = await preparar(t);
  await assert.rejects(operationsService.crearTarea({ titulo: 'T' }, ANA), (err) => err.status === 400 && /tablero_id/.test(err.message));
  await assert.rejects(operationsService.crearTarea({ titulo: 'T', tablero_id: compras.id }, ANA), (err) => err.status === 403);
  await assert.rejects(
    operationsService.crearTarea({ titulo: 'T', tablero_id: mant.id, asignados: [beto.id, caro.id] }, ANA),
    (err) => err.status === 400 && /miembro/.test(err.message) && err.message.includes(caro.id)
  );
  // Asignación legacy por nombre: debe identificar a un miembro
  await assert.rejects(operationsService.crearTarea({ titulo: 'T', tablero_id: mant.id, asignado_a: 'Caro' }, ANA), (err) => err.status === 400);
  await assert.rejects(operationsService.crearTarea({ titulo: 'T', tablero_id: mant.id, asignado_a: 'Fantasma' }, ANA), (err) => err.status === 400);
  assert.equal(db.tareas.length, 0);

  const tarea = await operationsService.crearTarea({ titulo: 'T', tablero_id: mant.id, asignado_a: 'Beto' }, ANA);
  assert.equal(tarea.tablero_id, mant.id);
  assert.deepEqual(tarea.asignados.map(a => a.id), [beto.id]);
});

test('editar tarea: no cambia de tablero, no agrega no-miembros; editar, borrar e historial exigen ver el tablero', async (t) => {
  const { ANA, CARO, mant, compras, beto, caro } = await preparar(t);
  const { id } = await operationsService.crearTarea({ titulo: 'T', tablero_id: mant.id }, ANA);

  await assert.rejects(operationsService.actualizarTarea(id, { tablero_id: compras.id }, ANA), (err) => err.status === 400);
  await assert.rejects(operationsService.actualizarTarea(id, { asignados: [caro.id] }, ANA), (err) => err.status === 400);
  await assert.rejects(operationsService.actualizarTarea(id, { asignado_a: 'Caro' }, ANA), (err) => err.status === 400);
  const editada = await operationsService.actualizarTarea(id, { tablero_id: mant.id, titulo: 'Nuevo', asignados: [beto.id] }, ANA);
  assert.equal(editada.titulo, 'Nuevo');

  await assert.rejects(operationsService.actualizarTarea(id, { titulo: 'X' }, CARO), (err) => err.status === 403);
  await assert.rejects(operationsService.obtenerHistorial(id, CARO), (err) => err.status === 403);
  await assert.rejects(operationsService.eliminarTarea(id, CARO), (err) => err.status === 403);
  await assert.rejects(operationsService.eliminarTarea(randomUUID(), ANA), (err) => err.status === 404);
  await operationsService.eliminarTarea(id, ANA);
});

test('tarea sin tablero (creada por un backend anterior): solo la ve el mando alto', async (t) => {
  const { ANA, DIR, db } = await preparar(t);
  db.tareas.push({ id: randomUUID(), titulo: 'huérfana', tipo: 'asignacion', etapa_id: 'e-pend', tablero_id: null });
  const { id } = db.tareas[0];
  await assert.rejects(operationsService.actualizarTarea(id, { titulo: 'X' }, ANA), (err) => err.status === 403);
  const editada = await operationsService.actualizarTarea(id, { titulo: 'rescatada' }, DIR);
  assert.equal(editada.titulo, 'rescatada');
});

// ── Totales ──────────────────────────────────────────────────────────────────

test('totales por tablero: pendientes, en proceso (incluye revisión abierta), completadas y vencidas', async (t) => {
  const { ANA, CARO, mant, compras, ana, beto } = await preparar(t);
  const crear = (titulo, etapa_id, extra = {}) => operationsService.crearTarea({ titulo, etapa_id, tablero_id: mant.id, ...extra }, ANA);
  await crear('p1', 'e-pend', { fecha_limite: '2020-01-01', asignados: [ana.id] });
  await crear('p2', 'e-pend', { asignados: [beto.id] });
  await crear('c1', 'e-curso', { asignados: [ana.id, beto.id] });
  await crear('r1', 'e-rev');
  await crear('ok', 'e-ok', { fecha_limite: '2020-01-01', asignados: [ana.id] });
  await crear('x', 'e-canc');
  await operationsService.crearTarea({ titulo: 'otra', tablero_id: compras.id }, CARO);

  const m = await operationsService.getMetricas({ tablero_id: mant.id }, ANA);
  assert.deepEqual(
    { total: m.total, pendientes: m.pendientes, enProceso: m.enProceso, completadas: m.completadas, vencidas: m.vencidas },
    { total: 6, pendientes: 2, enProceso: 2, completadas: 1, vencidas: 1 }
  );
  assert.ok(Array.isArray(m.porEtapa) && m.porTipoBase, 'conserva los campos que ya existían');

  const mias = await operationsService.getMetricas({ tablero_id: mant.id, solo_mias: 'true' }, ANA);
  assert.deepEqual([mias.total, mias.pendientes, mias.enProceso, mias.completadas, mias.vencidas], [3, 1, 1, 1, 1]);

  await assert.rejects(operationsService.getMetricas({ tablero_id: mant.id }, CARO), (err) => err.status === 403);
});

test('totales sin tablero_id: globales como antes (los usa Nexi sin usuario)', async (t) => {
  const { ANA, CARO, mant, compras } = await preparar(t);
  await operationsService.crearTarea({ titulo: 'a', tablero_id: mant.id }, ANA);
  await operationsService.crearTarea({ titulo: 'b', tablero_id: compras.id }, CARO);
  const global = await operationsService.getMetricas({});
  assert.equal(global.total, 2);
  assert.equal(global.pendientes, 2);
});

// ── Propuestas ───────────────────────────────────────────────────────────────

test('propuestas: se listan solo las de tableros visibles y aprobar/rechazar exige ver el tablero', async (t) => {
  const { ANA, CARO, DIR, mant, compras } = await preparar(t);
  const pMant = await operationsService.crearTarea({ titulo: 'pm', tipo: 'propuesta', estado_propuesta: 'pendiente', tablero_id: mant.id }, ANA);
  await operationsService.crearTarea({ titulo: 'pc', tipo: 'propuesta', estado_propuesta: 'pendiente', tablero_id: compras.id }, CARO);

  assert.deepEqual((await operationsService.listarPropuestas({}, ANA)).data.map(p => p.titulo), ['pm']);
  assert.equal((await operationsService.listarPropuestas({}, DIR)).total, 2);
  assert.deepEqual((await operationsService.listarPropuestas({ tablero_id: compras.id }, DIR)).data.map(p => p.titulo), ['pc']);
  await assert.rejects(operationsService.listarPropuestas({ tablero_id: compras.id }, ANA), (err) => err.status === 403);

  await assert.rejects(operationsService.aprobarPropuesta(pMant.id, {}, CARO), (err) => err.status === 403);
  await assert.rejects(operationsService.rechazarPropuesta(pMant.id, {}, CARO), (err) => err.status === 403);
  const aprobada = await operationsService.aprobarPropuesta(pMant.id, {}, DIR);
  assert.equal(aprobada.tablero_id, mant.id);
});

// ── Administradores de tablero ───────────────────────────────────────────────

const miembrosDe = (tablero) => tablero.miembros.map(m => [m.nombre, m.es_admin]);

test('admin: un administrador de mando bajo agrega miembros comunes (sin duplicar y sin poder darles admin al agregarlos)', async (t) => {
  const { DIR, ANA, mant, ana, caro, beto, db } = await preparar(t);
  await tablerosService.actualizarMiembro(mant.id, ana.id, { es_admin: true }, DIR);

  const editado = await tablerosService.agregarMiembros(mant.id, { miembros: [caro.id, caro.id, beto.id], es_admin: true }, ANA);
  assert.deepEqual(miembrosDe(editado), [['Ana', true], ['Beto', false], ['Caro', false], ['Dora', true]]);
  assert.equal(db.operativo_tablero_miembros.filter(m => m.tablero_id === mant.id).length, 4);
  // Caro ya ve el tablero y puede ser responsable de tareas
  assert.deepEqual((await tablerosService.listarTableros({ id: caro.id, hierarchyLevel: 'LOW' })).data.map(x => x.nombre), ['Compras', 'Mantenimiento']);
});

test('admin: validaciones al agregar (lista vacía, ids inválidos, usuario inexistente o inactivo)', async (t) => {
  const { DIR, mant, usuario } = await preparar(t);
  const inactivo = usuario('Ivo', 'Inactivo');
  for (const miembros of [undefined, [], 'abc', ['no-uuid'], [randomUUID()], [inactivo.id]]) {
    await assert.rejects(tablerosService.agregarMiembros(mant.id, { miembros }, DIR), (err) => err.status === 400, JSON.stringify(miembros));
  }
  await assert.rejects(tablerosService.agregarMiembros(randomUUID(), { miembros: [inactivo.id] }, DIR), (err) => err.status === 404);
});

test('admin: promueve a otro miembro y el promovido ya puede administrar', async (t) => {
  const { DIR, BETO, mant, beto, caro } = await preparar(t);
  const editado = await tablerosService.actualizarMiembro(mant.id, beto.id, { es_admin: true }, DIR);
  assert.deepEqual(miembrosDe(editado), [['Ana', false], ['Beto', true], ['Dora', true]]);

  const visto = await tablerosService.agregarMiembros(mant.id, { miembros: [caro.id] }, BETO);
  assert.equal(visto.permisos.es_admin, true);
  assert.equal(visto.permisos.puede_administrar_permisos, true);
});

test('admin: quitar el privilegio exige que quede otro administrador activo', async (t) => {
  const { DIR, ANA, mant, ana, dir, db } = await preparar(t);
  // Único administrador: no puede degradarse
  await assert.rejects(tablerosService.actualizarMiembro(mant.id, dir.id, { es_admin: false }, DIR), (err) => err.status === 409);

  await tablerosService.actualizarMiembro(mant.id, ana.id, { es_admin: true }, DIR);
  // Con otro administrador sí puede, y también degradar a otro
  const editado = await tablerosService.actualizarMiembro(mant.id, dir.id, { es_admin: false }, DIR);
  assert.deepEqual(miembrosDe(editado), [['Ana', true], ['Beto', false], ['Dora', false]]);
  assert.equal(editado.permisos.es_admin, false);
  // Ahora Ana es la única
  await assert.rejects(tablerosService.actualizarMiembro(mant.id, ana.id, { es_admin: false }, ANA), (err) => err.status === 409);
  // Dora ya no administra, aunque sea Dirección
  await assert.rejects(tablerosService.actualizarMiembro(mant.id, dir.id, { es_admin: true }, DIR), (err) => err.status === 403);

  // Un administrador inactivo no cuenta como el que queda
  await tablerosService.actualizarMiembro(mant.id, dir.id, { es_admin: true }, ANA);
  db.usuarios.find(u => u.id === dir.id).estado = 'Inactivo';
  await assert.rejects(tablerosService.actualizarMiembro(mant.id, ana.id, { es_admin: false }, ANA), (err) => err.status === 409);
});

test('admin: validaciones de promover/degradar (es_admin no booleano, no miembro, inactivo, id inválido)', async (t) => {
  const { DIR, mant, ana, caro, beto, db } = await preparar(t);
  for (const es_admin of [undefined, 'true', 1, null]) {
    await assert.rejects(tablerosService.actualizarMiembro(mant.id, ana.id, { es_admin }, DIR), (err) => err.status === 400, String(es_admin));
  }
  await assert.rejects(tablerosService.actualizarMiembro(mant.id, caro.id, { es_admin: true }, DIR), (err) => err.status === 404);
  await assert.rejects(tablerosService.actualizarMiembro(mant.id, 'no-uuid', { es_admin: true }, DIR), (err) => err.status === 400);
  db.usuarios.find(u => u.id === beto.id).estado = 'Inactivo';
  await assert.rejects(tablerosService.actualizarMiembro(mant.id, beto.id, { es_admin: true }, DIR), (err) => err.status === 400);
});

test('admin: quita miembros (incluido otro administrador) sin dejar el tablero sin administradores', async (t) => {
  const { DIR, ANA, mant, ana, beto, dir, caro } = await preparar(t);
  const sinBeto = await tablerosService.quitarMiembro(mant.id, beto.id, DIR);
  assert.deepEqual(miembrosDe(sinBeto), [['Ana', false], ['Dora', true]]);

  await assert.rejects(tablerosService.quitarMiembro(mant.id, dir.id, DIR), (err) => err.status === 409);
  await assert.rejects(tablerosService.quitarMiembro(mant.id, caro.id, DIR), (err) => err.status === 404);

  await tablerosService.actualizarMiembro(mant.id, ana.id, { es_admin: true }, DIR);
  const sinDora = await tablerosService.quitarMiembro(mant.id, dir.id, ANA);
  assert.deepEqual(miembrosDe(sinDora), [['Ana', true]]);
  // Dora, Dirección, sigue viendo el tablero (acceso global) pero ya no es miembro
  const visto = (await tablerosService.listarTableros(DIR)).data.find(x => x.id === mant.id);
  assert.deepEqual(visto.permisos, {
    es_miembro: false, es_admin: false, puede_agregar_miembros: false, puede_quitar_miembros: false,
    puede_administrar_permisos: false, puede_editar_tablero: true, puede_regularizar_admin: false,
  });
});

test('miembro común: no puede agregar, quitar, promover ni autopromoverse (403) y nada cambia', async (t) => {
  const { BETO, mant, beto, ana, caro, db } = await preparar(t);
  const antes = JSON.stringify(db.operativo_tablero_miembros);
  await assert.rejects(tablerosService.agregarMiembros(mant.id, { miembros: [caro.id] }, BETO), (err) => err.status === 403);
  await assert.rejects(tablerosService.actualizarMiembro(mant.id, beto.id, { es_admin: true }, BETO), (err) => err.status === 403);
  await assert.rejects(tablerosService.actualizarMiembro(mant.id, ana.id, { es_admin: true }, BETO), (err) => err.status === 403);
  await assert.rejects(tablerosService.quitarMiembro(mant.id, ana.id, BETO), (err) => err.status === 403);
  assert.equal(JSON.stringify(db.operativo_tablero_miembros), antes);

  const [visto] = (await tablerosService.listarTableros(BETO)).data;
  assert.deepEqual(visto.permisos, {
    es_miembro: true, es_admin: false, puede_agregar_miembros: false, puede_quitar_miembros: false,
    puede_administrar_permisos: false, puede_editar_tablero: false, puede_regularizar_admin: false,
  });
});

test('acceso global no implica administración: Superadmin no miembro ve el tablero y crea tareas, pero no administra', async (t) => {
  const { usuario, mant, ana, caro } = await preparar(t);
  const SUPER = { id: usuario('Sofía').id, hierarchyLevel: 'HIGH' };

  const visto = (await tablerosService.listarTableros(SUPER)).data.find(x => x.id === mant.id);
  assert.equal(visto.permisos.es_admin, false);
  assert.equal(visto.permisos.puede_agregar_miembros, false);
  const tarea = await operationsService.crearTarea({ titulo: 'T', tablero_id: mant.id, asignados: [ana.id] }, SUPER);
  assert.equal(tarea.tablero_id, mant.id);

  await assert.rejects(tablerosService.agregarMiembros(mant.id, { miembros: [caro.id] }, SUPER), (err) => err.status === 403);
  await assert.rejects(tablerosService.actualizarMiembro(mant.id, SUPER.id, { es_admin: true }, SUPER), (err) => err.status === 403);
  await assert.rejects(tablerosService.quitarMiembro(mant.id, ana.id, SUPER), (err) => err.status === 403);
  // Sin sesión tampoco
  await assert.rejects(tablerosService.agregarMiembros(mant.id, { miembros: [caro.id] }, undefined), (err) => err.status === 403);
});

test('nunca sin administradores: la edición de mando alto no puede quitar al último administrador', async (t) => {
  const { DIR, mant, ana, beto, db } = await preparar(t);
  await assert.rejects(tablerosService.actualizarTablero(mant.id, { nombre: 'Otro', miembros: [ana.id, beto.id] }, DIR), (err) => err.status === 409);
  // No se aplicó nada a medias
  assert.equal(db.operativo_tableros.find(x => x.id === mant.id).nombre, 'Mantenimiento');
  assert.equal(db.operativo_tablero_miembros.filter(m => m.tablero_id === mant.id).length, 3);
});

test('nunca sin administradores: si dos pedidos pasan la validación a la vez, la función bloqueada rechaza el segundo (409)', async (t) => {
  const { DIR, ANA, mant, ana, dir, db, llamadasRpc } = await preparar(t);
  await tablerosService.actualizarMiembro(mant.id, ana.id, { es_admin: true }, DIR);
  // Simula la carrera: la verificación previa del service ya pasó para ambos.
  t.mock.method(tablerosService, '_exigirAdminRestante', () => {});
  await tablerosService.actualizarMiembro(mant.id, dir.id, { es_admin: false }, DIR);
  await assert.rejects(tablerosService.actualizarMiembro(mant.id, ana.id, { es_admin: false }, ANA), (err) => err.status === 409);
  await assert.rejects(tablerosService.quitarMiembro(mant.id, ana.id, ANA), (err) => err.status === 409);
  assert.deepEqual(db.operativo_tablero_miembros.filter(m => m.tablero_id === mant.id && m.es_admin).map(m => m.usuario_id), [ana.id]);
  assert.ok(llamadasRpc.includes('operativo_tablero_quitar_miembro'));
});

test('regularizar: mando alto designa un administrador solo en tableros sin administradores activos', async (t) => {
  const { DIR, ANA, ana, beto, usuario, db } = await preparar(t);
  // Tablero "General" creado por la migración: sin creador y sin administradores
  const general = { id: randomUUID(), nombre: 'General', created_by: null };
  db.operativo_tableros.push(general);
  for (const u of [ana, beto]) db.operativo_tablero_miembros.push({ tablero_id: general.id, usuario_id: u.id, es_admin: false });

  const visto = (await tablerosService.listarTableros(DIR)).data.find(x => x.id === general.id);
  assert.equal(visto.permisos.puede_regularizar_admin, true);
  // Mientras tanto nadie lo administra
  await assert.rejects(tablerosService.agregarMiembros(general.id, { miembros: [beto.id] }, DIR), (err) => err.status === 403);

  await assert.rejects(tablerosService.regularizarAdministrador(general.id, { usuario_id: usuario('Ivo', 'Inactivo').id }, DIR), (err) => err.status === 400);
  await assert.rejects(tablerosService.regularizarAdministrador(general.id, {}, DIR), (err) => err.status === 400);
  await assert.rejects(tablerosService.regularizarAdministrador(randomUUID(), { usuario_id: ana.id }, DIR), (err) => err.status === 404);

  const regularizado = await tablerosService.regularizarAdministrador(general.id, { usuario_id: ana.id }, DIR);
  assert.deepEqual(miembrosDe(regularizado), [['Ana', true], ['Beto', false]]);
  assert.equal(regularizado.permisos.puede_regularizar_admin, false);
  // Ya tiene administrador: desde ahora los permisos los maneja Ana
  await assert.rejects(tablerosService.regularizarAdministrador(general.id, { usuario_id: beto.id }, DIR), (err) => err.status === 409);
  await tablerosService.actualizarMiembro(general.id, beto.id, { es_admin: true }, ANA);

  // Si todos sus administradores quedan inactivos, se puede volver a regularizar
  db.usuarios.find(u => u.id === ana.id).estado = 'Inactivo';
  db.usuarios.find(u => u.id === beto.id).estado = 'Inactivo';
  const dora = db.usuarios.find(u => u.nombre === 'Dora');
  const otraVez = await tablerosService.regularizarAdministrador(general.id, { usuario_id: dora.id }, DIR);
  assert.deepEqual(miembrosDe(otraVez), [['Ana', true], ['Beto', true], ['Dora', true]]);
});

// ── Creación de tareas: cualquier miembro ────────────────────────────────────

test('crear tarea: cualquier miembro puede, sin importar su rol jerárquico ni si es administrador', async (t) => {
  const { usuario, BETO, DIR, mant, ana, caro } = await preparar(t);
  const externo = usuario('Eli');
  const ELI = { id: externo.id, name: 'Eli', hierarchyLevel: 'NONE' };
  await tablerosService.agregarMiembros(mant.id, { miembros: [externo.id] }, DIR);

  for (const sesion of [BETO, ELI, { ...BETO, hierarchyLevel: 'MEDIUM' }, { ...BETO, hierarchyLevel: undefined }]) {
    const tarea = await operationsService.crearTarea({ titulo: `de ${sesion.hierarchyLevel}`, tablero_id: mant.id, asignados: [ana.id, externo.id] }, sesion);
    assert.deepEqual(tarea.asignados.map(a => a.id), [ana.id, externo.id]);
  }
  // Los responsables siguen teniendo que ser miembros
  await assert.rejects(operationsService.crearTarea({ titulo: 'X', tablero_id: mant.id, asignados: [caro.id] }, ELI), (err) => err.status === 400);
});

test('rutas: POST /tareas solo exige estar autenticado (sin middleware de rol ni de administrador)', () => {
  const route = tareasRouter.stack.find(l => l.route?.path === '/' && l.route.methods.post).route;
  assert.equal(route.stack.length, 1);
});

// ── Filtros: solo mis tareas / solo abiertas ─────────────────────────────────

test('estados abiertos y cerrados: por tipo_base de la etapa y, sin etapa, por estado canónico', () => {
  const esperado = {
    pendiente: true, en_curso: true, en_revision_abierta: true,
    completada: false, cancelada: false, en_revision_cerrada: false,
  };
  assert.deepEqual(Object.keys(esperado).sort(), [...TIPOS_BASE].sort(), 'cubre todos los tipo_base');
  for (const [tipo_base, abierta] of Object.entries(esperado)) {
    // El estado canónico no influye si hay etapa (Cerrada · En Revisión guarda "Completada")
    assert.equal(esTareaAbierta({ estado: 'Pendiente', operativo_etapas: { tipo_base } }), abierta, tipo_base);
  }
  for (const [estado, abierta] of [['Pendiente', true], ['En Proceso', true], ['Completada', false], ['Cancelada', false], [null, true]]) {
    assert.equal(esTareaAbierta({ estado, operativo_etapas: null }), abierta, String(estado));
  }
});

async function prepararFiltros(t) {
  const ctx = await preparar(t);
  const { ANA, mant, ana, beto } = ctx;
  const crear = (titulo, etapa_id, asignados, extra = {}) =>
    operationsService.crearTarea({ titulo, etapa_id, tablero_id: mant.id, asignados, ...extra }, ANA);
  await crear('ana-pend', 'e-pend', [ana.id], { prioridad: 'Alta' });
  await crear('ana-rev-abierta', 'e-rev', [ana.id, beto.id]);
  await crear('ana-ok', 'e-ok', [ana.id]);
  await crear('ana-rev-cerrada', 'e-revc', [ana.id]);
  await crear('beto-curso', 'e-curso', [beto.id]);
  await crear('beto-canc', 'e-canc', [beto.id]);
  await crear('sin-responsable', 'e-pend', []);
  const titulos = async (filtros, user = ANA) =>
    (await operationsService.listarTareas({ tablero_id: mant.id, ...filtros }, user)).data.map(x => x.titulo).sort();
  return { ...ctx, titulos };
}

test('filtros: sin filtros, solo mis tareas, solo abiertas y ambos combinados', async (t) => {
  const { titulos } = await prepararFiltros(t);
  assert.deepEqual(await titulos({}), ['ana-ok', 'ana-pend', 'ana-rev-abierta', 'ana-rev-cerrada', 'beto-canc', 'beto-curso', 'sin-responsable']);
  assert.deepEqual(await titulos({ solo_mias: 'true' }), ['ana-ok', 'ana-pend', 'ana-rev-abierta', 'ana-rev-cerrada']);
  assert.deepEqual(await titulos({ solo_abiertas: 'true' }), ['ana-pend', 'ana-rev-abierta', 'beto-curso', 'sin-responsable']);
  assert.deepEqual(await titulos({ solo_mias: 'true', solo_abiertas: '1' }), ['ana-pend', 'ana-rev-abierta']);
});

test('filtros: se combinan con prioridad y responsable; valores falsos no filtran; total coincide', async (t) => {
  const { titulos, ANA, mant, beto } = await prepararFiltros(t);
  assert.deepEqual(await titulos({ solo_abiertas: 'true', prioridad: 'Alta' }), ['ana-pend']);
  assert.deepEqual(await titulos({ solo_abiertas: 'true', asignado_id: beto.id }), ['ana-rev-abierta', 'beto-curso']);
  assert.equal((await titulos({ solo_mias: 'false', solo_abiertas: '0' })).length, 7);
  const r = await operationsService.listarTareas({ tablero_id: mant.id, solo_abiertas: true }, ANA);
  assert.equal(r.total, r.data.length);
  assert.equal(r.total, 4);
});

test('filtros: solo mis tareas sin sesión no trae nada; los filtros no saltean el control de acceso', async (t) => {
  const { titulos, CARO } = await prepararFiltros(t);
  assert.deepEqual(await titulos({ solo_mias: 'true' }, { hierarchyLevel: 'HIGH' }), []);
  await assert.rejects(titulos({ solo_abiertas: 'true' }, CARO), (err) => err.status === 403);
});

test('métricas: solo_abiertas excluye etapas cerradas y se combina con solo_mias', async (t) => {
  const { ANA, mant } = await prepararFiltros(t);
  const abiertas = await operationsService.getMetricas({ tablero_id: mant.id, solo_abiertas: 'true' }, ANA);
  assert.deepEqual([abiertas.total, abiertas.pendientes, abiertas.enProceso, abiertas.completadas], [4, 2, 2, 0]);
  const mias = await operationsService.getMetricas({ tablero_id: mant.id, solo_abiertas: 'true', solo_mias: 'true' }, ANA);
  assert.equal(mias.total, 2);
  const todas = await operationsService.getMetricas({ tablero_id: mant.id }, ANA);
  assert.equal(todas.total, 7);
});

// ── Seguridad: campos protegidos, propuestas e historial ─────────────────────

test('editar tarea: solo aplica los campos editables; tipo, propuesta, estado, fechas reales, created_at e id del body se ignoran', async (t) => {
  const { ANA, mant, db } = await preparar(t);
  const { id } = await operationsService.crearTarea({ titulo: 'T', tablero_id: mant.id }, ANA);
  const antes = { ...db.tareas.find(x => x.id === id) };

  const editada = await operationsService.actualizarTarea(id, {
    titulo: 'Nuevo', tablero_id: mant.id,
    tipo: 'propuesta', estado_propuesta: 'aprobada', propuesto_por: 'Intruso',
    estado: 'Completada', fecha_inicio_real: '2000-01-01', fecha_fin_real: '2000-01-02',
    created_at: '2000-01-01T00:00:00Z', id: randomUUID(), etapa_inexistente: 'x',
  }, ANA);

  const fila = db.tareas.find(x => x.id === id);
  assert.equal(editada.titulo, 'Nuevo');
  for (const campo of ['tipo', 'estado_propuesta', 'propuesto_por', 'estado', 'fecha_inicio_real', 'fecha_fin_real', 'created_at', 'id', 'tablero_id']) {
    assert.deepEqual(fila[campo], antes[campo], campo);
  }
  assert.equal('etapa_inexistente' in fila, false);
});

test('editar tarea: el formulario completo del frontend sigue funcionando (etapa, prioridad, fechas, responsables) y no pisa datos de la propuesta aprobada', async (t) => {
  const { ANA, DIR, mant, ana, beto, db } = await preparar(t);
  const prop = await operationsService.crearTarea({ titulo: 'P', tipo: 'propuesta', tablero_id: mant.id, asignados: [beto.id] }, ANA);
  await operationsService.aprobarPropuesta(prop.id, {}, DIR);

  // Mismo payload que arma ModalTarea en el frontend al editar
  const editada = await operationsService.actualizarTarea(prop.id, {
    titulo: 'P editada', descripcion: 'd', etapa_id: 'e-curso', prioridad: 'Alta',
    fecha_inicio_planeada: '2026-11-10', fecha_limite: '2026-11-30',
    asignados: [beto.id, ana.id], tipo: 'asignacion',
    usuario_nombre: 'Ana', usuario_id: 'ana@x.com', propuesto_por: null, estado_propuesta: null,
  }, ANA);

  assert.equal(editada.titulo, 'P editada');
  assert.equal(editada.prioridad, 'Alta');
  assert.equal(editada.etapa_id, 'e-curso');
  assert.equal(editada.estado, 'En Proceso');
  assert.ok(editada.fecha_inicio_real, 'la etapa en curso completa la fecha real');
  assert.equal(editada.fecha_limite, '2026-11-30');
  assert.deepEqual(editada.asignados.map(a => a.id), [beto.id, ana.id]);
  const fila = db.tareas.find(x => x.id === prop.id);
  assert.deepEqual([fila.tipo, fila.estado_propuesta, fila.propuesto_por], ['asignacion', 'aprobada', 'Ana']);

  // Cambio de etapa desde el kanban (handleCambiarEtapa)
  const movida = await operationsService.actualizarTarea(prop.id, { etapa_id: 'e-ok', usuario_nombre: 'X', usuario_id: 'x' }, ANA);
  assert.equal(movida.estado, 'Completada');
});

test('crear tarea: tipo válido; una propuesta nace pendiente y propuesta por la sesión, sin importar el body', async (t) => {
  const { ANA, mant, beto } = await preparar(t);
  const prop = await operationsService.crearTarea({
    titulo: 'P', tipo: 'propuesta', estado_propuesta: 'aprobada', propuesto_por: 'Dora', tablero_id: mant.id, asignados: [beto.id],
  }, ANA);
  assert.deepEqual([prop.tipo, prop.estado_propuesta, prop.propuesto_por], ['propuesta', 'pendiente', 'Ana']);

  const asig = await operationsService.crearTarea({ titulo: 'A', estado_propuesta: 'pendiente', propuesto_por: 'Dora', tablero_id: mant.id }, ANA);
  assert.deepEqual([asig.tipo, asig.estado_propuesta, asig.propuesto_por], ['asignacion', null, null]);

  for (const tipo of ['admin', 'PROPUESTA', 1]) {
    await assert.rejects(operationsService.crearTarea({ titulo: 'X', tipo, tablero_id: mant.id }, ANA), (err) => err.status === 400, String(tipo));
  }
});

test('historial: el autor sale siempre de la sesión (crear, editar, aprobar, rechazar), nunca del body', async (t) => {
  const { ANA, BETO, mant, ana, beto, db } = await preparar(t);
  const falso = { usuario_nombre: 'Dora', usuario_id: 'dora@x.com' };
  const tarea = await operationsService.crearTarea({ titulo: 'T', tablero_id: mant.id, ...falso }, ANA);
  await operationsService.actualizarTarea(tarea.id, { titulo: 'T2', ...falso }, ANA);
  const p1 = await operationsService.crearTarea({ titulo: 'P1', tipo: 'propuesta', tablero_id: mant.id, asignados: [beto.id] }, ANA);
  const p2 = await operationsService.crearTarea({ titulo: 'P2', tipo: 'propuesta', tablero_id: mant.id, asignados: [beto.id] }, ANA);
  await operationsService.aprobarPropuesta(p1.id, falso, BETO);
  await operationsService.rechazarPropuesta(p2.id, falso, BETO);

  const autores = db.tarea_historial.map(h => [h.accion, h.usuario_id, h.usuario_nombre]);
  assert.deepEqual(autores, [
    ['creacion', ana.id, 'Ana'],
    ['actualizacion', ana.id, 'Ana'],
    ['creacion', ana.id, 'Ana'],
    ['creacion', ana.id, 'Ana'],
    ['aprobacion_propuesta', beto.id, 'Beto'],
    ['rechazo_propuesta', beto.id, 'Beto'],
  ]);
});

test('propuestas: aprueba o rechaza el responsable propuesto o el mando alto; no el que propuso ni otros miembros', async (t) => {
  const { ANA, BETO, DIR, CARO, mant, beto, db } = await preparar(t);
  const crear = (titulo, asignados) => operationsService.crearTarea({ titulo, tipo: 'propuesta', tablero_id: mant.id, asignados }, ANA);
  const p1 = await crear('P1', [beto.id]);
  const p2 = await crear('P2', [beto.id]);
  const p3 = await crear('P3', [beto.id]);

  // Quien propuso (Ana, mando bajo, no responsable) y quien no ve el tablero: 403
  await assert.rejects(operationsService.aprobarPropuesta(p1.id, {}, ANA), (err) => err.status === 403);
  await assert.rejects(operationsService.rechazarPropuesta(p1.id, {}, ANA), (err) => err.status === 403);
  await assert.rejects(operationsService.aprobarPropuesta(p1.id, {}, CARO), (err) => err.status === 403);
  assert.equal(db.tareas.find(x => x.id === p1.id).estado_propuesta, 'pendiente');

  assert.equal((await operationsService.aprobarPropuesta(p1.id, {}, BETO)).estado_propuesta, 'aprobada');
  assert.equal((await operationsService.rechazarPropuesta(p2.id, {}, BETO)).estado_propuesta, 'rechazada');
  assert.equal((await operationsService.aprobarPropuesta(p3.id, {}, DIR)).estado_propuesta, 'aprobada');

  // Propuesta histórica: estado_propuesta NULL y responsable solo por nombre
  const legacy = { id: randomUUID(), titulo: 'L', tipo: 'propuesta', estado_propuesta: null, asignado_a: 'Ana', tablero_id: mant.id, etapa_id: 'e-pend' };
  db.tareas.push(legacy);
  await assert.rejects(operationsService.aprobarPropuesta(legacy.id, {}, BETO), (err) => err.status === 403);
  assert.equal((await operationsService.rechazarPropuesta(legacy.id, {}, ANA)).estado_propuesta, 'rechazada');
});

test('propuestas: no se puede aprobar una asignación ni resolver dos veces una propuesta', async (t) => {
  const { ANA, BETO, DIR, mant, beto, db } = await preparar(t);
  const asignacion = await operationsService.crearTarea({ titulo: 'A', tablero_id: mant.id, etapa_id: 'e-ok' }, ANA);
  await assert.rejects(operationsService.aprobarPropuesta(asignacion.id, {}, DIR), (err) => err.status === 400);
  await assert.rejects(operationsService.rechazarPropuesta(asignacion.id, {}, DIR), (err) => err.status === 400);
  const fila = db.tareas.find(x => x.id === asignacion.id);
  assert.deepEqual([fila.etapa_id, fila.estado_propuesta], ['e-ok', null], 'la asignación no vuelve a la etapa inicial');

  const p = await operationsService.crearTarea({ titulo: 'P', tipo: 'propuesta', tablero_id: mant.id, asignados: [beto.id] }, ANA);
  await operationsService.rechazarPropuesta(p.id, {}, BETO);
  await assert.rejects(operationsService.aprobarPropuesta(p.id, {}, DIR), (err) => err.status === 409);
  await assert.rejects(operationsService.rechazarPropuesta(p.id, {}, DIR), (err) => err.status === 409);
  assert.equal(db.tareas.find(x => x.id === p.id).estado_propuesta, 'rechazada');
  await assert.rejects(operationsService.aprobarPropuesta(randomUUID(), {}, DIR), (err) => err.status === 404);
});

test('propuestas: aprobar y rechazar a la vez la misma propuesta resuelve una sola (la otra recibe 409)', async (t) => {
  const { ANA, BETO, DIR, mant, beto, db } = await preparar(t);
  const p = await operationsService.crearTarea({ titulo: 'P', tipo: 'propuesta', tablero_id: mant.id, asignados: [beto.id] }, ANA);
  const escrituras = t.mock.method(operationsService, '_resolverPropuesta');
  const resultados = await Promise.allSettled([
    operationsService.aprobarPropuesta(p.id, {}, DIR),
    operationsService.rechazarPropuesta(p.id, {}, BETO),
  ]);
  // Las dos pasaron la validación previa: frena la actualización condicional
  assert.equal(escrituras.mock.callCount(), 2);
  assert.deepEqual(resultados.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(resultados.find(r => r.status === 'rejected').reason.status, 409);
  const ganador = resultados.findIndex(r => r.status === 'fulfilled') === 0 ? 'aprobada' : 'rechazada';
  assert.equal(db.tareas.find(x => x.id === p.id).estado_propuesta, ganador);
  assert.equal(db.tarea_historial.filter(h => h.tarea_id === p.id && h.accion !== 'creacion').length, 1);
});

test('propuestas: quien la creó no puede aprobarla ni rechazarla aunque sea responsable; otro responsable sí', async (t) => {
  const { ANA, BETO, mant, ana, beto, db } = await preparar(t);
  // El body intenta atribuir la creación a Beto: el autor sale de la sesión
  const p = await operationsService.crearTarea(
    { titulo: 'P', tipo: 'propuesta', tablero_id: mant.id, asignados: [ana.id, beto.id], usuario_id: beto.id, usuario_nombre: 'Beto' }, ANA);
  const p2 = await operationsService.crearTarea({ titulo: 'P2', tipo: 'propuesta', tablero_id: mant.id, asignados: [ana.id, beto.id] }, ANA);

  await assert.rejects(operationsService.aprobarPropuesta(p.id, {}, ANA), (err) => err.status === 403 && /creó/.test(err.message));
  await assert.rejects(operationsService.rechazarPropuesta(p.id, {}, ANA), (err) => err.status === 403);
  assert.equal(db.tareas.find(x => x.id === p.id).estado_propuesta, 'pendiente');

  assert.equal((await operationsService.aprobarPropuesta(p.id, {}, BETO)).estado_propuesta, 'aprobada');
  assert.equal((await operationsService.rechazarPropuesta(p2.id, {}, BETO)).estado_propuesta, 'rechazada');
});

test('propuestas: el mando alto puede resolver una propuesta propia', async (t) => {
  const { DIR, mant, dir, beto } = await preparar(t);
  const p = await operationsService.crearTarea({ titulo: 'P', tipo: 'propuesta', tablero_id: mant.id, asignados: [dir.id, beto.id] }, DIR);
  assert.equal((await operationsService.aprobarPropuesta(p.id, {}, DIR)).estado_propuesta, 'aprobada');
});

test('propuestas antiguas sin UUID confiable de creación: se mantiene el comportamiento anterior (no se compara por nombre ni email)', async (t) => {
  const { ANA, mant, ana, db } = await preparar(t);
  const antigua = (usuarioIdCreacion) => {
    const id = randomUUID();
    db.tareas.push({ id, titulo: 'L', tipo: 'propuesta', estado_propuesta: 'pendiente', propuesto_por: 'Ana', tablero_id: mant.id, etapa_id: 'e-pend' });
    db.tarea_asignados.push({ tarea_id: id, usuario_id: ana.id, orden: 1 });
    if (usuarioIdCreacion !== undefined) {
      db.tarea_historial.push({ id: randomUUID(), tarea_id: id, accion: 'creacion', usuario_id: usuarioIdCreacion, usuario_nombre: 'Ana', created_at: new Date().toISOString() });
    }
    return id;
  };
  // Email enviado por el frontend anterior, sin usuario_id, basura o sin registro de creación
  for (const usuarioId of ['ana@x.com', null, 'no-uuid', undefined]) {
    const id = antigua(usuarioId);
    assert.equal((await operationsService.aprobarPropuesta(id, {}, ANA)).estado_propuesta, 'aprobada', String(usuarioId));
  }
});
