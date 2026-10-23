const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const tablerosService = require('../operations/services/tablerosService');
const operationsService = require('../operations/services/operationsService');
const tablerosRouter = require('../operations/routes/tableros');

// ── Supabase en memoria ──────────────────────────────────────────────────────
// Implementa solo lo que usan tablerosService / operationsService: filtros
// eq/in/or(tipo), order, count head, insert/update/delete, embeds de miembros,
// etapas y asignados, el índice único de nombre de tablero y la RPC
// tarea_sincronizar_asignados.

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
        .map(m => ({ usuarios: usuarioPublico(db.usuarios.find(u => u.id === m.usuario_id)) }));
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
        assert.equal(expr, 'tipo.is.null,tipo.eq.asignacion');
        st.filtros.push(f => f.tipo == null || f.tipo === 'asignacion');
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

  async function rpc(nombre, { p_tarea_id, p_usuario_ids }) {
    assert.equal(nombre, 'tarea_sincronizar_asignados');
    db.tarea_asignados = db.tarea_asignados.filter(a => a.tarea_id !== p_tarea_id);
    p_usuario_ids.forEach((usuario_id, i) => db.tarea_asignados.push({ tarea_id: p_tarea_id, usuario_id, orden: i + 1 }));
    const nombres = p_usuario_ids.map(id => db.usuarios.find(u => u.id === id).nombre);
    db.tareas.find(t => t.id === p_tarea_id).asignado_a = nombres.length ? nombres.join(', ') : null;
    return { error: null };
  }

  return { db, from, rpc };
}

// Dirección (mando alto) crea dos tableros: "Mantenimiento" con Ana y Beto, y
// "Compras" solo con Caro. Ana, Beto y Caro son mando bajo.
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

test('crear tablero: guarda nombre, descripción, creador y miembros', async (t) => {
  const { compras, dir, caro } = await preparar(t);
  assert.equal(compras.nombre, 'Compras');
  assert.equal(compras.descripcion, 'Proveedores');
  assert.equal(compras.created_by, dir.id);
  assert.deepEqual(compras.miembros.map(m => m.id), [caro.id]);
  assert.equal(compras.cantidad_tareas, 0);
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
  assert.deepEqual(m.miembros.map(x => x.nombre), ['Ana', 'Beto']);
  assert.equal(m.cantidad_tareas, 2);
  const compras = (await tablerosService.listarTableros(DIR)).data.find(x => x.nombre === 'Compras');
  assert.equal(compras.cantidad_tareas, 0);
});

test('editar tablero: nombre, descripción y miembros como lista completa', async (t) => {
  const { mant, caro, ana } = await preparar(t);
  const editado = await tablerosService.actualizarTablero(mant.id, { nombre: 'Mantenimiento planta', descripcion: '', miembros: [ana.id, caro.id] });
  assert.equal(editado.nombre, 'Mantenimiento planta');
  assert.equal(editado.descripcion, null);
  assert.deepEqual(editado.miembros.map(m => m.nombre), ['Ana', 'Caro']);
});

test('editar tablero: validaciones (inexistente 404, vacío 400, nombre repetido 409, nuevo miembro inactivo 400)', async (t) => {
  const { mant, usuario, beto, db } = await preparar(t);
  const inactivo = usuario('Ivo', 'Inactivo');
  await assert.rejects(tablerosService.actualizarTablero(randomUUID(), { nombre: 'X' }), (err) => err.status === 404);
  await assert.rejects(tablerosService.actualizarTablero('no-uuid', { nombre: 'X' }), (err) => err.status === 404);
  await assert.rejects(tablerosService.actualizarTablero(mant.id, {}), (err) => err.status === 400);
  await assert.rejects(tablerosService.actualizarTablero(mant.id, { nombre: 'COMPRAS' }), (err) => err.status === 409);
  await assert.rejects(tablerosService.actualizarTablero(mant.id, { miembros: [inactivo.id] }), (err) => err.status === 400);
  // Un miembro que ya estaba puede seguir aunque esté inactivo
  db.usuarios.find(u => u.id === beto.id).estado = 'Inactivo';
  const editado = await tablerosService.actualizarTablero(mant.id, { miembros: [beto.id] });
  assert.deepEqual(editado.miembros.map(m => m.nombre), ['Beto']);
});

test('quitar a un miembro: sus tareas conservan el responsable y él deja de ver el tablero', async (t) => {
  const { ANA, BETO, DIR, mant, ana, beto } = await preparar(t);
  const tarea = await operationsService.crearTarea({ titulo: 'T', tablero_id: mant.id, asignados: [beto.id] }, ANA);

  await tablerosService.actualizarTablero(mant.id, { miembros: [ana.id] });

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
  const aprobada = await operationsService.aprobarPropuesta(pMant.id, {}, ANA);
  assert.equal(aprobada.tablero_id, mant.id);
});
