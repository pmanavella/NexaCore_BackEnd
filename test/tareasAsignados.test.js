const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const operationsService = require('../operations/services/operationsService');
const nexiDatos = require('../nexi/services/nexiDatos');

// ── Supabase en memoria ──────────────────────────────────────────────────────
// Implementa solo lo que usan operationsService / tareaAsignados: filtros eq/in/or
// (tipo), embeds de operativo_etapas y tarea_asignados(usuarios), insert/update/
// delete y la RPC tarea_sincronizar_asignados (con el UNIQUE de la base).

function crearBase() {
  const db = {
    usuarios: [], tareas: [], tarea_asignados: [], tarea_historial: [],
    operativo_etapas: [{ id: 'etapa-1', nombre: 'Pendiente', color: '#000000', tipo_base: 'pendiente', posicion: 0 }],
  };
  const usuario = (nombre, estado = 'Activo') => {
    const u = { id: randomUUID(), nombre, email: `${nombre.toLowerCase()}@x.com`, estado };
    db.usuarios.push(u);
    return u;
  };

  function embeber(tabla, fila, select) {
    const out = { ...fila };
    if (tabla === 'tareas' && select.includes('operativo_etapas(')) {
      out.operativo_etapas = db.operativo_etapas.find(e => e.id === fila.etapa_id) ?? null;
    }
    if (tabla === 'tareas' && select.includes('tarea_asignados(')) {
      out.tarea_asignados = db.tarea_asignados
        .filter(a => a.tarea_id === fila.id)
        .map(a => {
          const u = db.usuarios.find(x => x.id === a.usuario_id);
          return { orden: a.orden, usuarios: { id: u.id, nombre: u.nombre, email: u.email, estado: u.estado } };
        });
    }
    return out;
  }

  function from(tabla) {
    const st = { filtros: [], accion: 'select', select: '*', single: false };
    const ejecutar = () => {
      let filas = db[tabla].filter(f => st.filtros.every(fn => fn(f)));
      if (st.accion === 'insert') {
        const nuevas = st.valores.map(v => ({ id: randomUUID(), created_at: new Date().toISOString(), ...v }));
        db[tabla].push(...nuevas);
        filas = nuevas;
      } else if (st.accion === 'update') {
        filas.forEach(f => Object.assign(f, st.valores));
      } else if (st.accion === 'delete') {
        db[tabla] = db[tabla].filter(f => !filas.includes(f));
        if (tabla === 'tareas') db.tarea_asignados = db.tarea_asignados.filter(a => !filas.some(t => t.id === a.tarea_id));
        return { data: null, error: null };
      }
      const data = filas.map(f => embeber(tabla, f, st.select));
      if (st.single) {
        return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: 'not found', code: 'PGRST116' } };
      }
      return { data, error: null, count: data.length };
    };
    const b = {
      select(cols = '*') { st.select = cols; return b; },
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
      order() { return b; },
      limit() { return b; },
      single() { st.single = true; return b; },
      maybeSingle() { st.single = true; return b; },
      then(res, rej) { return Promise.resolve().then(ejecutar).then(res, rej); },
    };
    return b;
  }

  async function rpc(nombre, { p_tarea_id, p_usuario_ids }) {
    assert.equal(nombre, 'tarea_sincronizar_asignados');
    if (new Set(p_usuario_ids).size !== p_usuario_ids.length) return { error: { code: '23505', message: 'duplicate' } };
    db.tarea_asignados = db.tarea_asignados.filter(a => a.tarea_id !== p_tarea_id || p_usuario_ids.includes(a.usuario_id));
    p_usuario_ids.forEach((usuario_id, i) => {
      const existente = db.tarea_asignados.find(a => a.tarea_id === p_tarea_id && a.usuario_id === usuario_id);
      if (existente) existente.orden = i + 1;
      else db.tarea_asignados.push({ id: randomUUID(), tarea_id: p_tarea_id, usuario_id, orden: i + 1 });
    });
    const nombres = db.tarea_asignados
      .filter(a => a.tarea_id === p_tarea_id).sort((a, b) => a.orden - b.orden)
      .map(a => db.usuarios.find(u => u.id === a.usuario_id).nombre);
    db.tareas.find(t => t.id === p_tarea_id).asignado_a = nombres.length ? nombres.join(', ') : null;
    return { error: null };
  }

  return { db, usuario, from, rpc };
}

function preparar(t) {
  const base = crearBase();
  t.mock.method(supabase, 'from', base.from);
  t.mock.method(supabase, 'rpc', base.rpc);
  const A = base.usuario('Ana'), B = base.usuario('Beto'), C = base.usuario('Caro');
  return { ...base, A, B, C };
}

const nombres = (tarea) => tarea.asignados.map(a => a.nombre);

// ── Creación ─────────────────────────────────────────────────────────────────

test('A) crear tarea con una persona', async (t) => {
  const { A } = preparar(t);
  const tarea = await operationsService.crearTarea({ titulo: 'T', asignados: [A.id] });
  assert.deepEqual(tarea.asignados, [{ id: A.id, nombre: 'Ana', email: 'ana@x.com', estado: 'Activo' }]);
  assert.equal(tarea.asignado_a, 'Ana'); // compatibilidad: igual que antes con un responsable
  assert.equal(tarea.tarea_asignados, undefined);
});

test('B/C) crear tarea con dos y tres personas (respeta el orden enviado)', async (t) => {
  const { A, B, C } = preparar(t);
  const dos = await operationsService.crearTarea({ titulo: 'T2', asignados: [B.id, A.id] });
  assert.deepEqual(nombres(dos), ['Beto', 'Ana']);
  assert.equal(dos.asignado_a, 'Beto, Ana');
  const tres = await operationsService.crearTarea({ titulo: 'T3', asignados: [A.id, B.id, C.id] });
  assert.deepEqual(nombres(tres), ['Ana', 'Beto', 'Caro']);
});

test('D) crear con [A, A] → 400 y no crea la tarea', async (t) => {
  const { A, db } = preparar(t);
  await assert.rejects(
    operationsService.crearTarea({ titulo: 'T', asignados: [A.id, A.id] }),
    (err) => err.status === 400 && /dos veces/.test(err.message)
  );
  assert.equal(db.tareas.length, 0);
});

test('crear: validaciones de asignados (no array, id inválido, inexistente, inactivo) → 400', async (t) => {
  const { usuario, db } = preparar(t);
  const inactivo = usuario('Ivo', 'Inactivo');
  for (const asignados of ['abc', ['no-uuid'], [randomUUID()], [inactivo.id]]) {
    await assert.rejects(operationsService.crearTarea({ titulo: 'T', asignados }), (err) => err.status === 400, JSON.stringify(asignados));
  }
  assert.equal(db.tareas.length, 0);
});

test('crear sin asignados: tarea sin personas (el campo sigue siendo opcional)', async (t) => {
  preparar(t);
  const tarea = await operationsService.crearTarea({ titulo: 'T' });
  assert.deepEqual(tarea.asignados, []);
  assert.equal(tarea.asignado_a, null);
});

test('crear con asignado_a legacy (nombre único) → vincula al usuario', async (t) => {
  const { A } = preparar(t);
  const tarea = await operationsService.crearTarea({ titulo: 'T', asignado_a: 'Ana' });
  assert.deepEqual(tarea.asignados.map(a => a.id), [A.id]);
});

// ── Edición ──────────────────────────────────────────────────────────────────

test('E/F/G) editar [A] → [A,B] → [B] → [B,C] con historial', async (t) => {
  const { A, B, C, db } = preparar(t);
  const { id } = await operationsService.crearTarea({ titulo: 'T', asignados: [A.id] });

  let tarea = await operationsService.actualizarTarea(id, { asignados: [A.id, B.id], usuario_nombre: 'Admin' });
  assert.deepEqual(nombres(tarea), ['Ana', 'Beto']);
  tarea = await operationsService.actualizarTarea(id, { asignados: [B.id] });
  assert.deepEqual(nombres(tarea), ['Beto']);
  tarea = await operationsService.actualizarTarea(id, { asignados: [B.id, C.id] });
  assert.deepEqual(nombres(tarea), ['Beto', 'Caro']);
  assert.equal(db.tarea_asignados.filter(a => a.tarea_id === id).length, 2);

  const cambios = db.tarea_historial.filter(h => h.campo_modificado === 'asignado_a').map(h => [h.valor_anterior, h.valor_nuevo]);
  assert.deepEqual(cambios, [['Ana', 'Ana, Beto'], ['Ana, Beto', 'Beto'], ['Beto', 'Beto, Caro']]);
});

test('editar con duplicados → 400 y no cambia nada', async (t) => {
  const { A, B } = preparar(t);
  const { id } = await operationsService.crearTarea({ titulo: 'T', asignados: [A.id] });
  await assert.rejects(operationsService.actualizarTarea(id, { asignados: [B.id, B.id], titulo: 'Otro' }), (err) => err.status === 400);
  const [tarea] = (await operationsService.listarTareas()).data;
  assert.equal(tarea.titulo, 'T');
  assert.deepEqual(nombres(tarea), ['Ana']);
});

test('editar sin `asignados` no toca la asignación; reenviar el asignado_a actual tampoco', async (t) => {
  const { A, B } = preparar(t);
  const { id } = await operationsService.crearTarea({ titulo: 'T', asignados: [A.id, B.id] });
  let tarea = await operationsService.actualizarTarea(id, { titulo: 'Nuevo' });
  assert.deepEqual(nombres(tarea), ['Ana', 'Beto']);
  // Cliente viejo que reenvía el formulario con el texto que recibió
  tarea = await operationsService.actualizarTarea(id, { titulo: 'Otro', asignado_a: 'Ana, Beto' });
  assert.deepEqual(nombres(tarea), ['Ana', 'Beto']);
});

test('editar: un asignado ya inactivo puede mantenerse, pero no agregarse', async (t) => {
  const { A, B, db } = preparar(t);
  const { id } = await operationsService.crearTarea({ titulo: 'T', asignados: [A.id] });
  db.usuarios.find(u => u.id === A.id).estado = 'Inactivo';
  const tarea = await operationsService.actualizarTarea(id, { asignados: [A.id, B.id] });
  assert.deepEqual(nombres(tarea), ['Ana', 'Beto']);
  const otra = await operationsService.crearTarea({ titulo: 'T2' });
  await assert.rejects(operationsService.actualizarTarea(otra.id, { asignados: [A.id] }), (err) => err.status === 400);
});

// ── Listado y filtros ────────────────────────────────────────────────────────

test('H/I) listar devuelve todos los asignados; filtrar por persona incluye tareas compartidas', async (t) => {
  const { A, B, C } = preparar(t);
  await operationsService.crearTarea({ titulo: 'solo-ana', asignados: [A.id] });
  await operationsService.crearTarea({ titulo: 'compartida', asignados: [A.id, B.id] });
  await operationsService.crearTarea({ titulo: 'solo-caro', asignados: [C.id] });

  const todas = await operationsService.listarTareas();
  assert.deepEqual(nombres(todas.data.find(x => x.titulo === 'compartida')), ['Ana', 'Beto']);

  const porId = await operationsService.listarTareas({ asignado_id: B.id });
  assert.deepEqual(porId.data.map(x => x.titulo), ['compartida']);

  // Filtro legacy por nombre: también encuentra la compartida (antes eq exacto la perdía)
  const porNombre = await operationsService.listarTareas({ asignado_a: 'Ana' });
  assert.deepEqual(porNombre.data.map(x => x.titulo).sort(), ['compartida', 'solo-ana']);

  const nadie = await operationsService.listarTareas({ asignado_a: 'Nadie' });
  assert.deepEqual(nadie, { data: [], total: 0 });
});

test('J) tarea histórica: vinculada por la migración se devuelve como asignados: [persona]; sin vincular conserva su texto', async (t) => {
  const { A, db } = preparar(t);
  // Estado tal como lo deja la migración
  db.tareas.push({ id: 'hist-1', titulo: 'vieja', tipo: 'asignacion', asignado_a: 'Ana', etapa_id: 'etapa-1' });
  db.tarea_asignados.push({ id: 'r1', tarea_id: 'hist-1', usuario_id: A.id, orden: 1 });
  db.tareas.push({ id: 'hist-2', titulo: 'externa', tipo: 'asignacion', asignado_a: 'Fantasma', etapa_id: 'etapa-1' });

  const { data } = await operationsService.listarTareas();
  const vieja = data.find(x => x.id === 'hist-1');
  assert.deepEqual(vieja.asignados.map(a => a.id), [A.id]);
  assert.equal(vieja.asignado_a, 'Ana');
  assert.equal(vieja.operativo_etapas.id, 'etapa-1');
  const externa = data.find(x => x.id === 'hist-2');
  assert.deepEqual(externa.asignados, []);
  assert.equal(externa.asignado_a, 'Fantasma');

  // El filtro por nombre sigue encontrando la tarea sin vincular
  const fantasma = await operationsService.listarTareas({ asignado_a: 'Fantasma' });
  assert.deepEqual(fantasma.data.map(x => x.id), ['hist-2']);

  // Editar otros campos no altera su responsable histórico
  const editada = await operationsService.actualizarTarea('hist-2', { titulo: 'externa 2', asignado_a: 'Fantasma' });
  assert.equal(editada.asignado_a, 'Fantasma');
});

test('Nexi mis_tareas: incluye tareas compartidas del usuario de la sesión', async (t) => {
  const { A, B } = preparar(t);
  await operationsService.crearTarea({ titulo: 'compartida', asignados: [A.id, B.id] });
  await operationsService.crearTarea({ titulo: 'de-beto', asignados: [B.id] });
  const { filas, total } = await nexiDatos.tareasAbiertasAsignadasA({ id: A.id, nombre: 'Ana' }, 10);
  assert.equal(total, 1);
  assert.deepEqual(filas.map(f => f.titulo), ['compartida']);
});

test('eliminar tarea elimina sus asignaciones', async (t) => {
  const { A, B, db } = preparar(t);
  const { id } = await operationsService.crearTarea({ titulo: 'T', asignados: [A.id, B.id] });
  await operationsService.eliminarTarea(id);
  assert.equal(db.tarea_asignados.length, 0);
});
