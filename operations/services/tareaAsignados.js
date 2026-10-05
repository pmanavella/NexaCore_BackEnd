const supabase = require('../../config/supabase');

// Asignación múltiple de tareas (public.tarea_asignados, migración
// 2026-10-05_tareas_multiples_asignados). Único lugar del backend que sabe cómo
// se relaciona una tarea con sus personas: lo usan operationsService y Nexi.
//
// Compatibilidad: tareas.asignado_a (text) se conserva. La función SQL de
// sincronización lo mantiene con los nombres de los asignados separados por
// ", " (un solo nombre si hay un asignado, NULL si no hay ninguno), así que los
// consumidores que solo leen ese texto siguen funcionando.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Embed para select(): trae los asignados de cada tarea en el mismo query.
const SELECT_ASIGNADOS = 'tarea_asignados(orden, usuarios(id, nombre, email, estado))';

function error400(mensaje) {
  return Object.assign(new Error(mensaje), { status: 400 });
}

// Reemplaza el embed crudo `tarea_asignados` por `asignados: [{ id, nombre, email, estado }]`
// en el orden en que fueron enviados.
function conAsignados(tarea) {
  if (!tarea) return tarea;
  const { tarea_asignados, ...resto } = tarea;
  const asignados = (tarea_asignados ?? [])
    .filter(a => a.usuarios)
    .sort((a, b) => a.orden - b.orden)
    .map(a => ({ ...a.usuarios }));
  return { ...resto, asignados };
}

// Valida la lista final de asignados. `actuales` son los usuario_id ya asignados
// a la tarea (en una edición): pueden mantenerse aunque el usuario esté inactivo,
// pero solo se pueden agregar usuarios activos.
async function validarAsignados(asignados, actuales = []) {
  if (!Array.isArray(asignados)) throw error400('"asignados" debe ser un array de ids de usuario.');

  const invalidos = asignados.filter(id => typeof id !== 'string' || !UUID.test(id));
  if (invalidos.length) throw error400(`"asignados" contiene ids inválidos: ${invalidos.map(String).join(', ')}`);

  const repetidos = [...new Set(asignados.filter((id, i) => asignados.indexOf(id) !== i))];
  if (repetidos.length) throw error400(`La misma persona no puede asignarse dos veces a una tarea (repetido: ${repetidos.join(', ')}).`);

  if (asignados.length === 0) return [];

  const { data: usuarios, error } = await supabase
    .from('usuarios')
    .select('id, estado')
    .in('id', asignados);
  if (error) throw error;

  const encontrados = new Map((usuarios ?? []).map(u => [u.id, u]));
  const inexistentes = asignados.filter(id => !encontrados.has(id));
  if (inexistentes.length) throw error400(`No existen usuarios con id: ${inexistentes.join(', ')}`);

  const inactivosNuevos = asignados.filter(id => encontrados.get(id).estado !== 'Activo' && !actuales.includes(id));
  if (inactivosNuevos.length) throw error400(`No se puede asignar usuarios inactivos: ${inactivosNuevos.join(', ')}`);

  return asignados;
}

// Deja la tarea con exactamente esta lista de asignados (alta, baja y reemplazo)
// y recalcula tareas.asignado_a, todo en una única transacción SQL.
async function sincronizar(tareaId, usuarioIds) {
  const { error } = await supabase.rpc('tarea_sincronizar_asignados', {
    p_tarea_id: tareaId,
    p_usuario_ids: usuarioIds,
  });
  if (error) {
    if (error.code === '23505') throw Object.assign(new Error('La misma persona no puede asignarse dos veces a una tarea.'), { status: 409 });
    throw error;
  }
}

async function usuarioIdsDeTarea(tareaId) {
  const { data, error } = await supabase
    .from('tarea_asignados')
    .select('usuario_id')
    .eq('tarea_id', tareaId)
    .order('orden', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(a => a.usuario_id);
}

// Ids de tareas de una persona. Por usuario (usuarioIds) usa la relación; por
// nombre (filtro legacy ?asignado_a=Nombre) resuelve los usuarios con ese nombre
// y suma las tareas históricas cuyo texto asignado_a coincide pero que no
// pudieron vincularse a ningún usuario. Devuelve tareas compartidas también.
async function idsTareasDePersona({ usuarioIds = [], nombre } = {}) {
  let ids = [...usuarioIds];
  if (nombre) {
    const { data: porNombre, error } = await supabase.from('usuarios').select('id').eq('nombre', nombre);
    if (error) throw error;
    ids = ids.concat((porNombre ?? []).map(u => u.id));
  }

  const tareaIds = new Set();
  if (ids.length) {
    const { data, error } = await supabase.from('tarea_asignados').select('tarea_id').in('usuario_id', ids);
    if (error) throw error;
    for (const a of data ?? []) tareaIds.add(a.tarea_id);
  }

  if (nombre) {
    const { data: legacy, error } = await supabase.from('tareas').select('id').eq('asignado_a', nombre);
    if (error) throw error;
    const candidatas = (legacy ?? []).map(t => t.id).filter(id => !tareaIds.has(id));
    if (candidatas.length) {
      // Si la tarea ya tiene asignados en la relación, esa es la fuente de verdad.
      const { data: vinculadas, error: errV } = await supabase
        .from('tarea_asignados').select('tarea_id').in('tarea_id', candidatas);
      if (errV) throw errV;
      const conRelacion = new Set((vinculadas ?? []).map(v => v.tarea_id));
      for (const id of candidatas) if (!conRelacion.has(id)) tareaIds.add(id);
    }
  }

  return [...tareaIds];
}

// Compatibilidad con clientes que todavía envían `asignado_a` (nombre) en vez de
// `asignados`. Si el nombre identifica a un único usuario se trata como
// asignados: [id]; si no, se conserva como texto libre sin vínculo (comportamiento previo).
async function resolverAsignadoLegacy(asignado_a) {
  const nombre = typeof asignado_a === 'string' ? asignado_a.trim() : '';
  if (!nombre) return { ids: [], texto: null };
  const { data, error } = await supabase.from('usuarios').select('id').eq('nombre', nombre);
  if (error) throw error;
  if (data?.length === 1) return { ids: [data[0].id], texto: null };
  return { ids: [], texto: nombre };
}

module.exports = {
  SELECT_ASIGNADOS,
  conAsignados,
  validarAsignados,
  sincronizar,
  usuarioIdsDeTarea,
  idsTareasDePersona,
  resolverAsignadoLegacy,
};
