const { DASHBOARD_WIDGETS } = require('../config/widgets');

// Reglas compartidas por dashboardService (Panel General) y dashboardViewsService
// (vistas) para los mosaicos con horizonte (Alertas) y los deprecados (CRM).

function error400(mensaje) {
  return Object.assign(new Error(mensaje), { status: 400 });
}

// Parámetros normalizados de un mosaico con horizonte. Valores faltantes o
// inválidos caen al default (la validación estricta vive en validarParametrosAlerta).
function normalizarParametrosAlerta(widget, entry) {
  const raw = typeof entry === 'string' ? {} : (entry || {});
  const tipos = Array.isArray(raw.alertTypes)
    ? widget.alertTypes.filter(t => raw.alertTypes.includes(t))
    : [];
  return {
    alertTypes: tipos.length ? tipos : [...widget.alertTypes],
    horizonDays: widget.horizons.includes(raw.horizonDays) ? raw.horizonDays : widget.defaultHorizon,
  };
}

// Validación estricta (400) de `alertTypes` / `horizonDays` cuando vienen explícitos.
function validarParametrosAlerta(widget, entry) {
  if (entry.alertTypes !== undefined && entry.alertTypes !== null) {
    if (!Array.isArray(entry.alertTypes) || entry.alertTypes.length === 0) {
      throw error400(`"alertTypes" del mosaico "${entry.id}" debe ser un array no vacío. Opciones: ${widget.alertTypes.join(', ')}.`);
    }
    const invalidos = entry.alertTypes.filter(t => !widget.alertTypes.includes(t));
    if (invalidos.length) {
      throw error400(`Tipo(s) de alerta inválido(s) para el mosaico "${entry.id}": ${invalidos.join(', ')}. Opciones: ${widget.alertTypes.join(', ')}.`);
    }
  }
  if (entry.horizonDays !== undefined && entry.horizonDays !== null && !widget.horizons.includes(entry.horizonDays)) {
    throw error400(`Horizonte inválido para el mosaico "${entry.id}": "${entry.horizonDays}". Opciones: ${widget.horizons.join(', ')}.`);
  }
}

// Los parámetros de alerta solo se admiten en mosaicos con horizonte.
function rechazarParametrosAlertaAjenos(entry) {
  if (entry.alertTypes !== undefined || entry.horizonDays !== undefined) {
    throw error400(`"alertTypes" y "horizonDays" solo se admiten en mosaicos de alertas (mosaico "${entry.id}").`);
  }
}

// Mosaicos deprecados (CRM): solo se admiten las instancias que ya estaban
// guardadas (mismo `instanceId` y mismo `id`). `widgets` y `widgetsPrevios`
// están normalizados (las entradas legacy tienen instanceId `legacy:<id>`).
function validarDeprecados(widgets, widgetsPrevios) {
  const deprecados = widgets.filter(w => DASHBOARD_WIDGETS[w.id]?.deprecated);
  if (deprecados.length === 0) return;
  const previos = new Set((widgetsPrevios || []).map(w => `${w.instanceId}|${w.id}`));
  const nuevos = [...new Set(deprecados.filter(w => !previos.has(`${w.instanceId}|${w.id}`)).map(w => w.id))];
  if (nuevos.length) {
    throw error400(`El/los mosaico(s) ${nuevos.join(', ')} ya no está(n) disponible(s) para agregar. Los que ya tenías guardados se conservan.`);
  }
}

module.exports = {
  normalizarParametrosAlerta, validarParametrosAlerta, rechazarParametrosAlertaAjenos, validarDeprecados,
};
