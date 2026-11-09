const supabase = require('../../config/supabase');
const operationsService = require('./operationsService');
const tablerosService = require('./tablerosService');
const menciones = require('./menciones');

// Panel "Actualizaciones" de una tarea del Operativo: comentarios (con
// menciones) y registros de tiempo (temporizadores y cargas manuales).
// Migraciones 2026-11-03_tareas_comentarios_y_tiempos,
// 2026-11-03_tiempos_integridad_y_acceso,
// 2026-11-09_tiempos_carga_manual_y_correcciones y
// 2026-11-09_comentarios_menciones_y_notificaciones.
// Contratos HTTP: docs/operativo-actualizaciones-contratos.md.
//
// Acceso: el mismo que el resto de las operaciones sobre una tarea
// (operationsService._asegurarAccesoTarea -> tablerosService.asegurarAcceso):
// miembros del tablero de la tarea y mando alto. No hace falta estar asignado
// a la tarea. 404 si la tarea no existe, 403 si no ve su tablero.
//
// El autor de un comentario y el dueño de un registro de tiempo salen siempre
// de la sesión (user.id). Cualquier usuario_id, duración, origen o versión
// que no corresponda del body se ignora.
//
// Tiempos: la base garantiza la concurrencia de los temporizadores, el cierre
// automático y que un registro finalizado solo cambie con
// tarea_tiempo_corregir (auditado en la misma transacción). No hay eliminación
// de registros de tiempo. Las superposiciones se informan, nunca se rechazan.
//
// Comentarios con menciones: comentario, menciones y notificaciones se
// guardan juntos (tarea_comentario_crear / tarea_comentario_editar). Solo se
// menciona a miembros activos del tablero; la base lo vuelve a verificar con
// las membresías bloqueadas.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Debe coincidir con tarea_comentarios_contenido_check.
const MAX_COMENTARIO_LENGTH = 2000;

const TIPO_COMENTARIO = 'comentario';
const TIPO_REGISTRO_TIEMPO = 'registro_tiempo';

const ORIGEN_TEMPORIZADOR = 'temporizador';
const ORIGEN_CARGA_MANUAL = 'carga_manual';

// `usuarios!usuario_id`: la tabla de menciones relaciona comentarios y
// usuarios (muchos a muchos), así que el autor se pide por su columna.
const COLUMNAS_COMENTARIO = 'id, tarea_id, usuario_id, contenido, created_at, editado_at, usuarios!usuario_id(id, nombre), tarea_comentario_menciones(usuario_id, usuarios(id, nombre, estado))';
const COLUMNAS_REGISTRO = 'id, tarea_id, usuario_id, inicio, fin, duracion_segundos, motivo_finalizacion, origen, version, corregido_at, usuarios!usuario_id(id, nombre)';
const COLUMNAS_AUDITORIA = 'id, registro_id, accion, version, inicio_anterior, fin_anterior, inicio_nuevo, fin_nuevo, created_at, actor:usuarios!actor_id(id, nombre)';

// Errores de las funciones de la base (RAISE ... ERRCODE P0001):
// [status HTTP, mensaje, codigo estable para el frontend].
const ERRORES_RPC = {
  NX_SIN_ACCESO_TAREA:          [403, 'No tenés acceso a esta tarea.', 'ACCESO_DENEGADO'],
  NX_TAREA_NO_ENCONTRADA:       [404, 'Tarea no encontrada', 'TAREA_NO_ENCONTRADA'],
  NX_TAREA_FINALIZADA:          [409, 'La tarea está completada o cancelada: no se pueden iniciar temporizadores.', 'TAREA_FINALIZADA'],
  NX_TEMPORIZADOR_ACTIVO:       [409, 'Ya tenés un temporizador activo en esta tarea.', 'TEMPORIZADOR_YA_ACTIVO'],
  NX_SIN_TEMPORIZADOR_ACTIVO:   [409, 'No tenés un temporizador activo en esta tarea.', 'SIN_TEMPORIZADOR_ACTIVO'],
  NX_USUARIO_REQUERIDO:         [401, 'No se pudo identificar al usuario autenticado.', 'NO_AUTENTICADO'],
  NX_REGISTRO_TIEMPO_INMUTABLE: [409, 'Los registros de tiempo solo se modifican mediante una corrección de su autor.', 'REGISTRO_INMUTABLE'],
  NX_INTERVALO_INVALIDO:        [400, 'El inicio debe ser anterior al fin.', 'INTERVALO_INVALIDO'],
  NX_FIN_FUTURO:                [400, 'El horario de finalización no puede ser futuro.', 'FIN_FUTURO'],
  NX_REGISTRO_NO_ENCONTRADO:    [404, 'Registro de tiempo no encontrado.', 'REGISTRO_NO_ENCONTRADO'],
  NX_REGISTRO_AJENO:            [403, 'Solo el autor puede corregir este registro de tiempo.', 'REGISTRO_AJENO'],
  NX_REGISTRO_ACTIVO:           [409, 'El temporizador sigue activo: detenelo antes de corregir el registro.', 'REGISTRO_TIEMPO_ACTIVO'],
  NX_VERSION_DESACTUALIZADA:    [409, 'El registro cambió desde que lo consultaste. Volvé a cargarlo y repetí la corrección.', 'VERSION_DESACTUALIZADA'],
  NX_COMENTARIO_NO_ENCONTRADO:  [404, 'Comentario no encontrado.', 'COMENTARIO_NO_ENCONTRADO'],
  NX_COMENTARIO_AJENO:          [403, 'Solo el autor puede modificar o eliminar este comentario.', 'COMENTARIO_AJENO'],
  NX_MENCION_INVALIDA:          [400, 'Solo se puede mencionar a miembros activos del tablero de la tarea.', 'MENCION_INVALIDA'],
};

function error(status, mensaje, codigo) {
  return Object.assign(new Error(mensaje), codigo ? { status, codigo } : { status });
}

// Agrega un `codigo` estable a los errores de acceso que vienen de
// operationsService / tablerosService (que no lo definen), sin cambiar su
// status ni su mensaje.
async function conCodigoDeAcceso(promesa, porStatus) {
  try {
    return await promesa;
  } catch (err) {
    if (err && !err.codigo && porStatus[err.status]) err.codigo = porStatus[err.status];
    throw err;
  }
}
const CODIGOS_TAREA = { 403: 'ACCESO_DENEGADO', 404: 'TAREA_NO_ENCONTRADA' };
const CODIGOS_TABLERO = { 400: 'TABLERO_INVALIDO', 403: 'ACCESO_DENEGADO', 404: 'TABLERO_NO_ENCONTRADO' };

async function llamarRpc(nombre, params) {
  const { data, error: err } = await supabase.rpc(nombre, params);
  if (!err) return data;
  const conocido = err.code === 'P0001' && ERRORES_RPC[err.message];
  if (conocido) throw error(...conocido);
  throw err;
}

function exigirUsuario(user) {
  if (!user?.id) throw error(...ERRORES_RPC.NX_USUARIO_REQUERIDO);
}

// Recorta los bordes y valida longitud. 400 si no es texto, queda vacío o es
// demasiado largo.
function validarContenido(contenido) {
  if (typeof contenido !== 'string') throw error(400, '"contenido" es obligatorio y debe ser texto.', 'CONTENIDO_INVALIDO');
  const limpio = contenido.trim();
  if (!limpio) throw error(400, 'El comentario no puede estar vacío.', 'CONTENIDO_INVALIDO');
  if (limpio.length > MAX_COMENTARIO_LENGTH) {
    throw error(400, `El comentario no puede superar los ${MAX_COMENTARIO_LENGTH} caracteres.`, 'CONTENIDO_INVALIDO');
  }
  return limpio;
}

function usuarioVisible(fila) {
  return fila.usuarios ? { id: fila.usuarios.id, nombre: fila.usuarios.nombre } : null;
}

function segundosEntre(desde, hasta) {
  return Math.max(0, Math.floor((Date.parse(hasta) - Date.parse(desde)) / 1000));
}

// ── Fechas de los registros manuales ────────────────────────────────────────
// ISO 8601 con zona horaria explícita (Z o ±hh:mm), hasta milisegundos. Se
// rechazan fechas que JavaScript "corregiría" (31/02, 25:00...), así que lo que
// se guarda es exactamente lo que el usuario indicó.

const INSTANTE_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function diasDelMes(anio, mes) {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

function leerInstante(valor, campo) {
  const formato = `"${campo}" debe ser una fecha y hora ISO 8601 con zona horaria (ej. 2026-11-08T09:00:00-03:00).`;
  if (typeof valor !== 'string') throw error(400, formato, 'FECHA_INVALIDA');
  const m = INSTANTE_ISO.exec(valor.trim());
  if (!m) throw error(400, formato, 'FECHA_INVALIDA');
  const [, a, mes, d, h, min, s = '0', , oh = '0', om = '0'] = m;
  const valido = +mes >= 1 && +mes <= 12 && +d >= 1 && +d <= diasDelMes(+a, +mes)
    && +h <= 23 && +min <= 59 && +s <= 59 && +oh <= 14 && +om <= 59;
  const ms = Date.parse(valor.trim());
  if (!valido || Number.isNaN(ms)) throw error(400, `"${campo}" no es una fecha y hora válida.`, 'FECHA_INVALIDA');
  return new Date(ms).toISOString();
}

function validarIntervalo(inicio, fin) {
  if (Date.parse(inicio) >= Date.parse(fin)) throw error(...ERRORES_RPC.NX_INTERVALO_INVALIDO);
  if (Date.parse(fin) > Date.now()) throw error(...ERRORES_RPC.NX_FIN_FUTURO);
}

function validarVersion(version) {
  if (!Number.isInteger(version) || version < 1) {
    throw error(400, '"version" es obligatoria: enviá la versión del registro que estás corrigiendo.', 'VERSION_REQUERIDA');
  }
  return version;
}

// ── Formatos de respuesta ────────────────────────────────────────────────────
// `fecha` es el momento en que el evento entra al historial (criterio de
// orden): created_at para un comentario, fin para un registro de tiempo.

// Menciones vigentes (tarea_comentario_menciones), en el orden en que
// aparecen en el texto. Un usuario eliminado deja de figurar (su token queda
// como texto).
function mencionesDe(c) {
  const orden = menciones.idsMencionados(c.contenido);
  const posicion = (id) => { const i = orden.indexOf(id); return i === -1 ? orden.length : i; };
  return (c.tarea_comentario_menciones ?? [])
    .filter(m => m.usuarios)
    .map(m => ({ id: m.usuarios.id, nombre: m.usuarios.nombre, activo: m.usuarios.estado === 'Activo' }))
    .sort((a, b) => posicion(a.id) - posicion(b.id) || String(a.id).localeCompare(String(b.id)));
}

function formatearComentario(c, user) {
  const propio = !!user?.id && c.usuario_id === user.id;
  return {
    tipo:       TIPO_COMENTARIO,
    id:         c.id,
    tarea_id:   c.tarea_id,
    usuario:    usuarioVisible(c),
    contenido:  c.contenido,
    menciones:  mencionesDe(c),
    fecha:      c.created_at,
    created_at: c.created_at,
    editado_at: c.editado_at ?? null,
    editado:    !!c.editado_at,
    permisos:   { puede_editar: propio, puede_eliminar: propio },
  };
}

// Solo el autor corrige, y solo registros finalizados. Nunca se eliminan.
function formatearRegistro(r, user) {
  const corregible = !!user?.id && r.usuario_id === user.id && r.fin != null;
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
    origen:              r.origen ?? ORIGEN_TEMPORIZADOR,
    version:             r.version ?? 1,
    corregido:           !!r.corregido_at,
    corregido_at:        r.corregido_at ?? null,
    permisos:            { puede_editar: corregible, puede_eliminar: false },
  };
}

function formatearAuditoria(a) {
  return {
    id:                         a.id,
    registro_id:                a.registro_id,
    accion:                     a.accion,
    version:                    a.version,
    actor:                      a.actor ? { id: a.actor.id, nombre: a.actor.nombre } : null,
    inicio_anterior:            a.inicio_anterior ?? null,
    fin_anterior:               a.fin_anterior ?? null,
    duracion_anterior_segundos: a.inicio_anterior && a.fin_anterior ? segundosEntre(a.inicio_anterior, a.fin_anterior) : null,
    inicio_nuevo:               a.inicio_nuevo,
    fin_nuevo:                  a.fin_nuevo,
    duracion_nueva_segundos:    segundosEntre(a.inicio_nuevo, a.fin_nuevo),
    created_at:                 a.created_at,
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

// ¿El usuario ve hoy la tarea de este tablero? Mismo criterio que
// _asegurarAccesoTarea: sin tablero, solo el mando alto (visibles === null).
function tableroVisible(tableroId, visibles) {
  return tableroId ? (visibles === null || visibles.includes(tableroId)) : visibles === null;
}

class TareaActualizacionesService {

  _asegurarAccesoTarea(tareaId, user) {
    return conCodigoDeAcceso(operationsService._asegurarAccesoTarea(tareaId, user), CODIGOS_TAREA);
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
      ...registros.map(r => formatearRegistro(r, user)),
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

  async _comentarioPorId(id) {
    const { data, error: err } = await supabase
      .from('tarea_comentarios')
      .select(COLUMNAS_COMENTARIO)
      .eq('id', id)
      .single();
    if (err) throw err;
    return data;
  }

  // Resuelve las menciones del texto. `anterior` (en una edición) trae las
  // menciones vigentes del comentario y su texto previo:
  //   - las vigentes se conservan sin volver a validar (pueden haber dejado el
  //     tablero, igual que los responsables de una tarea);
  //   - un token que ya estaba en el texto previo pero no es mención vigente
  //     (su usuario fue eliminado) queda como texto, sin error;
  //   - el resto son menciones nuevas: tienen que ser miembros activos del
  //     tablero de la tarea (400 si no).
  // Devuelve el contenido con las etiquetas normalizadas al nombre actual y la
  // lista final de ids mencionados.
  async _prepararMenciones(tarea, texto, anterior = { vigentes: [], textoPrevio: '' }) {
    const ids = menciones.idsMencionados(texto);
    if (!ids.length) return { contenido: texto, ids: [] };

    const previos = menciones.idsMencionados(anterior.textoPrevio);
    const candidatos = ids.filter(id => anterior.vigentes.includes(id) || !previos.includes(id));
    const nuevos = candidatos.filter(id => !anterior.vigentes.includes(id));

    const [{ data: usuarios, error: errU }, miembros] = await Promise.all([
      candidatos.length
        ? supabase.from('usuarios').select('id, nombre, estado').in('id', candidatos)
        : Promise.resolve({ data: [], error: null }),
      nuevos.length && tarea.tablero_id ? tablerosService.idsMiembros(tarea.tablero_id) : Promise.resolve([]),
    ]);
    if (errU) throw errU;
    const porId = new Map((usuarios ?? []).map(u => [u.id, u]));

    const invalidos = nuevos.filter(id => !miembros.includes(id) || porId.get(id)?.estado !== 'Activo');
    if (invalidos.length) {
      throw error(400, `${ERRORES_RPC.NX_MENCION_INVALIDA[1]} No son mencionables: ${invalidos.join(', ')}.`, 'MENCION_INVALIDA');
    }

    const finales = candidatos.filter(id => porId.has(id));
    const nombres = new Map(finales.map(id => [id, porId.get(id).nombre]));
    const contenido = menciones.normalizarTokens(texto, nombres);
    if (contenido.length > MAX_COMENTARIO_LENGTH) {
      throw error(400, `El comentario no puede superar los ${MAX_COMENTARIO_LENGTH} caracteres (las menciones cuentan con su formato completo).`, 'CONTENIDO_INVALIDO');
    }
    return { contenido, ids: finales };
  }

  // Solo se toma `contenido` del body: autor y fecha los pone el servidor; a
  // quién menciona sale de los tokens del texto.
  async crearComentario(tareaId, body, user) {
    const tarea = await this._asegurarAccesoTarea(tareaId, user);
    exigirUsuario(user);
    const { contenido, ids } = await this._prepararMenciones(tarea, validarContenido(body?.contenido));

    const creado = await llamarRpc('tarea_comentario_crear', {
      p_tarea_id: tareaId, p_autor_id: user.id, p_contenido: contenido, p_mencionados: ids,
    });
    return formatearComentario(await this._comentarioPorId(creado.id), user);
  }

  // Comentario de esa tarea. 404 si no existe o es de otra tarea (no revela
  // comentarios de tareas ajenas cambiando ids); 403 si no es del usuario.
  async _comentarioPropio(tareaId, comentarioId, user) {
    if (typeof comentarioId !== 'string' || !UUID.test(comentarioId)) throw error(...ERRORES_RPC.NX_COMENTARIO_NO_ENCONTRADO);
    const { data, error: err } = await supabase
      .from('tarea_comentarios')
      .select('id, usuario_id, contenido, tarea_comentario_menciones(usuario_id)')
      .eq('id', comentarioId)
      .eq('tarea_id', tareaId)
      .maybeSingle();
    if (err) throw err;
    if (!data) throw error(...ERRORES_RPC.NX_COMENTARIO_NO_ENCONTRADO);
    if (!user?.id || data.usuario_id !== user.id) throw error(...ERRORES_RPC.NX_COMENTARIO_AJENO);
    return data;
  }

  // Solo el autor. editado_at lo completa la base (trigger) cuando cambia el
  // contenido. Notifica solo a quienes se mencionan por primera vez en este
  // comentario. Si el comentario se eliminó entre la lectura y la escritura,
  // 404.
  async editarComentario(tareaId, comentarioId, body, user) {
    const tarea = await this._asegurarAccesoTarea(tareaId, user);
    const texto = validarContenido(body?.contenido);
    const actual = await this._comentarioPropio(tareaId, comentarioId, user);
    const { contenido, ids } = await this._prepararMenciones(tarea, texto, {
      vigentes: (actual.tarea_comentario_menciones ?? []).map(m => m.usuario_id),
      textoPrevio: actual.contenido,
    });

    await llamarRpc('tarea_comentario_editar', {
      p_comentario_id: comentarioId, p_tarea_id: tareaId, p_autor_id: user.id,
      p_contenido: contenido, p_mencionados: ids,
    });
    return formatearComentario(await this._comentarioPorId(comentarioId), user);
  }

  // Solo el autor. Eliminación física (no hay recuperación de comentarios).
  // Sus menciones se eliminan en cascada; las notificaciones que generó se
  // conservan marcadas como de comentario eliminado (trigger de la base).
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
    if (!data?.length) throw error(...ERRORES_RPC.NX_COMENTARIO_NO_ENCONTRADO);
    return { message: 'Comentario eliminado correctamente' };
  }

  // Usuarios que se pueden mencionar en la tarea: miembros ACTIVOS de su
  // tablero (asignados o no). El mando alto que no es miembro no aparece. Una
  // tarea sin tablero no tiene mencionables. Devuelve solo id y nombre; el
  // email se incluye únicamente para distinguir nombres repetidos (en el resto
  // es null). Nunca forma parte del texto del comentario.
  async listarMencionables(tareaId, user) {
    const tarea = await this._asegurarAccesoTarea(tareaId, user);
    if (!tarea.tablero_id) return { data: [], total: 0 };
    const { data, error: err } = await supabase
      .from('operativo_tablero_miembros')
      .select('usuario_id, usuarios(id, nombre, email, estado)')
      .eq('tablero_id', tarea.tablero_id);
    if (err) throw err;
    const activos = (data ?? []).map(m => m.usuarios).filter(u => u && u.estado === 'Activo');
    const clave = (nombre) => String(nombre ?? '').trim().toLocaleLowerCase('es');
    const repeticiones = new Map();
    for (const u of activos) repeticiones.set(clave(u.nombre), (repeticiones.get(clave(u.nombre)) ?? 0) + 1);
    const lista = activos
      .map(u => ({ id: u.id, nombre: u.nombre, email: repeticiones.get(clave(u.nombre)) > 1 ? (u.email ?? null) : null }))
      .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)) || String(a.id).localeCompare(String(b.id)));
    return { data: lista, total: lista.length };
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

  // Temporizadores activos del usuario autenticado, para marcar las tarjetas
  // del Kanban con una sola llamada. Con `tablero_id`, solo los de ese tablero
  // (tiene que poder verlo); sin él, los de todas las tareas que ve. Nunca
  // incluye temporizadores de otros usuarios.
  async listarTemporizadoresActivos({ tablero_id } = {}, user) {
    exigirUsuario(user);
    const filtrarTablero = tablero_id !== undefined && tablero_id !== '';
    if (filtrarTablero) await conCodigoDeAcceso(tablerosService.asegurarAcceso(tablero_id, user), CODIGOS_TABLERO);
    const visibles = filtrarTablero ? [tablero_id] : await tablerosService.idsVisibles(user);

    const { data, error: err } = await supabase
      .from('tarea_registros_tiempo')
      .select('id, tarea_id, usuario_id, inicio, tareas!tarea_id(tablero_id)')
      .eq('usuario_id', user.id)
      .is('fin', null)
      .order('inicio', { ascending: true });
    if (err) throw err;

    const lista = (data ?? [])
      .filter(r => r.tareas && tableroVisible(r.tareas.tablero_id, visibles))
      .map(r => ({ ...formatearActivo(r), tablero_id: r.tareas.tablero_id ?? null }));
    return { data: lista, total: lista.length, servidor_ahora: new Date().toISOString() };
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
    return formatearRegistro(await this._registroPorId(id), user);
  }

  // ── Registros de tiempo: carga manual, corrección y superposiciones ────────

  async _registroPorId(id) {
    const { data, error: err } = await supabase
      .from('tarea_registros_tiempo')
      .select(COLUMNAS_REGISTRO)
      .eq('id', id)
      .single();
    if (err) throw err;
    return data;
  }

  // Registro de esa tarea. 404 si el id es inválido, no existe o es de otra
  // tarea.
  async _registroDeTarea(tareaId, registroId) {
    if (typeof registroId !== 'string' || !UUID.test(registroId)) throw error(...ERRORES_RPC.NX_REGISTRO_NO_ENCONTRADO);
    const { data, error: err } = await supabase
      .from('tarea_registros_tiempo')
      .select(COLUMNAS_REGISTRO)
      .eq('id', registroId)
      .eq('tarea_id', tareaId)
      .maybeSingle();
    if (err) throw err;
    if (!data) throw error(...ERRORES_RPC.NX_REGISTRO_NO_ENCONTRADO);
    return data;
  }

  // Mismas reglas que tarea_tiempo_corregir, para responder antes de llamar a
  // la base (la base las vuelve a verificar con el registro bloqueado).
  _exigirCorregible(registro, user) {
    if (registro.usuario_id == null || registro.usuario_id !== user.id) throw error(...ERRORES_RPC.NX_REGISTRO_AJENO);
    if (registro.fin == null) throw error(...ERRORES_RPC.NX_REGISTRO_ACTIVO);
  }

  // Otros registros del usuario (de cualquier tarea, también temporizadores
  // activos, cuyo fin efectivo es "ahora") que se cruzan con [inicio, fin).
  // Rangos contiguos (uno termina cuando empieza el otro) no se superponen.
  // De tareas que el usuario ya no ve, solo se informa el horario.
  async _advertencias(tareaId, user, inicio, fin, excluirId) {
    let query = supabase
      .from('tarea_registros_tiempo')
      .select('id, tarea_id, inicio, fin, origen, tareas!tarea_id(titulo, tablero_id)')
      .eq('usuario_id', user.id)
      .lt('inicio', fin)
      .or(`fin.is.null,fin.gt."${inicio}"`)
      .order('inicio', { ascending: true })
      .order('id', { ascending: true });
    if (excluirId) query = query.neq('id', excluirId);
    const [{ data, error: err }, visibles] = await Promise.all([query, tablerosService.idsVisibles(user)]);
    if (err) throw err;

    const ahora = new Date().toISOString();
    const superposiciones = (data ?? []).map(r => {
      const finEfectivo = r.fin ?? ahora;
      const desde = Date.parse(r.inicio) > Date.parse(inicio) ? r.inicio : inicio;
      const hasta = Date.parse(finEfectivo) < Date.parse(fin) ? finEfectivo : fin;
      const visible = !!r.tareas && tableroVisible(r.tareas.tablero_id, visibles);
      return {
        registro_id:           r.id,
        misma_tarea:           r.tarea_id === tareaId,
        tarea:                 visible ? { id: r.tarea_id, titulo: r.tareas.titulo } : null,
        inicio:                r.inicio,
        fin:                   r.fin,
        activo:                r.fin == null,
        origen:                r.origen ?? ORIGEN_TEMPORIZADOR,
        solapamiento_segundos: segundosEntre(desde, hasta),
      };
    });
    return { superposicion: superposiciones.length > 0, superposiciones };
  }

  // Lee y valida { inicio, fin } del body (fechas reales, inicio < fin, fin no
  // futuro). Devuelve los instantes normalizados a ISO UTC.
  _leerIntervalo(body) {
    const inicio = leerInstante(body?.inicio, 'inicio');
    const fin = leerInstante(body?.fin, 'fin');
    validarIntervalo(inicio, fin);
    return { inicio, fin };
  }

  // Carga manual de tiempo propio. Se permite en tareas completadas o
  // canceladas (no inicia temporizadores ni cambia la tarea). Las
  // superposiciones no impiden guardar: vuelven en `advertencias`, calculadas
  // con el registro ya guardado.
  async registrarTiempoManual(tareaId, body, user) {
    await this._asegurarAccesoTarea(tareaId, user);
    exigirUsuario(user);
    const { inicio, fin } = this._leerIntervalo(body);

    const { id } = await llamarRpc('tarea_tiempo_registrar_manual', {
      p_tarea_id: tareaId, p_usuario_id: user.id, p_inicio: inicio, p_fin: fin,
    });
    const registro = await this._registroPorId(id);
    return {
      registro:     formatearRegistro(registro, user),
      advertencias: await this._advertencias(tareaId, user, registro.inicio, registro.fin, registro.id),
    };
  }

  // Corrección de un registro finalizado propio (manual o del temporizador).
  // `version` es obligatoria (409 si cambió). Se puede enviar inicio, fin o
  // ambos; el que falta conserva su valor. La duración la recalcula la base y
  // la corrección queda auditada en la misma transacción.
  async corregirRegistroTiempo(tareaId, registroId, body, user) {
    await this._asegurarAccesoTarea(tareaId, user);
    exigirUsuario(user);
    const actual = await this._registroDeTarea(tareaId, registroId);
    this._exigirCorregible(actual, user);

    const datos = body ?? {};
    if (datos.inicio === undefined && datos.fin === undefined) {
      throw error(400, 'Debés enviar "inicio", "fin" o ambos.', 'DATOS_INCOMPLETOS');
    }
    const version = validarVersion(datos.version);
    // Un campo omitido, o igual al actual al milisegundo, conserva el valor
    // guardado exacto (la base guarda microsegundos): no cuenta como cambio.
    const valorFinal = (campo) => {
      if (datos[campo] === undefined) return actual[campo];
      const nuevo = leerInstante(datos[campo], campo);
      return Date.parse(nuevo) === Date.parse(actual[campo]) ? actual[campo] : nuevo;
    };
    const inicio = valorFinal('inicio');
    const fin = valorFinal('fin');
    if (inicio !== actual.inicio || fin !== actual.fin) validarIntervalo(inicio, fin);

    await llamarRpc('tarea_tiempo_corregir', {
      p_registro_id: registroId, p_tarea_id: tareaId, p_usuario_id: user.id,
      p_inicio: inicio, p_fin: fin, p_version: version,
    });
    const registro = await this._registroPorId(registroId);
    return {
      registro:     formatearRegistro(registro, user),
      advertencias: await this._advertencias(tareaId, user, registro.inicio, registro.fin, registro.id),
    };
  }

  // Validación previa (no guarda nada): mismas reglas de fechas que el alta o
  // la corrección y la advertencia de superposición, para que el frontend la
  // muestre antes de confirmar. Con `registro_id`, valida como corrección de
  // ese registro (propio y finalizado) y lo excluye de las superposiciones.
  async validarRegistroTiempo(tareaId, body, user) {
    await this._asegurarAccesoTarea(tareaId, user);
    exigirUsuario(user);
    const { inicio, fin } = this._leerIntervalo(body);
    let excluir = null;
    if (body?.registro_id !== undefined && body.registro_id !== null) {
      const registro = await this._registroDeTarea(tareaId, body.registro_id);
      this._exigirCorregible(registro, user);
      excluir = registro.id;
    }
    return {
      valido:            true,
      inicio,
      fin,
      duracion_segundos: segundosEntre(inicio, fin),
      advertencias:      await this._advertencias(tareaId, user, inicio, fin, excluir),
    };
  }

  // Historial de cargas y correcciones de un registro (valores anteriores y
  // nuevos), del más antiguo al más reciente. Lo ve quien ve la tarea, igual
  // que los registros.
  async listarCorreccionesRegistro(tareaId, registroId, user) {
    await this._asegurarAccesoTarea(tareaId, user);
    const registro = await this._registroDeTarea(tareaId, registroId);
    const { data, error: err } = await supabase
      .from('tarea_registros_tiempo_auditoria')
      .select(COLUMNAS_AUDITORIA)
      .eq('registro_id', registro.id)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (err) throw err;
    const lista = (data ?? []).map(formatearAuditoria);
    return { registro: formatearRegistro(registro, user), data: lista, total: lista.length };
  }
}

module.exports = new TareaActualizacionesService();
module.exports.MAX_COMENTARIO_LENGTH = MAX_COMENTARIO_LENGTH;
module.exports.TIPO_COMENTARIO = TIPO_COMENTARIO;
module.exports.TIPO_REGISTRO_TIEMPO = TIPO_REGISTRO_TIEMPO;
module.exports.ORIGEN_TEMPORIZADOR = ORIGEN_TEMPORIZADOR;
module.exports.ORIGEN_CARGA_MANUAL = ORIGEN_CARGA_MANUAL;
