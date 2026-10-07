const supabase = require('../../config/supabase');

const CATEGORIAS_VALIDAS = ['robot', 'instalacion', 'hardware', 'rrhh'];
const ESTADOS_VALIDOS = ['ok', 'fail', 'na'];
// invalid_text_representation: un id que no es UUID no puede existir → 404.
const UUID_INVALIDO = '22P02';

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

  // Protocolo + checklist en una sola transacción (RPC protocolo_crear_con_items,
  // migración 2026-10-07): si falla un ítem no queda un protocolo sin checklist.
  async crearProtocolo(body, userId) {
    const { nombre, descripcion, categoria, acceso, items } = body;

    if (!nombre || !nombre.trim())
      throw Object.assign(new Error('El nombre del protocolo es obligatorio'), { status: 400 });
    if (!categoria || !CATEGORIAS_VALIDAS.includes(categoria))
      throw Object.assign(new Error(`Categoría inválida. Valores permitidos: ${CATEGORIAS_VALIDAS.join(', ')}`), { status: 400 });
    if (items !== undefined && !Array.isArray(items))
      throw Object.assign(new Error('Se esperaba un array "items"'), { status: 400 });

    const filas = this._normalizarItems(items ?? []);

    const { data: protocoloId, error } = await supabase.rpc('protocolo_crear_con_items', {
      p_nombre: nombre.trim(),
      p_descripcion: descripcion?.trim() || null,
      p_categoria: categoria,
      p_acceso: acceso?.trim() || null,
      p_usuario: userId || null,
      p_items: filas,
    });
    if (error) throw error;

    return this.obtenerProtocolo(protocoloId);
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

  // Eliminación definitiva del protocolo completo. protocolo_items y
  // protocolo_pruebas tienen FK ON DELETE CASCADE hacia protocolos (definidas
  // al crear el módulo), así que un único DELETE borra todo de forma atómica.
  // Para ocultarlo de forma reversible existe `activo: false` vía PUT.
  async eliminarProtocolo(id) {
    const { data: protocolo } = await supabase
      .from('protocolos')
      .select('id, nombre')
      .eq('id', id)
      .maybeSingle();
    if (!protocolo) throw Object.assign(new Error('Protocolo no encontrado'), { status: 404 });

    const { count: registros, error: countErr } = await supabase
      .from('protocolo_pruebas')
      .select('id', { count: 'exact', head: true })
      .eq('protocolo_id', id);
    if (countErr) throw countErr;

    const { error } = await supabase.from('protocolos').delete().eq('id', id);
    if (error) {
      if (error.code === '23503')
        throw Object.assign(new Error('No se puede eliminar el protocolo porque tiene registros asociados.'), { status: 409 });
      throw error;
    }

    return {
      message: 'Protocolo eliminado correctamente',
      id: protocolo.id,
      nombre: protocolo.nombre,
      registrosEliminados: registros ?? 0,
    };
  }

  // ── PRUEBAS ────────────────────────────────────────────────

  // Cada resultado lleva el `estado` del ítem (ok/fail/na) y, opcionalmente,
  // `tildado` (boolean): si el ítem se marcó en el checklist de la prueba.
  // Se guarda siempre como boolean (false si no viene). Las pruebas registradas
  // antes de existir el tilde no tienen este campo.
  // `action_items` es opcional (lista vacía si no viene) y pertenece solo a
  // este registro.
  async registrarPrueba(protocoloId, body, user) {
    const { fecha, resultados, observaciones, resultado_texto, action_items } = body;

    const { data: protocolo } = await supabase
      .from('protocolos')
      .select('id')
      .eq('id', protocoloId)
      .maybeSingle();
    if (!protocolo) throw Object.assign(new Error('Protocolo no encontrado'), { status: 404 });

    const resultadosConTilde = this._validarResultados(resultados);
    const obs = this._validarTexto800(observaciones, 'observaciones');
    const resTexto = this._validarTexto800(resultado_texto, 'resultado_texto');
    const actionItems = this._normalizarActionItems(action_items ?? []);

    const realizado_por = user?.name || user?.email || 'Usuario no identificado';

    const { data, error } = await supabase
      .from('protocolo_pruebas')
      .insert([{
        protocolo_id: protocoloId,
        realizado_por,
        fecha: fecha || new Date().toISOString().split('T')[0],
        resultados: resultadosConTilde,
        observaciones: obs,
        resultado_texto: resTexto,
        action_items: actionItems,
        created_by: user?.id || null,
      }])
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // Edición parcial: solo se modifican los campos enviados. `resultados` y
  // `action_items`, si vienen, reemplazan la lista completa. El filtro por
  // protocolo_id garantiza que el registro pertenezca al protocolo de la URL.
  async actualizarPrueba(protocoloId, pruebaId, body) {
    const { fecha, resultados, observaciones, resultado_texto, action_items } = body;

    const update = {};
    if (fecha !== undefined) {
      if (!fecha)
        throw Object.assign(new Error('La fecha del registro es obligatoria'), { status: 400 });
      update.fecha = fecha;
    }
    if (resultados !== undefined) update.resultados = this._validarResultados(resultados);
    if (observaciones !== undefined) update.observaciones = this._validarTexto800(observaciones, 'observaciones');
    if (resultado_texto !== undefined) update.resultado_texto = this._validarTexto800(resultado_texto, 'resultado_texto');
    if (action_items !== undefined) update.action_items = this._normalizarActionItems(action_items);

    if (Object.keys(update).length === 0)
      throw Object.assign(new Error('No se enviaron campos para actualizar'), { status: 400 });

    const { data, error } = await supabase
      .from('protocolo_pruebas')
      .update(update)
      .eq('id', pruebaId)
      .eq('protocolo_id', protocoloId)
      .select()
      .maybeSingle();
    if (error && error.code !== UUID_INVALIDO) throw error;
    if (!data) throw Object.assign(new Error('Registro no encontrado en este protocolo'), { status: 404 });
    return data;
  }

  // Borra solo el registro (sus resultados y action_items viven en la misma
  // fila; ninguna otra tabla referencia protocolo_pruebas). El protocolo y su
  // checklist no se tocan.
  async eliminarPrueba(protocoloId, pruebaId) {
    const { data, error } = await supabase
      .from('protocolo_pruebas')
      .delete()
      .eq('id', pruebaId)
      .eq('protocolo_id', protocoloId)
      .select('id')
      .maybeSingle();
    if (error && error.code !== UUID_INVALIDO) throw error;
    if (!data) throw Object.assign(new Error('Registro no encontrado en este protocolo'), { status: 404 });
    return { message: 'Registro eliminado correctamente', id: data.id };
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
    if (error) throw Object.assign(new Error('Registro no encontrado'), { status: 404 });
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

  // Ítems del checklist estático: cada uno puede venir como string ("Calibrar
  // sensores") o como objeto ({ texto, orden?, activo? }). Valida todo antes de
  // escribir y devuelve las filas listas para protocolo_items (sin protocolo_id).
  _normalizarItems(items) {
    return items.map((item, idx) => {
      const texto = typeof item === 'string' ? item : item?.texto;
      if (typeof texto !== 'string' || !texto.trim())
        throw Object.assign(new Error('Cada ítem requiere un texto'), { status: 400 });
      return {
        texto: texto.trim(),
        orden: item?.orden ?? idx,
        activo: item?.activo ?? true,
      };
    });
  }

  async _reemplazarItems(protocoloId, items) {
    const filas = this._normalizarItems(items);

    await supabase.from('protocolo_items').delete().eq('protocolo_id', protocoloId);

    if (filas.length === 0) return;

    const rows = filas.map(f => ({ protocolo_id: protocoloId, ...f }));

    const { error } = await supabase.from('protocolo_items').insert(rows);
    if (error) throw error;
  }

  // Cada resultado lleva item_id y estado (ok/fail/na); `tildado` es opcional
  // y se guarda siempre como boolean.
  _validarResultados(resultados) {
    if (!Array.isArray(resultados) || resultados.length === 0)
      throw Object.assign(new Error('Se esperaba un array "resultados" con al menos un ítem'), { status: 400 });

    for (const r of resultados) {
      if (!r.item_id || !r.estado)
        throw Object.assign(new Error('Cada resultado requiere item_id y estado'), { status: 400 });
      if (!ESTADOS_VALIDOS.includes(r.estado))
        throw Object.assign(new Error(`Estado inválido: ${r.estado}. Valores permitidos: ${ESTADOS_VALIDOS.join(', ')}`), { status: 400 });
      if (r.tildado !== undefined && typeof r.tildado !== 'boolean')
        throw Object.assign(new Error('"tildado" debe ser true o false'), { status: 400 });
    }
    return resultados.map(r => ({ ...r, tildado: r.tildado === true }));
  }

  _validarTexto800(valor, campo) {
    const texto = valor?.trim() || null;
    if (texto && texto.length > 800)
      throw Object.assign(new Error(`El campo ${campo} no puede superar los 800 caracteres`), { status: 400 });
    return texto;
  }

  // Action items del registro: array de objetos { texto }. Solo se persiste
  // `texto`; el formato objeto deja lugar para sumar campos más adelante.
  _normalizarActionItems(actionItems) {
    if (!Array.isArray(actionItems))
      throw Object.assign(new Error('Se esperaba un array "action_items"'), { status: 400 });

    return actionItems.map(ai => {
      const texto = ai?.texto;
      if (typeof texto !== 'string' || !texto.trim())
        throw Object.assign(new Error('Cada action item requiere un texto'), { status: 400 });
      if (texto.trim().length > 800)
        throw Object.assign(new Error('El texto de un action item no puede superar los 800 caracteres'), { status: 400 });
      return { texto: texto.trim() };
    });
  }
}

module.exports = new ProtocolosService();
