const supabase = require('../../config/supabase')

const NIVEL_PERMISO = { sin_acceso: 0, lector: 1, editor: 2, administrador: 3 }

const SELECT_NODO = `
  id, usuario_id, empleado_id, superior_id, nivel, area, cargo,
  es_externo, fecha_inicio, fecha_fin, activo, created_at, updated_at,
  nombre_manual, apellido_manual, email_manual, telefono_manual,
  usuarios (id, nombre, email, estado, roles(id, nombre)),
  empleados (id, nombre, apellido, email, telefono, estado)
`

// Normaliza email para comparar "misma persona" entre usuarios y empleados.
function normalizarEmail(valor) {
  if (!valor) return null
  const trimmed = String(valor).trim().toLowerCase()
  return trimmed === '' ? null : trimmed
}

// Normaliza texto libre opcional: "", "   " o undefined pasan a null.
function normalizarTexto(valor) {
  if (valor === undefined || valor === null) return null
  const trimmed = String(valor).trim()
  return trimmed === '' ? null : trimmed
}

// Determina el origen de un nodo para que el frontend sepa cómo renderizarlo.
function agregarOrigen(nodo) {
  if (!nodo) return nodo
  let origen
  if (nodo.usuario_id && nodo.empleado_id) origen = 'ambos'
  else if (nodo.usuario_id) origen = 'usuario'
  else if (nodo.empleado_id) origen = 'empleado'
  else origen = 'manual'
  return { ...nodo, origen }
}

// Traduce violaciones de unicidad de Postgres (23505) a mensajes claros.
function mapearErrorDuplicadoNodo(error) {
  if (error?.code !== '23505') return null
  const detalle = `${error.message || ''} ${error.details || ''}`.toLowerCase()
  if (detalle.includes('usuario_id')) {
    return Object.assign(new Error('Este usuario ya tiene un nodo activo en el organigrama.'), { status: 409 })
  }
  if (detalle.includes('empleado_id')) {
    return Object.assign(new Error('Este empleado ya tiene un nodo activo en el organigrama.'), { status: 409 })
  }
  return Object.assign(new Error('El registro ya existe.'), { status: 409 })
}

class OrganizacionService {

  // ── ORGANIGRAMA ──────────────────────────────────────────────

  async obtenerOrganigrama() {
    const { data, error } = await supabase
      .from('organigrama')
      .select(SELECT_NODO)
      .order('created_at', { ascending: true })

    if (error) throw error
    return (data ?? []).map(agregarOrigen)
  }

  async crearNodo(body) {
    const {
      usuario_id, empleado_id, superior_id, nivel, area, cargo, es_externo, fecha_inicio, fecha_fin,
      nombre_manual, apellido_manual, email_manual, telefono_manual,
    } = body

    const nombreManualNormalizado = normalizarTexto(nombre_manual)
    const esManual = !usuario_id && !empleado_id

    if ((!usuario_id && !empleado_id && !nombreManualNormalizado) || !nivel)
      throw Object.assign(
        new Error('Campos obligatorios: nivel, y al menos uno de usuario_id / empleado_id / nombre_manual'),
        { status: 400 }
      )

    const nivelValido = ['Directivo', 'Mandos Medios', 'Operarios / Staff', 'Externo']
    if (!nivelValido.includes(nivel))
      throw Object.assign(new Error('Nivel inválido'), { status: 400 })

    if (usuario_id) {
      const { data: usr } = await supabase.from('usuarios').select('id').eq('id', usuario_id).maybeSingle()
      if (!usr) throw Object.assign(new Error('Usuario no encontrado'), { status: 404 })
    }

    if (empleado_id) {
      const { data: emp } = await supabase.from('empleados').select('id').eq('id', empleado_id).maybeSingle()
      if (!emp) throw Object.assign(new Error('Empleado no encontrado'), { status: 404 })
    }

    await this._verificarNodoActivoUnico({ usuario_id, empleado_id })

    const { data, error } = await supabase
      .from('organigrama')
      .insert([{
        usuario_id: usuario_id || null,
        empleado_id: empleado_id || null,
        // Los datos manuales solo se guardan cuando el nodo no es de un usuario/empleado real.
        nombre_manual:   esManual ? nombreManualNormalizado           : null,
        apellido_manual: esManual ? normalizarTexto(apellido_manual)  : null,
        email_manual:    esManual ? normalizarTexto(email_manual)     : null,
        telefono_manual: esManual ? normalizarTexto(telefono_manual)  : null,
        superior_id: superior_id || null,
        nivel,
        area: area?.trim() || null,
        cargo: cargo?.trim() || null,
        es_externo: es_externo ?? (nivel === 'Externo'),
        fecha_inicio: fecha_inicio || null,
        fecha_fin: fecha_fin || null,
        activo: true,
      }])
      .select(SELECT_NODO)
      .single()

    if (error) throw mapearErrorDuplicadoNodo(error) || error
    return agregarOrigen(data)
  }

  async actualizarNodo(id, body, requesterId) {
    const nodoActual = await this._verificarAccesoEdicion(id, requesterId)

    const {
      usuario_id, empleado_id, superior_id, nivel, area, cargo, es_externo, fecha_inicio, fecha_fin, activo,
      nombre_manual, apellido_manual, email_manual, telefono_manual,
    } = body

    if (nivel) {
      const nivelValido = ['Directivo', 'Mandos Medios', 'Operarios / Staff', 'Externo']
      if (!nivelValido.includes(nivel))
        throw Object.assign(new Error('Nivel inválido'), { status: 400 })
    }

    // Evitar ciclos jerárquicos: un nodo no puede ser su propio superior
    if (superior_id === id)
      throw Object.assign(new Error('Un nodo no puede ser su propio superior'), { status: 400 })

    const update = {}
    if (superior_id !== undefined) update.superior_id = superior_id || null
    if (nivel       !== undefined) update.nivel        = nivel
    if (area        !== undefined) update.area         = area?.trim() || null
    if (cargo       !== undefined) update.cargo        = cargo?.trim() || null
    if (es_externo  !== undefined) update.es_externo   = es_externo
    if (fecha_inicio !== undefined) update.fecha_inicio = fecha_inicio || null
    if (fecha_fin   !== undefined) update.fecha_fin    = fecha_fin || null
    if (activo      !== undefined) update.activo       = activo

    const identidadTocada = [usuario_id, empleado_id, nombre_manual, apellido_manual, email_manual, telefono_manual]
      .some(v => v !== undefined)

    if (identidadTocada) {
      const usuarioFinal      = usuario_id     !== undefined ? (usuario_id || null)            : nodoActual.usuario_id
      const empleadoFinal     = empleado_id    !== undefined ? (empleado_id || null)            : nodoActual.empleado_id
      const nombreManualFinal = nombre_manual  !== undefined ? normalizarTexto(nombre_manual)    : nodoActual.nombre_manual

      if (!usuarioFinal && !empleadoFinal && !nombreManualFinal)
        throw Object.assign(new Error('El nodo debe tener usuario_id, empleado_id o nombre_manual'), { status: 400 })

      if (usuario_id) {
        const { data: usr } = await supabase.from('usuarios').select('id').eq('id', usuario_id).maybeSingle()
        if (!usr) throw Object.assign(new Error('Usuario no encontrado'), { status: 404 })
      }
      if (empleado_id) {
        const { data: emp } = await supabase.from('empleados').select('id').eq('id', empleado_id).maybeSingle()
        if (!emp) throw Object.assign(new Error('Empleado no encontrado'), { status: 404 })
      }

      await this._verificarNodoActivoUnico({ usuario_id, empleado_id, excludeId: id })

      // Los datos manuales solo tienen sentido si el nodo queda sin usuario ni empleado real.
      const quedaComoManual = !usuarioFinal && !empleadoFinal

      if (usuario_id      !== undefined) update.usuario_id      = usuario_id || null
      if (empleado_id     !== undefined) update.empleado_id     = empleado_id || null
      if (nombre_manual   !== undefined) update.nombre_manual   = quedaComoManual ? nombreManualFinal : null
      if (apellido_manual !== undefined) update.apellido_manual = quedaComoManual ? normalizarTexto(apellido_manual) : null
      if (email_manual    !== undefined) update.email_manual    = quedaComoManual ? normalizarTexto(email_manual)    : null
      if (telefono_manual !== undefined) update.telefono_manual = quedaComoManual ? normalizarTexto(telefono_manual) : null
    }

    const { data, error } = await supabase
      .from('organigrama')
      .update(update)
      .eq('id', id)
      .select(SELECT_NODO)
      .single()

    if (error) throw mapearErrorDuplicadoNodo(error) || error
    return agregarOrigen(data)
  }

  async eliminarNodo(id, requesterId) {
    await this._verificarAccesoEdicion(id, requesterId)

    // Desconectar hijos antes de eliminar
    await supabase
      .from('organigrama')
      .update({ superior_id: null })
      .eq('superior_id', id)

    const { error } = await supabase.from('organigrama').delete().eq('id', id)
    if (error) throw error
    return { message: 'Nodo eliminado del organigrama' }
  }

  // ── PERMISOS POR USUARIO ─────────────────────────────────────

  async obtenerPermisosUsuario(usuarioId) {
    // Obtener rol del usuario para el fallback
    const { data: usuario } = await supabase
      .from('usuarios')
      .select('id, rol_id, roles(id, nombre)')
      .eq('id', usuarioId)
      .single()

    // Todos los módulos
    const { data: modulos, error: modErr } = await supabase
      .from('modulos')
      .select('id, nombre, label')
      .order('nombre')
    if (modErr) throw modErr

    // Permisos explícitos del usuario
    const { data: userPermisos, error: upErr } = await supabase
      .from('usuario_modulo_permisos')
      .select('id, usuario_id, modulo_id, permiso, alcance, modulos(id, nombre, label)')
      .eq('usuario_id', usuarioId)
    if (upErr) throw upErr

    // Permisos del rol como fallback
    let rolPermisos = []
    if (usuario?.rol_id) {
      const { data: rp } = await supabase
        .from('rol_modulo_permisos')
        .select('modulo_id, puede_ver, puede_editar')
        .eq('rol_id', usuario.rol_id)
      rolPermisos = rp || []
    }

    // Mezclar: usuario > rol > sin_acceso para cada módulo
    const merged = (modulos || []).map(mod => {
      const up = (userPermisos || []).find(p => p.modulo_id === mod.id)
      if (up) return { ...up, source: 'usuario' }

      const rp = rolPermisos.find(p => p.modulo_id === mod.id)
      if (rp?.puede_ver) {
        return {
          id: null, usuario_id: usuarioId, modulo_id: mod.id,
          permiso: rp.puede_editar ? 'editor' : 'lector',
          alcance: 'global', modulos: mod, source: 'rol',
        }
      }

      return {
        id: null, usuario_id: usuarioId, modulo_id: mod.id,
        permiso: 'sin_acceso', alcance: null, modulos: mod, source: 'ninguno',
      }
    })

    return merged
  }

  async upsertPermisosUsuario(usuarioId, permisos, requesterId) {
    // Seguridad: nadie puede darse permisos a sí mismo para escalar
    if (requesterId && usuarioId === requesterId) {
      throw Object.assign(
        new Error('No podés modificar tus propios permisos'),
        { status: 403 }
      )
    }

    // Validar estructura de cada permiso
    const permisosValidos = ['sin_acceso', 'lector', 'editor', 'administrador']
    const alcancesValidos = ['propio', 'equipo_directo', 'subarbol', 'global']

    for (const p of permisos) {
      if (!p.modulo_id)
        throw Object.assign(new Error('Cada permiso requiere modulo_id'), { status: 400 })
      if (p.permiso && !permisosValidos.includes(p.permiso))
        throw Object.assign(new Error(`Permiso inválido: ${p.permiso}`), { status: 400 })
      if (p.alcance && !alcancesValidos.includes(p.alcance))
        throw Object.assign(new Error(`Alcance inválido: ${p.alcance}`), { status: 400 })
    }

    const rows = permisos.map(p => ({
      usuario_id: usuarioId,
      modulo_id:  p.modulo_id,
      permiso:    p.permiso  || 'sin_acceso',
      alcance:    p.alcance  || 'propio',
    }))

    const { data, error } = await supabase
      .from('usuario_modulo_permisos')
      .upsert(rows, { onConflict: 'usuario_id,modulo_id' })
      .select(`
        id, usuario_id, modulo_id, permiso, alcance,
        modulos (id, nombre, label)
      `)

    if (error) throw error
    return data
  }

  // ── MATRIZ DE PERMISOS ───────────────────────────────────────

  async obtenerMatrizPermisos() {
    const [usuariosRes, permisosRes, modulosRes, rolPermisosRes] = await Promise.all([
      supabase
        .from('usuarios')
        .select('id, nombre, email, estado, rol_id, roles(id, nombre)')
        .order('nombre'),
      supabase
        .from('usuario_modulo_permisos')
        .select('usuario_id, modulo_id, permiso, alcance'),
      supabase
        .from('modulos')
        .select('id, nombre, label')
        .order('nombre'),
      supabase
        .from('rol_modulo_permisos')
        .select('rol_id, modulo_id, puede_ver, puede_editar'),
    ])

    if (usuariosRes.error)    throw usuariosRes.error
    if (permisosRes.error)    throw permisosRes.error
    if (modulosRes.error)     throw modulosRes.error
    if (rolPermisosRes.error) throw rolPermisosRes.error

    // "personas": todas las personas del organigrama (usuario/empleado/ambos/manual),
    // con sus permisos reales si tienen usuario, o "no_aplica" si no lo tienen.
    // Se agrega sin tocar "usuarios"/"permisos"/"rolPermisos" para no romper consumidores actuales.
    const modulosList = modulosRes.data ?? []

    const { data: nodos, error: nodosErr } = await supabase
      .from('organigrama')
      .select(`
        id, usuario_id, empleado_id, activo, nombre_manual, apellido_manual, email_manual,
        usuarios (id, nombre, email, estado, roles(id, nombre)),
        empleados (id, nombre, apellido, email, estado)
      `)
      .order('created_at', { ascending: true })
    if (nodosErr) throw nodosErr

    const personas = []
    for (const nodo of (nodos ?? [])) {
      const origen = nodo.usuario_id && nodo.empleado_id ? 'ambos'
        : nodo.usuario_id ? 'usuario'
        : nodo.empleado_id ? 'empleado'
        : 'manual'

      let permisos
      if (nodo.usuario_id) {
        // Permisos reales: mismo merge usuario > rol > sin_acceso que usa /permisos/:usuarioId
        const efectivos = await this.obtenerPermisosUsuario(nodo.usuario_id)
        permisos = efectivos.map(p => ({
          modulo_id: p.modulo_id, modulo: p.modulos, permiso: p.permiso, alcance: p.alcance, source: p.source,
        }))
      } else {
        // Empleado sin usuario o persona manual: no tiene login, no aplican permisos.
        permisos = modulosList.map(mod => ({
          modulo_id: mod.id, modulo: mod, permiso: 'no_aplica', alcance: null, source: 'no_aplica',
        }))
      }

      personas.push({
        nodo_id: nodo.id,
        origen,
        usuario_id: nodo.usuario_id,
        empleado_id: nodo.empleado_id,
        activo: nodo.activo,
        nombre: nodo.usuarios?.nombre ?? nodo.empleados?.nombre ?? nodo.nombre_manual,
        email:  nodo.usuarios?.email  ?? nodo.empleados?.email  ?? nodo.email_manual,
        rol: nodo.usuarios?.roles?.nombre ?? null,
        permisos,
      })
    }

    return {
      usuarios:    usuariosRes.data    ?? [],
      permisos:    permisosRes.data    ?? [],
      modulos:     modulosList,
      rolPermisos: rolPermisosRes.data ?? [],
      personas,
    }
  }

  // ── MÓDULOS ──────────────────────────────────────────────────

  async obtenerModulos() {
    const { data, error } = await supabase
      .from('modulos')
      .select('id, nombre, label, descripcion')
      .order('nombre')

    if (error) throw error
    return data ?? []
  }

  // ── ROLES PREDEFINIDOS ───────────────────────────────────────

  async obtenerRolesPredefinidos() {
    const { data: roles, error: rolesErr } = await supabase
      .from('roles')
      .select('id, nombre, descripcion')
      .order('nombre')

    if (rolesErr) throw rolesErr

    const { data: permisos, error: permErr } = await supabase
      .from('rol_modulo_permisos')
      .select(`
        rol_id, puede_ver, puede_editar,
        modulos (id, nombre, label)
      `)

    if (permErr) throw permErr

    return roles.map(rol => ({
      ...rol,
      permisos: (permisos ?? []).filter(p => p.rol_id === rol.id),
    }))
  }

  // ── INACTIVAR EXTERNOS VENCIDOS ──────────────────────────────

  async inactivarExpirados() {
    const today = new Date().toISOString().split('T')[0]

    const { data: expirados, error } = await supabase
      .from('organigrama')
      .select('id, usuario_id')
      .eq('activo', true)
      .not('fecha_fin', 'is', null)
      .lte('fecha_fin', today)

    if (error) throw error
    if (!expirados?.length) return { desactivados: 0 }

    const orgIds     = expirados.map(e => e.id)
    const usuarioIds = expirados.map(e => e.usuario_id)

    await supabase.from('organigrama').update({ activo: false }).in('id', orgIds)
    await supabase.from('usuarios').update({ estado: 'Inactivo' }).in('id', usuarioIds)

    return { desactivados: expirados.length, usuarioIds }
  }

  // ── HELPERS PRIVADOS ─────────────────────────────────────────

  async _verificarAccesoEdicion(nodoId, requesterId) {
    const { data: nodo } = await supabase
      .from('organigrama')
      .select('usuario_id, empleado_id, nombre_manual')
      .eq('id', nodoId)
      .single()

    if (!nodo) throw Object.assign(new Error('Nodo no encontrado'), { status: 404 })

    if (!requesterId) return nodo // sin auth, la ruta ya protege con requireRole

    const { data: requester } = await supabase
      .from('usuarios')
      .select('roles(nombre)')
      .eq('id', requesterId)
      .single()

    // Superadmin puede editar todo
    if (requester?.roles?.nombre === 'Superadmin') return nodo

    // Proteger: nadie puede editar el nodo del Superadmin (solo aplica si el nodo tiene usuario)
    if (nodo.usuario_id) {
      const { data: targetUser } = await supabase
        .from('usuarios')
        .select('roles(nombre)')
        .eq('id', nodo.usuario_id)
        .single()

      if (targetUser?.roles?.nombre === 'Superadmin')
        throw Object.assign(
          new Error('No se puede modificar al Superadmin desde esta vista'),
          { status: 403 }
        )
    }

    return nodo
  }

  // Verifica que usuario_id/empleado_id no tengan ya otro nodo ACTIVO
  // (espeja los índices únicos parciales de la base: únicos solo si activo=true).
  async _verificarNodoActivoUnico({ usuario_id, empleado_id, excludeId } = {}) {
    if (usuario_id) {
      let q = supabase.from('organigrama').select('id').eq('usuario_id', usuario_id).eq('activo', true)
      if (excludeId) q = q.neq('id', excludeId)
      const { data: existente } = await q.maybeSingle()
      if (existente)
        throw Object.assign(new Error('Este usuario ya tiene un nodo activo en el organigrama'), { status: 409 })
    }

    if (empleado_id) {
      let q = supabase.from('organigrama').select('id').eq('empleado_id', empleado_id).eq('activo', true)
      if (excludeId) q = q.neq('id', excludeId)
      const { data: existente } = await q.maybeSingle()
      if (existente)
        throw Object.assign(new Error('Este empleado ya tiene un nodo activo en el organigrama'), { status: 409 })
    }
  }

  // ── PERSONAS ASIGNABLES ──────────────────────────────────────

  async obtenerPersonasAsignables() {
    const [usuariosRes, empleadosRes, nodosRes] = await Promise.all([
      supabase
        .from('usuarios')
        .select('id, nombre, email, estado, roles(id, nombre)')
        .eq('estado', 'Activo')
        .order('nombre'),
      supabase
        .from('empleados')
        .select('id, nombre, apellido, email, telefono, estado')
        .eq('estado', 'Activo')
        .order('apellido'),
      supabase
        .from('organigrama')
        .select('usuario_id, empleado_id')
        .eq('activo', true),
    ])

    if (usuariosRes.error) throw usuariosRes.error
    if (empleadosRes.error) throw empleadosRes.error
    if (nodosRes.error) throw nodosRes.error

    const usuarioIdsEnNodo  = new Set((nodosRes.data ?? []).filter(n => n.usuario_id).map(n => n.usuario_id))
    const empleadoIdsEnNodo = new Set((nodosRes.data ?? []).filter(n => n.empleado_id).map(n => n.empleado_id))

    const usuariosLibres  = (usuariosRes.data  ?? []).filter(u => !usuarioIdsEnNodo.has(u.id))
    const empleadosLibres = (empleadosRes.data ?? []).filter(e => !empleadoIdsEnNodo.has(e.id))

    const empleadosPorEmail = new Map()
    for (const emp of empleadosLibres) {
      const email = normalizarEmail(emp.email)
      if (email) empleadosPorEmail.set(email, emp)
    }

    const resultado = []
    const empleadosUnificados = new Set()

    for (const usr of usuariosLibres) {
      const email = normalizarEmail(usr.email)
      const empMatch = email ? empleadosPorEmail.get(email) : null

      if (empMatch) {
        empleadosUnificados.add(empMatch.id)
        resultado.push({
          origen: 'ambos',
          usuario_id: usr.id,
          empleado_id: empMatch.id,
          nombre: usr.nombre,
          apellido: empMatch.apellido,
          email: usr.email,
          rol: usr.roles?.nombre ?? null,
        })
      } else {
        resultado.push({
          origen: 'usuario',
          usuario_id: usr.id,
          empleado_id: null,
          nombre: usr.nombre,
          apellido: null,
          email: usr.email,
          rol: usr.roles?.nombre ?? null,
        })
      }
    }

    for (const emp of empleadosLibres) {
      if (empleadosUnificados.has(emp.id)) continue
      resultado.push({
        origen: 'empleado',
        usuario_id: null,
        empleado_id: emp.id,
        nombre: emp.nombre,
        apellido: emp.apellido,
        email: emp.email,
        rol: null,
      })
    }

    return resultado
  }
}

module.exports = new OrganizacionService()
