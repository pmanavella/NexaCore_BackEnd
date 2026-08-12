const supabase = require('../../config/supabase');
const organizacionService = require('../../organization/services/organizacionService');
const { DASHBOARD_WIDGETS } = require('../config/widgets');

const DASHBOARD_NAME = 'Panel General';
const WIDGET_SIZES = ['sm', 'md', 'lg'];
const DEFAULT_WIDGET_SIZE = 'sm';

class DashboardService {
  // Acepta tanto el formato viejo (array de IDs string) como el nuevo
  // (array de {id, size}), y devuelve siempre [{id, size}] normalizado.
  // Usado tanto al leer (compatibilidad con filas guardadas en formato viejo)
  // como al guardar (compatibilidad con clientes viejos que mandan strings).
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
  // Módulos (slugs) a los que el usuario tiene acceso real hoy, según la Matriz
  // de permisos (usuario_modulo_permisos > rol_modulo_permisos). Reutiliza
  // organizacionService en vez de reimplementar la precedencia de permisos.
  async _modulosHabilitados(usuarioId) {
    const permisos = await organizacionService.obtenerPermisosUsuario(usuarioId);
    return permisos
      .filter(p => p.permiso !== 'sin_acceso')
      .map(p => p.modulos.nombre);
  }

  // Un widget es visible para el usuario si su módulo está habilitado y,
  // cuando el widget declara `requiresRole`, si el rol del usuario está incluido.
  _widgetPermitido(widgetId, allowedModules, userRole) {
    const widget = DASHBOARD_WIDGETS[widgetId];
    if (!widget) return false;
    if (!allowedModules.includes(widget.module)) return false;
    if (widget.requiresRole && !widget.requiresRole.includes(userRole)) return false;
    return true;
  }

  async obtenerConfiguracion(usuarioId, userRole) {
    const allowedModules = await this._modulosHabilitados(usuarioId);

    const { data: config, error } = await supabase
      .from('dashboard_configuraciones')
      .select('widgets')
      .eq('usuario_id', usuarioId)
      .maybeSingle();
    if (error) throw error;

    if (!config) {
      return {
        dashboard: { name: DASHBOARD_NAME, widgets: [] },
        allowedModules,
        hasConfiguration: false,
      };
    }

    // Filtra en lectura mosaicos guardados cuyo permiso haya sido revocado desde
    // el último guardado (ej. le sacaron acceso al módulo) — no se los devuelve,
    // pero tampoco se reescribe la fila: el filtro es solo de presentación.
    const widgets = this._normalizarWidgets(config.widgets)
      .filter(w => this._widgetPermitido(w.id, allowedModules, userRole));

    return {
      dashboard: { name: DASHBOARD_NAME, widgets },
      allowedModules,
      hasConfiguration: true,
    };
  }

  async guardarConfiguracion(usuarioId, widgetsInput, userRole) {
    if (!Array.isArray(widgetsInput)) {
      throw Object.assign(new Error('"widgets" debe ser un array de mosaicos.'), { status: 400 });
    }

    // Acepta tanto [id, id, ...] (formato viejo) como [{id, size}, ...] (nuevo).
    // IDs repetidos: se quedan con la primera aparición, preservando el orden
    // enviado (no se rechaza el request por esto).
    const widgetsUnicos = this._normalizarWidgets(widgetsInput);

    const idsDesconocidos = widgetsUnicos.filter(w => !DASHBOARD_WIDGETS[w.id]).map(w => w.id);
    if (idsDesconocidos.length > 0) {
      throw Object.assign(
        new Error(`Mosaico(s) desconocido(s): ${idsDesconocidos.join(', ')}.`),
        { status: 400 }
      );
    }

    const allowedModules = await this._modulosHabilitados(usuarioId);

    const idsNoAutorizados = widgetsUnicos.filter(w => !this._widgetPermitido(w.id, allowedModules, userRole)).map(w => w.id);
    if (idsNoAutorizados.length > 0) {
      throw Object.assign(
        new Error(`No tenés permisos para agregar el/los mosaico(s): ${idsNoAutorizados.join(', ')}.`),
        { status: 403 }
      );
    }

    const { data: saved, error } = await supabase
      .from('dashboard_configuraciones')
      .upsert(
        { usuario_id: usuarioId, widgets: widgetsUnicos },
        { onConflict: 'usuario_id' }
      )
      .select('widgets')
      .single();
    if (error) throw error;

    return {
      dashboard: { name: DASHBOARD_NAME, widgets: this._normalizarWidgets(saved.widgets) },
      allowedModules,
      hasConfiguration: true,
    };
  }
}

module.exports = new DashboardService();
