const supabase = require('../../config/supabase');
const { resolverPeriodo, rangoMes } = require('../../utils/periodo');

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

  // mes/anio son opcionales: si no llegan, se mantiene el comportamiento histórico
  // (métricas sobre todos los contactos, sin filtrar por fecha).
  async getMetricas({ mes, anio } = {}) {
    let query = supabase.from('contactos').select('tipo, estado');

    const periodoProvisto = (mes ?? '') !== '' || (anio ?? '') !== '';
    if (periodoProvisto) {
      const { mes: targetMes, anio: targetAnio } = resolverPeriodo(mes, anio);
      const { desde, hasta } = rangoMes(targetMes, targetAnio);
      // contactos.created_at es timestamptz: se ancla explícitamente a UTC para no depender
      // de la zona horaria de la sesión.
      query = query.gte('created_at', `${desde}T00:00:00.000Z`).lt('created_at', `${hasta}T00:00:00.000Z`);
    }

    const { data, error } = await query;
    if (error) throw error;
    const total = data.length;
    const clientes = data.filter(c => c.tipo === 'Cliente').length;
    const prospectos = data.filter(c => c.tipo === 'Prospecto').length;
    const proveedores = data.filter(c => c.tipo === 'Proveedor').length;
    return { total, clientes, prospectos, proveedores };
  }
}

module.exports = new CrmService();
