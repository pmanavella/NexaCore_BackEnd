const supabase = require('../../config/supabase');

class CrmService {
  async listarContactos({ tipo, estado, search } = {}) {
    let query = supabase
      .from('contactos')
      .select('*')
      .order('created_at', { ascending: false });

    if (tipo && tipo !== 'Todos') query = query.eq('tipo', tipo);
    if (estado && estado !== 'Todos') query = query.eq('estado', estado);
    if (search) query = query.ilike('nombre', `%${search}%`);

    const { data, error } = await query;
    if (error) throw error;
    return { data, total: data.length };
  }

  async crearContacto(body) {
    const { nombre, empresa, email, telefono, tipo, estado, notas } = body;
    if (!nombre) throw Object.assign(new Error('El nombre es obligatorio'), { status: 400 });

    const { data, error } = await supabase
      .from('contactos')
      .insert([{ nombre, empresa, email, telefono, tipo: tipo || 'Cliente', estado: estado || 'Activo', notas }])
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async actualizarContacto(id, body) {
    const { data, error } = await supabase
      .from('contactos')
      .update(body)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async eliminarContacto(id) {
    const { error } = await supabase.from('contactos').delete().eq('id', id);
    if (error) throw error;
    return { message: 'Contacto eliminado correctamente' };
  }

  async getMetricas() {
    const { data, error } = await supabase.from('contactos').select('tipo, estado');
    if (error) throw error;
    const total = data.length;
    const clientes = data.filter(c => c.tipo === 'Cliente').length;
    const prospectos = data.filter(c => c.tipo === 'Prospecto').length;
    const proveedores = data.filter(c => c.tipo === 'Proveedor').length;
    return { total, clientes, prospectos, proveedores };
  }
}

module.exports = new CrmService();
