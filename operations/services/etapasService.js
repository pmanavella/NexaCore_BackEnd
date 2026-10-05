const supabase = require('../../config/supabase');
const { TIPOS_BASE } = require('../config/etapas');

const COLOR_HEX = /^#[0-9A-Fa-f]{6}$/;

function validarNombre(nombre) {
  if (!nombre || !String(nombre).trim()) {
    throw Object.assign(new Error('El nombre de la etapa es obligatorio'), { status: 400 });
  }
}
function validarColor(color) {
  if (!color || !COLOR_HEX.test(color)) {
    throw Object.assign(new Error('El color debe tener formato hexadecimal, ej: #3B82F6'), { status: 400 });
  }
}
function validarTipoBase(tipo_base) {
  if (!TIPOS_BASE.includes(tipo_base)) {
    throw Object.assign(
      new Error(`tipo_base inválido. Debe ser uno de: ${TIPOS_BASE.join(', ')}`),
      { status: 400 }
    );
  }
}

class EtapasService {

  async listarEtapas() {
    const { data, error } = await supabase
      .from('operativo_etapas')
      .select('*')
      .order('posicion', { ascending: true });
    if (error) throw error;
    return { data };
  }

  // La etapa nueva se agrega siempre al final del orden actual.
  // Para cambiar su posición se usa PATCH /etapas/:id con { posicion }.
  async crearEtapa({ nombre, color, tipo_base }) {
    validarNombre(nombre);
    validarColor(color);
    validarTipoBase(tipo_base);

    const { data: existentes, error: errLectura } = await supabase
      .from('operativo_etapas')
      .select('posicion')
      .order('posicion', { ascending: false })
      .limit(1);
    if (errLectura) throw errLectura;

    const siguientePosicion = existentes.length > 0 ? existentes[0].posicion + 1 : 0;

    const { data, error } = await supabase
      .from('operativo_etapas')
      .insert([{ nombre: nombre.trim(), color, tipo_base, posicion: siguientePosicion }])
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // Actualiza nombre/color/tipo_base y, si viene `posicion`, reordena el resto
  // de las etapas para que la lista quede contigua (0..n-1) sin duplicados.
  async actualizarEtapa(id, { nombre, color, tipo_base, posicion }) {
    if (nombre !== undefined) validarNombre(nombre);
    if (color !== undefined) validarColor(color);
    if (tipo_base !== undefined) validarTipoBase(tipo_base);

    if (posicion !== undefined) {
      await this._reordenar(id, posicion);
    }

    const camposSimples = {};
    if (nombre !== undefined) camposSimples.nombre = nombre.trim();
    if (color !== undefined) camposSimples.color = color;
    if (tipo_base !== undefined) camposSimples.tipo_base = tipo_base;

    if (Object.keys(camposSimples).length === 0 && posicion === undefined) {
      throw Object.assign(new Error('No se envió ningún campo para actualizar'), { status: 400 });
    }

    if (Object.keys(camposSimples).length === 0) {
      // Solo se pidió reordenar: devolver el estado ya actualizado por _reordenar.
      const { data, error } = await supabase.from('operativo_etapas').select('*').eq('id', id).single();
      if (error) throw error;
      return data;
    }

    const { data, error } = await supabase
      .from('operativo_etapas')
      .update(camposSimples)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // Recalcula `posicion` de todas las etapas moviendo `id` a `nuevaPosicion`.
  // Estrategia simple: traer todas ordenadas, sacar la etapa movida, reinsertarla
  // en el índice pedido (clampeado al rango válido) y reescribir 0..n-1.
  async _reordenar(id, nuevaPosicion) {
    const { data: etapas, error } = await supabase
      .from('operativo_etapas')
      .select('id')
      .order('posicion', { ascending: true });
    if (error) throw error;

    const idx = etapas.findIndex(e => e.id === id);
    if (idx === -1) {
      throw Object.assign(new Error('Etapa no encontrada'), { status: 404 });
    }

    const [movida] = etapas.splice(idx, 1);
    const destino = Math.max(0, Math.min(Number(posicionSegura(nuevaPosicion)), etapas.length));
    etapas.splice(destino, 0, movida);

    await Promise.all(
      etapas.map((e, i) =>
        supabase.from('operativo_etapas').update({ posicion: i }).eq('id', e.id)
      )
    );
  }

  // No se puede borrar una etapa con tareas asignadas.
  async eliminarEtapa(id) {
    const { count, error: errConteo } = await supabase
      .from('tareas')
      .select('id', { count: 'exact', head: true })
      .eq('etapa_id', id);
    if (errConteo) throw errConteo;

    if (count > 0) {
      throw Object.assign(
        new Error(`No se puede eliminar la etapa: tiene ${count} tarea(s) asignada(s). Mové esas tareas a otra etapa antes de eliminarla.`),
        { status: 409 }
      );
    }

    const { error } = await supabase.from('operativo_etapas').delete().eq('id', id);
    if (error) throw error;

    // Recompactar posiciones para no dejar huecos en el orden.
    const { data: restantes, error: errRestantes } = await supabase
      .from('operativo_etapas')
      .select('id')
      .order('posicion', { ascending: true });
    if (errRestantes) throw errRestantes;

    await Promise.all(
      restantes.map((e, i) =>
        supabase.from('operativo_etapas').update({ posicion: i }).eq('id', e.id)
      )
    );

    return { message: 'Etapa eliminada correctamente' };
  }
}

function posicionSegura(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw Object.assign(new Error('posicion debe ser un entero mayor o igual a 0'), { status: 400 });
  }
  return n;
}

module.exports = new EtapasService();
