const supabase = require('../../config/supabase');
const tablerosService = require('../../operations/services/tablerosService');

// Notificaciones internas persistentes por usuario (public.notificaciones,
// migración 2026-11-09_comentarios_menciones_y_notificaciones). Complementan
// al Centro de Alertas (GET /api/alertas, calculado bajo demanda y sin
// cambios): el frontend muestra ambas en la misma campana.
//
// - Se crean solo en la base, junto con el comentario que menciona
//   (tarea_comentario_crear / tarea_comentario_editar): este servicio no crea
//   notificaciones ni acepta destinatarios del cliente.
// - Cada usuario ve y marca solo las suyas (destinatario = req.user.id). Una
//   notificación ajena responde 404, igual que una inexistente.
// - El acceso a la tarea se evalúa al consultar, con la regla vigente
//   (tablerosService):
//     · "pendientes" = no leídas Y de una tarea que el usuario ve hoy. Es lo
//       que cuentan `no_leidas` y GET /no-leidas/cantidad y lo que lista
//       estado=no_leidas. Si recupera el acceso, vuelven a contar.
//     · estado=todas (historial) también lista las de tareas que ya no ve,
//       con accesible:false y sin autor, tarea, comentario ni destino.
//   Abrir la tarea vuelve a validar el acceso en sus propios endpoints.
// - Si el comentario se eliminó, la notificación se conserva con
//   `comentario.eliminado: true` y sin contenido (nunca se guarda una copia
//   del texto). Si se elimina la tarea, sus notificaciones se eliminan (FK
//   ON DELETE CASCADE).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ESTADOS = ['todas', 'no_leidas'];
const LIMITE_DEFECTO = 20;
const LIMITE_MAXIMO = 50;

const COLUMNAS_BASE = 'id, tipo, tarea_id, comentario_id, comentario_eliminado_at, created_at, leida_at, autor:usuarios!autor_id(id, nombre)';
const COLUMNAS = `${COLUMNAS_BASE}, tareas!tarea_id(id, titulo, tablero_id)`;
// !inner: solo filas cuya tarea pasa el filtro de tableros visibles.
const COLUMNAS_VISIBLES = `${COLUMNAS_BASE}, tareas!tarea_id!inner(id, titulo, tablero_id)`;

// Destino de navegación: valores fijos más ids de la base, nunca texto libre.
const MODULO_DESTINO = 'operations';

function error(status, mensaje, codigo) {
  return Object.assign(new Error(mensaje), { status, codigo });
}

function exigirUsuario(user) {
  if (!user?.id) throw error(401, 'No se pudo identificar al usuario autenticado.', 'NO_AUTENTICADO');
}

function entero(valor, { campo, defecto, minimo, maximo }) {
  if (valor === undefined || valor === '') return defecto;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < minimo || (maximo !== undefined && n > maximo)) {
    throw error(400, `"${campo}" debe ser un entero entre ${minimo} y ${maximo ?? 'infinito'}.`, 'PARAMETRO_INVALIDO');
  }
  return n;
}

// Mismo criterio que operationsService._asegurarAccesoTarea: sin tablero, solo
// el mando alto (visibles === null).
function tableroVisible(tableroId, visibles) {
  return tableroId ? (visibles === null || visibles.includes(tableroId)) : visibles === null;
}

// Restringe una consulta con COLUMNAS_VISIBLES a las tareas que el usuario ve.
// visibles === null (mando alto): todas. Devuelve null si no ve ninguna.
function soloVisibles(query, visibles) {
  if (visibles === null) return query;
  if (!visibles.length) return null;
  return query.in('tareas.tablero_id', visibles);
}

function formatear(n, { visibles, vigentes }) {
  const accesible = !!n.tareas && tableroVisible(n.tareas.tablero_id, visibles);
  const base = {
    id:         n.id,
    tipo:       n.tipo,
    created_at: n.created_at,
    leida:      !!n.leida_at,
    leida_at:   n.leida_at ?? null,
    accesible,
  };
  if (!accesible) return { ...base, autor: null, tarea: null, comentario: null, destino: null };

  const eliminado = !!n.comentario_eliminado_at;
  return {
    ...base,
    autor: n.autor ? { id: n.autor.id, nombre: n.autor.nombre } : null,
    tarea: { id: n.tareas.id, titulo: n.tareas.titulo, tablero_id: n.tareas.tablero_id ?? null },
    comentario: {
      id:              n.comentario_id,
      eliminado,
      eliminado_at:    n.comentario_eliminado_at ?? null,
      // false si el autor quitó la mención al editar el comentario.
      mencion_vigente: !eliminado && vigentes.has(n.comentario_id),
    },
    destino: {
      modulo:        MODULO_DESTINO,
      tablero_id:    n.tareas.tablero_id ?? null,
      tarea_id:      n.tareas.id,
      comentario_id: eliminado ? null : n.comentario_id,
    },
  };
}

class NotificacionesService {

  async _vigentes(filas, user) {
    const ids = [...new Set(filas.filter(n => !n.comentario_eliminado_at).map(n => n.comentario_id))];
    if (!ids.length) return new Set();
    const { data, error: err } = await supabase
      .from('tarea_comentario_menciones')
      .select('comentario_id')
      .eq('usuario_id', user.id)
      .in('comentario_id', ids);
    if (err) throw err;
    return new Set((data ?? []).map(m => m.comentario_id));
  }

  // No leídas de tareas que el usuario ve hoy.
  async _contarPendientes(user, visibles) {
    const query = soloVisibles(supabase
      .from('notificaciones')
      .select('id, tareas!tarea_id!inner(tablero_id)', { count: 'exact', head: true })
      .eq('destinatario_id', user.id)
      .is('leida_at', null), visibles);
    if (!query) return 0;
    const { count, error: err } = await query;
    if (err) throw err;
    return count || 0;
  }

  // Notificaciones del usuario autenticado, de la más reciente a la más
  // antigua. `estado`: todas (por defecto; historial completo) o no_leidas
  // (pendientes con acceso vigente). Paginado por limite/offset.
  async listar({ estado, limite, offset } = {}, user) {
    exigirUsuario(user);
    const filtro = estado === undefined || estado === '' ? 'todas' : estado;
    if (!ESTADOS.includes(filtro)) throw error(400, `"estado" inválido: debe ser ${ESTADOS.join(' o ')}.`, 'PARAMETRO_INVALIDO');
    const tam = entero(limite, { campo: 'limite', defecto: LIMITE_DEFECTO, minimo: 1, maximo: LIMITE_MAXIMO });
    const desde = entero(offset, { campo: 'offset', defecto: 0, minimo: 0 });
    const visibles = await tablerosService.idsVisibles(user);

    let query = supabase
      .from('notificaciones')
      .select(filtro === 'no_leidas' ? COLUMNAS_VISIBLES : COLUMNAS)
      .eq('destinatario_id', user.id);
    if (filtro === 'no_leidas') query = soloVisibles(query.is('leida_at', null), visibles);

    const [resultado, pendientes] = await Promise.all([
      query
        ? query.order('created_at', { ascending: false }).order('id', { ascending: false })
          .range(desde, desde + tam) // uno de más para saber si hay otra página
        : Promise.resolve({ data: [], error: null }),
      this._contarPendientes(user, visibles),
    ]);
    if (resultado.error) throw resultado.error;
    const filas = (resultado.data ?? []).slice(0, tam);
    const vigentes = await this._vigentes(filas, user);
    return {
      data:      filas.map(n => formatear(n, { visibles, vigentes })),
      no_leidas: pendientes,
      limite:    tam,
      offset:    desde,
      hay_mas:   (resultado.data ?? []).length > tam,
    };
  }

  // Contador para la campana (consulta periódica liviana): mismo criterio que
  // `no_leidas` del listado.
  async contarNoLeidas(user) {
    exigirUsuario(user);
    return { no_leidas: await this._contarPendientes(user, await tablerosService.idsVisibles(user)) };
  }

  async _propia(id, user) {
    const { data, error: err } = await supabase
      .from('notificaciones')
      .select(COLUMNAS)
      .eq('id', id)
      .eq('destinatario_id', user.id)
      .maybeSingle();
    if (err) throw err;
    if (!data) throw error(404, 'Notificación no encontrada.', 'NOTIFICACION_NO_ENCONTRADA');
    return data;
  }

  // Idempotente: marcar una ya leída no cambia su leida_at. La hora la pone la
  // base. Se puede marcar aunque ya no se tenga acceso a la tarea.
  async marcarLeida(id, user) {
    exigirUsuario(user);
    if (typeof id !== 'string' || !UUID.test(id)) throw error(404, 'Notificación no encontrada.', 'NOTIFICACION_NO_ENCONTRADA');
    await this._propia(id, user);
    const { error: err } = await supabase
      .from('notificaciones')
      .update({ leida_at: new Date().toISOString() })
      .eq('id', id)
      .eq('destinatario_id', user.id)
      .is('leida_at', null)
      .select('id');
    if (err) throw err;
    const fila = await this._propia(id, user);
    const visibles = await tablerosService.idsVisibles(user);
    return formatear(fila, { visibles, vigentes: await this._vigentes([fila], user) });
  }

  // Marca todas las no leídas del usuario, también las de tareas que ya no ve
  // (para que no reaparezcan como pendientes si recupera el acceso).
  async marcarTodasLeidas(user) {
    exigirUsuario(user);
    const { data, error: err } = await supabase
      .from('notificaciones')
      .update({ leida_at: new Date().toISOString() })
      .eq('destinatario_id', user.id)
      .is('leida_at', null)
      .select('id');
    if (err) throw err;
    return {
      actualizadas: (data ?? []).length,
      no_leidas:    await this._contarPendientes(user, await tablerosService.idsVisibles(user)),
    };
  }
}

module.exports = new NotificacionesService();
module.exports.LIMITE_MAXIMO = LIMITE_MAXIMO;
