const supabase = require('../../config/supabase');
const { NIVELES_JERARQUICOS } = require('../../rbac/config/jerarquia');

// Tableros de tareas del Operativo (public.operativo_tableros, migración
// 2026-10-19_tableros_operativo). Único lugar del backend que decide quién ve
// un tablero: sus miembros (operativo_tablero_miembros) y, siempre, el mando
// alto (Dirección y Superadmin, nivel jerárquico HIGH). Todos los tableros
// comparten las mismas etapas (operativo_etapas).
//
// Acceso y administración son cosas distintas (migración
// 2026-11-02_tableros_administradores):
//   - Acceso (asegurarAcceso): ver el tablero y trabajar con sus tareas.
//     Miembros y mando alto.
//   - Administración (asegurarAdministrador): agregar/quitar miembros y
//     otorgar/quitar el privilegio de administrador. Solo los miembros con
//     es_admin, sin importar su rol jerárquico.
// Operaciones de mando alto que se conservan (routes/tableros.js): crear un
// tablero, editar nombre/descripción/lista completa de miembros, y designar un
// administrador en un tablero que no tiene ninguno activo.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOMBRE_LENGTH = 100;
const COLUMNAS = 'id, nombre, descripcion, created_by, created_at, updated_at';
const SELECT_MIEMBROS = 'operativo_tablero_miembros(es_admin, usuarios(id, nombre, email, estado))';

// Errores de las funciones operativo_tablero_* (RAISE ... ERRCODE P0001).
const ERRORES_RPC = {
  NX_TABLERO_NO_ENCONTRADO: [404, 'Tablero no encontrado.'],
  NX_NO_ADMIN:              [403, 'Solo los administradores del tablero pueden gestionar sus miembros.'],
  NX_NO_MIEMBRO:            [404, 'El usuario no es miembro del tablero.'],
  NX_USUARIO_INACTIVO:      [400, 'El usuario no está activo.'],
  NX_ULTIMO_ADMIN:          [409, 'El tablero debe conservar al menos un administrador activo.'],
  NX_YA_TIENE_ADMIN:        [409, 'El tablero ya tiene un administrador activo: los cambios de permisos los hacen sus administradores.'],
};

function error(status, mensaje) {
  return Object.assign(new Error(mensaje), { status });
}

async function llamarRpc(nombre, params) {
  const { error: err } = await supabase.rpc(nombre, params);
  if (!err) return;
  const conocido = err.code === 'P0001' && ERRORES_RPC[err.message];
  if (conocido) throw error(...conocido);
  throw err;
}

function validarUsuarioId(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw error(400, 'Id de usuario inválido.');
  return id;
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

// Reemplaza el embed crudo por `miembros: [{ id, nombre, email, estado, es_admin }]`
// ordenados por nombre, y agrega `permisos`: lo que el usuario que consulta
// puede hacer en este tablero (para que el frontend muestre u oculte acciones;
// el backend las vuelve a verificar siempre).
function conMiembros(tablero, user) {
  const { operativo_tablero_miembros, ...resto } = tablero;
  const miembros = (operativo_tablero_miembros ?? [])
    .filter(m => m.usuarios)
    .map(m => ({ ...m.usuarios, es_admin: m.es_admin === true }))
    .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));

  const propio = user?.id ? miembros.find(m => m.id === user.id) : null;
  const esAdmin = !!propio?.es_admin;
  const mandoAlto = esMandoAlto(user);
  const sinAdminActivo = !miembros.some(m => m.es_admin && m.estado === 'Activo');
  const permisos = {
    es_miembro:                 !!propio,
    es_admin:                   esAdmin,
    puede_agregar_miembros:     esAdmin,
    puede_quitar_miembros:      esAdmin,
    puede_administrar_permisos: esAdmin,
    puede_editar_tablero:       mandoAlto,
    puede_regularizar_admin:    mandoAlto && sinAdminActivo,
  };
  return { ...resto, miembros, permisos };
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

  // Verifica que el tablero exista y que el usuario sea administrador de ese
  // tablero. El rol jerárquico no cuenta: un Superadmin que no es
  // administrador del tablero recibe 403. 404 si el tablero no existe.
  // (Las funciones operativo_tablero_* lo vuelven a verificar con el tablero
  // bloqueado.)
  async asegurarAdministrador(tableroId, user) {
    if (typeof tableroId !== 'string' || !UUID.test(tableroId)) throw error(404, 'Tablero no encontrado.');

    const { data: tablero, error: err } = await supabase
      .from('operativo_tableros')
      .select('id, nombre')
      .eq('id', tableroId)
      .maybeSingle();
    if (err) throw err;
    if (!tablero) throw error(404, 'Tablero no encontrado.');

    if (!user?.id) throw error(403, ERRORES_RPC.NX_NO_ADMIN[1]);
    const { data: membresia, error: errMiembro } = await supabase
      .from('operativo_tablero_miembros')
      .select('es_admin')
      .eq('tablero_id', tableroId)
      .eq('usuario_id', user.id)
      .maybeSingle();
    if (errMiembro) throw errMiembro;
    if (membresia?.es_admin !== true) throw error(403, ERRORES_RPC.NX_NO_ADMIN[1]);
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

    const data = tableros.map(t => ({ ...conMiembros(t, user), cantidad_tareas: cantidad.get(t.id) ?? 0 }));
    return { data, total: data.length };
  }

  async _obtenerTablero(id, user) {
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
    return { ...conMiembros(data, user), cantidad_tareas: count ?? 0 };
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

  // Membresías del tablero con su privilegio y el estado del usuario.
  async _membresias(tableroId) {
    const { data, error: err } = await supabase
      .from('operativo_tablero_miembros')
      .select('usuario_id, es_admin, usuarios(estado)')
      .eq('tablero_id', tableroId);
    if (err) throw err;
    return (data ?? []).map(m => ({ usuario_id: m.usuario_id, es_admin: m.es_admin === true, activo: m.usuarios?.estado === 'Activo' }));
  }

  // Misma regla que las funciones operativo_tablero_*: un cambio no puede
  // dejar sin administradores activos a un tablero que tenía al menos uno.
  // Se verifica antes de escribir para no aplicar cambios a medias; la función
  // lo repite con el tablero bloqueado.
  _exigirAdminRestante(membresias, quedan) {
    const activos = membresias.filter(m => m.es_admin && m.activo);
    if (activos.length && !activos.some(m => quedan(m))) throw error(...ERRORES_RPC.NX_ULTIMO_ADMIN);
  }

  // ── Alta y edición (solo mando alto, ver routes/tableros.js) ───────────────

  // Quien crea el tablero queda como miembro administrador; el resto de los
  // miembros pedidos, como miembros comunes.
  async crearTablero(body, user) {
    const { nombre, descripcion, miembros = [] } = body ?? {};
    const limpio = validarNombre(nombre);
    const desc = normalizarDescripcion(descripcion);
    const ids = await this._validarMiembros(miembros);
    if (!user?.id) throw error(400, 'No se pudo identificar al usuario que crea el tablero.');

    const { data: creado, error: err } = await supabase
      .from('operativo_tableros')
      .insert([{ nombre: limpio, descripcion: desc, created_by: user.id }])
      .select('id')
      .single();
    if (err) throw traducirError(err, limpio);

    const filas = [
      { tablero_id: creado.id, usuario_id: user.id, es_admin: true },
      ...ids.filter(id => id !== user.id).map(usuario_id => ({ tablero_id: creado.id, usuario_id, es_admin: false })),
    ];
    const { error: errMiembros } = await supabase.from('operativo_tablero_miembros').insert(filas);
    if (errMiembros) {
      // No dejar un tablero creado sin los miembros pedidos.
      await supabase.from('operativo_tableros').delete().eq('id', creado.id);
      throw errMiembros;
    }

    return this._obtenerTablero(creado.id, user);
  }

  // `miembros` es la lista completa: los nuevos entran como miembros comunes y
  // los que siguen conservan su privilegio. No puede dejar el tablero sin
  // administradores activos (409).
  async actualizarTablero(id, body, user) {
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
    if (miembros !== undefined) {
      const membresias = await this._membresias(id);
      miembrosFinales = await this._validarMiembros(miembros, membresias.map(m => m.usuario_id));
      this._exigirAdminRestante(membresias, m => miembrosFinales.includes(m.usuario_id));
    }

    if (Object.keys(updates).length) {
      const { error: err } = await supabase.from('operativo_tableros').update(updates).eq('id', id);
      if (err) throw traducirError(err, updates.nombre);
    }
    // Quitar a alguien no toca sus tareas: conservan el responsable y él deja
    // de ver el tablero.
    if (miembrosFinales) {
      await llamarRpc('operativo_tablero_sincronizar_miembros', { p_tablero_id: id, p_usuario_ids: miembrosFinales });
    }

    return this._obtenerTablero(id, user);
  }

  // ── Administración de miembros (administradores del tablero) ──────────────

  // Agrega miembros comunes (`miembros`: array de usuario_id activos). Los que
  // ya eran miembros quedan como estaban. Cualquier otro campo del body (por
  // ejemplo es_admin) se ignora: promover es una operación aparte.
  async agregarMiembros(id, body, user) {
    await this.asegurarAdministrador(id, user);
    const { miembros } = body ?? {};
    const actuales = await this.idsMiembros(id);
    const ids = await this._validarMiembros(miembros, actuales);
    if (!ids.length) throw error(400, '"miembros" debe incluir al menos un usuario.');

    await llamarRpc('operativo_tablero_agregar_miembros', { p_tablero_id: id, p_actor_id: user.id, p_usuario_ids: ids });
    return this._obtenerTablero(id, user);
  }

  // Promueve (es_admin: true) o degrada (es_admin: false) a un miembro. Un
  // administrador puede degradarse a sí mismo si queda otro administrador
  // activo.
  async actualizarMiembro(id, usuarioId, body, user) {
    await this.asegurarAdministrador(id, user);
    validarUsuarioId(usuarioId);
    const { es_admin } = body ?? {};
    if (typeof es_admin !== 'boolean') throw error(400, '"es_admin" debe ser true o false.');

    const membresias = await this._membresias(id);
    const objetivo = membresias.find(m => m.usuario_id === usuarioId);
    if (!objetivo) throw error(...ERRORES_RPC.NX_NO_MIEMBRO);
    if (es_admin && !objetivo.activo) throw error(...ERRORES_RPC.NX_USUARIO_INACTIVO);
    if (!es_admin) this._exigirAdminRestante(membresias, m => m.usuario_id !== usuarioId);

    await llamarRpc('operativo_tablero_cambiar_admin', { p_tablero_id: id, p_actor_id: user.id, p_usuario_id: usuarioId, p_es_admin: es_admin });
    return this._obtenerTablero(id, user);
  }

  // Quita a un miembro (también a uno mismo o a otro administrador) si el
  // tablero conserva un administrador activo. Sus tareas no se modifican.
  async quitarMiembro(id, usuarioId, user) {
    await this.asegurarAdministrador(id, user);
    validarUsuarioId(usuarioId);

    const membresias = await this._membresias(id);
    if (!membresias.some(m => m.usuario_id === usuarioId)) throw error(...ERRORES_RPC.NX_NO_MIEMBRO);
    this._exigirAdminRestante(membresias, m => m.usuario_id !== usuarioId);

    await llamarRpc('operativo_tablero_quitar_miembro', { p_tablero_id: id, p_actor_id: user.id, p_usuario_id: usuarioId });
    return this._obtenerTablero(id, user);
  }

  // Excepción de mando alto (routes/tableros.js): designa un administrador en
  // un tablero que no tiene ninguno activo (ej. "General", creado por
  // migración sin creador, o cuyo último administrador fue desactivado o
  // borrado). Si el tablero ya tiene un administrador activo, 409: desde ahí
  // los permisos los manejan sus administradores.
  async regularizarAdministrador(id, body, user) {
    if (typeof id !== 'string' || !UUID.test(id)) throw error(404, 'Tablero no encontrado.');
    const usuarioId = validarUsuarioId(body?.usuario_id);

    const { data: existente, error: errLectura } = await supabase
      .from('operativo_tableros')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (errLectura) throw errLectura;
    if (!existente) throw error(404, 'Tablero no encontrado.');

    const membresias = await this._membresias(id);
    if (membresias.some(m => m.es_admin && m.activo)) throw error(...ERRORES_RPC.NX_YA_TIENE_ADMIN);
    await this._validarMiembros([usuarioId]);

    await llamarRpc('operativo_tablero_regularizar_admin', { p_tablero_id: id, p_usuario_id: usuarioId });
    return this._obtenerTablero(id, user);
  }
}

module.exports = new TablerosService();
