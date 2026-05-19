const supabase = require('../../config/supabase');

const ESTADOS_VALIDOS = ['Pendiente', 'Pagada', 'Vencida'];

class DeudasService {
  async listar({ estado, search } = {}) {
    let query = supabase
      .from('deudas')
      .select('*')
      .order('vencimiento', { ascending: true });

    if (estado && estado !== 'Todos') query = query.eq('estado', estado);
    if (search) query = query.ilike('acreedor', `%${search}%`);

    const { data, error } = await query;
    if (error) throw error;
    return { data, total: data.length };
  }

  async getMetricas() {
    const { data, error } = await supabase.from('deudas').select('monto, estado, vencimiento');
    if (error) throw error;

    const hoy = new Date().toISOString().split('T')[0];
    const pendientes = data.filter(d => d.estado !== 'Pagada');
    const vencidas   = data.filter(d => d.estado !== 'Pagada' && d.vencimiento < hoy);
    const totalPendiente = pendientes.reduce((s, d) => s + Number(d.monto), 0);
    const totalVencido   = vencidas.reduce((s, d) => s + Number(d.monto), 0);

    return { totalPendiente, totalVencido, cantPendientes: pendientes.length, cantVencidas: vencidas.length };
  }

  async obtenerPorId(id) {
    const { data, error } = await supabase.from('deudas').select('*').eq('id', id).single();
    if (error) throw error;
    if (!data) throw Object.assign(new Error('No encontrado'), { status: 404 });
    return data;
  }

  _validar({ acreedor, monto, vencimiento, estado }) {
    if (!String(acreedor || '').trim() || !monto || !vencimiento)
      throw Object.assign(new Error('Faltan campos obligatorios: acreedor, monto, vencimiento'), { status: 400 });
    if (Number(monto) <= 0)
      throw Object.assign(new Error('El monto debe ser mayor a 0'), { status: 400 });
    if (estado && !ESTADOS_VALIDOS.includes(estado))
      throw Object.assign(new Error(`Estado inválido. Opciones: ${ESTADOS_VALIDOS.join(', ')}`), { status: 400 });
  }

  async crear(body, email = null) {
    const { acreedor, descripcion, monto, vencimiento, estado, notas } = body;
    this._validar({ acreedor, monto, vencimiento, estado });

    const { data, error } = await supabase
      .from('deudas')
      .insert([{
        acreedor: String(acreedor).trim(),
        descripcion: descripcion ? String(descripcion).trim() : null,
        monto: Number(monto),
        vencimiento,
        estado: estado || 'Pendiente',
        notas: notas ? String(notas).trim() : null,
        created_by: email,
      }])
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async actualizar(id, body, email = null) {
    const { acreedor, descripcion, monto, vencimiento, estado, notas } = body;
    this._validar({ acreedor, monto, vencimiento, estado });

    const { data, error } = await supabase
      .from('deudas')
      .update({
        acreedor: String(acreedor).trim(),
        descripcion: descripcion ? String(descripcion).trim() : null,
        monto: Number(monto),
        vencimiento,
        estado: estado || 'Pendiente',
        notas: notas ? String(notas).trim() : null,
        updated_by: email,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async eliminar(id) {
    const { error } = await supabase.from('deudas').delete().eq('id', id);
    if (error) throw error;
    return { message: 'Deuda eliminada correctamente' };
  }
}

module.exports = new DeudasService();
