const supabase = require('../../config/supabase');

class PlanificationService {
  async listarProyectos({ estado, search } = {}) {
    let query = supabase
      .from('proyectos')
      .select('*')
      .order('created_at', { ascending: false });

    if (estado && estado !== 'Todos') query = query.eq('estado', estado);
    if (search) query = query.ilike('nombre', `%${search}%`);

    const { data, error } = await query;
    if (error) throw error;
    return { data, total: data.length };
  }

  async crearProyecto(body) {
    const { nombre, descripcion, estado, fecha_inicio, fecha_fin, responsable, presupuesto } = body;
    if (!nombre) throw Object.assign(new Error('El nombre del proyecto es obligatorio'), { status: 400 });

    const { data, error } = await supabase
      .from('proyectos')
      .insert([{ nombre, descripcion, estado: estado || 'Planificado', fecha_inicio, fecha_fin, responsable, presupuesto: presupuesto ? Number(presupuesto) : null }])
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async actualizarProyecto(id, body) {
    const { data, error } = await supabase
      .from('proyectos')
      .update(body)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async eliminarProyecto(id) {
    const { error } = await supabase.from('proyectos').delete().eq('id', id);
    if (error) throw error;
    return { message: 'Proyecto eliminado correctamente' };
  }

  async getMetricas() {
    const { data, error } = await supabase.from('proyectos').select('estado, presupuesto');
    if (error) throw error;
    const total = data.length;
    const activos = data.filter(p => p.estado === 'En Curso').length;
    const completados = data.filter(p => p.estado === 'Completado').length;
    const presupuestoTotal = data.reduce((acc, p) => acc + (Number(p.presupuesto) || 0), 0);
    return { total, activos, completados, presupuestoTotal };
  }
}

module.exports = new PlanificationService();
