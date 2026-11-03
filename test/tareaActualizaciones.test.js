const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const express = require('express');
const supabase = require('../config/supabase');
const errorHandler = require('../middleware/errorHandler');
const operationsService = require('../operations/services/operationsService');
const etapasService = require('../operations/services/etapasService');
const service = require('../operations/services/tareaActualizacionesService');
const tareasRouter = require('../operations/routes/tareas');

// ── Supabase en memoria ──────────────────────────────────────────────────────
// Implementa lo que usan tareaActualizacionesService y operationsService
// (acceso a tareas, actualizar y eliminar tareas) y emula, con la misma
// lógica, lo que en la base hace la migración 2026-11-03_tareas_comentarios_y_tiempos:
//   - RPC tarea_tiempo_iniciar / tarea_tiempo_detener (atómicas);
//   - índice único parcial (tarea_id, usuario_id) WHERE fin IS NULL;
//   - trigger de cierre automático al pasar a completada/cancelada;
//   - trigger editado_at de comentarios; duracion_segundos generada;
//   - ON DELETE CASCADE desde tareas.
// El comportamiento real de PostgreSQL (bloqueos, triggers) requiere
// validación manual en nexacore_dev.

const ETAPAS = [
  { id: 'e-pend', nombre: 'Pendiente', tipo_base: 'pendiente', posicion: 0 },
  { id: 'e-curso', nombre: 'En curso', tipo_base: 'en_curso', posicion: 1 },
  { id: 'e-rev', nombre: 'Revisión', tipo_base: 'en_revision_abierta', posicion: 2 },
  { id: 'e-ok', nombre: 'Completada', tipo_base: 'completada', posicion: 3 },
  { id: 'e-canc', nombre: 'Cancelada', tipo_base: 'cancelada', posicion: 4 },
  { id: 'e-revc', nombre: 'Revisión final', tipo_base: 'en_revision_cerrada', posicion: 5 },
];

function crearBase() {
  const db = {
    usuarios: [], roles: [], tareas: [], tarea_asignados: [], tarea_historial: [],
    operativo_tableros: [], operativo_tablero_miembros: [],
    operativo_etapas: ETAPAS.map(e => ({ ...e })),
    tarea_comentarios: [], tarea_registros_tiempo: [],
  };
  const ahora = () => new Date().toISOString();
  const usuarioDe = (id) => {
    const u = db.usuarios.find(x => x.id === id);
    return u ? { id: u.id, nombre: u.nombre, email: u.email, estado: u.estado } : null;
  };
  const esFinal = (tarea) => {
    const etapa = db.operativo_etapas.find(e => e.id === tarea.etapa_id);
    if (etapa) return ['completada', 'cancelada'].includes(etapa.tipo_base);
    return ['Completada', 'Cancelada'].includes(tarea.estado);
  };
  const duracion = (r) => (r.fin ? Math.floor((Date.parse(r.fin) - Date.parse(r.inicio)) / 1000) : null);
  const cerrarActivos = (tareaId, motivo) => {
    for (const r of db.tarea_registros_tiempo) {
      if (r.tarea_id === tareaId && r.fin == null) {
        r.fin = ahora();
        r.motivo_finalizacion = motivo;
        r.duracion_segundos = duracion(r);
      }
    }
  };
  // Modelo de la migración correctiva. No ejecuta SQL ni demuestra locks MVCC.
  const tieneAcceso = (tarea, usuarioId) => {
    const u = db.usuarios.find(u => u.id === usuarioId);
    const nivel = db.roles.find(r => r.id === u?.rol_id)?.nivel_jerarquico;
    return !!u && u.estado === 'Activo' && (nivel === 'HIGH'
      || db.operativo_tablero_miembros.some(m => m.tablero_id === tarea.tablero_id && m.usuario_id === usuarioId));
  };
  const reconciliar = () => {
    for (const r of db.tarea_registros_tiempo) {
      const tarea = db.tareas.find(t => t.id === r.tarea_id);
      if (r.fin == null && tarea && (esFinal(tarea) || !tieneAcceso(tarea, r.usuario_id))) {
        r.fin = ahora();
        r.motivo_finalizacion = 'automatico';
        r.duracion_segundos = duracion(r);
      }
    }
  };

  function embeber(tabla, fila, select) {
    const out = { ...fila };
    if (tabla === 'tareas' && select.includes('operativo_etapas(')) {
      out.operativo_etapas = db.operativo_etapas.find(e => e.id === fila.etapa_id) ?? null;
    }
    if (tabla === 'tareas' && select.includes('tarea_asignados(')) {
      out.tarea_asignados = db.tarea_asignados.filter(a => a.tarea_id === fila.id)
        .map(a => ({ orden: a.orden, usuarios: usuarioDe(a.usuario_id) }));
    }
    if (tabla === 'usuarios' && select.includes('roles(')) {
      out.roles = { nombre: fila.rol ?? 'Operativo', nivel_jerarquico: fila.nivel ?? 'LOW' };
    }
    if (['tarea_comentarios', 'tarea_registros_tiempo'].includes(tabla) && select.includes('usuarios(')) {
      const u = usuarioDe(fila.usuario_id);
      out.usuarios = u ? { id: u.id, nombre: u.nombre } : null;
    }
    return out;
  }

  const consultas = [];
  function from(tabla) {
    consultas.push(tabla);
    const st = { filtros: [], accion: 'select', select: '*', single: false, head: false, ordenes: [], devolver: false };
    const ejecutar = () => {
      let filas = db[tabla].filter(f => st.filtros.every(fn => fn(f)));
      if (st.accion === 'insert') {
        const nuevas = st.valores.map(v => ({ id: randomUUID(), created_at: ahora(), ...v }));
        if (tabla === 'tarea_comentarios') nuevas.forEach(n => { n.editado_at = null; });
        db[tabla].push(...nuevas);
        filas = nuevas;
      } else if (st.accion === 'update') {
        for (const f of filas) {
          if (tabla === 'tarea_comentarios') {
            const cambio = 'contenido' in st.valores && st.valores.contenido !== f.contenido;
            Object.assign(f, st.valores, { tarea_id: f.tarea_id, created_at: f.created_at, editado_at: cambio ? ahora() : f.editado_at });
          } else {
            Object.assign(f, st.valores);
          }
          // trigger_tareas_finalizar_tiempos (AFTER UPDATE OF etapa_id, estado)
          if (tabla === 'tareas' && ('etapa_id' in st.valores || 'estado' in st.valores) && esFinal(f)) {
            cerrarActivos(f.id, 'automatico');
          }
        }
      } else if (st.accion === 'delete') {
        db[tabla] = db[tabla].filter(f => !filas.includes(f));
        if (tabla === 'usuarios') {
          for (const dep of ['tarea_comentarios', 'tarea_registros_tiempo']) {
            db[dep].forEach(r => { if (filas.some(u => u.id === r.usuario_id)) r.usuario_id = null; });
          }
          db.operativo_tablero_miembros = db.operativo_tablero_miembros.filter(m => !filas.some(u => u.id === m.usuario_id));
        }
        if (tabla === 'tareas') {
          const ids = new Set(filas.map(t => t.id));
          for (const dep of ['tarea_asignados', 'tarea_historial', 'tarea_comentarios', 'tarea_registros_tiempo']) {
            db[dep] = db[dep].filter(r => !ids.has(r.tarea_id));
          }
        }
      }
      if (['update', 'delete'].includes(st.accion)
          && ['tareas', 'operativo_etapas', 'operativo_tablero_miembros', 'usuarios', 'roles'].includes(tabla)) reconciliar();
      if (st.accion === 'delete' && !st.devolver) return { data: null, error: null };
      if (st.head) return { data: null, error: null, count: filas.length };
      if (st.ordenes.length) {
        filas = [...filas].sort((a, b) => {
          for (const [col, asc] of st.ordenes) {
            const x = a[col] ?? '', y = b[col] ?? '';
            if (x !== y) return (asc ? 1 : -1) * (x < y ? -1 : 1);
          }
          return 0;
        });
      }
      if (st.limite != null) filas = filas.slice(0, st.limite);
      const data = filas.map(f => embeber(tabla, f, st.select));
      if (st.single === 'maybe') return { data: data[0] ?? null, error: null };
      if (st.single) return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'not found' } };
      return { data, error: null, count: data.length };
    };
    const b = {
      select(cols = '*', opts = {}) { st.select = cols; st.head = !!opts.head; st.devolver = true; return b; },
      insert(v) { st.accion = 'insert'; st.valores = v; return b; },
      update(v) { st.accion = 'update'; st.valores = v; return b; },
      delete() { st.accion = 'delete'; return b; },
      eq(c, v) { st.filtros.push(f => f[c] === v); return b; },
      in(c, vs) { st.filtros.push(f => vs.includes(f[c])); return b; },
      is(c, v) { assert.equal(v, null); st.filtros.push(f => f[c] == null); return b; },
      not(c, op, v) { assert.deepEqual([op, v], ['is', null]); st.filtros.push(f => f[c] != null); return b; },
      or(expr) {
        assert.equal(expr, 'tipo.is.null,tipo.eq.asignacion');
        st.filtros.push(f => f.tipo == null || f.tipo === 'asignacion');
        return b;
      },
      order(col, { ascending } = {}) { st.ordenes.push([col, ascending !== false]); return b; },
      limit(n) { st.limite = n; return b; },
      single() { st.single = true; return b; },
      maybeSingle() { st.single = 'maybe'; return b; },
      then(res, rej) { return Promise.resolve().then(ejecutar).then(res, rej); },
    };
    return b;
  }

  const falla = (message) => ({ data: null, error: { code: 'P0001', message } });
  const rpcs = {
    tarea_sincronizar_asignados({ p_tarea_id, p_usuario_ids }) {
      db.tarea_asignados = db.tarea_asignados.filter(a => a.tarea_id !== p_tarea_id);
      p_usuario_ids.forEach((usuario_id, i) => db.tarea_asignados.push({ tarea_id: p_tarea_id, usuario_id, orden: i + 1 }));
      return { data: null, error: null };
    },
    tarea_tiempo_iniciar({ p_tarea_id, p_usuario_id }) {
      if (!p_usuario_id) return falla('NX_USUARIO_REQUERIDO');
      const tarea = db.tareas.find(t => t.id === p_tarea_id);
      if (!tarea) return falla('NX_TAREA_NO_ENCONTRADA');
      if (!tieneAcceso(tarea, p_usuario_id)) return falla('NX_SIN_ACCESO_TAREA');
      if (esFinal(tarea)) return falla('NX_TAREA_FINALIZADA');
      if (db.tarea_registros_tiempo.some(r => r.tarea_id === p_tarea_id && r.usuario_id === p_usuario_id && r.fin == null)) {
        return falla('NX_TEMPORIZADOR_ACTIVO');
      }
      const r = { id: randomUUID(), tarea_id: p_tarea_id, usuario_id: p_usuario_id, inicio: ahora(), fin: null, duracion_segundos: null, motivo_finalizacion: null };
      db.tarea_registros_tiempo.push(r);
      return { data: { ...r }, error: null };
    },
    tarea_tiempo_detener({ p_tarea_id, p_usuario_id }) {
      const r = db.tarea_registros_tiempo.find(x => x.tarea_id === p_tarea_id && x.usuario_id === p_usuario_id && x.fin == null);
      if (!r) return falla('NX_SIN_TEMPORIZADOR_ACTIVO');
      r.fin = ahora();
      r.motivo_finalizacion = 'manual';
      r.duracion_segundos = duracion(r);
      return { data: { ...r }, error: null };
    },
  };
  async function rpc(nombre, params) {
    assert.ok(nombre in rpcs, `RPC no soportada: ${nombre}`);
    return rpcs[nombre](params);
  }

  return { db, from, rpc, consultas };
}

const HORA = 60 * 60 * 1000;
const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-03T11:00:00.000Z');

// Tablero "Mantenimiento" con Nico, Pilar y Gino (mando bajo); "Compras" con
// Caro. Dora es Dirección (mando alto, ve todos los tableros sin ser miembro).
// Nadia no es miembro de ningún tablero.
function preparar(t) {
  const base = crearBase();
  t.mock.method(supabase, 'from', base.from);
  t.mock.method(supabase, 'rpc', base.rpc);
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const avanzar = (ms) => t.mock.timers.tick(ms);

  const usuario = (nombre, nivel = 'LOW') => {
    let rol = base.db.roles.find(r => r.nivel_jerarquico === nivel);
    if (!rol) { rol = { id: randomUUID(), nivel_jerarquico: nivel }; base.db.roles.push(rol); }
    const u = { id: randomUUID(), nombre, email: `${nombre.toLowerCase()}@x.com`, estado: 'Activo', nivel, rol_id: rol.id };
    base.db.usuarios.push(u);
    return u;
  };
  const sesion = (u) => ({ id: u.id, name: u.nombre, hierarchyLevel: u.nivel });
  const tablero = (nombre, miembros) => {
    const tb = { id: randomUUID(), nombre };
    base.db.operativo_tableros.push(tb);
    miembros.forEach(m => base.db.operativo_tablero_miembros.push({ tablero_id: tb.id, usuario_id: m.id, es_admin: false }));
    return tb;
  };
  const tarea = (tb, { etapa_id = 'e-curso', titulo = 'T', asignados = [] } = {}) => {
    const etapa = ETAPAS.find(e => e.id === etapa_id);
    const estado = { pendiente: 'Pendiente', completada: 'Completada', cancelada: 'Cancelada', en_revision_cerrada: 'Completada' }[etapa.tipo_base] ?? 'En Proceso';
    const tr = { id: randomUUID(), titulo, tipo: 'asignacion', tablero_id: tb.id, etapa_id, estado, created_at: new Date().toISOString() };
    base.db.tareas.push(tr);
    asignados.forEach((u, i) => base.db.tarea_asignados.push({ tarea_id: tr.id, usuario_id: u.id, orden: i + 1 }));
    return tr;
  };

  const nico = usuario('Nico'), pilar = usuario('Pilar'), gino = usuario('Gino');
  const caro = usuario('Caro'), dora = usuario('Dora', 'HIGH'), nadia = usuario('Nadia');
  const mant = tablero('Mantenimiento', [nico, pilar, gino]);
  const compras = tablero('Compras', [caro]);
  return {
    ...base, avanzar, usuario, tablero, tarea, mant, compras,
    nico, pilar, gino, caro, dora, nadia,
    NICO: sesion(nico), PILAR: sesion(pilar), GINO: sesion(gino), CARO: sesion(caro), DORA: sesion(dora), NADIA: sesion(nadia),
  };
}

const conStatus = (status) => (err) => err.status === status;

// ── Comentarios ──────────────────────────────────────────────────────────────

test('comentarios: un miembro del tablero comenta sin estar asignado; autor y fecha salen del servidor', async (t) => {
  const { mant, tarea, nico, pilar, PILAR, avanzar, db } = preparar(t);
  const tr = tarea(mant, { asignados: [nico] });
  avanzar(28 * MIN);
  const c = await service.crearComentario(tr.id, {
    contenido: '  Necesito ayuda con esto  ', usuario_id: nico.id, created_at: '2000-01-01T00:00:00Z', editado_at: '2000-01-01T00:00:00Z',
  }, PILAR);

  assert.equal(c.tipo, 'comentario');
  assert.equal(c.contenido, 'Necesito ayuda con esto');
  assert.deepEqual(c.usuario, { id: pilar.id, nombre: 'Pilar' });
  assert.equal(c.created_at, new Date(T0 + 28 * MIN).toISOString());
  assert.equal(c.fecha, c.created_at);
  assert.equal(c.editado_at, null);
  assert.equal(c.editado, false);
  assert.deepEqual(c.permisos, { puede_editar: true, puede_eliminar: true });
  // Persistido con el autor de la sesión
  assert.deepEqual(db.tarea_comentarios.map(x => [x.usuario_id, x.contenido]), [[pilar.id, 'Necesito ayuda con esto']]);
});

test('comentarios: persisten y se leen en orden cronológico con permisos por usuario', async (t) => {
  const { mant, tarea, NICO, PILAR, avanzar } = preparar(t);
  const tr = tarea(mant);
  await service.crearComentario(tr.id, { contenido: 'Empecé con esta tarea' }, NICO);
  avanzar(47 * MIN);
  await service.crearComentario(tr.id, { contenido: 'Necesito ayuda con esto' }, PILAR);

  // Nueva lectura (equivale a cerrar y volver a abrir la aplicación)
  const { data, total } = await service.listarComentarios(tr.id, NICO);
  assert.equal(total, 2);
  assert.deepEqual(data.map(c => [c.usuario.nombre, c.contenido, c.permisos.puede_editar]), [
    ['Nico', 'Empecé con esta tarea', true],
    ['Pilar', 'Necesito ayuda con esto', false],
  ]);
});

test('comentarios: el autor edita (marca editado_at) y elimina; los cambios se ven en consultas posteriores', async (t) => {
  const { mant, tarea, NICO, avanzar, db } = preparar(t);
  const tr = tarea(mant);
  const c = await service.crearComentario(tr.id, { contenido: 'Hola' }, NICO);
  avanzar(5 * MIN);
  const editado = await service.editarComentario(tr.id, c.id, { contenido: ' Hola a todos ', created_at: '2000-01-01T00:00:00Z' }, NICO);
  assert.equal(editado.contenido, 'Hola a todos');
  assert.equal(editado.created_at, c.created_at);
  assert.equal(editado.editado_at, new Date(T0 + 5 * MIN).toISOString());
  assert.equal(editado.editado, true);
  assert.equal((await service.listarComentarios(tr.id, NICO)).data[0].contenido, 'Hola a todos');

  assert.deepEqual(await service.eliminarComentario(tr.id, c.id, NICO), { message: 'Comentario eliminado correctamente' });
  assert.equal(db.tarea_comentarios.length, 0);
  assert.deepEqual((await service.listarComentarios(tr.id, NICO)).data, []);
  await assert.rejects(service.eliminarComentario(tr.id, c.id, NICO), conStatus(404));
});

test('comentarios: otro miembro (o Dirección) no puede editar ni eliminar un comentario ajeno', async (t) => {
  const { mant, tarea, NICO, PILAR, DORA, db } = preparar(t);
  const tr = tarea(mant);
  const c = await service.crearComentario(tr.id, { contenido: 'Original' }, NICO);
  for (const user of [PILAR, DORA]) {
    await assert.rejects(service.editarComentario(tr.id, c.id, { contenido: 'Pisado' }, user), conStatus(403));
    await assert.rejects(service.eliminarComentario(tr.id, c.id, user), conStatus(403));
  }
  assert.deepEqual(db.tarea_comentarios.map(x => x.contenido), ['Original']);
});

test('comentarios: usuarios ajenos al tablero no leen, crean, editan ni eliminan', async (t) => {
  const { mant, tarea, NICO, CARO, NADIA, db } = preparar(t);
  const tr = tarea(mant);
  const c = await service.crearComentario(tr.id, { contenido: 'Interno' }, NICO);
  for (const user of [CARO, NADIA]) {
    await assert.rejects(service.listarComentarios(tr.id, user), conStatus(403));
    await assert.rejects(service.listarActualizaciones(tr.id, user), conStatus(403));
    await assert.rejects(service.crearComentario(tr.id, { contenido: 'x' }, user), conStatus(403));
    await assert.rejects(service.editarComentario(tr.id, c.id, { contenido: 'x' }, user), conStatus(403));
    await assert.rejects(service.eliminarComentario(tr.id, c.id, user), conStatus(403));
  }
  assert.deepEqual(db.tarea_comentarios.map(x => x.contenido), ['Interno']);
});

test('comentarios: un comentario no se alcanza desde una tarea de otro tablero cambiando ids', async (t) => {
  const { mant, compras, tarea, NICO, CARO } = preparar(t);
  const propia = tarea(compras);
  const ajena = tarea(mant);
  const c = await service.crearComentario(ajena.id, { contenido: 'Secreto' }, NICO);
  // Caro usa su tarea (a la que tiene acceso) con el id del comentario ajeno
  await assert.rejects(service.editarComentario(propia.id, c.id, { contenido: 'x' }, CARO), conStatus(404));
  await assert.rejects(service.eliminarComentario(propia.id, c.id, CARO), conStatus(404));
});

test('comentarios: rechaza contenido vacío, solo espacios, no texto o demasiado largo', async (t) => {
  const { mant, tarea, NICO, db } = preparar(t);
  const tr = tarea(mant);
  const largo = 'a'.repeat(service.MAX_COMENTARIO_LENGTH + 1);
  for (const contenido of [undefined, null, '', '   ', '\n\t ', 42, ['x'], largo]) {
    await assert.rejects(service.crearComentario(tr.id, { contenido }, NICO), conStatus(400), JSON.stringify(contenido));
  }
  await assert.rejects(service.crearComentario(tr.id, undefined, NICO), conStatus(400));
  const ok = await service.crearComentario(tr.id, { contenido: 'a'.repeat(service.MAX_COMENTARIO_LENGTH) }, NICO);
  await assert.rejects(service.editarComentario(tr.id, ok.id, { contenido: '   ' }, NICO), conStatus(400));
  assert.equal(db.tarea_comentarios.length, 1);
});

test('comentarios: tareas y comentarios inexistentes o con id inválido -> 404', async (t) => {
  const { mant, tarea, NICO } = preparar(t);
  const tr = tarea(mant);
  await assert.rejects(service.crearComentario(randomUUID(), { contenido: 'x' }, NICO), conStatus(404));
  await assert.rejects(service.listarComentarios(randomUUID(), NICO), conStatus(404));
  await assert.rejects(service.listarActualizaciones(randomUUID(), NICO), conStatus(404));
  for (const id of [randomUUID(), 'no-uuid']) {
    await assert.rejects(service.editarComentario(tr.id, id, { contenido: 'x' }, NICO), conStatus(404));
    await assert.rejects(service.eliminarComentario(tr.id, id, NICO), conStatus(404));
  }
});

// ── Temporizadores ───────────────────────────────────────────────────────────

test('temporizador: inicio, consulta del activo y detención manual con duración del servidor', async (t) => {
  const { mant, tarea, gino, GINO, avanzar, db } = preparar(t);
  const tr = tarea(mant);
  assert.deepEqual(await service.obtenerTemporizadorActivo(tr.id, GINO), { activo: null, servidor_ahora: new Date(T0).toISOString() });

  const activo = await service.iniciarTemporizador(tr.id, GINO);
  assert.equal(activo.activo, true);
  assert.equal(activo.usuario_id, gino.id);
  assert.equal(activo.inicio, new Date(T0).toISOString());
  assert.equal(activo.transcurrido_segundos, 0);

  avanzar(HORA);
  // Recuperación al volver a abrir la tarea: se reconstruye con el reloj del servidor
  const recuperado = await service.obtenerTemporizadorActivo(tr.id, GINO);
  assert.equal(recuperado.activo.id, activo.id);
  assert.equal(recuperado.activo.transcurrido_segundos, 3600);
  assert.equal(recuperado.activo.servidor_ahora, new Date(T0 + HORA).toISOString());

  avanzar(2 * HORA + 45 * MIN + 30 * 1000);
  const registro = await service.detenerTemporizador(tr.id, GINO);
  assert.equal(registro.tipo, 'registro_tiempo');
  assert.equal(registro.id, activo.id);
  assert.equal(registro.duracion_segundos, 3 * 3600 + 45 * 60 + 30);
  assert.equal(registro.motivo_finalizacion, 'manual');
  assert.equal(registro.inicio, new Date(T0).toISOString());
  assert.equal(registro.fin, new Date(T0 + 3 * HORA + 45 * MIN + 30 * 1000).toISOString());
  assert.equal(registro.fecha, registro.fin);
  assert.deepEqual(registro.usuario, { id: gino.id, nombre: 'Gino' });
  assert.deepEqual(registro.permisos, { puede_editar: false, puede_eliminar: false });

  assert.equal((await service.obtenerTemporizadorActivo(tr.id, GINO)).activo, null);
  assert.equal(db.tarea_registros_tiempo.filter(r => r.fin == null).length, 0);
});

test('temporizador: dos usuarios en la misma tarea son independientes', async (t) => {
  const { mant, tarea, NICO, PILAR, avanzar } = preparar(t);
  const tr = tarea(mant);
  await service.iniciarTemporizador(tr.id, NICO);
  avanzar(10 * MIN);
  await service.iniciarTemporizador(tr.id, PILAR);
  avanzar(20 * MIN);

  const deNico = await service.detenerTemporizador(tr.id, NICO);
  assert.equal(deNico.duracion_segundos, 30 * 60);
  const dePilar = await service.obtenerTemporizadorActivo(tr.id, PILAR);
  assert.equal(dePilar.activo.transcurrido_segundos, 20 * 60, 'el de Pilar sigue activo');
  avanzar(5 * MIN);
  assert.equal((await service.detenerTemporizador(tr.id, PILAR)).duracion_segundos, 25 * 60);
});

test('temporizador: un usuario puede tener activos en distintas tareas a la vez', async (t) => {
  const { mant, tarea, PILAR, avanzar } = preparar(t);
  const a = tarea(mant, { titulo: 'A' }), b = tarea(mant, { titulo: 'B' });
  await service.iniciarTemporizador(a.id, PILAR);
  avanzar(MIN);
  await service.iniciarTemporizador(b.id, PILAR);
  assert.ok((await service.obtenerTemporizadorActivo(a.id, PILAR)).activo);
  assert.ok((await service.obtenerTemporizadorActivo(b.id, PILAR)).activo);
  await service.detenerTemporizador(b.id, PILAR);
  assert.ok((await service.obtenerTemporizadorActivo(a.id, PILAR)).activo, 'detener B no detiene A');
});

test('temporizador: no se crea un segundo activo del mismo usuario en la misma tarea (409)', async (t) => {
  const { mant, tarea, NICO, db } = preparar(t);
  const tr = tarea(mant);
  await service.iniciarTemporizador(tr.id, NICO);
  await assert.rejects(service.iniciarTemporizador(tr.id, NICO), conStatus(409));
  assert.equal(db.tarea_registros_tiempo.length, 1);
});

test('temporizador: pedidos de inicio simultáneos crean un solo registro activo', async (t) => {
  const { mant, tarea, NICO, db } = preparar(t);
  const tr = tarea(mant);
  const resultados = await Promise.allSettled(Array.from({ length: 5 }, () => service.iniciarTemporizador(tr.id, NICO)));
  assert.equal(resultados.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(resultados.filter(r => r.status === 'rejected').every(r => r.reason.status === 409));
  assert.equal(db.tarea_registros_tiempo.filter(r => r.fin == null).length, 1);
});

test('temporizador: pedidos de detención simultáneos cierran una sola vez', async (t) => {
  const { mant, tarea, NICO, avanzar, db } = preparar(t);
  const tr = tarea(mant);
  await service.iniciarTemporizador(tr.id, NICO);
  avanzar(MIN);
  const resultados = await Promise.allSettled([service.detenerTemporizador(tr.id, NICO), service.detenerTemporizador(tr.id, NICO)]);
  assert.deepEqual(resultados.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(resultados.find(r => r.status === 'rejected').reason.status, 409);
  assert.equal(db.tarea_registros_tiempo.length, 1);
});

test('temporizador: un tercero no puede detener el temporizador de otro usuario', async (t) => {
  const { mant, tarea, NICO, PILAR, DORA } = preparar(t);
  const tr = tarea(mant);
  await service.iniciarTemporizador(tr.id, NICO);
  // Detener siempre actúa sobre el temporizador propio: Pilar y Dirección no tienen uno.
  await assert.rejects(service.detenerTemporizador(tr.id, PILAR), conStatus(409));
  await assert.rejects(service.detenerTemporizador(tr.id, DORA), conStatus(409));
  assert.ok((await service.obtenerTemporizadorActivo(tr.id, NICO)).activo, 'el de Nico sigue activo');
});

test('temporizador: varias sesiones del mismo usuario en la misma tarea son registros independientes', async (t) => {
  const { mant, tarea, NICO, avanzar } = preparar(t);
  const tr = tarea(mant);
  const duraciones = [];
  for (const minutos of [10, 25, 5]) {
    await service.iniciarTemporizador(tr.id, NICO);
    avanzar(minutos * MIN);
    duraciones.push((await service.detenerTemporizador(tr.id, NICO)).duracion_segundos);
    avanzar(MIN);
  }
  assert.deepEqual(duraciones, [600, 1500, 300]);
  const { data } = await service.listarActualizaciones(tr.id, NICO);
  assert.equal(new Set(data.map(e => e.id)).size, 3);
  assert.deepEqual(data.map(e => e.duracion_segundos), [600, 1500, 300]);
});

test('temporizador: el usuario sale de la sesión; un usuario_id del body no se usa', async (t) => {
  const { mant, tarea, nico, PILAR, db } = preparar(t);
  const tr = tarea(mant);
  // La API no recibe usuario_id: el controlador solo pasa req.user
  await service.iniciarTemporizador(tr.id, PILAR, { usuario_id: nico.id });
  assert.deepEqual(db.tarea_registros_tiempo.map(r => r.usuario_id), [PILAR.id]);
});

test('temporizador: acceso por pertenencia al tablero (sin requerir asignación)', async (t) => {
  const { mant, tarea, nico, GINO, CARO, NADIA, DORA } = preparar(t);
  const tr = tarea(mant, { asignados: [nico] });
  await service.iniciarTemporizador(tr.id, GINO); // miembro, no asignado
  for (const user of [CARO, NADIA]) {
    await assert.rejects(service.iniciarTemporizador(tr.id, user), conStatus(403));
    await assert.rejects(service.detenerTemporizador(tr.id, user), conStatus(403));
    await assert.rejects(service.obtenerTemporizadorActivo(tr.id, user), conStatus(403));
  }
  // Mando alto: mismo acceso que al resto de las tareas del tablero
  assert.equal((await service.obtenerTemporizadorActivo(tr.id, DORA)).activo, null);
  await assert.rejects(service.iniciarTemporizador(randomUUID(), GINO), conStatus(404));
});

// ── Finalización automática ──────────────────────────────────────────────────

test('completar la tarea cierra todos los temporizadores activos (motivo automático) y quedan en el historial', async (t) => {
  const { mant, tarea, NICO, PILAR, GINO, avanzar, db } = preparar(t);
  const tr = tarea(mant);
  await service.iniciarTemporizador(tr.id, NICO);
  avanzar(30 * MIN);
  await service.iniciarTemporizador(tr.id, PILAR);
  avanzar(15 * MIN);

  await operationsService.actualizarTarea(tr.id, { etapa_id: 'e-ok' }, GINO);

  assert.equal(db.tarea_registros_tiempo.filter(r => r.fin == null).length, 0, 'sin temporizadores activos');
  const { data } = await service.listarActualizaciones(tr.id, GINO);
  // Ambos cierran en el mismo instante: el desempate es por id, así que se compara ordenado por nombre.
  assert.deepEqual(data.map(e => [e.usuario.nombre, e.duracion_segundos, e.motivo_finalizacion, e.fin]).sort(), [
    ['Nico', 45 * 60, 'automatico', new Date(T0 + 45 * MIN).toISOString()],
    ['Pilar', 15 * 60, 'automatico', new Date(T0 + 45 * MIN).toISOString()],
  ]);
  assert.equal((await service.obtenerTemporizadorActivo(tr.id, NICO)).activo, null);
  await assert.rejects(service.detenerTemporizador(tr.id, NICO), conStatus(409));
});

test('no se pueden iniciar temporizadores en tareas completadas o canceladas; sí al reabrirlas', async (t) => {
  const { mant, tarea, NICO, db } = preparar(t);
  for (const etapa_id of ['e-ok', 'e-canc']) {
    const tr = tarea(mant, { etapa_id });
    await assert.rejects(service.iniciarTemporizador(tr.id, NICO), conStatus(409), etapa_id);
  }
  // Sin etapa (tareas anteriores a las etapas): según el estado canónico
  db.tareas.push({ id: 'legacy', titulo: 'L', tipo: 'asignacion', tablero_id: mant.id, etapa_id: null, estado: 'Completada' });
  await assert.rejects(service.iniciarTemporizador('legacy', NICO), conStatus(409));
  assert.equal(db.tarea_registros_tiempo.length, 0);

  const reabierta = tarea(mant, { etapa_id: 'e-ok' });
  await operationsService.actualizarTarea(reabierta.id, { etapa_id: 'e-curso' }, NICO);
  assert.ok((await service.iniciarTemporizador(reabierta.id, NICO)).activo);
});

test('cancelar la tarea también cierra los temporizadores activos', async (t) => {
  const { mant, tarea, NICO, avanzar, db } = preparar(t);
  const tr = tarea(mant);
  await service.iniciarTemporizador(tr.id, NICO);
  avanzar(MIN);
  await operationsService.actualizarTarea(tr.id, { etapa_id: 'e-canc' }, NICO);
  assert.deepEqual(db.tarea_registros_tiempo.map(r => [r.motivo_finalizacion, r.duracion_segundos]), [['automatico', 60]]);
});

test('las etapas de revisión no son finales: los temporizadores siguen activos y se pueden iniciar', async (t) => {
  const { mant, tarea, NICO, PILAR, db } = preparar(t);
  const tr = tarea(mant);
  await service.iniciarTemporizador(tr.id, NICO);
  await operationsService.actualizarTarea(tr.id, { etapa_id: 'e-rev' }, NICO);
  await operationsService.actualizarTarea(tr.id, { etapa_id: 'e-revc' }, NICO);
  assert.equal(db.tarea_registros_tiempo.filter(r => r.fin == null).length, 1);
  assert.ok((await service.iniciarTemporizador(tr.id, PILAR)).activo, 'en_revision_cerrada admite iniciar');
});

test('eliminar la tarea no deja temporizadores activos ni registros huérfanos (cascada, igual que tarea_historial)', async (t) => {
  const { mant, tarea, NICO, PILAR, db } = preparar(t);
  const tr = tarea(mant);
  const otra = tarea(mant);
  await service.iniciarTemporizador(tr.id, NICO);
  await service.iniciarTemporizador(otra.id, NICO);
  await service.crearComentario(tr.id, { contenido: 'x' }, PILAR);
  await service.crearComentario(otra.id, { contenido: 'y' }, PILAR);

  await operationsService.eliminarTarea(tr.id, PILAR);

  assert.equal(db.tarea_registros_tiempo.some(r => r.tarea_id === tr.id), false);
  assert.equal(db.tarea_comentarios.some(c => c.tarea_id === tr.id), false);
  // Lo de otras tareas no se toca
  assert.equal(db.tarea_registros_tiempo.filter(r => r.tarea_id === otra.id && r.fin == null).length, 1);
  assert.equal(db.tarea_comentarios.filter(c => c.tarea_id === otra.id).length, 1);
  await assert.rejects(service.obtenerTemporizadorActivo(tr.id, NICO), conStatus(404));
  await assert.rejects(service.iniciarTemporizador(tr.id, NICO), conStatus(404));
});

// ── Historial unificado ──────────────────────────────────────────────────────

test('actualizaciones: comentarios y tiempos juntos, en orden cronológico, sin temporizadores activos', async (t) => {
  const { mant, tarea, NICO, PILAR, GINO, avanzar } = preparar(t);
  const tr = tarea(mant);
  await service.iniciarTemporizador(tr.id, GINO);                                     // 11:00
  avanzar(28 * MIN);
  await service.crearComentario(tr.id, { contenido: 'Empecé con esta tarea' }, NICO); // 11:28
  avanzar(47 * MIN);
  await service.crearComentario(tr.id, { contenido: 'Necesito ayuda con esto' }, PILAR); // 12:15
  await service.iniciarTemporizador(tr.id, NICO);                                     // activo, no aparece
  avanzar(3 * HORA + 30 * MIN);
  await service.detenerTemporizador(tr.id, GINO);                                     // 15:45, 4h45m

  const { data, total } = await service.listarActualizaciones(tr.id, PILAR);
  assert.equal(total, 3);
  assert.deepEqual(data.map(e => [e.tipo, e.usuario.nombre, e.fecha]), [
    ['comentario', 'Nico', '2026-11-03T11:28:00.000Z'],
    ['comentario', 'Pilar', '2026-11-03T12:15:00.000Z'],
    ['registro_tiempo', 'Gino', '2026-11-03T15:45:00.000Z'],
  ]);
  const [deNico, dePilar, tiempo] = data;
  assert.deepEqual([deNico.permisos, dePilar.permisos], [
    { puede_editar: false, puede_eliminar: false },
    { puede_editar: true, puede_eliminar: true },
  ]);
  assert.equal(tiempo.duracion_segundos, 4 * 3600 + 45 * 60);
  assert.deepEqual(tiempo.permisos, { puede_editar: false, puede_eliminar: false });
  assert.ok(!('contenido' in tiempo));
  // Datos estructurados, sin texto de presentación
  assert.ok(data.every(e => !JSON.stringify(e).includes('Trabajó')));
});

test('actualizaciones: orden determinista a igual marca temporal (comentario antes que tiempo, luego id)', async (t) => {
  const { mant, tarea, NICO, PILAR, avanzar } = preparar(t);
  const tr = tarea(mant);
  await service.iniciarTemporizador(tr.id, NICO);
  await service.iniciarTemporizador(tr.id, PILAR);
  avanzar(MIN);
  // Todo a la misma hora del servidor
  await service.detenerTemporizador(tr.id, PILAR);
  await service.detenerTemporizador(tr.id, NICO);
  await service.crearComentario(tr.id, { contenido: 'b' }, NICO);
  await service.crearComentario(tr.id, { contenido: 'a' }, PILAR);

  const primera = (await service.listarActualizaciones(tr.id, NICO)).data;
  assert.deepEqual(primera.map(e => e.tipo), ['comentario', 'comentario', 'registro_tiempo', 'registro_tiempo']);
  const ids = (tipo) => primera.filter(e => e.tipo === tipo).map(e => e.id);
  assert.deepEqual(ids('comentario'), [...ids('comentario')].sort());
  assert.deepEqual(ids('registro_tiempo'), [...ids('registro_tiempo')].sort());
  assert.deepEqual((await service.listarActualizaciones(tr.id, NICO)).data, primera);
});

test('actualizaciones: un usuario eliminado aparece sin autor', async (t) => {
  const { mant, tarea, pilar, PILAR, NICO, db } = preparar(t);
  const tr = tarea(mant);
  await service.crearComentario(tr.id, { contenido: 'x' }, PILAR);
  // ON DELETE SET NULL
  db.usuarios = db.usuarios.filter(u => u.id !== pilar.id);
  db.tarea_comentarios.forEach(c => { if (c.usuario_id === pilar.id) c.usuario_id = null; });
  const [c] = (await service.listarActualizaciones(tr.id, NICO)).data;
  assert.equal(c.usuario, null);
  assert.deepEqual(c.permisos, { puede_editar: false, puede_eliminar: false });
});

// Corrección incremental: comportamiento esperado con la BD simulada.
for (const tipo_base of ['completada', 'cancelada']) {
  test(`configurar etapa ${tipo_base}: cierra todos sus activos, conserva históricos y rechaza inicios`, async (t) => {
    const { mant, tarea, NICO, PILAR, avanzar, db } = preparar(t);
    const a = tarea(mant), b = tarea(mant), otra = tarea(mant, { etapa_id: 'e-pend' });
    await service.iniciarTemporizador(a.id, NICO);
    avanzar(MIN);
    await service.detenerTemporizador(a.id, NICO);
    const historico = { ...db.tarea_registros_tiempo[0] };
    await service.iniciarTemporizador(a.id, NICO);
    await service.iniciarTemporizador(b.id, PILAR);
    await service.iniciarTemporizador(otra.id, NICO);
    avanzar(2 * MIN);
    await etapasService.actualizarEtapa('e-curso', { tipo_base });
    const cerrados = db.tarea_registros_tiempo.filter(r => [a.id, b.id].includes(r.tarea_id));
    assert.ok(cerrados.every(r => r.fin !== null));
    assert.deepEqual(cerrados[0], historico);
    assert.deepEqual(cerrados.slice(1).map(r => [r.motivo_finalizacion, r.duracion_segundos]), [['automatico', 120], ['automatico', 120]]);
    assert.ok((await service.obtenerTemporizadorActivo(otra.id, NICO)).activo);
    await assert.rejects(service.iniciarTemporizador(a.id, NICO), conStatus(409));
    await etapasService.actualizarEtapa('e-curso', { tipo_base: 'en_curso' });
    assert.ok((await service.iniciarTemporizador(a.id, NICO)).activo);
  });
}

for (const tipo_base of ['en_revision_abierta', 'en_revision_cerrada']) {
  test(`configurar etapa ${tipo_base}: no cierra tiempos`, async (t) => {
    const { mant, tarea, NICO, PILAR } = preparar(t);
    const tr = tarea(mant);
    await service.iniciarTemporizador(tr.id, NICO);
    await etapasService.actualizarEtapa('e-curso', { tipo_base });
    assert.ok((await service.obtenerTemporizadorActivo(tr.id, NICO)).activo);
    assert.ok((await service.iniciarTemporizador(tr.id, PILAR)).activo);
  });
}

for (const escenario of ['baja de miembro', 'desactivación', 'eliminación']) {
  test(`pérdida de acceso: ${escenario} cierra solo los tiempos afectados`, async (t) => {
    const { mant, compras, tarea, NICO, PILAR, nico, avanzar, db } = preparar(t);
    db.operativo_tablero_miembros.push({ tablero_id: compras.id, usuario_id: nico.id });
    const tr = tarea(mant), otra = tarea(compras);
    await service.iniciarTemporizador(tr.id, NICO);
    await service.iniciarTemporizador(otra.id, NICO);
    await service.iniciarTemporizador(tr.id, PILAR);
    avanzar(MIN);
    if (escenario === 'baja de miembro') {
      await supabase.from('operativo_tablero_miembros').delete().eq('tablero_id', mant.id).eq('usuario_id', nico.id);
      await assert.rejects(service.listarActualizaciones(tr.id, NICO), conStatus(403));
      await assert.rejects(service.iniciarTemporizador(tr.id, NICO), conStatus(403));
    } else if (escenario === 'desactivación') {
      await supabase.from('usuarios').update({ estado: 'Inactivo' }).eq('id', nico.id);
      await assert.rejects(service.iniciarTemporizador(tr.id, NICO), conStatus(403));
    } else {
      await supabase.from('usuarios').delete().eq('id', nico.id);
    }
    const [primero, segundo, tercero] = db.tarea_registros_tiempo;
    assert.deepEqual([primero.motivo_finalizacion, primero.duracion_segundos], ['automatico', 60]);
    assert.equal(segundo.fin === null, escenario === 'baja de miembro');
    assert.equal(tercero.fin, null);
    if (escenario === 'eliminación') assert.equal(primero.usuario_id, null);
  });
}

test('mando alto: salir del tablero no cierra tiempos; perder HIGH solo cierra donde no es miembro', async (t) => {
  const { mant, compras, tarea, dora, DORA, nico, db } = preparar(t);
  db.operativo_tablero_miembros.push({ tablero_id: mant.id, usuario_id: dora.id });
  const a = tarea(mant), b = tarea(compras);
  await service.iniciarTemporizador(a.id, DORA);
  await service.iniciarTemporizador(b.id, DORA);
  await supabase.from('operativo_tablero_miembros').delete().eq('usuario_id', dora.id);
  assert.ok(db.tarea_registros_tiempo.every(r => r.fin === null));
  db.operativo_tablero_miembros.push({ tablero_id: mant.id, usuario_id: dora.id });
  await supabase.from('usuarios').update({ rol_id: nico.rol_id }).eq('id', dora.id);
  assert.equal(db.tarea_registros_tiempo[0].fin, null);
  assert.equal(db.tarea_registros_tiempo[1].motivo_finalizacion, 'automatico');
  // Una sesión leída antes del cambio no debe autorizar la RPC.
  await assert.rejects(service.iniciarTemporizador(b.id, DORA), conStatus(403));
});

test('cambiar nivel del rol cierra tiempos sin membresía; quitar admin conserva acceso', async (t) => {
  const { mant, tarea, nico, dora, NICO, DORA, db } = preparar(t);
  const tr = tarea(mant);
  await service.iniciarTemporizador(tr.id, NICO);
  await service.iniciarTemporizador(tr.id, DORA);
  await supabase.from('operativo_tablero_miembros').update({ es_admin: false }).eq('usuario_id', nico.id);
  assert.ok(db.tarea_registros_tiempo.every(r => r.fin === null));
  await supabase.from('roles').update({ nivel_jerarquico: 'LOW' }).eq('id', dora.rol_id);
  assert.equal(db.tarea_registros_tiempo[0].fin, null);
  assert.equal(db.tarea_registros_tiempo[1].motivo_finalizacion, 'automatico');
});

for (const cambio of ['etapa', 'membresía']) {
  test(`carrera ${cambio}/inicio: revocación después del chequeo JS es rechazada por RPC`, async (t) => {
    const { mant, tarea, nico, NICO, db } = preparar(t);
    const tr = tarea(mant);
    const verificar = service._asegurarAccesoTarea.bind(service);
    t.mock.method(service, '_asegurarAccesoTarea', async (...args) => {
      const fila = await verificar(...args);
      if (cambio === 'etapa') await etapasService.actualizarEtapa('e-curso', { tipo_base: 'completada' });
      else await supabase.from('operativo_tablero_miembros').delete().eq('usuario_id', nico.id);
      return fila;
    });
    await assert.rejects(service.iniciarTemporizador(tr.id, NICO), conStatus(cambio === 'etapa' ? 409 : 403));
    assert.equal(db.tarea_registros_tiempo.length, 0);
  });
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function servidor(t, ctx) {
  t.mock.method(supabase.auth, 'getUser', async (token) => {
    const u = ctx.db.usuarios.find(x => x.email === token);
    return u ? { data: { user: { email: u.email } }, error: null } : { data: { user: null }, error: { message: 'invalid' } };
  });
  const app = express();
  app.use(express.json());
  app.use('/api/operations/tareas', tareasRouter);
  app.use(errorHandler);
  const server = http.createServer(app).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/operations/tareas`;
  return async (metodo, path, { como, body } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (como) headers.authorization = `Bearer ${como.email}`;
    const res = await fetch(base + path, { method: metodo, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
}

test('HTTP: rutas, códigos de respuesta e identidad desde el token', async (t) => {
  const ctx = preparar(t);
  t.mock.timers.reset();
  const { mant, tarea, nico, pilar, caro, db } = ctx;
  const api = await servidor(t, ctx);
  const tr = tarea(mant);

  assert.equal((await api('GET', `/${tr.id}/actualizaciones`)).status, 401);
  assert.equal((await api('POST', `/${tr.id}/temporizador/iniciar`)).status, 401);

  const creado = await api('POST', `/${tr.id}/comentarios`, { como: pilar, body: { contenido: 'Hola', usuario_id: nico.id } });
  assert.equal(creado.status, 201);
  assert.equal(creado.body.usuario.id, pilar.id);
  assert.equal((await api('POST', `/${tr.id}/comentarios`, { como: pilar, body: { contenido: ' ' } })).status, 400);
  assert.equal((await api('POST', `/${tr.id}/comentarios`, { como: caro, body: { contenido: 'x' } })).status, 403);
  assert.equal((await api('POST', `/${randomUUID()}/comentarios`, { como: pilar, body: { contenido: 'x' } })).status, 404);
  assert.equal((await api('PATCH', `/${tr.id}/comentarios/${creado.body.id}`, { como: nico, body: { contenido: 'x' } })).status, 403);
  const editado = await api('PATCH', `/${tr.id}/comentarios/${creado.body.id}`, { como: pilar, body: { contenido: 'Hola!' } });
  assert.deepEqual([editado.status, editado.body.contenido, editado.body.editado], [200, 'Hola!', true]);
  assert.equal((await api('GET', `/${tr.id}/comentarios`, { como: nico })).body.total, 1);

  const iniciado = await api('POST', `/${tr.id}/temporizador/iniciar`, { como: nico, body: { usuario_id: pilar.id } });
  assert.deepEqual([iniciado.status, iniciado.body.usuario_id, iniciado.body.activo], [201, nico.id, true]);
  assert.equal((await api('POST', `/${tr.id}/temporizador/iniciar`, { como: nico })).status, 409);
  assert.equal((await api('GET', `/${tr.id}/temporizador`, { como: nico })).body.activo.id, iniciado.body.id);
  assert.equal((await api('GET', `/${tr.id}/temporizador`, { como: pilar })).body.activo, null);
  assert.equal((await api('POST', `/${tr.id}/temporizador/detener`, { como: pilar })).status, 409);
  const detenido = await api('POST', `/${tr.id}/temporizador/detener`, { como: nico });
  assert.deepEqual([detenido.status, detenido.body.tipo, detenido.body.motivo_finalizacion], [200, 'registro_tiempo', 'manual']);
  assert.equal(typeof detenido.body.duracion_segundos, 'number');

  const hist = await api('GET', `/${tr.id}/actualizaciones`, { como: pilar });
  assert.deepEqual([hist.status, hist.body.data.map(e => e.tipo)], [200, ['comentario', 'registro_tiempo']]);

  const borrado = await api('DELETE', `/${tr.id}/comentarios/${creado.body.id}`, { como: pilar });
  assert.equal(borrado.status, 200);
  assert.equal(db.tarea_comentarios.length, 0);

  // Endpoints existentes sin cambios
  assert.equal((await api('GET', `/${tr.id}/historial`, { como: pilar })).status, 200);
});

test('HTTP: no hay rutas para editar ni eliminar registros de tiempo', () => {
  const rutas = tareasRouter.stack.filter(l => l.route).map(l => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
  assert.ok(!rutas.some(r => /tiempo|registro/i.test(r) && /^(PUT|PATCH|DELETE)/.test(r)));
  for (const r of ['GET /:id/actualizaciones', 'POST /:id/comentarios', 'PATCH /:id/comentarios/:comentarioId',
    'DELETE /:id/comentarios/:comentarioId', 'GET /:id/temporizador', 'POST /:id/temporizador/iniciar', 'POST /:id/temporizador/detener']) {
    assert.ok(rutas.includes(r), r);
  }
});
