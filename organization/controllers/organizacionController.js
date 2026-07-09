const organizacionService = require('../services/organizacionService')

class OrganizacionController {

  // ── ORGANIGRAMA ──────────────────────────────────────────────

  async obtenerOrganigrama(req, res, next) {
    try {
      const data = await organizacionService.obtenerOrganigrama()
      res.json({ data })
    } catch (err) { next(err) }
  }

  async crearNodo(req, res, next) {
    try {
      const data = await organizacionService.crearNodo(req.body)
      res.status(201).json(data)
    } catch (err) { next(err) }
  }

  async actualizarNodo(req, res, next) {
    try {
      const data = await organizacionService.actualizarNodo(
        req.params.id, req.body, req.user?.id
      )
      res.json(data)
    } catch (err) { next(err) }
  }

  async eliminarNodo(req, res, next) {
    try {
      const data = await organizacionService.eliminarNodo(req.params.id, req.user?.id)
      res.json(data)
    } catch (err) { next(err) }
  }

  // ── PERSONAS ASIGNABLES ──────────────────────────────────────

  async obtenerPersonasAsignables(req, res, next) {
    try {
      const data = await organizacionService.obtenerPersonasAsignables()
      res.json({ data })
    } catch (err) { next(err) }
  }

  // ── PERMISOS POR USUARIO ─────────────────────────────────────

  async obtenerPermisosUsuario(req, res, next) {
    try {
      const data = await organizacionService.obtenerPermisosUsuario(req.params.usuarioId)
      res.json({ data })
    } catch (err) { next(err) }
  }

  async actualizarPermisosUsuario(req, res, next) {
    try {
      const { permisos } = req.body
      if (!Array.isArray(permisos))
        return res.status(400).json({ error: 'Se esperaba un array "permisos"' })

      const data = await organizacionService.upsertPermisosUsuario(
        req.params.usuarioId, permisos, req.user?.id
      )
      res.json({ data })
    } catch (err) { next(err) }
  }

  // ── MATRIZ ───────────────────────────────────────────────────

  async obtenerMatrizPermisos(req, res, next) {
    try {
      const data = await organizacionService.obtenerMatrizPermisos()
      res.json(data)
    } catch (err) { next(err) }
  }

  // ── MÓDULOS ──────────────────────────────────────────────────

  async obtenerModulos(req, res, next) {
    try {
      const data = await organizacionService.obtenerModulos()
      res.json({ data })
    } catch (err) { next(err) }
  }

  // ── ROLES PREDEFINIDOS ───────────────────────────────────────

  async obtenerRolesPredefinidos(req, res, next) {
    try {
      const data = await organizacionService.obtenerRolesPredefinidos()
      res.json({ data })
    } catch (err) { next(err) }
  }

  // ── INACTIVAR EXPIRADOS ──────────────────────────────────────

  async inactivarExpirados(req, res, next) {
    try {
      const result = await organizacionService.inactivarExpirados()
      res.json(result)
    } catch (err) { next(err) }
  }
}

module.exports = new OrganizacionController()
