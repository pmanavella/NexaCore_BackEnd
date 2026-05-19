const supabase = require('../../config/supabase');

// Campos de la tabla `tareas` que se auditan en tarea_historial.
// Cualquier cambio en estos campos genera un registro automático.
const CAMPOS_AUDITABLES = ['titulo', 'descripcion', 'estado', 'prioridad', 'asignado_a', 'fecha_limite'];

// Normaliza valores para comparación: null, undefined y '' se tratan igual (sin valor).
// Evita falsos positivos cuando el frontend envía '' y la BD tiene null.
function normalizar(v) {
  return (v == null || v === '') ? '' : String(v);
}

class OperationsService {

  // ── Historial ──────────────────────────────────────────────────────────────

  // Inserta uno o más registros en tarea_historial.
  // Recibe un array de objetos con la estructura completa de la tabla.
  // No lanza error si falla — el historial no debe interrumpir la operación principal.
  async _registrarHistorial(entradas) {
    if (!entradas || entradas.length === 0) return;
    const { error } = await supabase.from('tarea_historial').insert(entradas);
    if (error) console.error('[Historial] Error al registrar:', error.message);
  }

  // Devuelve todo el historial de una tarea ordenado del más reciente al más antiguo.
  // Usado por GET /api/operations/tareas/:id/historial
  async obtenerHistorial(tarea_id) {
    const { data, error } = await supabase
      .from('tarea_historial')
      .select('*')
      .eq('tarea_id', tarea_id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { data };
  }

  // ── Tareas ─────────────────────────────────────────────────────────────────

  // Solo devuelve tareas directas (tipo = 'asignacion') — las propuestas van por su propio endpoint
  async listarTareas({ estado, prioridad, asignado_a } = {}) {
    let query = supabase
      .from('tareas')
      .select('*')
      .or('tipo.is.null,tipo.eq.asignacion')
      .order('created_at', { ascending: false });

    if (estado    && estado    !== 'Todos') query = query.eq('estado',    estado);
    if (prioridad && prioridad !== 'Todos') query = query.eq('prioridad', prioridad);
    if (asignado_a) query = query.eq('asignado_a', asignado_a);

    const { data, error } = await query;
    if (error) throw error;
    return { data, total: data.length };
  }

  // Crea una tarea nueva y registra el evento 'creacion' en tarea_historial.
  // usuario_nombre y usuario_id se extraen del body pero NO se guardan en tareas.
  async crearTarea(body) {
    const {
      titulo, descripcion, estado, prioridad, asignado_a, fecha_limite,
      tipo, propuesto_por, estado_propuesta,
      usuario_nombre, usuario_id,
    } = body;
    if (!titulo) throw Object.assign(new Error('El título es obligatorio'), { status: 400 });

    const { data, error } = await supabase
      .from('tareas')
      .insert([{
        titulo,
        descripcion,
        estado:           estado           || 'Pendiente',
        prioridad:        prioridad        || 'Media',
        asignado_a,
        fecha_limite,
        tipo:             tipo             || 'asignacion',
        propuesto_por:    propuesto_por    || null,
        estado_propuesta: estado_propuesta || null,
      }])
      .select()
      .single();
    if (error) throw error;

    // Registrar evento de creación — no incluye campo_modificado ni valores previos
    await this._registrarHistorial([{
      tarea_id:         data.id,
      usuario_id:       usuario_id     || null,
      usuario_nombre:   usuario_nombre || 'Sistema',
      accion:           'creacion',
      campo_modificado: null,
      valor_anterior:   null,
      valor_nuevo:      null,
    }]);

    return data;
  }

  // Actualiza una tarea y genera un registro de historial por cada campo que cambió.
  // Pasos: 1) extrae datos de auditoría del body, 2) lee estado actual de la tarea,
  //         3) actualiza en BD, 4) compara campo a campo y registra diferencias.
  async actualizarTarea(id, body) {
    // Separar campos de auditoría (no pertenecen a la tabla tareas)
    const { usuario_nombre, usuario_id, ...camposTarea } = body;

    // Leer estado actual ANTES de actualizar para poder comparar valores
    const { data: tareaActual, error: errLectura } = await supabase
      .from('tareas')
      .select('*')
      .eq('id', id)
      .single();
    if (errLectura) throw errLectura;

    // Aplicar la actualización en la tabla tareas
    const { data, error } = await supabase
      .from('tareas')
      .update(camposTarea)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    // Comparar únicamente los campos auditables que fueron enviados en el body.
    // Si el valor normalizado cambió, se genera un registro individual por campo.
    const entradas = [];
    for (const campo of CAMPOS_AUDITABLES) {
      if (campo in camposTarea) {
        const anterior = normalizar(tareaActual[campo]);
        const nuevo    = normalizar(camposTarea[campo]);
        if (anterior !== nuevo) {
          entradas.push({
            tarea_id:         id,
            usuario_id:       usuario_id     || null,
            usuario_nombre:   usuario_nombre || 'Sistema',
            accion:           'actualizacion',
            campo_modificado: campo,
            // Guardar null real cuando el campo estaba/quedó vacío
            valor_anterior:   (tareaActual[campo] != null && tareaActual[campo] !== '') ? String(tareaActual[campo]) : null,
            valor_nuevo:      (camposTarea[campo]  != null && camposTarea[campo]  !== '') ? String(camposTarea[campo])  : null,
          });
        }
      }
    }
    await this._registrarHistorial(entradas);

    return data;
  }

  async eliminarTarea(id) {
    // ON DELETE CASCADE en tarea_historial elimina el historial automáticamente
    const { error } = await supabase.from('tareas').delete().eq('id', id);
    if (error) throw error;
    return { message: 'Tarea eliminada correctamente' };
  }

  async getMetricas() {
    const { data, error } = await supabase
      .from('tareas')
      .select('estado, prioridad, tipo')
      .or('tipo.is.null,tipo.eq.asignacion');
    if (error) throw error;
    const total      = data.length;
    const pendientes = data.filter(t => t.estado === 'Pendiente').length;
    const enProceso  = data.filter(t => t.estado === 'En Proceso').length;
    const completadas= data.filter(t => t.estado === 'Completada').length;
    return { total, pendientes, enProceso, completadas };
  }

  // ── Propuestas ─────────────────────────────────────────────────────────────

  async listarPropuestas({ propuesto_por, asignado_a } = {}) {
    let query = supabase
      .from('tareas')
      .select('*')
      .eq('tipo', 'propuesta')
      .order('created_at', { ascending: false });

    if (propuesto_por) query = query.eq('propuesto_por', propuesto_por);
    if (asignado_a)    query = query.eq('asignado_a',    asignado_a);

    const { data, error } = await query;
    if (error) throw error;
    return { data, total: data.length };
  }

  // Aprueba una propuesta (tipo → 'asignacion', estado_propuesta → 'aprobada', estado → 'Pendiente')
  // y registra el evento en tarea_historial.
  // usuario_nombre y usuario_id provienen del body del request (enviados por el frontend).
  async aprobarPropuesta(id, { usuario_nombre, usuario_id } = {}) {
    // Leer estado actual para registrar el valor anterior en historial
    const { data: antes, error: errLectura } = await supabase
      .from('tareas')
      .select('estado_propuesta')
      .eq('id', id)
      .single();
    if (errLectura) throw errLectura;

    const { data, error } = await supabase
      .from('tareas')
      .update({ tipo: 'asignacion', estado_propuesta: 'aprobada', estado: 'Pendiente' })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    await this._registrarHistorial([{
      tarea_id:         id,
      usuario_id:       usuario_id     || null,
      usuario_nombre:   usuario_nombre || 'Sistema',
      accion:           'aprobacion_propuesta',
      campo_modificado: 'estado_propuesta',
      valor_anterior:   antes.estado_propuesta || 'pendiente',
      valor_nuevo:      'aprobada',
    }]);

    return data;
  }

  // Rechaza una propuesta (estado_propuesta → 'rechazada')
  // y registra el evento en tarea_historial.
  async rechazarPropuesta(id, { usuario_nombre, usuario_id } = {}) {
    // Leer estado actual para registrar el valor anterior en historial
    const { data: antes, error: errLectura } = await supabase
      .from('tareas')
      .select('estado_propuesta')
      .eq('id', id)
      .single();
    if (errLectura) throw errLectura;

    const { data, error } = await supabase
      .from('tareas')
      .update({ estado_propuesta: 'rechazada' })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    await this._registrarHistorial([{
      tarea_id:         id,
      usuario_id:       usuario_id     || null,
      usuario_nombre:   usuario_nombre || 'Sistema',
      accion:           'rechazo_propuesta',
      campo_modificado: 'estado_propuesta',
      valor_anterior:   antes.estado_propuesta || 'pendiente',
      valor_nuevo:      'rechazada',
    }]);

    return data;
  }
}

module.exports = new OperationsService();
