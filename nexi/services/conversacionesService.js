const supabase = require('../../config/supabase');
const { LIMITES } = require('../config/nexi');
const { errorPublico } = require('../utils/errores');

// Conversaciones y mensajes de Nexi. TODAS las consultas filtran por el
// usuario autenticado: una conversación ajena se trata igual que una
// inexistente (404) para no revelar su existencia.

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNAS_CONVERSACION = 'id, titulo, created_at, updated_at';
const TITULO_POR_DEFECTO = 'Nueva conversación';

function noEncontrada() {
  return errorPublico(404, 'Conversación no encontrada.', 'CONVERSACION_NO_ENCONTRADA');
}

function requerirUsuario(usuarioId) {
  if (!usuarioId) throw errorPublico(401, 'No autenticado.', 'NO_AUTENTICADO');
}

function normalizarTitulo(titulo) {
  if (titulo === undefined || titulo === null || titulo === '') return TITULO_POR_DEFECTO;
  if (typeof titulo !== 'string') throw errorPublico(400, 'El título debe ser texto.', 'TITULO_INVALIDO');
  const limpio = titulo.replace(/\s+/g, ' ').trim();
  if (!limpio) return TITULO_POR_DEFECTO;
  return limpio.slice(0, LIMITES.MAX_TITULO_CARACTERES);
}

class ConversacionesService {
  async listar(usuarioId) {
    requerirUsuario(usuarioId);
    const { data, error } = await supabase
      .from('nexi_conversaciones')
      .select(COLUMNAS_CONVERSACION)
      .eq('usuario_id', usuarioId)
      .order('updated_at', { ascending: false })
      .limit(LIMITES.MAX_CONVERSACIONES_LISTADO);
    if (error) throw error;
    return { data: data || [], total: (data || []).length };
  }

  async crear(usuarioId, titulo) {
    requerirUsuario(usuarioId);
    const { data, error } = await supabase
      .from('nexi_conversaciones')
      .insert([{ usuario_id: usuarioId, titulo: normalizarTitulo(titulo) }])
      .select(COLUMNAS_CONVERSACION)
      .single();
    if (error) throw error;
    return data;
  }

  // Devuelve la conversación solo si pertenece al usuario; si no, 404.
  async obtenerPropia(conversacionId, usuarioId) {
    requerirUsuario(usuarioId);
    if (typeof conversacionId !== 'string' || !UUID_REGEX.test(conversacionId)) throw noEncontrada();
    const { data, error } = await supabase
      .from('nexi_conversaciones')
      .select(COLUMNAS_CONVERSACION)
      .eq('id', conversacionId)
      .eq('usuario_id', usuarioId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw noEncontrada();
    return data;
  }

  async listarMensajes(conversacionId, usuarioId) {
    const conversacion = await this.obtenerPropia(conversacionId, usuarioId);
    const { data, error } = await supabase
      .from('nexi_mensajes')
      .select('id, rol, contenido, created_at')
      .eq('conversacion_id', conversacion.id)
      .order('created_at', { ascending: true })
      .limit(LIMITES.MAX_MENSAJES_LISTADO);
    if (error) throw error;
    return { conversacion, data: data || [] };
  }

  // Últimos N mensajes (orden cronológico) para enviar como historial al modelo.
  // Llamar solo después de obtenerPropia().
  async historialReciente(conversacionId, limite = LIMITES.MAX_MENSAJES_HISTORIAL) {
    const { data, error } = await supabase
      .from('nexi_mensajes')
      .select('rol, contenido, created_at')
      .eq('conversacion_id', conversacionId)
      .order('created_at', { ascending: false })
      .limit(limite);
    if (error) throw error;
    return (data || []).reverse();
  }

  // Guarda el par pregunta/respuesta con timestamps explícitos para mantener
  // el orden, y actualiza updated_at (y el título, si se indica) de la conversación.
  async guardarIntercambio(conversacionId, { pregunta, respuesta, preguntaAt, respuestaAt, nuevoTitulo = null }) {
    const { data, error } = await supabase
      .from('nexi_mensajes')
      .insert([
        { conversacion_id: conversacionId, rol: 'usuario', contenido: pregunta, created_at: preguntaAt },
        { conversacion_id: conversacionId, rol: 'asistente', contenido: respuesta, created_at: respuestaAt },
      ])
      .select('id, rol, contenido, created_at');
    if (error) throw error;

    const { error: errUpd } = await supabase
      .from('nexi_conversaciones')
      .update({ updated_at: respuestaAt, ...(nuevoTitulo ? { titulo: nuevoTitulo } : {}) })
      .eq('id', conversacionId);
    if (errUpd) console.error('[Nexi] No se pudo actualizar updated_at de la conversación:', errUpd.message);

    return (data || []).find(m => m.rol === 'asistente') || null;
  }

  async eliminar(conversacionId, usuarioId) {
    const conversacion = await this.obtenerPropia(conversacionId, usuarioId);
    const { error } = await supabase
      .from('nexi_conversaciones')
      .delete()
      .eq('id', conversacion.id)
      .eq('usuario_id', usuarioId);
    if (error) throw error;
    return { message: 'Conversación eliminada correctamente.' };
  }

  // Borra una conversación recién creada que quedó sin mensajes (fallo del chat).
  async eliminarSiVacia(conversacionId, usuarioId) {
    const { count, error } = await supabase
      .from('nexi_mensajes')
      .select('id', { count: 'exact', head: true })
      .eq('conversacion_id', conversacionId);
    if (error || count) return;
    await supabase.from('nexi_conversaciones').delete().eq('id', conversacionId).eq('usuario_id', usuarioId);
  }
}

const service = new ConversacionesService();
module.exports = service;
module.exports.normalizarTitulo = normalizarTitulo;
module.exports.TITULO_POR_DEFECTO = TITULO_POR_DEFECTO;
