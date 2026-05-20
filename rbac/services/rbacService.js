const supabase = require('../../config/supabase')
const { validateUserName, validateEmail } = require('../../utils/validators')

class RbacService {
  async listarUsuarios() {
    const { data, error } = await supabase
      .from('usuarios')
      .select('*, roles (id, nombre)')
      .order('nombre', { ascending: true })
    if (error) throw error
    return { data, total: data.length }
  }

  async obtenerUsuarioPorId(id) {
    const { data, error } = await supabase
      .from('usuarios')
      .select('*, roles (id, nombre)')
      .eq('id', id)
      .single()
    if (error) throw error
    if (!data) throw Object.assign(new Error('Usuario no encontrado'), { status: 404 })
    return data
  }

  async crearUsuario(body) {
    const { email, nombre, rol_id, estado, password } = body
    if (!email || !nombre || !rol_id || !password)
      throw Object.assign(new Error('Faltan campos obligatorios: email, nombre, rol_id, password'), { status: 400 })

    const nameErr = validateUserName(nombre, 'nombre')
    if (nameErr) throw Object.assign(new Error(nameErr), { status: 400 })

    const emailErr = validateEmail(email)
    if (emailErr) throw Object.assign(new Error(emailErr), { status: 400 })

    // Verificar email duplicado
    const { data: existing } = await supabase
      .from('usuarios')
      .select('id')
      .eq('email', email.trim().toLowerCase())
      .maybeSingle()
    if (existing)
      throw Object.assign(new Error('Ya existe un usuario registrado con este email.'), { status: 409 })

    // Crear el auth user en Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password,
      email_confirm: true,
    })
    if (authError) throw Object.assign(new Error(authError.message), { status: 400 })

    const authUserId = authData.user.id

    // Insertar en la tabla usuarios linkeando el auth user
    const { data, error } = await supabase
      .from('usuarios')
      .insert([{
        email: email.trim().toLowerCase(),
        nombre: nombre.trim(),
        rol_id,
        estado: estado || 'Activo',
        auth_user_id: authUserId,
      }])
      .select('*, roles (id, nombre)')
      .single()

    if (error) {
      // Revertir el auth user si falla la inserción en la tabla
      await supabase.auth.admin.deleteUser(authUserId)
      throw error
    }

    return data
  }

  async actualizarUsuario(id, body) {
    const { email, nombre, rol_id, estado } = body

    if (nombre !== undefined) {
      const nameErr = validateUserName(nombre, 'nombre')
      if (nameErr) throw Object.assign(new Error(nameErr), { status: 400 })
    }

    if (email !== undefined) {
      const emailErr = validateEmail(email)
      if (emailErr) throw Object.assign(new Error(emailErr), { status: 400 })

      // Verificar email duplicado excluyendo al propio usuario
      const { data: existing } = await supabase
        .from('usuarios')
        .select('id')
        .eq('email', email.trim().toLowerCase())
        .neq('id', id)
        .maybeSingle()
      if (existing)
        throw Object.assign(new Error('Ya existe un usuario registrado con este email.'), { status: 409 })
    }

    const { data, error } = await supabase
      .from('usuarios')
      .update({
        email: email?.trim().toLowerCase(),
        nombre: nombre?.trim(),
        rol_id,
        estado,
      })
      .eq('id', id)
      .select('*, roles (id, nombre)')
      .single()
    if (error) throw error
    return data
  }

  async eliminarUsuario(id, requesterId = null) {
    // Autoprotección: un usuario no puede eliminarse a sí mismo
    if (requesterId && id === requesterId) {
      throw Object.assign(new Error('No podés eliminar tu propia cuenta.'), { status: 400 })
    }

    // Verificar que el usuario a eliminar existe
    const { data: target } = await supabase
      .from('usuarios')
      .select('*, roles(nombre)')
      .eq('id', id)
      .single()

    if (!target) throw Object.assign(new Error('Usuario no encontrado'), { status: 404 })

    // Proteger al último Superadmin activo
    if (target.roles?.nombre === 'Superadmin') {
      const { count } = await supabase
        .from('usuarios')
        .select('id', { count: 'exact' })
        .eq('estado', 'Activo')
        .eq('rol_id', target.rol_id)
      if (count <= 1) {
        throw Object.assign(
          new Error('No se puede eliminar el único Superadmin activo del sistema.'),
          { status: 400 }
        )
      }
    }

    const { error } = await supabase.from('usuarios').delete().eq('id', id)
    if (error) throw error
    return { message: 'Usuario eliminado correctamente' }
  }

  async listarUsuariosAsignables() {
    const { data, error } = await supabase
      .from('usuarios')
      .select('id, nombre')
      .eq('estado', 'Activo')
      .order('nombre', { ascending: true })
    if (error) throw error
    return { data }
  }

  async listarRoles() {
    const { data, error } = await supabase
      .from('roles')
      .select('*')
      .order('nombre', { ascending: true })
    if (error) throw error
    return { data, total: data.length }
  }
}

module.exports = new RbacService()
