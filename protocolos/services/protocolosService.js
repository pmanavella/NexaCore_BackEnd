const supabase = require('../../config/supabase');

const CATEGORIAS_VALIDAS = ['robot', 'instalacion', 'hardware', 'rrhh'];
const ESTADOS_VALIDOS = ['ok', 'fail', 'na'];

class ProtocolosService {

  // ── PROTOCOLOS ─────────────────────────────────────────────

  async listarProtocolos({ categoria, search } = {}) {
    let query = supabase
      .from('protocolos')
      .select('*')
      .eq('activo', true)
      .order('created_at', { ascending: false });

    if (categoria) query = query.eq('categoria', categoria);
    if (search) query = query.ilike('nombre', `%${search}%`);

    const { data, error } = await query;
    if (error) throw error;
    return { data: data ?? [], total: data?.length ?? 0 };
  }

  async obtenerProtocolo(id) {
    const { data: protocolo, error } = await supabase
      .from('protocolos')
      .select('*')
      .eq('id', id)
      .single();
    if (error) throw Object.assign(new Error('Protocolo no encontrado'), { status: 404 });

    const { data: items, error: itemsErr } = await supabase
      .from('protocolo_items')
      .select('*')
      .eq('protocolo_id', id)
      .eq('activo', true)
      .order('orden', { ascending: true });
    if (itemsErr) throw itemsErr;

    return { ...protocolo, items: items ?? [] };
  }

  async crearProtocolo(body, userId) {
    const { nombre, descripcion, categoria, acceso, items } = body;

    if (!nombre || !nombre.trim())
      throw Object.assign(new Error('El nombre del protocolo es obligatorio'), { status: 400 });
    if (!categoria || !CATEGORIAS_VALIDAS.includes(categoria))
      throw Object.assign(new Error(`Categoría inválida. Valores permitidos: ${CATEGORIAS_VALIDAS.join(', ')}`), { status: 400 });

    const { data: protocolo, error } = await supabase
      .from('protocolos')
      .insert([{
        nombre: nombre.trim(),
        descripcion: descripcion?.trim() || null,
        categoria,
        acceso: acceso?.trim() || null,
        activo: true,
        created_by: userId || null,
        updated_by: userId || null,
      }])
      .select()
      .single();
    if (error) throw error;

    if (Array.isArray(items) && items.length > 0) {
      await this._reemplazarItems(protocolo.id, items);
    }

    return this.obtenerProtocolo(protocolo.id);
  }

  async actualizarProtocolo(id, body, userId) {
    const { nombre, descripcion, categoria, acceso, activo } = body;

    if (categoria && !CATEGORIAS_VALIDAS.includes(categoria))
      throw Object.assign(new Error(`Categoría inválida. Valores permitidos: ${CATEGORIAS_VALIDAS.join(', ')}`), { status: 400 });

    const update = { updated_by: userId || null, updated_at: new Date().toISOString() };
    if (nombre !== undefined) {
      if (!nombre.trim())
        throw Object.assign(new Error('El nombre del protocolo es obligatorio'), { status: 400 });
      update.nombre = nombre.trim();
    }
    if (descripcion !== undefined) update.descripcion = descripcion?.trim() || null;
    if (categoria !== undefined) update.categoria = categoria;
    if (acceso !== undefined) update.acceso = acceso?.trim() || null;
    if (activo !== undefined) update.activo = activo;

    const { data, error } = await supabase
      .from('protocolos')
      .update(update)
      .eq('id', id)
      .select()
      .single();
    if (error) throw Object.assign(new Error('Protocolo no encontrado'), { status: 404 });

    return data;
  }

  async actualizarItems(id, body) {
    const { items } = body;
    if (!Array.isArray(items))
      throw Object.assign(new Error('Se esperaba un array "items"'), { status: 400 });

    const { data: protocolo } = await supabase
      .from('protocolos')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (!protocolo) throw Object.assign(new Error('Protocolo no encontrado'), { status: 404 });

    await this._reemplazarItems(id, items);

    const { data: nuevosItems, error } = await supabase
      .from('protocolo_items')
      .select('*')
      .eq('protocolo_id', id)
      .eq('activo', true)
      .order('orden', { ascending: true });
    if (error) throw error;

    return nuevosItems ?? [];
  }

  // ── PRUEBAS ────────────────────────────────────────────────

  async registrarPrueba(protocoloId, body, userId) {
    const { realizado_por, fecha, resultados, observaciones } = body;

    const { data: protocolo } = await supabase
      .from('protocolos')
      .select('id')
      .eq('id', protocoloId)
      .maybeSingle();
    if (!protocolo) throw Object.assign(new Error('Protocolo no encontrado'), { status: 404 });

    if (!Array.isArray(resultados) || resultados.length === 0)
      throw Object.assign(new Error('Se esperaba un array "resultados" con al menos un ítem'), { status: 400 });

    for (const r of resultados) {
      if (!r.item_id || !r.estado)
        throw Object.assign(new Error('Cada resultado requiere item_id y estado'), { status: 400 });
      if (!ESTADOS_VALIDOS.includes(r.estado))
        throw Object.assign(new Error(`Estado inválido: ${r.estado}. Valores permitidos: ${ESTADOS_VALIDOS.join(', ')}`), { status: 400 });
    }

    const { data, error } = await supabase
      .from('protocolo_pruebas')
      .insert([{
        protocolo_id: protocoloId,
        realizado_por: realizado_por?.trim() || null,
        fecha: fecha || new Date().toISOString().split('T')[0],
        resultados,
        observaciones: observaciones?.trim() || null,
        created_by: userId || null,
      }])
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async listarPruebas(protocoloId) {
    const { data: protocolo } = await supabase
      .from('protocolos')
      .select('id')
      .eq('id', protocoloId)
      .maybeSingle();
    if (!protocolo) throw Object.assign(new Error('Protocolo no encontrado'), { status: 404 });

    const { data, error } = await supabase
      .from('protocolo_pruebas')
      .select('*')
      .eq('protocolo_id', protocoloId)
      .order('fecha', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data ?? [];
  }

  async obtenerPrueba(pruebaId) {
    const { data, error } = await supabase
      .from('protocolo_pruebas')
      .select('*, protocolos(id, nombre, categoria)')
      .eq('id', pruebaId)
      .single();
    if (error) throw Object.assign(new Error('Prueba no encontrada'), { status: 404 });
    return data;
  }

  // ── MÉTRICAS ───────────────────────────────────────────────

  async obtenerMetricas() {
    const [protocolosRes, pruebasRes] = await Promise.all([
      supabase.from('protocolos').select('id', { count: 'exact', head: true }).eq('activo', true),
      supabase.from('protocolo_pruebas').select('resultados'),
    ]);

    if (protocolosRes.error) throw protocolosRes.error;
    if (pruebasRes.error) throw pruebasRes.error;

    const pruebas = pruebasRes.data ?? [];
    let conIncumplimientos = 0;
    let sinIncumplimientos = 0;

    for (const p of pruebas) {
      const tieneFail = Array.isArray(p.resultados) && p.resultados.some(r => r.estado === 'fail');
      if (tieneFail) conIncumplimientos++;
      else sinIncumplimientos++;
    }

    return {
      totalProtocolosActivos: protocolosRes.count ?? 0,
      totalPruebas: pruebas.length,
      pruebasSinIncumplimientos: sinIncumplimientos,
      pruebasConIncumplimientos: conIncumplimientos,
    };
  }

  // ── HELPERS PRIVADOS ───────────────────────────────────────

  async _reemplazarItems(protocoloId, items) {
    for (const item of items) {
      if (!item.texto || !item.texto.trim())
        throw Object.assign(new Error('Cada ítem requiere un texto'), { status: 400 });
    }

    await supabase.from('protocolo_items').delete().eq('protocolo_id', protocoloId);

    const rows = items.map((item, idx) => ({
      protocolo_id: protocoloId,
      texto: item.texto.trim(),
      orden: item.orden ?? idx,
      activo: item.activo ?? true,
    }));

    const { error } = await supabase.from('protocolo_items').insert(rows);
    if (error) throw error;
  }
}

module.exports = new ProtocolosService();
