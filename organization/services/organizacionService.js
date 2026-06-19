const supabase = require('../../config/supabase')

const NIVEL_PERMISO = { sin_acceso: 0, lector: 1, editor: 2, administrador: 3 }

class OrganizacionService {

  // ── ORGANIGRAMA ──────────────────────────────────────────────

  async obtenerOrganigrama() {
    const { data, error } = await supabase
      .from('organigrama')
      .select(`
        id, usuario_id, superior_id, nivel, area, cargo,
        es_externo, fecha_inicio, fecha_fin, activo, created_at, updated_at,
        usuarios (id, nombre, email, estado, roles(id, nombre))
      `)
      .order('created_at', { ascending: true })

    if (error) throw error
    return data ?? []
  }

  async crearNodo(body) {
    const { usuario_id, superior_id, nivel, area, cargo, es_externo, fecha_inicio, fecha_fin } = body

    if (!usuario_id || !nivel)
      throw Object.assign(new Error('Campos obligatorios: usuario_id, nivel'), { status: 400 })

    const nivelValido = ['Directivo', 'Mandos Medios', 'Operarios / Staff', 'Externo']
    if (!nivelValido.includes(nivel))
      throw Object.assign(new Error('Nivel inválido'), { status: 400 })

    // Verificar que el usuario existe
    const { data: usr } = await supabase
      .from('usuarios')
      .select('id')
      .eq('id', usuario_id)
      .maybeSingle()
    if (!usr) throw Object.assign(new Error('Usuario no encontrado'), { status: 404 })

    // Verificar unicidad: un usuario solo puede tener un nodo
    const { data: existente } = await supabase
      .from('organigrama')
      .select('id')
      .eq('usuario_id', usuario_id)
      .maybeSingle()
    if (existente)
      throw Object.assign(new Error('Este usuario ya tiene un nodo en el organigrama'), { status: 409 })

    const { data, error } = await supabase
      .from('organigrama')
      .insert([{
        usuario_id,
        superior_id: superior_id || null,
        nivel,
        area: area?.trim() || null,
        cargo: cargo?.trim() || null,
        es_externo: es_externo ?? (nivel === 'Externo'),
        fecha_inicio: fecha_inicio || null,
        fecha_fin: fecha_fin || null,
        activo: true,
      }])
      .select(`
        id, usuario_id, superior_id, nivel, area, cargo,
        es_externo, fecha_inicio, fecha_fin, activo,
        usuarios (id, nombre, email, estado, roles(id, nombre))
      `)
      .single()

    if (error) throw error
    return data
  }

  async actualizarNodo(id, body, requesterId) {
    await this._verificarAccesoEdicion(id, requesterId)

    const { superior_id, nivel, area, cargo, es_externo, fecha_inicio, fecha_fin, activo } = body

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

    const { data, error } = await supabase
      .from('organigrama')
      .update(update)
      .eq('id', id)
      .select(`
        id, usuario_id, superior_id, nivel, area, cargo,
        es_externo, fecha_inicio, fecha_fin, activo,
        usuarios (id, nombre, email, estado, roles(id, nombre))
      `)
      .single()

    if (error) throw error
    return data
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

    return {
      usuarios:    usuariosRes.data    ?? [],
      permisos:    permisosRes.data    ?? [],
      modulos:     modulosRes.data     ?? [],
      rolPermisos: rolPermisosRes.data ?? [],
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
    if (!requesterId) return // sin auth, la ruta ya protege con requireRole

    const { data: requester } = await supabase
      .from('usuarios')
      .select('roles(nombre)')
      .eq('id', requesterId)
      .single()

    // Superadmin puede editar todo
    if (requester?.roles?.nombre === 'Superadmin') return

    const { data: nodo } = await supabase
      .from('organigrama')
      .select('usuario_id')
      .eq('id', nodoId)
      .single()

    if (!nodo) throw Object.assign(new Error('Nodo no encontrado'), { status: 404 })

    // Proteger: nadie puede editar al Superadmin
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
}

module.exports = new OrganizacionService()
