const supabase = require('../../config/supabase');
const organizacionService = require('../../organization/services/organizacionService');
const { DASHBOARD_WIDGETS, WIDGET_PERIODS, CHART_TYPES } = require('../config/widgets');
const indicadoresService = require('../../indicators/services/indicadoresService');
const { UUID_REGEX } = indicadoresService;

const DASHBOARD_NAME = 'Panel General';
const WIDGET_SIZES = ['sm', 'md', 'lg'];
const DEFAULT_WIDGET_SIZE = 'sm';
const DEFAULT_WIDGET_PERIOD = 'month';
const DEFAULT_CHART_TYPE = 'kpi';

class DashboardService {
  // Períodos / tipos de gráfico admitidos para un ID del catálogo (o los
  // globales si el ID es desconocido — esos casos se filtran/rechazan aparte).
  _opcionesWidget(widgetId) {
    const widget = DASHBOARD_WIDGETS[widgetId];
    return {
      periods: widget?.periods || WIDGET_PERIODS,
      chartTypes: widget?.allowedChartTypes || CHART_TYPES,
      defaultPeriod: widget?.defaultPeriod || DEFAULT_WIDGET_PERIOD,
      defaultChartType: widget?.defaultChartType || DEFAULT_CHART_TYPE,
    };
  }

  // `instanceId` estable para una entrada legacy sin ese campo. Determinista y
  // constante entre lecturas (no aleatorio): históricamente el backend
  // deduplicaba por `id`, así que dentro de una config antigua no puede haber
  // dos instancias con el mismo `id` — `legacy:<id>` es único y reproducible.
  _instanceIdLegacy(id) {
    return `legacy:${id}`;
  }

  // Acepta el formato viejo (array de IDs string), el intermedio ({id, size}),
  // el {id, size, period, chartType} y el actual con `instanceId`; devuelve
  // siempre [{id, instanceId, size, period, chartType}] normalizado.
  // `id` sigue identificando QUÉ métrica es (catálogo, módulo, permisos);
  // `instanceId` identifica una instancia concreta dentro de la config del
  // usuario y NO participa en autorización.
  // Usado al leer (entradas legacy sin `instanceId` reciben uno estable
  // `legacy:<id>`; `period`/`chartType` faltantes caen al default del catálogo
  // — para los IDs `_6m` ese default es '6m') y al guardar (tolera strings y
  // {id, size}). La validación estricta (400) vive en `_validarEntradasWidgets`.
  _normalizarWidgets(widgetsInput) {
    const normalizados = (widgetsInput || [])
      .map(entry => {
        const id = typeof entry === 'string' ? entry : entry?.id;
        if (typeof id !== 'string' || !id) return null;
        const size = WIDGET_SIZES.includes(entry?.size) ? entry.size : DEFAULT_WIDGET_SIZE;
        const { periods, chartTypes, defaultPeriod, defaultChartType } = this._opcionesWidget(id);
        const rawPeriod = typeof entry === 'string' ? undefined : entry?.period;
        const rawChart = typeof entry === 'string' ? undefined : entry?.chartType;
        const period = periods.includes(rawPeriod) ? rawPeriod : defaultPeriod;
        const chartType = chartTypes.includes(rawChart) ? rawChart : defaultChartType;
        const rawInstanceId = typeof entry === 'string' ? undefined : entry?.instanceId;
        const instanceId = (typeof rawInstanceId === 'string' && rawInstanceId.trim())
          ? rawInstanceId.trim()
          : this._instanceIdLegacy(id);
        // Mosaicos de indicador: `indicatorId` se conserva (y es obligatorio);
        // el resto de los mosaicos mantiene exactamente su estructura previa.
        if (DASHBOARD_WIDGETS[id]?.requiresIndicator) {
          const rawIndicatorId = typeof entry === 'string' ? undefined : entry?.indicatorId;
          const indicatorId = typeof rawIndicatorId === 'string' ? rawIndicatorId.trim() : '';
          if (!UUID_REGEX.test(indicatorId)) return null;
          return { id, instanceId, size, period, chartType, indicatorId };
        }
        return { id, instanceId, size, period, chartType };
      })
      .filter(Boolean);

    // Deduplicación defensiva por `instanceId` (antes era por `id`): dos entradas
    // con el mismo `instanceId` son la misma instancia. Se conserva la primera
    // aparición y se preserva el orden. Distintas instancias del mismo `id`
    // conviven sin problema.
    const vistos = new Set();
    return normalizados.filter(w => {
      if (vistos.has(w.instanceId)) return false;
      vistos.add(w.instanceId);
      return true;
    });
  }

  // Validación estricta para el guardado:
  //   - `instanceId` explícito debe ser un string no vacío → 400.
  //   - `period` / `chartType` explícito con un valor no permitido para esa
  //     métrica → 400.
  // Las entradas legacy (string o sin esas claves) no disparan error.
  _validarEntradasWidgets(widgetsInput) {
    (widgetsInput || []).forEach(entry => {
      if (typeof entry === 'string' && DASHBOARD_WIDGETS[entry]?.requiresIndicator) {
        throw Object.assign(new Error(`El mosaico "${entry}" requiere "indicatorId".`), { status: 400 });
      }
      if (typeof entry === 'string' || !entry || typeof entry !== 'object') return;
      if (entry.instanceId !== undefined && entry.instanceId !== null
          && (typeof entry.instanceId !== 'string' || entry.instanceId.trim() === '')) {
        throw Object.assign(
          new Error('Cada mosaico con "instanceId" debe usar un string no vacío.'),
          { status: 400 }
        );
      }
      const widget = DASHBOARD_WIDGETS[entry.id];
      if (!widget) return; // IDs desconocidos ya se rechazan en `guardarConfiguracion`
      if (widget.requiresIndicator) {
        if (typeof entry.indicatorId !== 'string' || !UUID_REGEX.test(entry.indicatorId.trim())) {
          throw Object.assign(new Error(`El mosaico "${entry.id}" requiere un "indicatorId" válido.`), { status: 400 });
        }
      } else if (entry.indicatorId !== undefined) {
        throw Object.assign(new Error(`"indicatorId" solo se admite en mosaicos de indicador (mosaico "${entry.id}").`), { status: 400 });
      }
      if (entry.period !== undefined && entry.period !== null) {
        const permitidos = widget.periods || WIDGET_PERIODS;
        if (!permitidos.includes(entry.period)) {
          throw Object.assign(
            new Error(`Período inválido para el mosaico "${entry.id}": "${entry.period}". Opciones: ${permitidos.join(', ')}.`),
            { status: 400 }
          );
        }
      }
      if (entry.chartType !== undefined && entry.chartType !== null) {
        const permitidos = widget.allowedChartTypes || CHART_TYPES;
        if (!permitidos.includes(entry.chartType)) {
          throw Object.assign(
            new Error(`Visualización inválida para el mosaico "${entry.id}": "${entry.chartType}". Opciones: ${permitidos.join(', ')}.`),
            { status: 400 }
          );
        }
      }
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
    if (widget.requiresModules && !widget.requiresModules.every(m => allowedModules.includes(m))) return false;
    if (widget.requiresRole && !widget.requiresRole.includes(userRole)) return false;
    return true;
  }

  // Mosaicos de indicador: el `indicatorId` debe existir. Uno inactivo solo se
  // admite si esa misma instancia ya lo usaba en la configuración guardada — no
  // se agregan mosaicos nuevos con indicadores inactivos, pero volver a guardar
  // un tablero existente no falla.
  _validarIndicadores(widgets, estadoPorId, widgetsPrevios) {
    const previos = new Set(this._normalizarWidgets(widgetsPrevios)
      .filter(w => w.indicatorId)
      .map(w => `${w.instanceId}|${w.indicatorId}`));
    const inexistentes = new Set();
    const inactivos = new Set();
    for (const w of widgets) {
      if (!DASHBOARD_WIDGETS[w.id]?.requiresIndicator) continue;
      if (!estadoPorId.has(w.indicatorId)) inexistentes.add(w.indicatorId);
      else if (!estadoPorId.get(w.indicatorId) && !previos.has(`${w.instanceId}|${w.indicatorId}`)) inactivos.add(w.indicatorId);
    }
    if (inexistentes.size > 0) {
      throw Object.assign(new Error(`Indicador(es) inexistente(s): ${[...inexistentes].join(', ')}.`), { status: 400 });
    }
    if (inactivos.size > 0) {
      throw Object.assign(
        new Error(`Indicador(es) inactivo(s): ${[...inactivos].join(', ')}. No pueden agregarse como nuevos mosaicos.`),
        { status: 400 }
      );
    }
  }

  async _verificarIndicadores(widgets, obtenerWidgetsPrevios) {
    const ids = widgets.filter(w => DASHBOARD_WIDGETS[w.id]?.requiresIndicator).map(w => w.indicatorId);
    if (ids.length === 0) return;
    const [estadoPorId, widgetsPrevios] = await Promise.all([
      indicadoresService.obtenerEstadoIndicadores(ids),
      obtenerWidgetsPrevios(),
    ]);
    this._validarIndicadores(widgets, estadoPorId, widgetsPrevios);
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

    // Acepta strings (formato viejo), {id, size} y {id, instanceId, size,
    // period, chartType}. Instancias repetidas (mismo `instanceId`) se quedan
    // con la primera aparición, preservando el orden; dos instancias distintas
    // del mismo `id` se conservan ambas.
    const widgetsUnicos = this._normalizarWidgets(widgetsInput);

    const idsDesconocidos = [...new Set(widgetsUnicos.filter(w => !DASHBOARD_WIDGETS[w.id]).map(w => w.id))];
    if (idsDesconocidos.length > 0) {
      throw Object.assign(
        new Error(`Mosaico(s) desconocido(s): ${idsDesconocidos.join(', ')}.`),
        { status: 400 }
      );
    }

    this._validarEntradasWidgets(widgetsInput);

    const allowedModules = await this._modulosHabilitados(usuarioId);

    const idsNoAutorizados = [...new Set(widgetsUnicos.filter(w => !this._widgetPermitido(w.id, allowedModules, userRole)).map(w => w.id))];
    if (idsNoAutorizados.length > 0) {
      throw Object.assign(
        new Error(`No tenés permisos para agregar el/los mosaico(s): ${idsNoAutorizados.join(', ')}.`),
        { status: 403 }
      );
    }

    await this._verificarIndicadores(widgetsUnicos, async () => {
      const { data: previa, error: errPrevia } = await supabase
        .from('dashboard_configuraciones')
        .select('widgets')
        .eq('usuario_id', usuarioId)
        .maybeSingle();
      if (errPrevia) throw errPrevia;
      return previa?.widgets || [];
    });

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
