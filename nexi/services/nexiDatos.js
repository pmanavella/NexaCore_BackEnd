const supabase = require('../../config/supabase');

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
  // tareas.asignado_a guarda el nombre del usuario: solo es un identificador
  // seguro si es único.
  async contarUsuariosConNombre(nombre) {
    return contar('usuarios', q => q.eq('nombre', nombre));
  }

  async tareasAbiertasAsignadasA(nombre, limite) {
    const { data, error, count } = await supabase
      .from('tareas')
      .select('titulo, estado, prioridad, fecha_limite', { count: 'exact' })
      .or('tipo.is.null,tipo.eq.asignacion')
      .eq('asignado_a', nombre)
      .in('estado', ['Pendiente', 'En Proceso'])
      .order('fecha_limite', { ascending: true, nullsFirst: false })
      .limit(limite);
    if (error) throw error;
    return { filas: data || [], total: count || 0 };
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
