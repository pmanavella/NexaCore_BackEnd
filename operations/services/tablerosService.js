const supabase = require('../../config/supabase');
const { NIVELES_JERARQUICOS } = require('../../rbac/config/jerarquia');

// Tableros de tareas del Operativo (public.operativo_tableros, migración
// 2026-10-19_tableros_operativo). Único lugar del backend que decide quién ve
// un tablero: sus miembros (operativo_tablero_miembros) y, siempre, el mando
// alto (Dirección y Superadmin, nivel jerárquico HIGH). Todos los tableros
// comparten las mismas etapas (operativo_etapas).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOMBRE_LENGTH = 100;
const COLUMNAS = 'id, nombre, descripcion, created_by, created_at, updated_at';
const SELECT_MIEMBROS = 'operativo_tablero_miembros(usuarios(id, nombre, email, estado))';

function error(status, mensaje) {
  return Object.assign(new Error(mensaje), { status });
}

function esMandoAlto(user) {
  return user?.hierarchyLevel === NIVELES_JERARQUICOS.HIGH;
}

function validarNombre(nombre) {
  const limpio = typeof nombre === 'string' ? nombre.trim() : '';
  if (!limpio) throw error(400, 'El nombre del tablero es obligatorio.');
  if (limpio.length > MAX_NOMBRE_LENGTH) throw error(400, `El nombre del tablero no puede superar los ${MAX_NOMBRE_LENGTH} caracteres.`);
  return limpio;
}

function normalizarDescripcion(descripcion) {
  if (descripcion == null) return null;
  if (typeof descripcion !== 'string') throw error(400, '"descripcion" debe ser texto.');
  return descripcion.trim() || null;
}

// Violación del índice único de nombre (uq_operativo_tableros_nombre) -> 409.
function traducirError(err, nombre) {
  if (err?.code === '23505') return error(409, `Ya existe un tablero llamado "${nombre}".`);
  return err;
}

// Reemplaza el embed crudo por `miembros: [{ id, nombre, email, estado }]`
// ordenados por nombre.
function conMiembros(tablero) {
  const { operativo_tablero_miembros, ...resto } = tablero;
  const miembros = (operativo_tablero_miembros ?? [])
    .map(m => m.usuarios)
    .filter(Boolean)
    .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
  return { ...resto, miembros };
}

class TablerosService {

  // ── Acceso ─────────────────────────────────────────────────────────────────

  esMandoAlto(user) {
    return esMandoAlto(user);
  }

  // Ids de los tableros que ve el usuario, o null si ve todos (mando alto).
  async idsVisibles(user) {
    if (esMandoAlto(user)) return null;
    if (!user?.id) return [];
    const { data, error: err } = await supabase
      .from('operativo_tablero_miembros')
      .select('tablero_id')
      .eq('usuario_id', user.id);
    if (err) throw err;
    return (data ?? []).map(m => m.tablero_id);
  }

  // Verifica que el tablero exista y que el usuario pueda verlo. Devuelve el
  // tablero. 400 si falta o es inválido, 404 si no existe, 403 si no lo ve.
  async asegurarAcceso(tableroId, user) {
    if (!tableroId) throw error(400, '"tablero_id" es obligatorio.');
    if (typeof tableroId !== 'string' || !UUID.test(tableroId)) throw error(400, '"tablero_id" inválido.');

    const { data: tablero, error: err } = await supabase
      .from('operativo_tableros')
      .select('id, nombre')
      .eq('id', tableroId)
      .maybeSingle();
    if (err) throw err;
    if (!tablero) throw error(404, 'Tablero no encontrado.');

    if (!esMandoAlto(user)) {
      const visibles = await this.idsVisibles(user);
      if (!visibles.includes(tableroId)) throw error(403, 'No tenés acceso a este tablero.');
    }
    return tablero;
  }

  async idsMiembros(tableroId) {
    const { data, error: err } = await supabase
      .from('operativo_tablero_miembros')
      .select('usuario_id')
      .eq('tablero_id', tableroId);
    if (err) throw err;
    return (data ?? []).map(m => m.usuario_id);
  }

  // ── Listado ────────────────────────────────────────────────────────────────

  // Tableros visibles para el usuario, con sus miembros y la cantidad de tareas
  // del tablero (sin contar propuestas, igual que el tablero de tareas).
  async listarTableros(user) {
    const visibles = await this.idsVisibles(user);
    if (visibles && visibles.length === 0) return { data: [], total: 0 };

    let query = supabase
      .from('operativo_tableros')
      .select(`${COLUMNAS}, ${SELECT_MIEMBROS}`)
      .order('nombre', { ascending: true });
    if (visibles) query = query.in('id', visibles);

    const { data: tableros, error: err } = await query;
    if (err) throw err;
    if (!tableros?.length) return { data: [], total: 0 };

    const { data: tareas, error: errTareas } = await supabase
      .from('tareas')
      .select('tablero_id')
      .in('tablero_id', tableros.map(t => t.id))
      .or('tipo.is.null,tipo.eq.asignacion');
    if (errTareas) throw errTareas;

    const cantidad = new Map();
    for (const t of tareas ?? []) cantidad.set(t.tablero_id, (cantidad.get(t.tablero_id) ?? 0) + 1);

    const data = tableros.map(t => ({ ...conMiembros(t), cantidad_tareas: cantidad.get(t.id) ?? 0 }));
    return { data, total: data.length };
  }

  async _obtenerTablero(id) {
    const { data, error: err } = await supabase
      .from('operativo_tableros')
      .select(`${COLUMNAS}, ${SELECT_MIEMBROS}`)
      .eq('id', id)
      .single();
    if (err) throw err;
    const { count, error: errCount } = await supabase
      .from('tareas')
      .select('id', { count: 'exact', head: true })
      .eq('tablero_id', id)
      .or('tipo.is.null,tipo.eq.asignacion');
    if (errCount) throw errCount;
    return { ...conMiembros(data), cantidad_tareas: count ?? 0 };
  }

  // ── Miembros ───────────────────────────────────────────────────────────────

  // Valida la lista completa de miembros. `actuales` (en una edición) pueden
  // mantenerse aunque el usuario esté inactivo; solo se agregan usuarios activos.
  async _validarMiembros(miembros, actuales = []) {
    if (!Array.isArray(miembros)) throw error(400, '"miembros" debe ser un array de ids de usuario.');

    const invalidos = miembros.filter(id => typeof id !== 'string' || !UUID.test(id));
    if (invalidos.length) throw error(400, `"miembros" contiene ids inválidos: ${invalidos.map(String).join(', ')}`);

    const unicos = [...new Set(miembros)];
    if (unicos.length === 0) return [];

    const { data: usuarios, error: err } = await supabase
      .from('usuarios')
      .select('id, estado')
      .in('id', unicos);
    if (err) throw err;

    const encontrados = new Map((usuarios ?? []).map(u => [u.id, u]));
    const inexistentes = unicos.filter(id => !encontrados.has(id));
    if (inexistentes.length) throw error(400, `No existen usuarios con id: ${inexistentes.join(', ')}`);

    const inactivosNuevos = unicos.filter(id => encontrados.get(id).estado !== 'Activo' && !actuales.includes(id));
    if (inactivosNuevos.length) throw error(400, `No se puede agregar usuarios inactivos: ${inactivosNuevos.join(', ')}`);

    return unicos;
  }

  // Deja el tablero con exactamente esta lista de miembros. Quitar a alguien no
  // toca sus tareas: conservan el responsable y él deja de ver el tablero.
  async _sincronizarMiembros(tableroId, nuevos, actuales) {
    const quitar = actuales.filter(id => !nuevos.includes(id));
    const agregar = nuevos.filter(id => !actuales.includes(id));

    if (quitar.length) {
      const { error: err } = await supabase
        .from('operativo_tablero_miembros')
        .delete()
        .eq('tablero_id', tableroId)
        .in('usuario_id', quitar);
      if (err) throw err;
    }
    if (agregar.length) {
      const { error: err } = await supabase
        .from('operativo_tablero_miembros')
        .insert(agregar.map(usuario_id => ({ tablero_id: tableroId, usuario_id })));
      if (err) throw err;
    }
  }

  // ── Alta y edición (solo mando alto, ver routes/tableros.js) ───────────────

  async crearTablero(body, user) {
    const { nombre, descripcion, miembros = [] } = body ?? {};
    const limpio = validarNombre(nombre);
    const desc = normalizarDescripcion(descripcion);
    const ids = await this._validarMiembros(miembros);

    const { data: creado, error: err } = await supabase
      .from('operativo_tableros')
      .insert([{ nombre: limpio, descripcion: desc, created_by: user?.id ?? null }])
      .select('id')
      .single();
    if (err) throw traducirError(err, limpio);

    try {
      await this._sincronizarMiembros(creado.id, ids, []);
    } catch (errMiembros) {
      // No dejar un tablero creado sin los miembros pedidos.
      await supabase.from('operativo_tableros').delete().eq('id', creado.id);
      throw errMiembros;
    }

    return this._obtenerTablero(creado.id);
  }

  async actualizarTablero(id, body) {
    if (typeof id !== 'string' || !UUID.test(id)) throw error(404, 'Tablero no encontrado.');
    const { nombre, descripcion, miembros } = body ?? {};

    const { data: existente, error: errLectura } = await supabase
      .from('operativo_tableros')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (errLectura) throw errLectura;
    if (!existente) throw error(404, 'Tablero no encontrado.');

    const updates = {};
    if (nombre !== undefined) updates.nombre = validarNombre(nombre);
    if (descripcion !== undefined) updates.descripcion = normalizarDescripcion(descripcion);
    if (Object.keys(updates).length === 0 && miembros === undefined) {
      throw error(400, 'Debés enviar al menos uno de: nombre, descripcion, miembros.');
    }

    // Validar todo antes de escribir.
    let miembrosFinales = null;
    let actuales = [];
    if (miembros !== undefined) {
      actuales = await this.idsMiembros(id);
      miembrosFinales = await this._validarMiembros(miembros, actuales);
    }

    if (Object.keys(updates).length) {
      const { error: err } = await supabase.from('operativo_tableros').update(updates).eq('id', id);
      if (err) throw traducirError(err, updates.nombre);
    }
    if (miembrosFinales) {
      await this._sincronizarMiembros(id, miembrosFinales, actuales);
    }

    return this._obtenerTablero(id);
  }
}

module.exports = new TablerosService();
