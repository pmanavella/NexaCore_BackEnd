const supabase = require('../../config/supabase');
const organizacionService = require('../../organization/services/organizacionService');
const { DASHBOARD_WIDGETS } = require('../config/widgets');

const WIDGET_SIZES       = ['sm', 'md', 'lg'];
const DEFAULT_WIDGET_SIZE = 'sm';
const MAX_VISTAS          = 10;
const MAX_NOMBRE_LENGTH   = 100;

class DashboardViewsService {

  // ── Helpers (duplicados de dashboardService — servicios independientes) ────

  _normalizarWidgets(widgetsInput) {
    const normalizados = (widgetsInput || [])
      .map(entry => {
        const id = typeof entry === 'string' ? entry : entry?.id;
        if (typeof id !== 'string' || !id) return null;
        const size = WIDGET_SIZES.includes(entry?.size) ? entry.size : DEFAULT_WIDGET_SIZE;
        return { id, size };
      })
      .filter(Boolean);

    const vistos = new Set();
    return normalizados.filter(w => {
      if (vistos.has(w.id)) return false;
      vistos.add(w.id);
      return true;
    });
  }

  async _modulosHabilitados(usuarioId) {
    const permisos = await organizacionService.obtenerPermisosUsuario(usuarioId);
    return permisos
      .filter(p => p.permiso !== 'sin_acceso')
      .map(p => p.modulos.nombre);
  }

  _widgetPermitido(widgetId, allowedModules, userRole) {
    const widget = DASHBOARD_WIDGETS[widgetId];
    if (!widget) return false;
    if (!allowedModules.includes(widget.module)) return false;
    if (widget.requiresRole && !widget.requiresRole.includes(userRole)) return false;
    return true;
  }

  _validarNombre(nombre) {
    const limpio = typeof nombre === 'string' ? nombre.trim() : '';
    if (!limpio) {
      throw Object.assign(new Error('"nombre" es requerido y no puede estar vacío.'), { status: 400 });
    }
    if (limpio.length > MAX_NOMBRE_LENGTH) {
      throw Object.assign(
        new Error(`"nombre" no puede superar los ${MAX_NOMBRE_LENGTH} caracteres.`),
        { status: 400 }
      );
    }
    return limpio;
  }

  // ── CRUD de vistas ─────────────────────────────────────────────────────────

  async listarVistas(usuarioId) {
    const { data, error } = await supabase
      .from('dashboard_vistas')
      .select('id, nombre, orden, created_at')
      .eq('usuario_id', usuarioId)
      .order('orden', { ascending: true });

    if (error) throw error;
    return data;
  }

  async crearVista(usuarioId, nombreRaw) {
    const nombre = this._validarNombre(nombreRaw);

    const { count, error: errCount } = await supabase
      .from('dashboard_vistas')
      .select('id', { count: 'exact', head: true })
      .eq('usuario_id', usuarioId);

    if (errCount) throw errCount;

    if (count >= MAX_VISTAS) {
      throw Object.assign(
        new Error(`No podés tener más de ${MAX_VISTAS} vistas de dashboard.`),
        { status: 409 }
      );
    }

    const { data, error } = await supabase
      .from('dashboard_vistas')
      .insert({ usuario_id: usuarioId, nombre, orden: count, widgets: [] })
      .select('id, nombre, orden, widgets')
      .single();

    if (error) throw error;
    return data;
  }

  async obtenerVista(vistaId, usuarioId, userRole) {
    const { data, error } = await supabase
      .from('dashboard_vistas')
      .select('id, nombre, orden, widgets')
      .eq('id', vistaId)
      .eq('usuario_id', usuarioId)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      throw Object.assign(new Error('Vista no encontrada.'), { status: 404 });
    }

    const allowedModules = await this._modulosHabilitados(usuarioId);
    const widgets = this._normalizarWidgets(data.widgets)
      .filter(w => this._widgetPermitido(w.id, allowedModules, userRole));

    return { id: data.id, nombre: data.nombre, orden: data.orden, widgets, allowedModules };
  }

  async actualizarVista(vistaId, usuarioId, body, userRole) {
    const { data: existente, error: errSelect } = await supabase
      .from('dashboard_vistas')
      .select('id')
      .eq('id', vistaId)
      .eq('usuario_id', usuarioId)
      .maybeSingle();

    if (errSelect) throw errSelect;
    if (!existente) {
      throw Object.assign(new Error('Vista no encontrada.'), { status: 404 });
    }

    const updates = {};

    if (body.nombre !== undefined) {
      updates.nombre = this._validarNombre(body.nombre);
    }

    if (body.orden !== undefined) {
      if (!Number.isInteger(body.orden) || body.orden < 0) {
        throw Object.assign(new Error('"orden" debe ser un entero no negativo.'), { status: 400 });
      }
      updates.orden = body.orden;
    }

    if (body.widgets !== undefined) {
      if (!Array.isArray(body.widgets)) {
        throw Object.assign(new Error('"widgets" debe ser un array.'), { status: 400 });
      }

      const widgetsUnicos = this._normalizarWidgets(body.widgets);

      const idsDesconocidos = widgetsUnicos.filter(w => !DASHBOARD_WIDGETS[w.id]).map(w => w.id);
      if (idsDesconocidos.length > 0) {
        throw Object.assign(
          new Error(`Mosaico(s) desconocido(s): ${idsDesconocidos.join(', ')}.`),
          { status: 400 }
        );
      }

      const allowedModules = await this._modulosHabilitados(usuarioId);
      const idsNoAutorizados = widgetsUnicos
        .filter(w => !this._widgetPermitido(w.id, allowedModules, userRole))
        .map(w => w.id);

      if (idsNoAutorizados.length > 0) {
        throw Object.assign(
          new Error(`No tenés permisos para agregar el/los mosaico(s): ${idsNoAutorizados.join(', ')}.`),
          { status: 403 }
        );
      }

      updates.widgets = widgetsUnicos;
    }

    if (Object.keys(updates).length === 0) {
      throw Object.assign(
        new Error('Debés enviar al menos uno de: nombre, orden, widgets.'),
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('dashboard_vistas')
      .update(updates)
      .eq('id', vistaId)
      .eq('usuario_id', usuarioId)
      .select('id, nombre, orden, widgets')
      .single();

    if (error) throw error;
    return {
      id: data.id,
      nombre: data.nombre,
      orden: data.orden,
      widgets: this._normalizarWidgets(data.widgets),
    };
  }

  async eliminarVista(vistaId, usuarioId) {
    const { data: existente, error: errSelect } = await supabase
      .from('dashboard_vistas')
      .select('id')
      .eq('id', vistaId)
      .eq('usuario_id', usuarioId)
      .maybeSingle();

    if (errSelect) throw errSelect;
    if (!existente) {
      throw Object.assign(new Error('Vista no encontrada.'), { status: 404 });
    }

    const { error } = await supabase
      .from('dashboard_vistas')
      .delete()
      .eq('id', vistaId)
      .eq('usuario_id', usuarioId);

    if (error) throw error;
    return { message: 'Vista eliminada correctamente.' };
  }
}

module.exports = new DashboardViewsService();
