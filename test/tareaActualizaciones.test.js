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
const tablerosService = require('../operations/services/tablerosService');
const notificacionesService = require('../notificaciones/services/notificacionesService');
const notificacionesRouter = require('../notificaciones/routes/notificaciones');

// ── Supabase en memoria ──────────────────────────────────────────────────────
// Implementa lo que usan tareaActualizacionesService y operationsService
// (acceso a tareas, actualizar y eliminar tareas) y emula, con la misma
// lógica, lo que en la base hace la migración 2026-11-03_tareas_comentarios_y_tiempos:
//   - RPC tarea_tiempo_iniciar / tarea_tiempo_detener (atómicas);
//   - índice único parcial (tarea_id, usuario_id) WHERE fin IS NULL;
//   - trigger de cierre automático al pasar a completada/cancelada;
//   - trigger editado_at de comentarios; duracion_segundos generada;
//   - ON DELETE CASCADE desde tareas.
// y lo de las migraciones 2026-11-09 (carga manual y corrección de tiempos
// con auditoría; comentarios con menciones y notificaciones):
//   - RPC tarea_tiempo_registrar_manual / tarea_tiempo_corregir;
//   - trigger de auditoría (carga_manual / correccion) y versión;
//   - RPC tarea_comentario_crear / tarea_comentario_editar;
//   - trigger de comentario eliminado sobre notificaciones; cascadas.
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
    tarea_registros_tiempo_auditoria: [], tarea_comentario_menciones: [], notificaciones: [],
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
    if (['tarea_comentarios', 'tarea_registros_tiempo'].includes(tabla) && select.includes('usuarios!usuario_id(')) {
      const u = usuarioDe(fila.usuario_id);
      out.usuarios = u ? { id: u.id, nombre: u.nombre } : null;
    }
    if (tabla === 'tarea_comentarios' && select.includes('tarea_comentario_menciones(')) {
      out.tarea_comentario_menciones = db.tarea_comentario_menciones.filter(m => m.comentario_id === fila.id)
        .map(m => ({ usuario_id: m.usuario_id, usuarios: usuarioDe(m.usuario_id) }));
    }
    if (['tarea_registros_tiempo', 'notificaciones'].includes(tabla) && /tareas!tarea_id(!inner)?\(/.test(select)) {
      const tr = db.tareas.find(x => x.id === fila.tarea_id);
      out.tareas = tr ? { id: tr.id, titulo: tr.titulo, tablero_id: tr.tablero_id ?? null } : null;
    }
    if (tabla === 'notificaciones' && select.includes('autor:usuarios!autor_id(')) {
      const u = usuarioDe(fila.autor_id);
      out.autor = u ? { id: u.id, nombre: u.nombre } : null;
    }
    if (tabla === 'tarea_registros_tiempo_auditoria' && select.includes('actor:usuarios!actor_id(')) {
      const u = usuarioDe(fila.actor_id);
      out.actor = u ? { id: u.id, nombre: u.nombre } : null;
    }
    if (tabla === 'operativo_tablero_miembros' && select.includes('usuarios(')) {
      out.usuarios = usuarioDe(fila.usuario_id);
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
          } else if (tabla === 'notificaciones') {
            // Privilegio de columna + notificaciones_proteger: solo leida_at, una vez, con la hora de la base.
            assert.deepEqual(Object.keys(st.valores), ['leida_at']);
            if (f.leida_at == null) f.leida_at = ahora();
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
          const ids = new Set(filas.map(u => u.id));
          for (const dep of ['tarea_comentarios', 'tarea_registros_tiempo']) {
            db[dep].forEach(r => { if (ids.has(r.usuario_id)) r.usuario_id = null; });
          }
          db.operativo_tablero_miembros = db.operativo_tablero_miembros.filter(m => !ids.has(m.usuario_id));
          db.tarea_comentario_menciones = db.tarea_comentario_menciones.filter(m => !ids.has(m.usuario_id));
          db.notificaciones = db.notificaciones.filter(n => !ids.has(n.destinatario_id));
          db.notificaciones.forEach(n => { if (ids.has(n.autor_id)) n.autor_id = null; });
          db.tarea_registros_tiempo_auditoria.forEach(a => { if (ids.has(a.actor_id)) a.actor_id = null; });
        }
        if (tabla === 'tarea_comentarios') {
          // CASCADE de menciones; trigger_tarea_comentarios_notificaciones_eliminado.
          const ids = new Set(filas.map(c => c.id));
          db.tarea_comentario_menciones = db.tarea_comentario_menciones.filter(m => !ids.has(m.comentario_id));
          db.notificaciones.forEach(n => { if (ids.has(n.comentario_id) && !n.comentario_eliminado_at) n.comentario_eliminado_at = ahora(); });
        }
        if (tabla === 'tareas') {
          const ids = new Set(filas.map(t => t.id));
          const comentarios = new Set(db.tarea_comentarios.filter(c => ids.has(c.tarea_id)).map(c => c.id));
          db.tarea_comentario_menciones = db.tarea_comentario_menciones.filter(m => !comentarios.has(m.comentario_id));
          for (const dep of ['tarea_asignados', 'tarea_historial', 'tarea_comentarios', 'tarea_registros_tiempo',
            'tarea_registros_tiempo_auditoria', 'notificaciones']) {
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
      if (st.limite != null) filas = filas.slice(st.desde ?? 0, (st.desde ?? 0) + st.limite);
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
      neq(c, v) { st.filtros.push(f => f[c] !== v); return b; },
      lt(c, v) { st.filtros.push(f => f[c] != null && Date.parse(f[c]) < Date.parse(v)); return b; },
      in(c, vs) {
        if (c === 'tareas.tablero_id') {
          // Filtro sobre el embed !inner (PostgREST): la fila queda si su tarea pasa el filtro.
          st.filtros.push(f => vs.includes(db.tareas.find(t => t.id === f.tarea_id)?.tablero_id));
          return b;
        }
        st.filtros.push(f => vs.includes(f[c]));
        return b;
      },
      is(c, v) { assert.equal(v, null); st.filtros.push(f => f[c] == null); return b; },
      not(c, op, v) { assert.deepEqual([op, v], ['is', null]); st.filtros.push(f => f[c] != null); return b; },
      or(expr) {
        const fin = /^fin\.is\.null,fin\.gt\."([^"]+)"$/.exec(expr);
        if (fin) {
          st.filtros.push(f => f.fin == null || Date.parse(f.fin) > Date.parse(fin[1]));
          return b;
        }
        assert.equal(expr, 'tipo.is.null,tipo.eq.asignacion');
        st.filtros.push(f => f.tipo == null || f.tipo === 'asignacion');
        return b;
      },
      order(col, { ascending } = {}) { st.ordenes.push([col, ascending !== false]); return b; },
      limit(n) { st.limite = n; return b; },
      range(desde, hasta) { st.desde = desde; st.limite = hasta - desde + 1; return b; },
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
      const r = {
        id: randomUUID(), tarea_id: p_tarea_id, usuario_id: p_usuario_id, inicio: ahora(), fin: null, duracion_segundos: null,
        motivo_finalizacion: null, origen: 'temporizador', version: 1, corregido_at: null,
      };
      db.tarea_registros_tiempo.push(r);
      return { data: { ...r }, error: null };
    },
    // tarea_tiempo_validar_intervalo
    _intervalo(inicio, fin) {
      if (!inicio || !fin || !(Date.parse(inicio) < Date.parse(fin))) return falla('NX_INTERVALO_INVALIDO');
      if (Date.parse(fin) > Date.now()) return falla('NX_FIN_FUTURO');
      return null;
    },
    _auditar(r, accion, actor, anterior = { inicio: null, fin: null }) {
      db.tarea_registros_tiempo_auditoria.push({
        id: randomUUID(), registro_id: r.id, tarea_id: r.tarea_id, accion, actor_id: actor, version: r.version,
        inicio_anterior: anterior.inicio, fin_anterior: anterior.fin, inicio_nuevo: r.inicio, fin_nuevo: r.fin, created_at: ahora(),
      });
    },
    tarea_tiempo_registrar_manual({ p_tarea_id, p_usuario_id, p_inicio, p_fin }) {
      if (!p_usuario_id) return falla('NX_USUARIO_REQUERIDO');
      const tarea = db.tareas.find(t => t.id === p_tarea_id);
      if (!tarea) return falla('NX_TAREA_NO_ENCONTRADA');
      if (!tieneAcceso(tarea, p_usuario_id)) return falla('NX_SIN_ACCESO_TAREA');
      const invalido = rpcs._intervalo(p_inicio, p_fin);
      if (invalido) return invalido;
      const r = {
        id: randomUUID(), tarea_id: p_tarea_id, usuario_id: p_usuario_id, inicio: p_inicio, fin: p_fin,
        motivo_finalizacion: null, origen: 'carga_manual', version: 1, corregido_at: null,
      };
      r.duracion_segundos = duracion(r);
      db.tarea_registros_tiempo.push(r);
      rpcs._auditar(r, 'carga_manual', p_usuario_id);
      return { data: { ...r }, error: null };
    },
    tarea_tiempo_corregir({ p_registro_id, p_tarea_id, p_usuario_id, p_inicio, p_fin, p_version }) {
      if (!p_usuario_id) return falla('NX_USUARIO_REQUERIDO');
      const tarea = db.tareas.find(t => t.id === p_tarea_id);
      if (!tarea) return falla('NX_TAREA_NO_ENCONTRADA');
      if (!tieneAcceso(tarea, p_usuario_id)) return falla('NX_SIN_ACCESO_TAREA');
      const r = db.tarea_registros_tiempo.find(x => x.id === p_registro_id && x.tarea_id === p_tarea_id);
      if (!r) return falla('NX_REGISTRO_NO_ENCONTRADO');
      if (r.usuario_id == null || r.usuario_id !== p_usuario_id) return falla('NX_REGISTRO_AJENO');
      if (r.fin == null) return falla('NX_REGISTRO_ACTIVO');
      if (p_version !== r.version) return falla('NX_VERSION_DESACTUALIZADA');
      if (p_inicio === r.inicio && p_fin === r.fin) return { data: { ...r }, error: null };
      const invalido = rpcs._intervalo(p_inicio, p_fin);
      if (invalido) return invalido;
      const anterior = { inicio: r.inicio, fin: r.fin };
      Object.assign(r, { inicio: p_inicio, fin: p_fin, version: r.version + 1, corregido_at: ahora() });
      r.duracion_segundos = duracion(r);
      rpcs._auditar(r, 'correccion', p_usuario_id, anterior);
      return { data: { ...r }, error: null };
    },
    // tarea_comentario_exigir_mencionables (miembros activos del tablero)
    _mencionables(tableroId, ids) {
      return ids.every(id => !!tableroId
        && db.operativo_tablero_miembros.some(m => m.tablero_id === tableroId && m.usuario_id === id)
        && db.usuarios.find(u => u.id === id)?.estado === 'Activo');
    },
    _notificar(comentarioId, tareaId, autorId, ids) {
      for (const id of ids) {
        if (id === autorId) continue;
        if (db.notificaciones.some(n => n.destinatario_id === id && n.tipo === 'mencion_comentario' && n.comentario_id === comentarioId)) continue;
        db.notificaciones.push({
          id: randomUUID(), destinatario_id: id, tipo: 'mencion_comentario', autor_id: autorId, tarea_id: tareaId,
          comentario_id: comentarioId, comentario_eliminado_at: null, created_at: ahora(), leida_at: null,
        });
      }
    },
    tarea_comentario_crear({ p_tarea_id, p_autor_id, p_contenido, p_mencionados }) {
      const ids = [...new Set(p_mencionados ?? [])];
      if (!p_autor_id) return falla('NX_USUARIO_REQUERIDO');
      const tarea = db.tareas.find(t => t.id === p_tarea_id);
      if (!tarea) return falla('NX_TAREA_NO_ENCONTRADA');
      if (!tieneAcceso(tarea, p_autor_id)) return falla('NX_SIN_ACCESO_TAREA');
      if (!rpcs._mencionables(tarea.tablero_id, ids)) return falla('NX_MENCION_INVALIDA');
      const c = { id: randomUUID(), tarea_id: p_tarea_id, usuario_id: p_autor_id, contenido: p_contenido, created_at: ahora(), editado_at: null };
      db.tarea_comentarios.push(c);
      ids.forEach(usuario_id => db.tarea_comentario_menciones.push({ comentario_id: c.id, usuario_id, created_at: ahora() }));
      rpcs._notificar(c.id, p_tarea_id, p_autor_id, ids);
      return { data: { ...c }, error: null };
    },
    tarea_comentario_editar({ p_comentario_id, p_tarea_id, p_autor_id, p_contenido, p_mencionados }) {
      const ids = [...new Set(p_mencionados ?? [])];
      if (!p_autor_id) return falla('NX_USUARIO_REQUERIDO');
      const tarea = db.tareas.find(t => t.id === p_tarea_id);
      if (!tarea) return falla('NX_TAREA_NO_ENCONTRADA');
      if (!tieneAcceso(tarea, p_autor_id)) return falla('NX_SIN_ACCESO_TAREA');
      const c = db.tarea_comentarios.find(x => x.id === p_comentario_id && x.tarea_id === p_tarea_id);
      if (!c) return falla('NX_COMENTARIO_NO_ENCONTRADO');
      if (c.usuario_id !== p_autor_id) return falla('NX_COMENTARIO_AJENO');
      const vigentes = db.tarea_comentario_menciones.filter(m => m.comentario_id === c.id).map(m => m.usuario_id);
      const nuevos = ids.filter(id => !vigentes.includes(id));
      if (!rpcs._mencionables(tarea.tablero_id, nuevos)) return falla('NX_MENCION_INVALIDA');
      if (p_contenido !== c.contenido) { c.contenido = p_contenido; c.editado_at = ahora(); }
      db.tarea_comentario_menciones = db.tarea_comentario_menciones.filter(m => m.comentario_id !== c.id || ids.includes(m.usuario_id));
      nuevos.forEach(usuario_id => db.tarea_comentario_menciones.push({ comentario_id: c.id, usuario_id, created_at: ahora() }));
      rpcs._notificar(c.id, p_tarea_id, p_autor_id, nuevos);
      return { data: { ...c }, error: null };
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
  // Ampliación 2026-11-09: el autor puede corregir su registro finalizado; nunca eliminarlo.
  assert.deepEqual(registro.permisos, { puede_editar: true, puede_eliminar: false });
  assert.deepEqual([registro.origen, registro.version, registro.corregido, registro.corregido_at], ['temporizador', 1, false, null]);

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

async function servidor(t, ctx, prefijo = '/api/operations/tareas') {
  t.mock.method(supabase.auth, 'getUser', async (token) => {
    const u = ctx.db.usuarios.find(x => x.email === token);
    return u ? { data: { user: { email: u.email } }, error: null } : { data: { user: null }, error: { message: 'invalid' } };
  });
  const app = express();
  app.use(express.json());
  app.use('/api/operations/tareas', tareasRouter);
  app.use('/api/notificaciones', notificacionesRouter);
  app.use(errorHandler);
  const server = http.createServer(app).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}${prefijo}`;
  return async (metodo, path, { como, body } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (como) headers.authorization = `Bearer ${como.email}`;
    const res = await fetch(base + path, { method: metodo, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const texto = await res.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { /* respuesta no JSON (404 de Express) */ }
    return { status: res.status, body: json };
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

test('HTTP: no hay rutas para eliminar registros de tiempo; la única modificación es la corrección', () => {
  const rutas = tareasRouter.stack.filter(l => l.route).map(l => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
  assert.ok(!rutas.some(r => /tiempo|registro|temporizador/i.test(r) && /^DELETE/.test(r)));
  assert.deepEqual(rutas.filter(r => /tiempo|registro|temporizador/i.test(r) && /^(PUT|PATCH)/.test(r)), ['PATCH /:id/registros-tiempo/:registroId']);
  // Endpoints existentes, sin cambios de ruta
  for (const r of ['GET /:id/actualizaciones', 'POST /:id/comentarios', 'PATCH /:id/comentarios/:comentarioId',
    'DELETE /:id/comentarios/:comentarioId', 'GET /:id/temporizador', 'POST /:id/temporizador/iniciar', 'POST /:id/temporizador/detener',
    'GET /:id/historial', 'GET /', 'POST /', 'PUT /:id', 'DELETE /:id']) {
    assert.ok(rutas.includes(r), r);
  }
  // Nuevos
  for (const r of ['GET /temporizadores-activos', 'GET /:id/mencionables', 'POST /:id/registros-tiempo',
    'POST /:id/registros-tiempo/validar', 'GET /:id/registros-tiempo/:registroId/correcciones']) {
    assert.ok(rutas.includes(r), r);
  }
  // Las rutas fijas van antes de las que empiezan con /:id
  assert.ok(rutas.indexOf('GET /temporizadores-activos') < rutas.indexOf('GET /:id/historial'));
});

// ══ 2026-11-09: carga manual y corrección de tiempos ═════════════════════════

const iso = (ms) => new Date(ms).toISOString();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test('carga manual: registra tiempo propio con duración calculada, origen y auditoría; ignora datos del cliente', async (t) => {
  const { mant, tarea, nico, pilar, NICO, PILAR, db } = preparar(t);
  const tr = tarea(mant);
  const { registro, advertencias } = await service.registrarTiempoManual(tr.id, {
    inicio: '2026-11-03T06:00:00-03:00', fin: '2026-11-03T07:30:00-03:00',
    usuario_id: pilar.id, duracion_segundos: 1, origen: 'temporizador', version: 9, motivo_finalizacion: 'manual',
  }, NICO);

  assert.equal(registro.tipo, 'registro_tiempo');
  assert.deepEqual(registro.usuario, { id: nico.id, nombre: 'Nico' });
  assert.deepEqual([registro.inicio, registro.fin, registro.fecha], ['2026-11-03T09:00:00.000Z', '2026-11-03T10:30:00.000Z', '2026-11-03T10:30:00.000Z']);
  assert.equal(registro.duracion_segundos, 90 * 60);
  assert.deepEqual([registro.origen, registro.motivo_finalizacion, registro.version, registro.corregido, registro.corregido_at],
    ['carga_manual', null, 1, false, null]);
  assert.deepEqual(registro.permisos, { puede_editar: true, puede_eliminar: false });
  assert.deepEqual(advertencias, { superposicion: false, superposiciones: [] });
  assert.deepEqual(db.tarea_registros_tiempo_auditoria.map(a => [a.accion, a.actor_id, a.version, a.inicio_anterior, a.fin_anterior, a.inicio_nuevo, a.fin_nuevo]),
    [['carga_manual', nico.id, 1, null, null, registro.inicio, registro.fin]]);

  // Aparece en el historial de la tarea; para otro miembro no es corregible.
  const [evento] = (await service.listarActualizaciones(tr.id, PILAR)).data;
  assert.deepEqual([evento.id, evento.origen, evento.permisos], [registro.id, 'carga_manual', { puede_editar: false, puede_eliminar: false }]);
  // No deja un temporizador activo.
  assert.equal((await service.obtenerTemporizadorActivo(tr.id, NICO)).activo, null);
});

test('carga manual: una sesión que cruza la medianoche se guarda entera', async (t) => {
  const { mant, tarea, NICO } = preparar(t);
  const tr = tarea(mant);
  const { registro } = await service.registrarTiempoManual(tr.id, { inicio: '2026-11-02T22:30:00-03:00', fin: '2026-11-03T01:15:00-03:00' }, NICO);
  assert.deepEqual([registro.inicio, registro.fin, registro.duracion_segundos],
    ['2026-11-03T01:30:00.000Z', '2026-11-03T04:15:00.000Z', 2 * 3600 + 45 * 60]);
});

test('carga manual: rechaza intervalos y fechas inválidas sin guardar nada', async (t) => {
  const { mant, tarea, NICO, db } = preparar(t);
  const tr = tarea(mant);
  const casos = [
    {},
    { inicio: '2026-11-03T06:00:00-03:00' },
    { fin: '2026-11-03T06:00:00-03:00' },
    { inicio: '2026-11-03T07:00:00-03:00', fin: '2026-11-03T07:00:00-03:00' },  // duración cero
    { inicio: '2026-11-03T07:00:00-03:00', fin: '2026-11-03T06:00:00-03:00' },  // invertido
    { inicio: '2026-11-03T07:00:00-03:00', fin: iso(T0 + MIN) },               // fin futuro
    { inicio: '2026-02-30T07:00:00-03:00', fin: '2026-03-01T08:00:00-03:00' },  // 30 de febrero
    { inicio: '2026-11-03T24:00:00-03:00', fin: '2026-11-03T07:00:00-03:00' },  // hora inexistente
    { inicio: '2026-13-01T07:00:00-03:00', fin: '2026-11-03T07:00:00-03:00' },  // mes inexistente
    { inicio: '2026-11-03T06:00:00', fin: '2026-11-03T07:00:00' },              // sin zona horaria
    { inicio: '03/11/2026 06:00', fin: '03/11/2026 07:00' },
    { inicio: Date.parse('2026-11-03T06:00:00Z'), fin: Date.parse('2026-11-03T07:00:00Z') },
  ];
  for (const body of casos) {
    await assert.rejects(service.registrarTiempoManual(tr.id, body, NICO), conStatus(400), JSON.stringify(body));
  }
  await assert.rejects(service.registrarTiempoManual(tr.id, undefined, NICO), conStatus(400));
  assert.equal(db.tarea_registros_tiempo.length, 0);
  assert.equal(db.tarea_registros_tiempo_auditoria.length, 0);

  // Bordes válidos: fin exactamente "ahora" y año bisiesto.
  assert.equal((await service.registrarTiempoManual(tr.id, { inicio: iso(T0 - HORA), fin: iso(T0) }, NICO)).registro.duracion_segundos, 3600);
  assert.equal((await service.registrarTiempoManual(tr.id, { inicio: '2024-02-29T10:00:00Z', fin: '2024-02-29T10:00:01Z' }, NICO)).registro.duracion_segundos, 1);
});

test('tareas completadas o canceladas: se registra y corrige tiempo sin reactivarlas ni cambiar su estado', async (t) => {
  const { mant, tarea, NICO, db } = preparar(t);
  for (const etapa_id of ['e-ok', 'e-canc']) {
    const tr = tarea(mant, { etapa_id });
    const antes = { ...db.tareas.find(x => x.id === tr.id) };
    const { registro } = await service.registrarTiempoManual(tr.id, { inicio: iso(T0 - 2 * HORA), fin: iso(T0 - HORA) }, NICO);
    const { registro: corregido } = await service.corregirRegistroTiempo(tr.id, registro.id, { fin: iso(T0 - 90 * MIN), version: 1 }, NICO);
    assert.equal(corregido.duracion_segundos, 30 * 60, etapa_id);
    assert.deepEqual(db.tareas.find(x => x.id === tr.id), antes, etapa_id);
    // La regla del temporizador no cambia: no se inicia en tareas finalizadas.
    await assert.rejects(service.iniciarTemporizador(tr.id, NICO), conStatus(409));
  }
  assert.equal(db.tarea_registros_tiempo.filter(r => r.fin == null).length, 0);
});

test('corrección: el autor corrige un registro del temporizador; se recalcula la duración y queda auditada', async (t) => {
  const { mant, tarea, nico, NICO, PILAR, avanzar } = preparar(t);
  const tr = tarea(mant);
  await service.iniciarTemporizador(tr.id, NICO);                 // T0
  avanzar(3 * HORA);                                              // se olvidó de detenerlo
  const detenido = await service.detenerTemporizador(tr.id, NICO);
  assert.equal(detenido.duracion_segundos, 3 * 3600);

  const { registro, advertencias } = await service.corregirRegistroTiempo(tr.id, detenido.id, {
    fin: iso(T0 + HORA), version: 1, usuario_id: randomUUID(), duracion_segundos: 5, origen: 'carga_manual',
  }, NICO);
  assert.deepEqual([registro.id, registro.origen, registro.motivo_finalizacion], [detenido.id, 'temporizador', 'manual']);
  assert.deepEqual([registro.inicio, registro.fin, registro.duracion_segundos], [iso(T0), iso(T0 + HORA), 3600]);
  assert.deepEqual([registro.version, registro.corregido, registro.corregido_at], [2, true, iso(T0 + 3 * HORA)]);
  assert.equal(advertencias.superposicion, false);

  // Trazabilidad visible para cualquier miembro con acceso a la tarea.
  const { registro: actual, data, total } = await service.listarCorreccionesRegistro(tr.id, detenido.id, PILAR);
  assert.equal(actual.version, 2);
  assert.equal(total, 1);
  assert.deepEqual(data.map(({ id, created_at, ...resto }) => resto), [{
    registro_id: detenido.id, accion: 'correccion', version: 2, actor: { id: nico.id, nombre: 'Nico' },
    inicio_anterior: iso(T0), fin_anterior: iso(T0 + 3 * HORA), duracion_anterior_segundos: 3 * 3600,
    inicio_nuevo: iso(T0), fin_nuevo: iso(T0 + HORA), duracion_nueva_segundos: 3600,
  }]);
});

test('corrección: una carga manual corregida dos veces conserva toda la trazabilidad en orden', async (t) => {
  const { mant, tarea, NICO, avanzar } = preparar(t);
  const tr = tarea(mant);
  const { registro } = await service.registrarTiempoManual(tr.id, { inicio: iso(T0 - 3 * HORA), fin: iso(T0 - 2 * HORA) }, NICO);
  avanzar(MIN);
  await service.corregirRegistroTiempo(tr.id, registro.id, { inicio: iso(T0 - 4 * HORA), version: 1 }, NICO);
  avanzar(MIN);
  const { registro: final } = await service.corregirRegistroTiempo(tr.id, registro.id,
    { inicio: '2026-11-03T03:30:00-03:00', fin: '2026-11-03T05:00:00-03:00', version: 2 }, NICO);
  assert.deepEqual([final.version, final.duracion_segundos, final.origen], [3, 90 * 60, 'carga_manual']);

  const { data } = await service.listarCorreccionesRegistro(tr.id, registro.id, NICO);
  assert.deepEqual(data.map(a => [a.accion, a.version, a.inicio_anterior, a.fin_anterior, a.inicio_nuevo, a.fin_nuevo]), [
    ['carga_manual', 1, null, null, iso(T0 - 3 * HORA), iso(T0 - 2 * HORA)],
    ['correccion', 2, iso(T0 - 3 * HORA), iso(T0 - 2 * HORA), iso(T0 - 4 * HORA), iso(T0 - 2 * HORA)],
    ['correccion', 3, iso(T0 - 4 * HORA), iso(T0 - 2 * HORA), '2026-11-03T06:30:00.000Z', '2026-11-03T08:00:00.000Z'],
  ]);
});

test('corrección: control de versión, campos obligatorios, validaciones y correcciones sin cambios', async (t) => {
  const { mant, tarea, NICO, db } = preparar(t);
  const tr = tarea(mant);
  const { registro } = await service.registrarTiempoManual(tr.id, { inicio: iso(T0 - 2 * HORA), fin: iso(T0 - HORA) }, NICO);
  const corregir = (body) => service.corregirRegistroTiempo(tr.id, registro.id, body, NICO);
  const fila = () => db.tarea_registros_tiempo.find(r => r.id === registro.id);

  await assert.rejects(corregir({ fin: iso(T0 - 90 * MIN) }), conStatus(400), 'sin versión');
  await assert.rejects(corregir({ fin: iso(T0 - 90 * MIN), version: '1' }), conStatus(400), 'versión no numérica');
  await assert.rejects(corregir({ version: 1 }), conStatus(400), 'sin inicio ni fin');
  await assert.rejects(corregir({ fin: iso(T0 - 90 * MIN), version: 2 }), conStatus(409), 'versión futura');
  await assert.rejects(corregir({ fin: iso(T0 + MIN), version: 1 }), conStatus(400), 'fin futuro');
  await assert.rejects(corregir({ inicio: iso(T0 - HORA), version: 1 }), conStatus(400), 'inicio = fin');
  await assert.rejects(corregir({ fin: '2026-11-31T10:00:00Z', version: 1 }), conStatus(400), 'fecha inexistente');
  assert.deepEqual([fila().version, fila().fin], [1, iso(T0 - HORA)]);

  assert.equal((await corregir({ fin: iso(T0 - 90 * MIN), version: 1 })).registro.version, 2);
  // Otra pantalla con la versión vieja no pisa la corrección.
  await assert.rejects(corregir({ fin: iso(T0 - 30 * MIN), version: 1 }), conStatus(409));
  assert.equal(fila().fin, iso(T0 - 90 * MIN));

  // Sin cambios efectivos: no hay nueva versión ni auditoría.
  const auditorias = db.tarea_registros_tiempo_auditoria.length;
  const igual = await corregir({ inicio: iso(T0 - 2 * HORA), fin: iso(T0 - 90 * MIN), version: 2 });
  assert.deepEqual([igual.registro.version, db.tarea_registros_tiempo_auditoria.length], [2, auditorias]);
});

test('corrección: solo el autor; registros ajenos, sin autor, activos o de otra tarea se rechazan', async (t) => {
  const { mant, compras, tarea, NICO, PILAR, DORA, CARO, db } = preparar(t);
  const tr = tarea(mant), otra = tarea(compras);
  const { registro } = await service.registrarTiempoManual(tr.id, { inicio: iso(T0 - 2 * HORA), fin: iso(T0 - HORA) }, NICO);
  const body = { fin: iso(T0 - 90 * MIN), version: 1 };

  // Otro miembro y el mando alto: 403. Sin acceso al tablero: 403.
  for (const user of [PILAR, DORA, CARO]) {
    await assert.rejects(service.corregirRegistroTiempo(tr.id, registro.id, body, user), conStatus(403));
  }
  await assert.rejects(service.validarRegistroTiempo(tr.id, { ...body, inicio: iso(T0 - 2 * HORA), registro_id: registro.id }, PILAR), conStatus(403));
  // Desde una tarea propia con el id del registro ajeno: no se encuentra.
  await assert.rejects(service.corregirRegistroTiempo(otra.id, registro.id, body, CARO), conStatus(404));
  for (const id of [randomUUID(), 'no-uuid']) {
    await assert.rejects(service.corregirRegistroTiempo(tr.id, id, body, NICO), conStatus(404));
  }
  // Un temporizador activo no se corrige (hay que detenerlo).
  const activo = await service.iniciarTemporizador(tr.id, PILAR);
  await assert.rejects(service.corregirRegistroTiempo(tr.id, activo.id, body, PILAR), conStatus(409));
  // Autor eliminado (usuario_id NULL por la FK): nadie puede corregirlo.
  db.tarea_registros_tiempo.find(r => r.id === registro.id).usuario_id = null;
  for (const user of [NICO, PILAR, DORA]) {
    await assert.rejects(service.corregirRegistroTiempo(tr.id, registro.id, body, user), conStatus(403));
  }
  const [evento] = (await service.listarActualizaciones(tr.id, NICO)).data;
  assert.deepEqual([evento.usuario, evento.permisos.puede_editar], [null, false]);
  assert.equal(db.tarea_registros_tiempo_auditoria.filter(a => a.accion === 'correccion').length, 0);
});

test('tiempos: perder el acceso impide registrar y corregir, también si ocurre después del chequeo del backend', async (t) => {
  const { mant, tarea, nico, NICO, db } = preparar(t);
  const tr = tarea(mant);
  const { registro } = await service.registrarTiempoManual(tr.id, { inicio: iso(T0 - 2 * HORA), fin: iso(T0 - HORA) }, NICO);

  // Carrera: la baja llega entre la verificación JS y la RPC; la base la rechaza.
  const verificar = service._asegurarAccesoTarea.bind(service);
  const mock = t.mock.method(service, '_asegurarAccesoTarea', async (...args) => {
    const fila = await verificar(...args);
    db.operativo_tablero_miembros = db.operativo_tablero_miembros.filter(m => m.usuario_id !== nico.id);
    return fila;
  });
  await assert.rejects(service.registrarTiempoManual(tr.id, { inicio: iso(T0 - 4 * HORA), fin: iso(T0 - 3 * HORA) }, NICO), conStatus(403));
  assert.equal(db.tarea_registros_tiempo.length, 1);
  mock.mock.restore();

  await assert.rejects(service.registrarTiempoManual(tr.id, { inicio: iso(T0 - 4 * HORA), fin: iso(T0 - 3 * HORA) }, NICO), conStatus(403));
  await assert.rejects(service.corregirRegistroTiempo(tr.id, registro.id, { fin: iso(T0 - 90 * MIN), version: 1 }, NICO), conStatus(403));
  await assert.rejects(service.validarRegistroTiempo(tr.id, { inicio: iso(T0 - 4 * HORA), fin: iso(T0 - 3 * HORA) }, NICO), conStatus(403));
  await assert.rejects(service.listarCorreccionesRegistro(tr.id, registro.id, NICO), conStatus(403));
});

test('superposición: se informa (misma tarea, otras tareas y temporizadores activos) y nunca bloquea', async (t) => {
  const { mant, compras, tarea, nico, NICO, PILAR, avanzar, db } = preparar(t);
  db.operativo_tablero_miembros.push({ tablero_id: compras.id, usuario_id: nico.id });
  const a = tarea(mant, { titulo: 'A' }), b = tarea(mant, { titulo: 'B' }), c = tarea(compras, { titulo: 'C' });
  const r1 = (await service.registrarTiempoManual(a.id, { inicio: iso(T0 - 3 * HORA), fin: iso(T0 - 2 * HORA) }, NICO)).registro;     // 08:00-09:00
  const r2 = (await service.registrarTiempoManual(c.id, { inicio: iso(T0 - 150 * MIN), fin: iso(T0 - 90 * MIN) }, NICO)).registro;   // 08:30-09:30
  await service.registrarTiempoManual(b.id, { inicio: iso(T0 - 4 * HORA), fin: iso(T0 - 3 * HORA) }, NICO);                        // 07:00-08:00, contiguo
  await service.registrarTiempoManual(a.id, { inicio: iso(T0 - 3 * HORA), fin: iso(T0 - HORA) }, PILAR);                           // de otra persona
  const activo = await service.iniciarTemporizador(b.id, NICO);                                                                    // desde 11:00
  avanzar(30 * MIN);

  const pedido = { inicio: iso(T0 - 165 * MIN), fin: iso(T0 + 15 * MIN) };                                                        // 08:15-11:15
  const previa = await service.validarRegistroTiempo(a.id, pedido, NICO);
  const cantidad = db.tarea_registros_tiempo.length;
  const { registro, advertencias } = await service.registrarTiempoManual(a.id, pedido, NICO);
  assert.equal(db.tarea_registros_tiempo.length, cantidad + 1, 'se guarda igual');
  assert.equal(registro.duracion_segundos, 3 * 3600);

  const resumen = (adv) => adv.superposiciones.map(s => [s.registro_id, s.misma_tarea, s.tarea?.titulo ?? null, s.activo, s.solapamiento_segundos]);
  const esperado = [
    [r1.id, true, 'A', false, 45 * 60],
    [r2.id, false, 'C', false, 60 * 60],
    [activo.id, false, 'B', true, 15 * 60],
  ];
  assert.equal(advertencias.superposicion, true);
  assert.deepEqual(resumen(advertencias), esperado);
  assert.deepEqual([previa.valido, previa.duracion_segundos, resumen(previa.advertencias)], [true, 3 * 3600, esperado]);
  assert.equal(db.tarea_registros_tiempo.filter(r => r.inicio === pedido.inicio).length, 1, 'la validación previa no guarda');

  // Validar una corrección excluye al propio registro.
  const comoCorreccion = await service.validarRegistroTiempo(a.id, { ...pedido, registro_id: registro.id }, NICO);
  assert.deepEqual(resumen(comoCorreccion.advertencias), esperado);

  // De una tarea que ya no ve, solo se informa el horario.
  db.operativo_tablero_miembros = db.operativo_tablero_miembros.filter(m => !(m.tablero_id === compras.id && m.usuario_id === nico.id));
  const sinAcceso = await service.validarRegistroTiempo(a.id, { ...pedido, registro_id: registro.id }, NICO);
  const deC = sinAcceso.advertencias.superposiciones.find(s => s.registro_id === r2.id);
  assert.deepEqual([deC.tarea, deC.misma_tarea, deC.inicio, deC.fin], [null, false, r2.inicio, r2.fin]);

  // Una corrección que genera superposición también se guarda con advertencia.
  const { registro: soloR1 } = await service.corregirRegistroTiempo(a.id, r1.id, { fin: iso(T0 - 150 * MIN), version: 1 }, NICO);
  assert.equal(soloR1.version, 2);
});

test('temporizadores activos: una sola llamada devuelve solo los del usuario autenticado en las tareas que ve', async (t) => {
  const { mant, compras, tarea, nico, NICO, PILAR, CARO, avanzar, db } = preparar(t);
  db.operativo_tablero_miembros.push({ tablero_id: compras.id, usuario_id: nico.id });
  const a = tarea(mant), b = tarea(mant), c = tarea(compras);
  await service.iniciarTemporizador(a.id, NICO);
  avanzar(MIN);
  await service.iniciarTemporizador(c.id, NICO);
  await service.iniciarTemporizador(b.id, PILAR);
  avanzar(MIN);

  const todos = await service.listarTemporizadoresActivos({}, NICO);
  assert.deepEqual(todos.data.map(x => [x.tarea_id, x.tablero_id, x.activo, x.transcurrido_segundos]),
    [[a.id, mant.id, true, 120], [c.id, compras.id, true, 60]]);
  assert.ok(todos.data.every(x => x.usuario_id === nico.id));
  assert.equal(todos.servidor_ahora, iso(T0 + 2 * MIN));

  assert.deepEqual((await service.listarTemporizadoresActivos({ tablero_id: mant.id }, NICO)).data.map(x => x.tarea_id), [a.id]);
  assert.deepEqual((await service.listarTemporizadoresActivos({ tablero_id: mant.id }, PILAR)).data.map(x => x.tarea_id), [b.id]);
  await assert.rejects(service.listarTemporizadoresActivos({ tablero_id: mant.id }, CARO), conStatus(403));
  await assert.rejects(service.listarTemporizadoresActivos({ tablero_id: 'x' }, NICO), conStatus(400));
  assert.deepEqual((await service.listarTemporizadoresActivos({ tablero_id: compras.id }, CARO)).data, []);

  // Refresco después de detener / iniciar.
  await service.detenerTemporizador(a.id, NICO);
  assert.deepEqual((await service.listarTemporizadoresActivos({ tablero_id: mant.id }, NICO)).data, []);
  await service.iniciarTemporizador(b.id, NICO);
  assert.deepEqual((await service.listarTemporizadoresActivos({ tablero_id: mant.id }, NICO)).data.map(x => x.tarea_id), [b.id]);
});

// ══ 2026-11-09: menciones ════════════════════════════════════════════════════

const token = (u, etiqueta = u.nombre) => `@[${etiqueta}](${u.id})`;

test('menciones: miembros del tablero (asignados o no) se mencionan por id, con etiqueta normalizada y notificación', async (t) => {
  const { mant, tarea, nico, pilar, gino, NICO, db } = preparar(t);
  const tr = tarea(mant, { asignados: [pilar] });
  const c = await service.crearComentario(tr.id, {
    contenido: `${token(gino, 'Ginito')}, revisá esto con @[Dirección](${pilar.id.toUpperCase()})`,
    menciones: [nico.id], // se ignora: las menciones salen del texto
  }, NICO);

  assert.equal(c.contenido, `@[Gino](${gino.id}), revisá esto con @[Pilar](${pilar.id})`);
  assert.deepEqual(c.menciones, [{ id: gino.id, nombre: 'Gino', activo: true }, { id: pilar.id, nombre: 'Pilar', activo: true }]);
  assert.deepEqual(db.notificaciones.map(n => [n.destinatario_id, n.autor_id, n.tarea_id, n.comentario_id, n.tipo, n.leida_at]).sort(), [
    [gino.id, nico.id, tr.id, c.id, 'mencion_comentario', null],
    [pilar.id, nico.id, tr.id, c.id, 'mencion_comentario', null],
  ].sort());
});

test('menciones: sin duplicados, la automención no notifica y el texto sin tokens no menciona', async (t) => {
  const { mant, tarea, nico, pilar, NICO, PILAR, db } = preparar(t);
  const tr = tarea(mant);
  const c = await service.crearComentario(tr.id, {
    contenido: `${token(pilar)} y ${token(pilar, 'Pili')} y ${token(nico)} y @Gino y @[Gino](123)`,
  }, NICO);
  assert.equal(c.contenido, `@[Pilar](${pilar.id}) y @[Pilar](${pilar.id}) y @[Nico](${nico.id}) y @Gino y @[Gino](123)`);
  assert.deepEqual(c.menciones.map(m => m.id), [pilar.id, nico.id]);
  assert.equal(db.tarea_comentario_menciones.length, 2);
  assert.deepEqual(db.notificaciones.map(n => n.destinatario_id), [pilar.id]);

  // Comentarios sin menciones: igual que antes.
  const simple = await service.crearComentario(tr.id, { contenido: '  @Pilar fijate  ' }, PILAR);
  assert.deepEqual([simple.contenido, simple.menciones], ['@Pilar fijate', []]);
  assert.equal(db.notificaciones.length, 1);
});

test('menciones: rechaza no miembros, mando alto sin membresía, inactivos e inexistentes sin guardar nada', async (t) => {
  const { mant, tarea, nico, caro, dora, gino, NICO, DORA, db } = preparar(t);
  const tr = tarea(mant);
  db.usuarios.find(u => u.id === gino.id).estado = 'Inactivo';
  for (const u of [caro, dora, gino, { id: randomUUID(), nombre: 'Fantasma' }]) {
    await assert.rejects(service.crearComentario(tr.id, { contenido: `Hola ${token(u)}` }, NICO),
      (e) => e.status === 400 && e.message.includes(u.id), u.nombre);
  }
  // Una mención inválida invalida todo el comentario (no se guarda a medias).
  await assert.rejects(service.crearComentario(tr.id, { contenido: `${token(nico)} ${token(caro)}` }, NICO), conStatus(400));
  assert.deepEqual([db.tarea_comentarios.length, db.tarea_comentario_menciones.length, db.notificaciones.length], [0, 0, 0]);

  // Tarea sin tablero (solo la ve el mando alto): nadie es mencionable.
  db.tareas.push({ id: 'sin-tablero', titulo: 'L', tipo: 'asignacion', tablero_id: null, etapa_id: 'e-curso', estado: 'En Proceso' });
  await assert.rejects(service.crearComentario('sin-tablero', { contenido: token(nico) }, DORA), conStatus(400));
  assert.deepEqual(await service.listarMencionables('sin-tablero', DORA), { data: [], total: 0 });
});

test('menciones: con nombres repetidos se notifica solo a la persona elegida por id', async (t) => {
  const { tarea, usuario, tablero, nico, NICO, db } = preparar(t);
  const leo1 = usuario('Leo'), leo2 = usuario(' leo ');
  leo1.email = 'leo.a@x.com'; leo2.email = 'leo.b@x.com';
  const tr = tarea(tablero('Obras', [nico, leo1, leo2]));
  const c = await service.crearComentario(tr.id, { contenido: `${token(leo2)}, revisá los cambios realizados en esta tarea.` }, NICO);
  assert.deepEqual(c.menciones.map(m => m.id), [leo2.id]);
  assert.deepEqual(db.notificaciones.map(n => n.destinatario_id), [leo2.id]);
  // El email nunca entra al texto del comentario ni a sus menciones.
  assert.ok(!JSON.stringify(c).includes('@x.com'));
  const { data } = await service.listarMencionables(tr.id, NICO);
  // Solo los homónimos (sin distinguir mayúsculas ni espacios) traen email para diferenciarse.
  assert.deepEqual(data.map(u => [u.id, u.email]).sort(), [
    [nico.id, null], [leo1.id, 'leo.a@x.com'], [leo2.id, 'leo.b@x.com'],
  ].sort());
  assert.ok(data.every(u => Object.keys(u).sort().join() === 'email,id,nombre'));
});

test('menciones: al editar solo notifican las nuevas; quitar y volver a agregar no repite la notificación', async (t) => {
  const { mant, tarea, pilar, gino, NICO, PILAR, avanzar, db } = preparar(t);
  const tr = tarea(mant);
  const c = await service.crearComentario(tr.id, { contenido: `Hola ${token(pilar)}` }, NICO);
  avanzar(MIN);
  const e1 = await service.editarComentario(tr.id, c.id, { contenido: `Hola ${token(pilar)} y ${token(gino)}` }, NICO);
  assert.deepEqual([e1.menciones.map(m => m.id), e1.editado], [[pilar.id, gino.id], true]);
  assert.deepEqual(db.notificaciones.map(n => n.destinatario_id), [pilar.id, gino.id]);

  const e2 = await service.editarComentario(tr.id, c.id, { contenido: `Hola ${token(gino)}` }, NICO);
  assert.deepEqual(e2.menciones.map(m => m.id), [gino.id]);
  // La notificación de Pilar se conserva, pero su mención ya no está vigente.
  const [dePilar] = (await notificacionesService.listar({}, PILAR)).data;
  assert.deepEqual([dePilar.comentario.eliminado, dePilar.comentario.mencion_vigente], [false, false]);

  const e3 = await service.editarComentario(tr.id, c.id, { contenido: `Hola ${token(gino)} y ${token(pilar)}` }, NICO);
  assert.deepEqual(e3.menciones.map(m => m.id), [gino.id, pilar.id]);
  assert.equal(db.notificaciones.length, 2, 'sin notificaciones repetidas');
  assert.equal((await notificacionesService.listar({}, PILAR)).data[0].comentario.mencion_vigente, true);
});

test('menciones: editar conserva menciones de quien dejó el tablero, no admite nuevas inválidas y tolera usuarios eliminados', async (t) => {
  const { mant, tarea, pilar, caro, NICO, db } = preparar(t);
  const tr = tarea(mant);
  const c = await service.crearComentario(tr.id, { contenido: `Ver ${token(pilar)}` }, NICO);
  db.operativo_tablero_miembros = db.operativo_tablero_miembros.filter(m => !(m.tablero_id === mant.id && m.usuario_id === pilar.id));

  const e = await service.editarComentario(tr.id, c.id, { contenido: `Ver ${token(pilar)} (corregido)` }, NICO);
  assert.deepEqual(e.menciones.map(m => m.id), [pilar.id]);
  await assert.rejects(service.editarComentario(tr.id, c.id, { contenido: `Ver ${token(caro)}` }, NICO), conStatus(400));
  assert.equal(db.tarea_comentarios[0].contenido, `Ver @[Pilar](${pilar.id}) (corregido)`);
  // Si se quita la mención, ya no se puede volver a agregar mientras no sea miembro.
  assert.deepEqual((await service.editarComentario(tr.id, c.id, { contenido: 'Ver (sin mención)' }, NICO)).menciones, []);
  await assert.rejects(service.editarComentario(tr.id, c.id, { contenido: `Ver ${token(pilar)}` }, NICO), (e) => e.codigo === 'MENCION_INVALIDA');
  await service.editarComentario(tr.id, c.id, { contenido: `Ver ${token(pilar)} (corregido)` }, NICO).catch(() => {});
  db.operativo_tablero_miembros.push({ tablero_id: mant.id, usuario_id: pilar.id });
  await service.editarComentario(tr.id, c.id, { contenido: `Ver ${token(pilar)} (corregido)` }, NICO);

  // Usuario eliminado: su token queda como texto y el comentario sigue editable.
  await supabase.from('usuarios').delete().eq('id', pilar.id);
  const e2 = await service.editarComentario(tr.id, c.id, { contenido: `Ver ${token(pilar, 'Pilar')} (otra vez)` }, NICO);
  assert.deepEqual([e2.contenido, e2.menciones], [`Ver @[Pilar](${pilar.id}) (otra vez)`, []]);
});

test('menciones: la base vuelve a verificar la membresía si cambia entre el chequeo y el guardado', async (t) => {
  const { mant, tarea, pilar, NICO, db } = preparar(t);
  const tr = tarea(mant);
  const original = tablerosService.idsMiembros.bind(tablerosService);
  t.mock.method(tablerosService, 'idsMiembros', async (id) => {
    const ids = await original(id);
    db.operativo_tablero_miembros = db.operativo_tablero_miembros.filter(m => m.usuario_id !== pilar.id);
    return ids;
  });
  await assert.rejects(service.crearComentario(tr.id, { contenido: token(pilar) }, NICO), conStatus(400));
  assert.deepEqual([db.tarea_comentarios.length, db.notificaciones.length], [0, 0]);
});

test('menciones: el límite de 2000 caracteres se aplica al texto con el formato completo', async (t) => {
  const { mant, tarea, pilar, NICO, db } = preparar(t);
  const tr = tarea(mant);
  const largo = (etiqueta) => 'a'.repeat(service.MAX_COMENTARIO_LENGTH - token(pilar, etiqueta).length) + token(pilar, etiqueta);
  // "P" se normaliza a "Pilar": el resultado supera el límite.
  await assert.rejects(service.crearComentario(tr.id, { contenido: largo('P') }, NICO), conStatus(400));
  assert.equal(db.tarea_comentarios.length, 0);
  const ok = await service.crearComentario(tr.id, { contenido: largo('Pilar') }, NICO);
  assert.equal(ok.contenido.length, service.MAX_COMENTARIO_LENGTH);
});

test('mencionables: miembros activos del tablero, sin mando alto ajeno ni inactivos; respeta el acceso', async (t) => {
  const { mant, tarea, nico, pilar, gino, DORA, NICO, CARO, NADIA, db } = preparar(t);
  const tr = tarea(mant);
  db.usuarios.find(u => u.id === gino.id).estado = 'Inactivo';
  const { data, total } = await service.listarMencionables(tr.id, DORA);
  assert.equal(total, 2);
  // Solo id y nombre; sin nombres repetidos, el email no se expone.
  assert.deepEqual(data, [
    { id: nico.id, nombre: 'Nico', email: null },
    { id: pilar.id, nombre: 'Pilar', email: null },
  ]);
  assert.deepEqual((await service.listarMencionables(tr.id, NICO)).data, data);
  for (const user of [CARO, NADIA]) await assert.rejects(service.listarMencionables(tr.id, user), conStatus(403));
  await assert.rejects(service.listarMencionables(randomUUID(), NICO), conStatus(404));
});

// ══ 2026-11-09: notificaciones ═══════════════════════════════════════════════

async function comentarioConMencion(ctx, { autor = ctx.NICO, a = [ctx.pilar] } = {}) {
  const tr = ctx.tarea(ctx.mant, { titulo: 'Revisar bomba' });
  const c = await service.crearComentario(tr.id, { contenido: `Mirá esto ${a.map(u => token(u)).join(' ')}` }, autor);
  return { tr, c };
}

test('notificaciones: persisten para el destinatario con autor, tarea, comentario y destino', async (t) => {
  const ctx = preparar(t);
  const { nico, mant, PILAR, GINO, NICO } = ctx;
  const { tr, c } = await comentarioConMencion(ctx);

  const lista = await notificacionesService.listar({}, PILAR);
  assert.deepEqual([lista.no_leidas, lista.hay_mas, lista.limite, lista.offset, lista.data.length], [1, false, 20, 0, 1]);
  const { id, ...resto } = lista.data[0];
  assert.ok(UUID_RE.test(id));
  assert.deepEqual(resto, {
    tipo: 'mencion_comentario', created_at: iso(T0), leida: false, leida_at: null, accesible: true,
    autor: { id: nico.id, nombre: 'Nico' },
    tarea: { id: tr.id, titulo: 'Revisar bomba', tablero_id: mant.id },
    comentario: { id: c.id, eliminado: false, eliminado_at: null, mencion_vigente: true },
    destino: { modulo: 'operations', tablero_id: mant.id, tarea_id: tr.id, comentario_id: c.id },
  });
  assert.ok(!JSON.stringify(lista).includes('Mirá esto'), 'no copia el contenido del comentario');
  // Solo el destinatario las ve; el autor no recibe la suya.
  assert.deepEqual((await notificacionesService.listar({}, GINO)).data, []);
  assert.deepEqual((await notificacionesService.listar({}, NICO)).data, []);
  assert.deepEqual(await notificacionesService.contarNoLeidas(PILAR), { no_leidas: 1 });
  // Navegar al destino vuelve a validar el acceso con los endpoints de la tarea.
  assert.ok((await service.listarActualizaciones(tr.id, PILAR)).data.some(e => e.id === c.id));
});

test('notificaciones: marcar como leída (solo la propia, idempotente), marcar todas, filtros y paginación', async (t) => {
  const ctx = preparar(t);
  const { PILAR, GINO, avanzar } = ctx;
  await comentarioConMencion(ctx);
  avanzar(MIN);
  await comentarioConMencion(ctx);
  const [reciente, anterior] = (await notificacionesService.listar({}, PILAR)).data;
  assert.ok(Date.parse(reciente.created_at) > Date.parse(anterior.created_at), 'más reciente primero');

  await assert.rejects(notificacionesService.marcarLeida(reciente.id, GINO), conStatus(404));
  for (const id of [randomUUID(), 'no-uuid']) await assert.rejects(notificacionesService.marcarLeida(id, PILAR), conStatus(404));

  avanzar(MIN);
  const leida = await notificacionesService.marcarLeida(reciente.id, PILAR);
  assert.deepEqual([leida.id, leida.leida, leida.leida_at], [reciente.id, true, iso(T0 + 2 * MIN)]);
  avanzar(MIN);
  assert.equal((await notificacionesService.marcarLeida(reciente.id, PILAR)).leida_at, iso(T0 + 2 * MIN), 'idempotente');
  assert.deepEqual(await notificacionesService.contarNoLeidas(PILAR), { no_leidas: 1 });
  assert.deepEqual((await notificacionesService.listar({ estado: 'no_leidas' }, PILAR)).data.map(n => n.id), [anterior.id]);

  const pagina = await notificacionesService.listar({ limite: '1' }, PILAR);
  assert.deepEqual([pagina.data.map(n => n.id), pagina.hay_mas], [[reciente.id], true]);
  const siguiente = await notificacionesService.listar({ limite: '1', offset: '1' }, PILAR);
  assert.deepEqual([siguiente.data.map(n => n.id), siguiente.hay_mas], [[anterior.id], false]);
  for (const q of [{ estado: 'leidas' }, { limite: '0' }, { limite: '51' }, { limite: 'x' }, { offset: '-1' }]) {
    await assert.rejects(notificacionesService.listar(q, PILAR), conStatus(400), JSON.stringify(q));
  }

  assert.deepEqual(await notificacionesService.marcarTodasLeidas(PILAR), { actualizadas: 1, no_leidas: 0 });
  assert.deepEqual(await notificacionesService.marcarTodasLeidas(PILAR), { actualizadas: 0, no_leidas: 0 });
  assert.deepEqual(await notificacionesService.marcarTodasLeidas(GINO), { actualizadas: 0, no_leidas: 0 });
});

test('notificaciones: si se elimina el comentario la notificación se conserva, marcada y sin contenido', async (t) => {
  const ctx = preparar(t);
  const { mant, PILAR, NICO, db } = ctx;
  const { tr, c } = await comentarioConMencion(ctx);
  await service.eliminarComentario(tr.id, c.id, NICO);

  assert.equal(db.notificaciones.length, 1);
  assert.equal(db.tarea_comentario_menciones.length, 0);
  const [n] = (await notificacionesService.listar({}, PILAR)).data;
  assert.equal(n.accesible, true);
  assert.deepEqual([n.comentario.id, n.comentario.eliminado, n.comentario.eliminado_at, n.comentario.mencion_vigente], [c.id, true, iso(T0), false]);
  assert.deepEqual(n.destino, { modulo: 'operations', tablero_id: mant.id, tarea_id: tr.id, comentario_id: null });
  assert.ok(!JSON.stringify(n).includes('Mirá esto'));
  assert.deepEqual(await notificacionesService.contarNoLeidas(PILAR), { no_leidas: 1 });
});

test('notificaciones: con el acceso revocado no revelan datos protegidos y se pueden marcar leídas', async (t) => {
  const ctx = preparar(t);
  const { mant, nico, pilar, PILAR } = ctx;
  const { tr } = await comentarioConMencion(ctx);
  assert.deepEqual(await notificacionesService.contarNoLeidas(PILAR), { no_leidas: 1 });
  await supabase.from('operativo_tablero_miembros').delete().eq('tablero_id', mant.id).eq('usuario_id', pilar.id);

  const lista = await notificacionesService.listar({}, PILAR);
  const [n] = lista.data;
  assert.deepEqual([n.accesible, n.leida, n.autor, n.tarea, n.comentario, n.destino], [false, false, null, null, null, null]);
  const texto = JSON.stringify(n);
  for (const dato of ['Revisar bomba', nico.id, tr.id, mant.id]) assert.ok(!texto.includes(dato), dato);
  // No cuenta como pendiente (contador, campo del listado y filtro no_leidas coinciden),
  // pero se conserva en el historial (estado=todas).
  assert.equal(lista.no_leidas, 0);
  assert.deepEqual(await notificacionesService.contarNoLeidas(PILAR), { no_leidas: 0 });
  assert.deepEqual((await notificacionesService.listar({ estado: 'no_leidas' }, PILAR)).data, []);
  // Abrir la tarea igual se rechaza.
  await assert.rejects(service.listarActualizaciones(tr.id, PILAR), (e) => e.status === 403 && e.codigo === 'ACCESO_DENEGADO');

  // Si recupera el acceso, vuelve a ser pendiente.
  ctx.db.operativo_tablero_miembros.push({ tablero_id: mant.id, usuario_id: pilar.id });
  assert.deepEqual(await notificacionesService.contarNoLeidas(PILAR), { no_leidas: 1 });
  assert.deepEqual((await notificacionesService.listar({ estado: 'no_leidas' }, PILAR)).data.map(x => x.id), [n.id]);
  ctx.db.operativo_tablero_miembros = ctx.db.operativo_tablero_miembros.filter(m => m.usuario_id !== pilar.id);

  // Se puede marcar como leída sin acceso.
  assert.equal((await notificacionesService.marcarLeida(n.id, PILAR)).leida, true);
});

test('notificaciones: el mando alto cuenta como pendientes las de cualquier tablero; un usuario sin tableros, ninguna', async (t) => {
  const ctx = preparar(t);
  const { mant, dora, nico, DORA, NICO, db } = ctx;
  db.operativo_tablero_miembros.push({ tablero_id: mant.id, usuario_id: dora.id });
  const tr = ctx.tarea(mant);
  await service.crearComentario(tr.id, { contenido: `Hola ${token(dora)}` }, NICO);
  db.operativo_tablero_miembros = db.operativo_tablero_miembros.filter(m => m.usuario_id !== dora.id);
  // Dora deja de ser miembro, pero el mando alto sigue viendo la tarea.
  assert.deepEqual(await notificacionesService.contarNoLeidas(DORA), { no_leidas: 1 });
  assert.equal((await notificacionesService.listar({ estado: 'no_leidas' }, DORA)).data[0].accesible, true);

  // Nico sin ningún tablero: sus pendientes son 0 aunque tenga no leídas.
  await service.crearComentario(tr.id, { contenido: `Hola ${token(nico)}` }, ctx.PILAR);
  db.operativo_tablero_miembros = db.operativo_tablero_miembros.filter(m => m.usuario_id !== nico.id);
  assert.deepEqual(await notificacionesService.contarNoLeidas(NICO), { no_leidas: 0 });
  assert.deepEqual((await notificacionesService.listar({ estado: 'no_leidas' }, NICO)).data, []);
  assert.equal((await notificacionesService.listar({}, NICO)).data.length, 1);
});

test('superposición: los intervalos contiguos no se superponen y no se consideran registros de otras personas', async (t) => {
  const { mant, tarea, NICO, PILAR } = preparar(t);
  const a = tarea(mant), b = tarea(mant);
  await service.registrarTiempoManual(a.id, { inicio: iso(T0 - 3 * HORA), fin: iso(T0 - 2 * HORA) }, NICO);   // 08:00-09:00
  await service.registrarTiempoManual(b.id, { inicio: iso(T0 - HORA), fin: iso(T0) }, NICO);                  // 10:00-11:00
  await service.registrarTiempoManual(a.id, { inicio: iso(T0 - 3 * HORA), fin: iso(T0) }, PILAR);              // otra persona
  // 09:00-10:00: toca ambos bordes, sin superponerse.
  const { advertencias } = await service.registrarTiempoManual(a.id, { inicio: iso(T0 - 2 * HORA), fin: iso(T0 - HORA) }, NICO);
  assert.deepEqual(advertencias, { superposicion: false, superposiciones: [] });
  // Un temporizador activo que empieza exactamente cuando termina el intervalo tampoco.
  await service.iniciarTemporizador(a.id, NICO);  // desde T0
  const previa = await service.validarRegistroTiempo(b.id, { inicio: iso(T0 - 30 * MIN), fin: iso(T0) }, NICO);
  assert.deepEqual(previa.advertencias.superposiciones.map(s => [s.activo, s.solapamiento_segundos]), [[false, 30 * 60]]);
});

test('notificaciones: eliminar la tarea elimina sus notificaciones (mismo criterio que comentarios y tiempos)', async (t) => {
  const ctx = preparar(t);
  const { PILAR, NICO, db } = ctx;
  const { tr } = await comentarioConMencion(ctx);
  await comentarioConMencion(ctx);
  const deLaTareaEliminada = (await notificacionesService.listar({}, PILAR)).data.find(n => n.tarea.id === tr.id);
  assert.ok(deLaTareaEliminada);
  await operationsService.eliminarTarea(tr.id, NICO);
  assert.equal(db.notificaciones.length, 1);
  assert.equal((await notificacionesService.listar({}, PILAR)).data.length, 1);
  assert.deepEqual(await notificacionesService.contarNoLeidas(PILAR), { no_leidas: 1 });
  // Si el frontend todavía la tenía en pantalla: ya no existe y la tarea tampoco (404, no 403).
  await assert.rejects(notificacionesService.marcarLeida(deLaTareaEliminada.id, PILAR), (e) => e.status === 404 && e.codigo === 'NOTIFICACION_NO_ENCONTRADA');
  await assert.rejects(service.listarActualizaciones(tr.id, PILAR), (e) => e.status === 404 && e.codigo === 'TAREA_NO_ENCONTRADA');
});

test('HTTP: registros de tiempo, mencionables, temporizadores activos y notificaciones', async (t) => {
  const ctx = preparar(t);
  t.mock.timers.reset();
  const { mant, tarea, nico, pilar, gino, caro } = ctx;
  const api = await servidor(t, ctx);
  const notif = await servidor(t, ctx, '/api/notificaciones');
  const tr = tarea(mant);
  const ahora = Date.now();
  const intervalo = { inicio: iso(ahora - 2 * HORA), fin: iso(ahora - HORA) };

  assert.equal((await api('POST', `/${tr.id}/registros-tiempo`, { body: intervalo })).status, 401);
  assert.equal((await api('POST', `/${tr.id}/registros-tiempo`, { como: caro, body: intervalo })).status, 403);
  assert.equal((await api('POST', `/${tr.id}/registros-tiempo`, { como: nico, body: { inicio: intervalo.fin, fin: intervalo.inicio } })).status, 400);
  const previa = await api('POST', `/${tr.id}/registros-tiempo/validar`, { como: nico, body: intervalo });
  assert.deepEqual([previa.status, previa.body.valido, previa.body.advertencias.superposicion], [200, true, false]);

  const creado = await api('POST', `/${tr.id}/registros-tiempo`, { como: nico, body: { ...intervalo, usuario_id: pilar.id } });
  assert.equal(creado.status, 201);
  assert.deepEqual([creado.body.registro.usuario.id, creado.body.registro.origen, creado.body.registro.duracion_segundos], [nico.id, 'carga_manual', 3600]);
  const rid = creado.body.registro.id;

  assert.equal((await api('PATCH', `/${tr.id}/registros-tiempo/${rid}`, { como: pilar, body: { fin: iso(ahora - 90 * MIN), version: 1 } })).status, 403);
  const corregido = await api('PATCH', `/${tr.id}/registros-tiempo/${rid}`, { como: nico, body: { fin: iso(ahora - 90 * MIN), version: 1 } });
  assert.deepEqual([corregido.status, corregido.body.registro.version, corregido.body.registro.duracion_segundos], [200, 2, 1800]);
  assert.equal((await api('PATCH', `/${tr.id}/registros-tiempo/${rid}`, { como: nico, body: { fin: iso(ahora - 80 * MIN), version: 1 } })).status, 409);
  assert.equal((await api('DELETE', `/${tr.id}/registros-tiempo/${rid}`, { como: nico })).status, 404, 'no existe la ruta');
  const historial = await api('GET', `/${tr.id}/registros-tiempo/${rid}/correcciones`, { como: pilar });
  assert.deepEqual([historial.status, historial.body.data.map(a => a.accion)], [200, ['carga_manual', 'correccion']]);

  await api('POST', `/${tr.id}/temporizador/iniciar`, { como: nico });
  const activos = await api('GET', `/temporizadores-activos?tablero_id=${mant.id}`, { como: nico });
  assert.deepEqual([activos.status, activos.body.data.map(x => x.tarea_id)], [200, [tr.id]]);
  assert.deepEqual((await api('GET', `/temporizadores-activos?tablero_id=${mant.id}`, { como: pilar })).body.data, []);
  assert.equal((await api('GET', `/temporizadores-activos?tablero_id=${mant.id}`, { como: caro })).status, 403);

  const mencionables = await api('GET', `/${tr.id}/mencionables`, { como: nico });
  assert.deepEqual([mencionables.status, mencionables.body.data.map(u => u.nombre)], [200, ['Gino', 'Nico', 'Pilar']]);
  const comentario = await api('POST', `/${tr.id}/comentarios`, { como: nico, body: { contenido: `Hola ${token(pilar, 'x')}` } });
  assert.deepEqual([comentario.status, comentario.body.contenido, comentario.body.menciones.map(m => m.id)], [201, `Hola @[Pilar](${pilar.id})`, [pilar.id]]);
  assert.equal((await api('POST', `/${tr.id}/comentarios`, { como: nico, body: { contenido: token(caro) } })).status, 400);

  assert.equal((await notif('GET', '/')).status, 401);
  const lista = await notif('GET', '/', { como: pilar });
  assert.deepEqual([lista.status, lista.body.no_leidas, lista.body.data[0].destino.tarea_id], [200, 1, tr.id]);
  assert.deepEqual((await notif('GET', '/no-leidas/cantidad', { como: pilar })).body, { no_leidas: 1 });
  assert.equal((await notif('GET', '/?estado=otra', { como: pilar })).status, 400);
  assert.equal((await notif('PATCH', `/${lista.body.data[0].id}/leida`, { como: gino })).status, 404);
  const leida = await notif('PATCH', `/${lista.body.data[0].id}/leida`, { como: pilar });
  assert.deepEqual([leida.status, leida.body.leida], [200, true]);
  assert.deepEqual((await notif('POST', '/marcar-todas-leidas', { como: pilar })).body, { actualizadas: 0, no_leidas: 0 });
});

test('HTTP: errores con `error` (sin cambios) y `codigo` estable; otros errores sin `codigo`', async (t) => {
  const ctx = preparar(t);
  t.mock.timers.reset();
  const { mant, compras, tarea, nico, pilar, caro, gino } = ctx;
  const api = await servidor(t, ctx);
  const notif = await servidor(t, ctx, '/api/notificaciones');
  const tr = tarea(mant);
  const ahora = Date.now();
  const esperar = async (pedido, status, codigo) => {
    const r = await pedido;
    assert.equal(r.status, status, codigo);
    assert.equal(typeof r.body.error, 'string', codigo);
    assert.equal(r.body.codigo, codigo);
    assert.deepEqual(Object.keys(r.body).sort(), ['codigo', 'error']);
  };

  const { body: { registro } } = await api('POST', `/${tr.id}/registros-tiempo`, { como: nico, body: { inicio: iso(ahora - 2 * HORA), fin: iso(ahora - HORA) } });
  await api('PATCH', `/${tr.id}/registros-tiempo/${registro.id}`, { como: nico, body: { fin: iso(ahora - 90 * MIN), version: 1 } });
  const activo = (await api('POST', `/${tr.id}/temporizador/iniciar`, { como: pilar })).body;

  await esperar(api('PATCH', `/${tr.id}/registros-tiempo/${registro.id}`, { como: nico, body: { fin: iso(ahora - 80 * MIN), version: 1 } }), 409, 'VERSION_DESACTUALIZADA');
  await esperar(api('PATCH', `/${tr.id}/registros-tiempo/${activo.id}`, { como: pilar, body: { fin: iso(ahora - MIN), version: 1 } }), 409, 'REGISTRO_TIEMPO_ACTIVO');
  await esperar(api('POST', `/${tr.id}/registros-tiempo`, { como: nico, body: { inicio: iso(ahora - HORA), fin: iso(ahora - 2 * HORA) } }), 400, 'INTERVALO_INVALIDO');
  await esperar(api('POST', `/${tr.id}/registros-tiempo`, { como: nico, body: { inicio: iso(ahora - HORA), fin: iso(ahora + HORA) } }), 400, 'FIN_FUTURO');
  await esperar(api('POST', `/${tr.id}/registros-tiempo`, { como: nico, body: { inicio: '2026-02-30T10:00:00Z', fin: iso(ahora - HORA) } }), 400, 'FECHA_INVALIDA');
  await esperar(api('PATCH', `/${tr.id}/registros-tiempo/${registro.id}`, { como: nico, body: { fin: iso(ahora - 85 * MIN) } }), 400, 'VERSION_REQUERIDA');
  await esperar(api('PATCH', `/${tr.id}/registros-tiempo/${registro.id}`, { como: pilar, body: { fin: iso(ahora - 85 * MIN), version: 2 } }), 403, 'REGISTRO_AJENO');
  await esperar(api('PATCH', `/${tr.id}/registros-tiempo/${randomUUID()}`, { como: nico, body: { fin: iso(ahora - 85 * MIN), version: 2 } }), 404, 'REGISTRO_NO_ENCONTRADO');
  await esperar(api('POST', `/${tr.id}/registros-tiempo`, { como: caro, body: { inicio: iso(ahora - 2 * HORA), fin: iso(ahora - HORA) } }), 403, 'ACCESO_DENEGADO');
  await esperar(api('GET', `/${randomUUID()}/mencionables`, { como: nico }), 404, 'TAREA_NO_ENCONTRADA');
  await esperar(api('GET', `/temporizadores-activos?tablero_id=${compras.id}`, { como: nico }), 403, 'ACCESO_DENEGADO');
  await esperar(api('POST', `/${tr.id}/comentarios`, { como: nico, body: { contenido: `Hola ${token(caro)}` } }), 400, 'MENCION_INVALIDA');
  const c = (await api('POST', `/${tr.id}/comentarios`, { como: nico, body: { contenido: 'Hola' } })).body;
  await esperar(api('PATCH', `/${tr.id}/comentarios/${c.id}`, { como: pilar, body: { contenido: 'x' } }), 403, 'COMENTARIO_AJENO');
  await esperar(api('POST', `/${tr.id}/temporizador/iniciar`, { como: pilar }), 409, 'TEMPORIZADOR_YA_ACTIVO');
  await esperar(notif('PATCH', `/${randomUUID()}/leida`, { como: gino }), 404, 'NOTIFICACION_NO_ENCONTRADA');
  await esperar(notif('GET', '/?limite=0', { como: gino }), 400, 'PARAMETRO_INVALIDO');

  // Errores de otras funcionalidades: mismo formato que antes ({ error } solo).
  const ajeno = await api('GET', '/', { como: nico }); // GET /tareas sin tablero_id (operationsService)
  assert.deepEqual([ajeno.status, Object.keys(ajeno.body)], [400, ['error']]);
  const sinToken = await api('GET', `/${tr.id}/actualizaciones`);
  assert.deepEqual([sinToken.status, Object.keys(sinToken.body)], [401, ['error']]);
});
