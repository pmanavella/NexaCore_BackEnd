const supabase = require('../../config/supabase');
const tareaAsignados = require('../../operations/services/tareaAsignados');

// Acceso a datos de SOLO LECTURA usado por las herramientas de Nexi.
// Cada método devuelve agregados o columnas explícitas mínimas: nunca `select('*')`,
// nunca texto libre (descripciones, notas, emails, teléfonos).
// Los conteos usan `count: 'exact', head: true` para no depender del límite de
// filas de PostgREST ni traer filas al servidor.

async function contar(tabla, aplicarFiltros) {
  const query = aplicarFiltros(supabase.from(tabla).select('id', { count: 'exact', head: true }));
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
}

class NexiDatos {
  // Totales de public.movimientos por (mes, tipo, categoria) en [desde, hasta),
  // vía la función SQL de solo lectura creada por la migración de Indicadores.
  async totalesMovimientos(desde, hasta) {
    const { data, error } = await supabase.rpc('indicadores_totales_movimientos', { p_desde: desde, p_hasta: hasta });
    if (error) throw error;
    return data || [];
  }

  async contarComprobantesEnRevision() {
    return contar('comprobantes', q => q.eq('estado_analisis', 'requiere_revision'));
  }

  // Deudas no pagadas con vencimiento <= hasta (incluye vencidas).
  async deudasPorVencer(hasta, limite) {
    const { data, error, count } = await supabase
      .from('deudas')
      .select('acreedor, monto, vencimiento, estado', { count: 'exact' })
      .neq('estado', 'Pagada')
      .lte('vencimiento', hasta)
      .order('vencimiento', { ascending: true })
      .limit(limite);
    if (error) throw error;
    return { filas: data || [], total: count || 0 };
  }

  async contarTareas(filtros = {}) {
    return contar('tareas', q => {
      let query = q;
      if (filtros.tipo === 'propuesta') query = query.eq('tipo', 'propuesta');
      else query = query.or('tipo.is.null,tipo.eq.asignacion');
      if (filtros.estado) query = query.eq('estado', filtros.estado);
      if (filtros.prioridad) query = query.eq('prioridad', filtros.prioridad);
      if (filtros.estadoPropuesta) query = query.eq('estado_propuesta', filtros.estadoPropuesta);
      if (filtros.estadosAbiertos) query = query.in('estado', filtros.estadosAbiertos);
      if (filtros.venceAntesDe) query = query.lt('fecha_limite', filtros.venceAntesDe);
      if (filtros.desde) query = query.gte('fecha_limite', filtros.desde);
      if (filtros.hasta) query = query.lt('fecha_limite', filtros.hasta);
      return query;
    });
  }

  // Cantidad de usuarios (cualquier estado) cuyo nombre coincide exactamente.
  // Las tareas históricas sin vincular solo tienen el nombre en tareas.asignado_a:
  // ese texto es un identificador seguro únicamente si el nombre es único.
  async contarUsuariosConNombre(nombre) {
    return contar('usuarios', q => q.eq('nombre', nombre));
  }

  // Tareas abiertas del usuario, incluidas las compartidas con otras personas
  // (public.tarea_asignados) y las históricas asignadas solo por nombre.
  async tareasAbiertasAsignadasA({ id, nombre }, limite) {
    const ids = await tareaAsignados.idsTareasDePersona({ usuarioIds: id ? [id] : [], nombre });
    if (!ids.length) return { filas: [], total: 0 };

    const { data, error, count } = await supabase
      .from('tareas')
      .select('titulo, estado, prioridad, fecha_limite', { count: 'exact' })
      .or('tipo.is.null,tipo.eq.asignacion')
      .in('id', ids)
      .in('estado', ['Pendiente', 'En Proceso'])
      .order('fecha_limite', { ascending: true, nullsFirst: false })
      .limit(limite);
    if (error) throw error;
    return { filas: data || [], total: count || 0 };
  }

  // Ids de tareas vinculadas a un conjunto de usuarios (tarea_asignados) y,
  // opcionalmente, a un nombre histórico en tareas.asignado_a. Reutiliza la
  // misma regla que el módulo Operativo (tareaAsignados.idsTareasDePersona).
  async idsTareasDeUsuarios(usuarioIds, nombreLegacy = null) {
    return tareaAsignados.idsTareasDePersona({ usuarioIds, nombre: nombreLegacy || undefined });
  }

  // Columnas mínimas de tareas para contar en memoria cuando el alcance está
  // restringido a un conjunto de ids. Se consulta en lotes para no exceder el
  // largo de URL de PostgREST con `in(...)`.
  async filasTareasPorIds(ids) {
    const filas = [];
    for (let i = 0; i < ids.length; i += 150) {
      const { data, error } = await supabase
        .from('tareas')
        .select('id, estado, prioridad, fecha_limite, tipo')
        .in('id', ids.slice(i, i + 150));
      if (error) throw error;
      filas.push(...(data || []));
    }
    return filas;
  }

  // Ejecuciones (registros) de protocolos en [desde, hasta) por `fecha`, con
  // columnas explícitas. protocolosService solo lista por protocolo; este
  // método cubre las consultas por período. Filtros opcionales: protocolos y
  // creadores (alcance). Devuelve como máximo `limite` filas más el total real.
  async pruebasProtocolos({ desde, hasta, protocoloIds, creadores, limite = 500 } = {}) {
    let query = supabase
      .from('protocolo_pruebas')
      .select('id, protocolo_id, fecha, realizado_por, resultados, observaciones, resultado_texto, action_items, created_by', { count: 'exact' })
      .order('fecha', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limite);
    if (desde) query = query.gte('fecha', desde);
    if (hasta) query = query.lt('fecha', hasta);
    if (protocoloIds) query = query.in('protocolo_id', protocoloIds);
    if (creadores) query = query.in('created_by', creadores);
    const { data, error, count } = await query;
    if (error) throw error;
    return { filas: data || [], total: count ?? (data || []).length };
  }

  // Nombres de usuarios del sistema por id (para mostrar "creado por").
  async nombresUsuarios(ids) {
    const validos = [...new Set(ids.filter(Boolean))];
    if (!validos.length) return new Map();
    const { data, error } = await supabase.from('usuarios').select('id, nombre').in('id', validos);
    if (error) throw error;
    return new Map((data || []).map(u => [u.id, u.nombre]));
  }

  async contarContactos(filtros = {}) {
    return contar('contactos', q => {
      let query = q;
      if (filtros.tipo) query = query.eq('tipo', filtros.tipo);
      if (filtros.estado) query = query.eq('estado', filtros.estado);
      if (filtros.desde) query = query.gte('created_at', filtros.desde);
      if (filtros.hasta) query = query.lt('created_at', filtros.hasta);
      return query;
    });
  }
}

module.exports = new NexiDatos();
