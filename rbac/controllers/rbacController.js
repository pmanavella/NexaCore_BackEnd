const rbacService = require('../services/rbacService')
const supabase = require('../../config/supabase')

class RbacController {
  async listarUsuarios(req, res, next) {
    try {
      const result = await rbacService.listarUsuarios()
      res.json(result)
    } catch (err) { next(err) }
  }

  async obtenerUsuario(req, res, next) {
    try {
      const result = await rbacService.obtenerUsuarioPorId(req.params.id)
      res.json(result)
    } catch (err) { next(err) }
  }

  async crearUsuario(req, res, next) {
    try {
      const result = await rbacService.crearUsuario(req.body)
      res.status(201).json(result)
    } catch (err) { next(err) }
  }

  async actualizarUsuario(req, res, next) {
    try {
      const result = await rbacService.actualizarUsuario(req.params.id, req.body, req.user?.id)
      res.json(result)
    } catch (err) { next(err) }
  }

  async eliminarUsuario(req, res, next) {
    try {
      const result = await rbacService.eliminarUsuario(req.params.id, req.user?.id)
      res.json(result)
    } catch (err) { next(err) }
  }

  async listarUsuariosAsignables(req, res, next) {
    try {
      const result = await rbacService.listarUsuariosAsignables()
      res.json(result)
    } catch (err) { next(err) }
  }

  async listarRoles(req, res, next) {
    try {
      const result = await rbacService.listarRoles()
      res.json(result)
    } catch (err) { next(err) }
  }

  async obtenerPerfil(req, res, next) {
    try {
      const email = req.query.email?.trim().toLowerCase()
  
      if (!email) {
        return res.status(400).json({
          error: 'El parámetro email es requerido.'
        })
      }
  
      const { data, error } = await supabase
        .from('usuarios')
        .select('nombre, roles(nombre)')
        .eq('email', email)
        .eq('estado', 'Activo')
        .single()
  
      if (error || !data) {
        return res.status(403).json({
          error: 'Usuario no encontrado o inactivo en el sistema.'
        })
      }
  
      res.json({
        nombre: data.nombre,
        rol: data.roles?.nombre ?? null
      })
    } catch (err) {
      next(err)
    }
  }


}

module.exports = new RbacController()
