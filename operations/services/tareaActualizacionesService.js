const supabase = require('../../config/supabase');
const operationsService = require('./operationsService');

// Panel "Actualizaciones" de una tarea del Operativo: comentarios y registros
// de tiempo (temporizadores por usuario + tarea). Migración
// 2026-11-03_tareas_comentarios_y_tiempos.
//
// Acceso: el mismo que el resto de las operaciones sobre una tarea
// (operationsService._asegurarAccesoTarea -> tablerosService.asegurarAcceso):
// miembros del tablero de la tarea y mando alto. No hace falta estar asignado
// a la tarea. 404 si la tarea no existe, 403 si no ve su tablero.
//
// El autor de un comentario y el dueño de un temporizador salen siempre de la
// sesión (user.id); las fechas, del servidor de base de datos. Cualquier
// usuario_id, fecha o duración del body se ignora.
//
// Temporizadores: la base garantiza las reglas de concurrencia
// (tarea_tiempo_iniciar / tarea_tiempo_detener, índice único parcial
// uq_tarea_registros_tiempo_activo) y el cierre automático cuando la tarea
// pasa a completada o cancelada (trigger_tareas_finalizar_tiempos, en la misma
// transacción que el cambio de etapa). Al eliminar una tarea, sus comentarios
// y registros se eliminan con ella (ON DELETE CASCADE, igual que
// tarea_historial y tarea_asignados).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Debe coincidir con tarea_comentarios_contenido_check.
const MAX_COMENTARIO_LENGTH = 2000;

const TIPO_COMENTARIO = 'comentario';
const TIPO_REGISTRO_TIEMPO = 'registro_tiempo';

const COLUMNAS_COMENTARIO = 'id, tarea_id, usuario_id, contenido, created_at, editado_at, usuarios(id, nombre)';
const COLUMNAS_REGISTRO = 'id, tarea_id, usuario_id, inicio, fin, duracion_segundos, motivo_finalizacion, usuarios(id, nombre)';

// Errores de las funciones tarea_tiempo_* (RAISE ... ERRCODE P0001).
const ERRORES_RPC = {
  NX_SIN_ACCESO_TAREA:         [403, 'No tenés acceso a esta tarea.'],
  NX_TAREA_NO_ENCONTRADA:       [404, 'Tarea no encontrada'],
  NX_TAREA_FINALIZADA:          [409, 'La tarea está completada o cancelada: no se pueden iniciar temporizadores.'],
  NX_TEMPORIZADOR_ACTIVO:       [409, 'Ya tenés un temporizador activo en esta tarea.'],
  NX_SIN_TEMPORIZADOR_ACTIVO:   [409, 'No tenés un temporizador activo en esta tarea.'],
  NX_USUARIO_REQUERIDO:         [401, 'No se pudo identificar al usuario autenticado.'],
  NX_REGISTRO_TIEMPO_INMUTABLE: [409, 'Los registros de tiempo finalizados no se pueden modificar.'],
};

function error(status, mensaje) {
  return Object.assign(new Error(mensaje), { status });
}

async function llamarRpc(nombre, params) {
  const { data, error: err } = await supabase.rpc(nombre, params);
  if (!err) return data;
  const conocido = err.code === 'P0001' && ERRORES_RPC[err.message];
  if (conocido) throw error(...conocido);
  throw err;
}

function exigirUsuario(user) {
  if (!user?.id) throw error(401, ERRORES_RPC.NX_USUARIO_REQUERIDO[1]);
}

// Recorta los bordes y valida longitud. 400 si no es texto, queda vacío o es
// demasiado largo.
function validarContenido(contenido) {
  if (typeof contenido !== 'string') throw error(400, '"contenido" es obligatorio y debe ser texto.');
  const limpio = contenido.trim();
  if (!limpio) throw error(400, 'El comentario no puede estar vacío.');
  if (limpio.length > MAX_COMENTARIO_LENGTH) {
    throw error(400, `El comentario no puede superar los ${MAX_COMENTARIO_LENGTH} caracteres.`);
  }
  return limpio;
}

function usuarioVisible(fila) {
  return fila.usuarios ? { id: fila.usuarios.id, nombre: fila.usuarios.nombre } : null;
}

function segundosEntre(desde, hasta) {
  return Math.max(0, Math.floor((Date.parse(hasta) - Date.parse(desde)) / 1000));
}

// ── Formatos de respuesta ────────────────────────────────────────────────────
// `fecha` es el momento en que el evento entra al historial (criterio de
// orden): created_at para un comentario, fin para un registro de tiempo.

function formatearComentario(c, user) {
  const propio = !!user?.id && c.usuario_id === user.id;
  return {
    tipo:       TIPO_COMENTARIO,
    id:         c.id,
    tarea_id:   c.tarea_id,
    usuario:    usuarioVisible(c),
    contenido:  c.contenido,
    fecha:      c.created_at,
    created_at: c.created_at,
    editado_at: c.editado_at ?? null,
    editado:    !!c.editado_at,
    permisos:   { puede_editar: propio, puede_eliminar: propio },
  };
}

function formatearRegistro(r) {
  return {
    tipo:                TIPO_REGISTRO_TIEMPO,
    id:                  r.id,
    tarea_id:            r.tarea_id,
    usuario:             usuarioVisible(r),
    fecha:               r.fin,
    inicio:              r.inicio,
    fin:                 r.fin,
    duracion_segundos:   r.duracion_segundos,
    motivo_finalizacion: r.motivo_finalizacion,
    permisos:            { puede_editar: false, puede_eliminar: false },
  };
}

// Temporizador activo: `inicio` y `servidor_ahora` permiten reconstruir el
// tiempo transcurrido sin depender del reloj del navegador.
function formatearActivo(r) {
  const ahora = new Date().toISOString();
  return {
    id:                    r.id,
    tarea_id:              r.tarea_id,
    usuario_id:            r.usuario_id,
    inicio:                r.inicio,
    activo:                true,
    servidor_ahora:        ahora,
    transcurrido_segundos: segundosEntre(r.inicio, ahora),
  };
}

// Orden cronológico ascendente y determinista: fecha; a igual fecha,
// comentario antes que registro de tiempo; después, id.
const ORDEN_TIPO = { [TIPO_COMENTARIO]: 0, [TIPO_REGISTRO_TIEMPO]: 1 };
function compararEventos(a, b) {
  return (Date.parse(a.fecha) - Date.parse(b.fecha))
    || (ORDEN_TIPO[a.tipo] - ORDEN_TIPO[b.tipo])
    || String(a.id).localeCompare(String(b.id));
}

class TareaActualizacionesService {

  _asegurarAccesoTarea(tareaId, user) {
    return operationsService._asegurarAccesoTarea(tareaId, user);
  }

  // ── Historial unificado ────────────────────────────────────────────────────

  // Comentarios + registros de tiempo FINALIZADOS de la tarea, en orden
  // cronológico ascendente. Los temporizadores activos no aparecen (se
  // consultan con obtenerTemporizadorActivo).
  async listarActualizaciones(tareaId, user) {
    await this._asegurarAccesoTarea(tareaId, user);
    const [comentarios, registros] = await Promise.all([
      this._comentariosDeTarea(tareaId),
      this._registrosFinalizadosDeTarea(tareaId),
    ]);
    const data = [
      ...comentarios.map(c => formatearComentario(c, user)),
      ...registros.map(formatearRegistro),
    ].sort(compararEventos);
    return { data, total: data.length };
  }

  async _comentariosDeTarea(tareaId) {
    const { data, error: err } = await supabase
      .from('tarea_comentarios')
      .select(COLUMNAS_COMENTARIO)
      .eq('tarea_id', tareaId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (err) throw err;
    return data ?? [];
  }

  async _registrosFinalizadosDeTarea(tareaId) {
    const { data, error: err } = await supabase
      .from('tarea_registros_tiempo')
      .select(COLUMNAS_REGISTRO)
      .eq('tarea_id', tareaId)
      .not('fin', 'is', null)
      .order('fin', { ascending: true })
      .order('id', { ascending: true });
    if (err) throw err;
    return data ?? [];
  }

  // ── Comentarios ────────────────────────────────────────────────────────────

  async listarComentarios(tareaId, user) {
    await this._asegurarAccesoTarea(tareaId, user);
    const data = (await this._comentariosDeTarea(tareaId)).map(c => formatearComentario(c, user));
    return { data, total: data.length };
  }

  // Solo se toma `contenido` del body: autor y fecha los pone el servidor.
  async crearComentario(tareaId, body, user) {
    await this._asegurarAccesoTarea(tareaId, user);
    exigirUsuario(user);
    const contenido = validarContenido(body?.contenido);

    const { data, error: err } = await supabase
      .from('tarea_comentarios')
      .insert([{ tarea_id: tareaId, usuario_id: user.id, contenido }])
      .select(COLUMNAS_COMENTARIO)
      .single();
    if (err) throw err;
    return formatearComentario(data, user);
  }

  // Comentario de esa tarea. 404 si no existe o es de otra tarea (no revela
  // comentarios de tareas ajenas cambiando ids); 403 si no es del usuario.
  async _comentarioPropio(tareaId, comentarioId, user) {
    if (typeof comentarioId !== 'string' || !UUID.test(comentarioId)) throw error(404, 'Comentario no encontrado.');
    const { data, error: err } = await supabase
      .from('tarea_comentarios')
      .select('id, usuario_id')
      .eq('id', comentarioId)
      .eq('tarea_id', tareaId)
      .maybeSingle();
    if (err) throw err;
    if (!data) throw error(404, 'Comentario no encontrado.');
    if (!user?.id || data.usuario_id !== user.id) throw error(403, 'Solo el autor puede modificar o eliminar este comentario.');
    return data;
  }

  // Solo el autor. editado_at lo completa la base (trigger) cuando cambia el
  // contenido. La escritura vuelve a filtrar por autor: si el comentario se
  // eliminó entre la lectura y la escritura, 404.
  async editarComentario(tareaId, comentarioId, body, user) {
    await this._asegurarAccesoTarea(tareaId, user);
    const contenido = validarContenido(body?.contenido);
    await this._comentarioPropio(tareaId, comentarioId, user);

    const { data, error: err } = await supabase
      .from('tarea_comentarios')
      .update({ contenido })
      .eq('id', comentarioId)
      .eq('tarea_id', tareaId)
      .eq('usuario_id', user.id)
      .select(COLUMNAS_COMENTARIO)
      .maybeSingle();
    if (err) throw err;
    if (!data) throw error(404, 'Comentario no encontrado.');
    return formatearComentario(data, user);
  }

  // Solo el autor. Eliminación física (no hay recuperación de comentarios).
  async eliminarComentario(tareaId, comentarioId, user) {
    await this._asegurarAccesoTarea(tareaId, user);
    await this._comentarioPropio(tareaId, comentarioId, user);

    const { data, error: err } = await supabase
      .from('tarea_comentarios')
      .delete()
      .eq('id', comentarioId)
      .eq('tarea_id', tareaId)
      .eq('usuario_id', user.id)
      .select('id');
    if (err) throw err;
    if (!data?.length) throw error(404, 'Comentario no encontrado.');
    return { message: 'Comentario eliminado correctamente' };
  }

  // ── Temporizadores ─────────────────────────────────────────────────────────

  // Temporizador activo del usuario autenticado en la tarea, o null.
  async obtenerTemporizadorActivo(tareaId, user) {
    await this._asegurarAccesoTarea(tareaId, user);
    exigirUsuario(user);
    const { data, error: err } = await supabase
      .from('tarea_registros_tiempo')
      .select('id, tarea_id, usuario_id, inicio')
      .eq('tarea_id', tareaId)
      .eq('usuario_id', user.id)
      .is('fin', null)
      .maybeSingle();
    if (err) throw err;
    return { activo: data ? formatearActivo(data) : null, servidor_ahora: new Date().toISOString() };
  }

  // 409 si ya tiene uno activo en la tarea o si la tarea está completada o
  // cancelada (lo verifica tarea_tiempo_iniciar con la tarea bloqueada).
  async iniciarTemporizador(tareaId, user) {
    await this._asegurarAccesoTarea(tareaId, user);
    exigirUsuario(user);
    const registro = await llamarRpc('tarea_tiempo_iniciar', { p_tarea_id: tareaId, p_usuario_id: user.id });
    return formatearActivo(registro);
  }

  // Detiene el temporizador activo del usuario autenticado (nunca el de otro).
  // Devuelve el registro finalizado con su duración.
  async detenerTemporizador(tareaId, user) {
    await this._asegurarAccesoTarea(tareaId, user);
    exigirUsuario(user);
    const { id } = await llamarRpc('tarea_tiempo_detener', { p_tarea_id: tareaId, p_usuario_id: user.id });
    const { data, error: err } = await supabase
      .from('tarea_registros_tiempo')
      .select(COLUMNAS_REGISTRO)
      .eq('id', id)
      .single();
    if (err) throw err;
    return formatearRegistro(data);
  }
}

module.exports = new TareaActualizacionesService();
module.exports.MAX_COMENTARIO_LENGTH = MAX_COMENTARIO_LENGTH;
module.exports.TIPO_COMENTARIO = TIPO_COMENTARIO;
module.exports.TIPO_REGISTRO_TIEMPO = TIPO_REGISTRO_TIEMPO;
