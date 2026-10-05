const supabase = require('../../config/supabase');
const { resolverPeriodo, rangoMes } = require('../../utils/periodo');
const { TIPOS_BASE, TIPOS_BASE_CERRADOS, ESTADO_CANONICO_POR_TIPO_BASE } = require('../config/etapas');
const tareaAsignados = require('./tareaAsignados');

// Columnas que devuelven los endpoints de tareas: la tarea, su etapa y sus asignados.
const SELECT_TAREA = `*, operativo_etapas(id, nombre, color, tipo_base, posicion), ${tareaAsignados.SELECT_ASIGNADOS}`;

// Campos de la tabla `tareas` que se auditan en tarea_historial.
// Cualquier cambio en estos campos genera un registro automático.
const CAMPOS_AUDITABLES = [
  'titulo', 'descripcion', 'estado', 'prioridad', 'asignado_a', 'fecha_limite',
  'fecha_inicio_planeada', 'fecha_inicio_real', 'fecha_fin_real',
];

// La columna `estado` tiene un CHECK en la base que solo permite 4 valores
// (Pendiente, En Proceso, Completada, Cancelada; preexistente, no forma parte de la migración de etapas). Con etapas personalizables
// el nombre de la etapa puede ser cualquier texto, así que `estado` deja de reflejar el
// nombre literal de la etapa y pasa a reflejar el equivalente canónico de su tipo_base.
// Esto es lo que sigue usando Nexi (nexi/tools/operativoTools.js), que no se tocó.
// El mapeo tipo_base -> estado vive en operations/config/etapas.js.

// Normaliza valores para comparación: null, undefined y '' se tratan igual (sin valor).
// Evita falsos positivos cuando el frontend envía '' y la BD tiene null.
function normalizar(v) {
  return (v == null || v === '') ? '' : String(v);
}

// Agrega `dias_trabajo` (calculado, no se persiste) a una tarea: días corridos entre
// fecha_inicio_real y fecha_fin_real, ambas fechas incluidas. null si falta alguna.
function conDiasTrabajo(tarea) {
  if (!tarea) return tarea;
  let dias_trabajo = null;
  if (tarea.fecha_inicio_real && tarea.fecha_fin_real) {
    const inicio = new Date(tarea.fecha_inicio_real);
    const fin = new Date(tarea.fecha_fin_real);
    dias_trabajo = Math.round((fin - inicio) / 86400000) + 1;
  }
  return { ...tarea, dias_trabajo };
}

// Forma de respuesta de una tarea: asignados aplanados + dias_trabajo.
function formatearTarea(tarea) {
  return conDiasTrabajo(tareaAsignados.conAsignados(tarea));
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

  // Devuelve la etapa a usar para una tarea: la indicada por etapa_id, o si no
  // se mandó ninguna, la primera etapa (menor posición) de tipo_base 'pendiente'.
  async _resolverEtapa(etapa_id) {
    let query = supabase.from('operativo_etapas').select('id, nombre, color, tipo_base, posicion');
    query = etapa_id
      ? query.eq('id', etapa_id)
      : query.eq('tipo_base', 'pendiente').order('posicion', { ascending: true }).limit(1);

    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) {
      throw Object.assign(
        new Error(etapa_id ? 'La etapa indicada no existe' : 'No hay ninguna etapa inicial configurada (tipo_base=pendiente)'),
        { status: 400 }
      );
    }
    return data[0];
  }

  // Completa fecha_inicio_real / fecha_fin_real en `campos` según el tipo_base de la
  // nueva etapa, solo si esa tarea todavía no las tenía cargadas (no se pisan fechas
  // reales ya registradas si la tarea vuelve a pasar por la misma etapa más adelante).
  // `actual` es la tarea tal como está hoy en la base (o un objeto vacío si es un alta).
  _aplicarFechasAutomaticas(campos, etapa, actual) {
    const hoy = new Date().toISOString().slice(0, 10);
    if (etapa.tipo_base === 'en_curso' && !actual.fecha_inicio_real) {
      campos.fecha_inicio_real = hoy;
    }
    if (etapa.tipo_base === 'completada' && !actual.fecha_fin_real) {
      campos.fecha_fin_real = hoy;
    }
  }

  // Restringe `query` a las tareas de una persona (incluye tareas compartidas).
  // asignado_id = usuario_id; asignado_a = nombre (filtro legacy, ver tareaAsignados).
  // Devuelve null si la persona no tiene tareas.
  async _filtrarPorPersona(query, { asignado_id, asignado_a }) {
    if (!asignado_id && !asignado_a) return query;
    const ids = await tareaAsignados.idsTareasDePersona({
      usuarioIds: asignado_id ? [asignado_id] : [],
      nombre: asignado_a,
    });
    return ids.length ? query.in('id', ids) : null;
  }

  // Lee una tarea con su etapa y asignados, con la forma de respuesta de la API.
  async _obtenerTarea(id) {
    const { data, error } = await supabase.from('tareas').select(SELECT_TAREA).eq('id', id).single();
    if (error) throw error;
    return formatearTarea(data);
  }

  // Solo devuelve tareas directas (tipo = 'asignacion') — las propuestas van por su propio endpoint
  async listarTareas({ estado, prioridad, asignado_a, asignado_id, etapa_id } = {}) {
    let query = supabase
      .from('tareas')
      .select(SELECT_TAREA)
      .or('tipo.is.null,tipo.eq.asignacion')
      .order('created_at', { ascending: false });

    if (estado    && estado    !== 'Todos') query = query.eq('estado',    estado);
    if (prioridad && prioridad !== 'Todos') query = query.eq('prioridad', prioridad);
    if (etapa_id)   query = query.eq('etapa_id',   etapa_id);
    query = await this._filtrarPorPersona(query, { asignado_id, asignado_a });
    if (!query) return { data: [], total: 0 };

    const { data, error } = await query;
    if (error) throw error;
    return { data: data.map(formatearTarea), total: data.length };
  }

  // Crea una tarea nueva y registra el evento 'creacion' en tarea_historial.
  // usuario_nombre y usuario_id se extraen del body pero NO se guardan en tareas.
  // `asignados` (array de usuario_id) define las personas asignadas; si no viene,
  // se acepta el `asignado_a` (nombre) histórico por compatibilidad.
  async crearTarea(body) {
    const {
      titulo, descripcion, prioridad, asignado_a, asignados, fecha_limite,
      tipo, propuesto_por, estado_propuesta,
      usuario_nombre, usuario_id,
      etapa_id, fecha_inicio_planeada,
    } = body;
    if (!titulo) throw Object.assign(new Error('El título es obligatorio'), { status: 400 });

    const asignacion = asignados !== undefined
      ? { ids: await tareaAsignados.validarAsignados(asignados), texto: null }
      : await tareaAsignados.resolverAsignadoLegacy(asignado_a);

    const etapa = await this._resolverEtapa(etapa_id);

    const nuevaTarea = {
      titulo,
      descripcion,
      estado:                 ESTADO_CANONICO_POR_TIPO_BASE[etapa.tipo_base],
      etapa_id:                etapa.id,
      prioridad:               prioridad        || 'Media',
      // Con asignados vinculados, la sincronización completa este texto.
      asignado_a:              asignacion.texto,
      fecha_limite,
      fecha_inicio_planeada:   fecha_inicio_planeada || null,
      tipo:                    tipo             || 'asignacion',
      propuesto_por:           propuesto_por    || null,
      estado_propuesta:        estado_propuesta || null,
    };
    // Si la tarea nace directamente en una etapa "en curso" o "completada"
    // (ej. se carga una tarea que ya se venía haciendo), completar sus fechas reales.
    this._aplicarFechasAutomaticas(nuevaTarea, etapa, {});

    const { data: creada, error } = await supabase
      .from('tareas')
      .insert([nuevaTarea])
      .select('id')
      .single();
    if (error) throw error;

    if (asignacion.ids.length) {
      try {
        await tareaAsignados.sincronizar(creada.id, asignacion.ids);
      } catch (err) {
        // No dejar una tarea creada sin las personas pedidas.
        await supabase.from('tareas').delete().eq('id', creada.id);
        throw err;
      }
    }

    const data = await this._obtenerTarea(creada.id);

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
  //
  // Asignados: `asignados` es la lista FINAL completa (agregar, quitar o reemplazar
  // personas = enviar la lista resultante). Si no viene y llega un `asignado_a`
  // distinto del actual, se trata como asignación legacy a una sola persona.
  async actualizarTarea(id, body) {
    // Separar campos de auditoría (no pertenecen a la tabla tareas)
    const { usuario_nombre, usuario_id, asignados, ...camposTarea } = body;

    // Leer estado actual ANTES de actualizar: sirve para comparar en el historial y
    // para saber si fecha_inicio_real/fecha_fin_real ya estaban cargadas (no pisarlas)
    const { data: tareaActual, error: errLectura } = await supabase
      .from('tareas')
      .select('*')
      .eq('id', id)
      .single();
    if (errLectura) throw errLectura;

    // Validar asignados ANTES de escribir nada.
    let asignacion = null;
    if (asignados !== undefined) {
      const actuales = await tareaAsignados.usuarioIdsDeTarea(id);
      asignacion = { ids: await tareaAsignados.validarAsignados(asignados, actuales), texto: null };
    } else if ('asignado_a' in camposTarea && normalizar(camposTarea.asignado_a) !== normalizar(tareaActual.asignado_a)) {
      asignacion = await tareaAsignados.resolverAsignadoLegacy(camposTarea.asignado_a);
    }
    // asignado_a lo mantiene la sincronización; un valor sin cambios se ignora
    // (clientes que reenvían el formulario completo).
    delete camposTarea.asignado_a;

    // Si viene etapa_id, resolverla, reflejar su nombre en `estado` (ver _resolverEtapa)
    // y completar fechas reales si corresponde
    if (camposTarea.etapa_id) {
      const etapa = await this._resolverEtapa(camposTarea.etapa_id);
      camposTarea.etapa_id = etapa.id;
      camposTarea.estado = ESTADO_CANONICO_POR_TIPO_BASE[etapa.tipo_base];
      this._aplicarFechasAutomaticas(camposTarea, etapa, tareaActual);
    }

    // Aplicar la actualización en la tabla tareas
    if (Object.keys(camposTarea).length) {
      const { error } = await supabase.from('tareas').update(camposTarea).eq('id', id);
      if (error) throw error;
    }

    if (asignacion) {
      await tareaAsignados.sincronizar(id, asignacion.ids);
      if (asignacion.texto) {
        const { error } = await supabase.from('tareas').update({ asignado_a: asignacion.texto }).eq('id', id);
        if (error) throw error;
      }
    }

    const data = await this._obtenerTarea(id);

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
    // asignado_a refleja la lista de asignados ("Ana, Juan"): se audita su cambio.
    if (asignacion && normalizar(tareaActual.asignado_a) !== normalizar(data.asignado_a)) {
      entradas.push({
        tarea_id:         id,
        usuario_id:       usuario_id     || null,
        usuario_nombre:   usuario_nombre || 'Sistema',
        accion:           'actualizacion',
        campo_modificado: 'asignado_a',
        valor_anterior:   tareaActual.asignado_a || null,
        valor_nuevo:      data.asignado_a || null,
      });
    }
    await this._registrarHistorial(entradas);

    return data;
  }

  async eliminarTarea(id) {
    // ON DELETE CASCADE en tarea_historial y tarea_asignados elimina historial y asignaciones
    const { error } = await supabase.from('tareas').delete().eq('id', id);
    if (error) throw error;
    return { message: 'Tarea eliminada correctamente' };
  }

  // mes/anio son opcionales: si no llegan, se mantiene el comportamiento histórico
  // (métricas sobre todas las tareas, sin filtrar por fecha). Cuando se proveen, filtran
  // por fecha_limite (vencimiento), que es el campo relevante para el tablero operativo.
  //
  // Los totales ya no son fijos (pendientes/enProceso/completadas): con etapas
  // personalizables se devuelve `porEtapa` (una entrada por cada etapa configurada,
  // en el orden del tablero) y `porTipoBase` (agregado por tipo_base interno,
  // útil para tarjetas resumen). `vencida` = fecha_limite pasada y la etapa de la
  // tarea no es de un tipo_base cerrado (ver TIPOS_BASE_CERRADOS).
  async getMetricas({ mes, anio } = {}) {
    let query = supabase
      .from('tareas')
      .select('fecha_limite, etapa_id, operativo_etapas(tipo_base)')
      .or('tipo.is.null,tipo.eq.asignacion');

    const periodoProvisto = (mes ?? '') !== '' || (anio ?? '') !== '';
    if (periodoProvisto) {
      const { mes: targetMes, anio: targetAnio } = resolverPeriodo(mes, anio);
      const { desde, hasta } = rangoMes(targetMes, targetAnio);
      query = query.gte('fecha_limite', desde).lt('fecha_limite', hasta);
    }

    const [{ data, error }, { data: etapas, error: errEtapas }] = await Promise.all([
      query,
      supabase.from('operativo_etapas').select('id, nombre, color, posicion, tipo_base').order('posicion', { ascending: true }),
    ]);
    if (error) throw error;
    if (errEtapas) throw errEtapas;

    const hoy = new Date().toISOString().slice(0, 10);
    const porEtapa = etapas.map(e => ({
      etapa_id: e.id,
      nombre:   e.nombre,
      color:    e.color,
      posicion: e.posicion,
      tipo_base: e.tipo_base,
      cantidad: data.filter(t => t.etapa_id === e.id).length,
    }));

    const porTipoBase = Object.fromEntries(TIPOS_BASE.map(t => [t, 0]));
    for (const t of data) {
      const tipoBase = t.operativo_etapas?.tipo_base;
      if (tipoBase && tipoBase in porTipoBase) porTipoBase[tipoBase]++;
    }

    const vencidas = data.filter(t =>
      t.fecha_limite && t.fecha_limite < hoy &&
      t.operativo_etapas?.tipo_base && !TIPOS_BASE_CERRADOS.includes(t.operativo_etapas.tipo_base)
    ).length;

    return { total: data.length, porEtapa, porTipoBase, vencidas };
  }

  // ── Propuestas ─────────────────────────────────────────────────────────────

  async listarPropuestas({ propuesto_por, asignado_a, asignado_id } = {}) {
    let query = supabase
      .from('tareas')
      .select(`*, ${tareaAsignados.SELECT_ASIGNADOS}`)
      .eq('tipo', 'propuesta')
      .order('created_at', { ascending: false });

    if (propuesto_por) query = query.eq('propuesto_por', propuesto_por);
    query = await this._filtrarPorPersona(query, { asignado_id, asignado_a });
    if (!query) return { data: [], total: 0 };

    const { data, error } = await query;
    if (error) throw error;
    return { data: data.map(tareaAsignados.conAsignados), total: data.length };
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

    // Al aprobar, la tarea entra al tablero en la etapa inicial (tipo_base 'pendiente')
    const etapaInicial = await this._resolverEtapa(null);

    const { data, error } = await supabase
      .from('tareas')
      .update({ tipo: 'asignacion', estado_propuesta: 'aprobada', estado: ESTADO_CANONICO_POR_TIPO_BASE[etapaInicial.tipo_base], etapa_id: etapaInicial.id })
      .eq('id', id)
      .select(SELECT_TAREA)
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

    return tareaAsignados.conAsignados(data);
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
      .select(`*, ${tareaAsignados.SELECT_ASIGNADOS}`)
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

    return tareaAsignados.conAsignados(data);
  }
}

module.exports = new OperationsService();
