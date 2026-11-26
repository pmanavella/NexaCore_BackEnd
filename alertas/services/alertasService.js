const supabase = require('../../config/supabase');
const organizacionService = require('../../organization/services/organizacionService');
const { puedeConsultarFinanzas, esMandoAlto } = require('../../finance/config/permisos');
const tareaAsignados = require('../../operations/services/tareaAsignados');
const tablerosService = require('../../operations/services/tablerosService');
const { esTareaAbierta } = require('../../operations/config/etapas');
const indicadoresService = require('../../indicators/services/indicadoresService');
const suscripcionesService = require('../../finance/services/suscripcionesService');
const { hoyArgentina } = require('../../indicators/services/periodos');
const { ROLES_ORGANIGRAMA } = require('../../organization/config/permisos');
const { ALERT_TYPES, ALERT_HORIZONS, DEFAULT_ALERT_HORIZON } = require('../../dashboard/config/widgets');

// Alertas calculadas en el momento a partir del estado actual de los datos.
// No se guardan, no se auditan y no modifican nada: si la condición deja de
// cumplirse, la alerta no aparece en la próxima evaluación.
//
// Cada fuente aplica la MISMA regla de acceso que el endpoint original de sus
// datos y usa solo la identidad de la sesión (req.user):
//   - deudas: consulta de Finanzas RN-02 (consultaFinanzas).
//   - tareas: tableros visibles (miembros; mando alto ve todos), como GET /tareas.
//   - indicadores: acceso al módulo Indicadores + consulta de Finanzas, como
//     GET /indicadores/:id/valor.
//   - externos (organigrama): ver Organización = Superadmin, o rol de
//     ROLES_ORGANIGRAMA (como GET /organizacion/organigrama) con acceso al
//     módulo 'organizacion' (como las herramientas de Organización de Nexi).
//
// Además del resumen agregado (evaluar → GET /api/alertas), `proximas` devuelve
// el DETALLE por ítem para el mosaico "Alertas" del Dashboard
// (GET /api/alertas/proximas): deudas, suscripciones (suscripcionesService.
// proximasVencer, la misma lógica de GET /finance/suscripciones/proximas-vencer)
// y personas externas del organigrama. Mismas reglas de acceso.
// Una fuente sin acceso no se evalúa ni se informa. Si una fuente falla (o
// tarda más de PLAZO_FUENTE_MS) se informa en `fuentes` y la respuesta queda
// `parcial`; las demás alertas se devuelven igual.
//
// Fechas: día calendario de Argentina (hoyArgentina, igual que Indicadores).
// Las fechas límite son días sin hora y vencen al terminar ese día.

const DIAS_DEUDAS_POR_VENCER = 3;     // vence hoy o en los próximos 3 días
const DIAS_TAREAS_POR_VENCER = 2;     // vence hoy o mañana (= dentro de 48 h)
const DIAS_EXTERNOS_POR_VENCER = 7;   // acceso externo que vence hoy o en los próximos 7 días
const DIAS_SEVERIDAD_PROXIMA = 7;     // detalle: 0..7 días → 'proxima'; más lejos → 'informativa'
const HORAS_NUEVAS_ASIGNACIONES = 24;
const PLAZO_FUENTE_MS = 5000;
const LOTE_IDS = 150;                 // largo de URL de PostgREST con in(...)

const SEVERIDADES = ['alta', 'media', 'info'];

// Destinos de navegación: valores fijos, nunca construidos con datos de la base.
const DESTINOS = Object.freeze({
  deudas:       { modulo: 'finance', seccion: 'deudas' },
  tareas:       { modulo: 'operations', seccion: null },
  indicadores:  { modulo: 'indicadores', seccion: null },
  suscripciones: { modulo: 'finance', seccion: 'suscripciones' },
  externos:     { modulo: 'organizacion', seccion: 'organigrama' },
});

function diasEntre(desde, hasta) {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86400000);
}

function fechaLegible(fecha) {
  const [a, m, d] = fecha.split('-');
  return `${d}/${m}/${a}`;
}

// "vence en 5 días (30/11/2026)" · "vence mañana (…)" · "vence hoy (…)" · "venció hace 2 días (…)"
function textoVencimiento(dias, fecha, { presente = 'vence', pasado = 'venció' } = {}) {
  const f = fechaLegible(fecha);
  if (dias === 0) return `${presente} hoy (${f})`;
  if (dias === 1) return `${presente} mañana (${f})`;
  if (dias > 1) return `${presente} en ${dias} días (${f})`;
  if (dias === -1) return `${pasado} ayer (${f})`;
  return `${pasado} hace ${-dias} días (${f})`;
}

function severidadPorDias(dias) {
  if (dias < 0) return 'vencida';
  return dias <= DIAS_SEVERIDAD_PROXIMA ? 'proxima' : 'informativa';
}

// Nombre de una fila del organigrama: usuario o empleado vinculado; si no, el manual.
function nombrePersona(fila) {
  if (fila.usuarios?.nombre) return fila.usuarios.nombre;
  if (fila.empleados) {
    const n = [fila.empleados.nombre, fila.empleados.apellido].filter(Boolean).join(' ');
    if (n) return n;
  }
  return [fila.nombre_manual, fila.apellido_manual].filter(Boolean).join(' ') || 'Persona sin nombre';
}

// Orden del detalle: vencidas primero; dentro de cada grupo, por fecha ascendente.
function compararDetalle(a, b) {
  const va = a.dias_restantes < 0 ? 0 : 1;
  const vb = b.dias_restantes < 0 ? 0 : 1;
  if (va !== vb) return va - vb;
  if (a.fecha_vencimiento !== b.fecha_vencimiento) return a.fecha_vencimiento < b.fecha_vencimiento ? -1 : 1;
  if (a.tipo !== b.tipo) return ALERT_TYPES.indexOf(a.tipo) - ALERT_TYPES.indexOf(b.tipo);
  return String(a.titulo).localeCompare(String(b.titulo), 'es');
}

function error400(mensaje) {
  return Object.assign(new Error(mensaje), { status: 400 });
}

function sumarDias(fecha, dias) {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function plural(n, singular, pluralTexto) {
  return n === 1 ? singular : pluralTexto;
}

function alerta({ id, modulo, tipo, severidad, titulo, mensaje, cantidad, destino }) {
  return { id, modulo, tipo, severidad, titulo, mensaje, cantidad, destino: { ...destino } };
}

async function contar(tabla, filtrar) {
  const { count, error } = await filtrar(supabase.from(tabla).select('id', { count: 'exact', head: true }));
  if (error) throw error;
  return count || 0;
}

function conPlazo(promesa, ms) {
  let timer;
  const plazo = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Plazo agotado'), { code: 'TIMEOUT' })), ms);
  });
  return Promise.race([promesa, plazo]).finally(() => clearTimeout(timer));
}

class AlertasService {
  constructor() {
    this.plazoFuenteMs = PLAZO_FUENTE_MS;
  }

  // ── Permisos (misma regla que cada endpoint original) ─────────────────────

  async _puedeConsultarFinanzas(user) {
    if (esMandoAlto(user)) return true;
    const permisos = await organizacionService.obtenerPermisosUsuario(user.id);
    return puedeConsultarFinanzas(user, permisos);
  }

  // Ver Organización: Superadmin siempre; si no, rol con acceso al organigrama
  // (ROLES_ORGANIGRAMA) Y acceso al módulo 'organizacion' en la Matriz. Si el
  // rol no califica, ni siquiera se consulta la Matriz.
  async _puedeVerOrganizacion(user) {
    if (user?.role === 'Superadmin') return true;
    if (!ROLES_ORGANIGRAMA.includes(user?.role)) return false;
    return (await organizacionService.usuarioTieneAccesoModulo(user.id, 'organizacion')) === true;
  }

  // Tipos del mosaico de Alertas que el usuario puede ver (para el catálogo).
  // Si un permiso no se puede verificar, ese tipo no se ofrece.
  async tiposPermitidos(user) {
    if (!user?.id) return [];
    const [finanzas, organizacion] = await Promise.allSettled([
      this._puedeConsultarFinanzas(user),
      this._puedeVerOrganizacion(user),
    ]);
    const ok = r => r.status === 'fulfilled' && r.value === true;
    return ALERT_TYPES.filter(t => (t === 'externos' ? ok(organizacion) : ok(finanzas)));
  }

  // ── Finanzas ──────────────────────────────────────────────────────────────

  async _alertasDeudas(hoy) {
    const limite = sumarDias(hoy, DIAS_DEUDAS_POR_VENCER);
    // Misma definición que deudasService.getMetricas: no pagada y vencimiento < hoy.
    const [vencidas, porVencer] = await Promise.all([
      contar('deudas', q => q.neq('estado', 'Pagada').lt('vencimiento', hoy)),
      contar('deudas', q => q.neq('estado', 'Pagada').gte('vencimiento', hoy).lte('vencimiento', limite)),
    ]);
    const alertas = [];
    if (vencidas > 0) {
      alertas.push(alerta({
        id: 'finance:deudas:vencidas', modulo: 'finance', tipo: 'deudas_vencidas', severidad: 'alta',
        titulo: 'Deudas vencidas',
        mensaje: `${vencidas} ${plural(vencidas, 'deuda impaga está vencida', 'deudas impagas están vencidas')}.`,
        cantidad: vencidas, destino: DESTINOS.deudas,
      }));
    }
    if (porVencer > 0) {
      alertas.push(alerta({
        id: 'finance:deudas:por_vencer', modulo: 'finance', tipo: 'deudas_por_vencer', severidad: 'media',
        titulo: 'Deudas por vencer',
        mensaje: `${porVencer} ${plural(porVencer, 'deuda vence', 'deudas vencen')} en los próximos ${DIAS_DEUDAS_POR_VENCER} días.`,
        cantidad: porVencer, destino: DESTINOS.deudas,
      }));
    }
    return alertas;
  }

  // ── Operativo ─────────────────────────────────────────────────────────────

  // Tareas (asignaciones, no propuestas) con su etapa, por lotes de ids.
  async _tareasPorIds(ids, filtrar = q => q) {
    const filas = [];
    for (let i = 0; i < ids.length; i += LOTE_IDS) {
      const { data, error } = await filtrar(supabase
        .from('tareas')
        .select('id, estado, fecha_limite, tablero_id, operativo_etapas(tipo_base)')
        .in('id', ids.slice(i, i + LOTE_IDS))
        .or('tipo.is.null,tipo.eq.asignacion'));
      if (error) throw error;
      filas.push(...(data || []));
    }
    return filas;
  }

  // Tareas del usuario (por tarea_asignados, nunca por nombre) que siguen
  // abiertas según el tipo_base de su etapa y cuyo tablero puede ver.
  async _alertasTareas(user, hoy, ahora) {
    const ids = await tareaAsignados.idsTareasDePersona({ usuarioIds: [user.id] });
    if (!ids.length) return [];

    const limite = sumarDias(hoy, DIAS_TAREAS_POR_VENCER);
    const desdeAsignacion = new Date(ahora.getTime() - HORAS_NUEVAS_ASIGNACIONES * 3600 * 1000).toISOString();

    const [visibles, porFecha, recientes] = await Promise.all([
      tablerosService.idsVisibles(user),
      this._tareasPorIds(ids, q => q.lt('fecha_limite', limite)),
      supabase.from('tarea_asignados').select('tarea_id').eq('usuario_id', user.id).gte('created_at', desdeAsignacion),
    ]);
    if (recientes.error) throw recientes.error;
    const idsRecientes = [...new Set((recientes.data || []).map(r => r.tarea_id))];
    const nuevas = idsRecientes.length ? await this._tareasPorIds(idsRecientes) : [];

    // Mismo criterio que _asegurarAccesoTarea: sin tablero, solo el mando alto.
    const accesible = t => (t.tablero_id ? (visibles === null || visibles.includes(t.tablero_id)) : visibles === null);
    const relevante = t => accesible(t) && esTareaAbierta(t);

    const vencidas = porFecha.filter(t => relevante(t) && t.fecha_limite < hoy).length;
    const porVencer = porFecha.filter(t => relevante(t) && t.fecha_limite >= hoy && t.fecha_limite < limite).length;
    const asignadas = nuevas.filter(relevante).length;

    const alertas = [];
    if (vencidas > 0) {
      alertas.push(alerta({
        id: 'operations:tareas:vencidas', modulo: 'operations', tipo: 'tareas_vencidas', severidad: 'alta',
        titulo: 'Tareas vencidas',
        mensaje: `Tenés ${vencidas} ${plural(vencidas, 'tarea abierta vencida', 'tareas abiertas vencidas')}.`,
        cantidad: vencidas, destino: DESTINOS.tareas,
      }));
    }
    if (porVencer > 0) {
      alertas.push(alerta({
        id: 'operations:tareas:por_vencer', modulo: 'operations', tipo: 'tareas_por_vencer', severidad: 'media',
        titulo: 'Tareas por vencer',
        mensaje: `${porVencer} ${plural(porVencer, 'tarea tuya vence', 'tareas tuyas vencen')} hoy o mañana.`,
        cantidad: porVencer, destino: DESTINOS.tareas,
      }));
    }
    if (asignadas > 0) {
      alertas.push(alerta({
        id: 'operations:tareas:nuevas_asignaciones', modulo: 'operations', tipo: 'tareas_nuevas_asignaciones', severidad: 'info',
        titulo: 'Nuevas tareas a tu cargo',
        mensaje: `${asignadas} ${plural(asignadas, 'tarea nueva quedó', 'tareas nuevas quedaron')} a tu cargo en las últimas ${HORAS_NUEVAS_ASIGNACIONES} horas.`,
        cantidad: asignadas, destino: DESTINOS.tareas,
      }));
    }
    return alertas;
  }

  // ── Indicadores ───────────────────────────────────────────────────────────

  async _alertasIndicadores(ahora) {
    const evaluados = await indicadoresService.evaluarUltimoPeriodoCerrado({ ahora });
    const criticos = evaluados.filter(i => i.estado === 'CRITICO').length;
    const enRiesgo = evaluados.filter(i => i.estado === 'EN_RIESGO').length;
    const alertas = [];
    if (criticos > 0) {
      alertas.push(alerta({
        id: 'indicadores:fuera_de_objetivo:critico', modulo: 'indicadores', tipo: 'indicadores_criticos', severidad: 'alta',
        titulo: 'Indicadores en estado crítico',
        mensaje: `${criticos} ${plural(criticos, 'indicador quedó', 'indicadores quedaron')} por debajo del límite aceptable en su último período cerrado.`,
        cantidad: criticos, destino: DESTINOS.indicadores,
      }));
    }
    if (enRiesgo > 0) {
      alertas.push(alerta({
        id: 'indicadores:fuera_de_objetivo:en_riesgo', modulo: 'indicadores', tipo: 'indicadores_en_riesgo', severidad: 'media',
        titulo: 'Indicadores en riesgo',
        mensaje: `${enRiesgo} ${plural(enRiesgo, 'indicador no alcanzó', 'indicadores no alcanzaron')} su objetivo en el último período cerrado.`,
        cantidad: enRiesgo, destino: DESTINOS.indicadores,
      }));
    }
    return alertas;
  }

  // ── Organización: personas externas por vencer ────────────────────────────

  // Filas externas activas con fecha_fin <= limite (incluye las ya vencidas).
  // `lte` excluye fecha_fin NULL (sin vencimiento).
  async _externosHasta(limite) {
    const { data, error } = await supabase
      .from('organigrama')
      .select('id, fecha_fin, cargo, area, nombre_manual, apellido_manual, usuarios(id, nombre), empleados(id, nombre, apellido)')
      .eq('es_externo', true)
      .eq('activo', true)
      .lte('fecha_fin', limite)
      .order('fecha_fin', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async _alertasExternos(hoy) {
    const filas = await this._externosHasta(sumarDias(hoy, DIAS_EXTERNOS_POR_VENCER));
    const vencidos = filas.filter(f => String(f.fecha_fin).slice(0, 10) < hoy).length;
    const porVencer = filas.length - vencidos;
    const alertas = [];
    if (vencidos > 0) {
      alertas.push(alerta({
        id: 'organizacion:externos:vencidos', modulo: 'organizacion', tipo: 'externos_vencidos', severidad: 'alta',
        titulo: 'Accesos externos vencidos',
        mensaje: `${vencidos} ${plural(vencidos, 'persona externa sigue activa con el acceso vencido', 'personas externas siguen activas con el acceso vencido')}.`,
        cantidad: vencidos, destino: DESTINOS.externos,
      }));
    }
    if (porVencer > 0) {
      alertas.push(alerta({
        id: 'organizacion:externos:por_vencer', modulo: 'organizacion', tipo: 'externos_por_vencer', severidad: 'media',
        titulo: 'Accesos externos por vencer',
        mensaje: `El acceso de ${porVencer} ${plural(porVencer, 'persona externa vence', 'personas externas vence')} en los próximos ${DIAS_EXTERNOS_POR_VENCER} días.`,
        cantidad: porVencer, destino: DESTINOS.externos,
      }));
    }
    return alertas;
  }

  // ── Detalle por ítem (mosaico "Alertas" del Dashboard) ────────────────────

  _detalle({ tipo, id, titulo, detalle, fecha, hoy, destino }) {
    const fecha_vencimiento = String(fecha).slice(0, 10);
    const dias_restantes = diasEntre(hoy, fecha_vencimiento);
    return {
      id: `${tipo}:${id}`,
      tipo,
      titulo,
      detalle,
      fecha_vencimiento,
      dias_restantes,
      severidad: severidadPorDias(dias_restantes),
      referencia: { id, modulo: destino.modulo, seccion: destino.seccion },
    };
  }

  // Deudas no pagadas (Pendiente / Vencida) con vencimiento <= hoy + horizonte.
  // Misma definición que _alertasDeudas y deudasService.getMetricas (estado ≠ Pagada).
  async _detalleDeudas(hoy, horizonte) {
    const { data, error } = await supabase
      .from('deudas')
      .select('id, acreedor, descripcion, vencimiento, estado')
      .neq('estado', 'Pagada')
      .lte('vencimiento', sumarDias(hoy, horizonte))
      .order('vencimiento', { ascending: true });
    if (error) throw error;
    return (data || []).map(d => {
      const dias = diasEntre(hoy, String(d.vencimiento).slice(0, 10));
      const acreedor = d.acreedor || 'acreedor sin nombre';
      return this._detalle({
        tipo: 'deudas', id: d.id, hoy, destino: DESTINOS.deudas, fecha: d.vencimiento,
        titulo: dias < 0 ? `Deuda vencida con ${acreedor}` : `Deuda con ${acreedor} por vencer`,
        detalle: `La deuda con ${acreedor}${d.descripcion ? ` (${d.descripcion})` : ''} ${textoVencimiento(dias, String(d.vencimiento).slice(0, 10))}.`,
      });
    });
  }

  // Suscripciones activas por vencer: reutiliza suscripcionesService.proximasVencer
  // (día de vencimiento + frecuencia, excluye las ya pagadas en el período).
  async _detalleSuscripciones(hoy, horizonte) {
    const proximas = await suscripcionesService.proximasVencer(horizonte);
    return proximas.map(s => {
      const fecha = s.proxima_fecha_vencimiento;
      const dias = diasEntre(hoy, fecha);
      return this._detalle({
        tipo: 'suscripciones', id: s.id, hoy, destino: DESTINOS.suscripciones, fecha,
        titulo: `Suscripción ${s.nombre}`,
        detalle: `La suscripción ${s.nombre}${s.proveedor ? ` (${s.proveedor})` : ''} ${textoVencimiento(dias, fecha)}.`,
      });
    });
  }

  async _detalleExternos(hoy, horizonte) {
    const filas = await this._externosHasta(sumarDias(hoy, horizonte));
    return filas.map(f => {
      const fecha = String(f.fecha_fin).slice(0, 10);
      const dias = diasEntre(hoy, fecha);
      const nombre = nombrePersona(f);
      return this._detalle({
        tipo: 'externos', id: f.id, hoy, destino: DESTINOS.externos, fecha,
        titulo: dias < 0 ? `Acceso externo vencido: ${nombre}` : `Acceso externo por vencer: ${nombre}`,
        detalle: `El acceso de ${nombre} ${textoVencimiento(dias, fecha)}.`,
      });
    });
  }

  // Valida y normaliza los parámetros de GET /api/alertas/proximas.
  // `tipos`: string "a,b" o array; vacío/ausente = todos. `horizonte`: 7|15|30.
  normalizarParametrosProximas({ tipos, horizonte } = {}) {
    let lista = Array.isArray(tipos) ? tipos : (typeof tipos === 'string' ? tipos.split(',') : []);
    lista = [...new Set(lista.map(t => String(t).trim()).filter(Boolean))];
    const invalidos = lista.filter(t => !ALERT_TYPES.includes(t));
    if (invalidos.length) throw error400(`Tipo(s) de alerta inválido(s): ${invalidos.join(', ')}. Opciones: ${ALERT_TYPES.join(', ')}.`);
    if (lista.length === 0) lista = [...ALERT_TYPES];

    let dias = DEFAULT_ALERT_HORIZON;
    if (horizonte !== undefined && horizonte !== null && horizonte !== '') {
      dias = Number(horizonte);
      if (!ALERT_HORIZONS.includes(dias)) throw error400(`Horizonte inválido: "${horizonte}". Opciones: ${ALERT_HORIZONS.join(', ')}.`);
    }
    return { tipos: ALERT_TYPES.filter(t => lista.includes(t)), horizonte: dias };
  }

  // Detalle de alertas próximas. Los tipos sin permiso se omiten sin error (no
  // se consultan ni se informan en `fuentes`). `ahora` es inyectable para pruebas.
  async proximas(user, params = {}, { ahora = new Date() } = {}) {
    if (!user?.id) throw Object.assign(new Error('No autenticado.'), { status: 401 });
    const { tipos, horizonte } = this.normalizarParametrosProximas(params);
    const hoy = hoyArgentina(ahora).fecha;

    const necesitaFinanzas = tipos.some(t => t !== 'externos');
    const necesitaOrganizacion = tipos.includes('externos');
    const [finanzas, organizacion] = await Promise.allSettled([
      necesitaFinanzas ? this._puedeConsultarFinanzas(user) : false,
      necesitaOrganizacion ? this._puedeVerOrganizacion(user) : false,
    ]);
    const acceso = (r) => (r.status === 'fulfilled' ? r.value === true : null);
    const evaluadores = {
      deudas:        { acceso: acceso(finanzas),     evaluar: () => this._detalleDeudas(hoy, horizonte) },
      suscripciones: { acceso: acceso(finanzas),     evaluar: () => this._detalleSuscripciones(hoy, horizonte) },
      externos:      { acceso: acceso(organizacion), evaluar: () => this._detalleExternos(hoy, horizonte) },
    };

    const fuentes = tipos.map(t => ({ fuente: t, ...evaluadores[t] })).filter(f => f.acceso !== false);
    const resultados = await Promise.all(fuentes.map(f => this._evaluarFuente(f)));

    const alertas = resultados.flatMap(r => r.alertas).sort(compararDetalle);
    return {
      alertas,
      total: alertas.length,
      horizonte,
      tipos: resultados.map(r => r.fuente),
      generado_en: ahora.toISOString(),
      parcial: resultados.some(r => r.estado === 'error'),
      fuentes: resultados.map(({ fuente, estado, motivo }) => (motivo ? { fuente, estado, motivo } : { fuente, estado })),
    };
  }

  // Ejecuta una fuente con plazo; nunca lanza: informa el error en el resultado.
  async _evaluarFuente(f) {
    if (f.acceso === null) return { fuente: f.fuente, estado: 'error', motivo: 'PERMISOS_NO_VERIFICADOS', alertas: [] };
    try {
      return { fuente: f.fuente, estado: 'ok', alertas: await conPlazo(f.evaluar(), this.plazoFuenteMs) };
    } catch (err) {
      console.error(`[Alertas] Fuente ${f.fuente} no disponible:`, err.message);
      return { fuente: f.fuente, estado: 'error', motivo: err.code === 'TIMEOUT' ? 'TIMEOUT' : 'ERROR', alertas: [] };
    }
  }

  // ── Evaluación ────────────────────────────────────────────────────────────

  // Punto de entrada único (endpoint y, a futuro, Nexi). `user` es req.user.
  // `ahora` es inyectable para pruebas.
  async evaluar(user, { ahora = new Date() } = {}) {
    if (!user?.id) throw Object.assign(new Error('No autenticado.'), { status: 401 });
    const hoy = hoyArgentina(ahora).fecha;

    // Permisos primero (en paralelo). Si no se pueden verificar, la fuente se
    // informa como error y no se evalúa: nunca se asume acceso.
    const [finanzas, moduloIndicadores, organizacion] = await Promise.allSettled([
      this._puedeConsultarFinanzas(user),
      organizacionService.usuarioTieneAccesoModulo(user.id, 'indicadores'),
      this._puedeVerOrganizacion(user),
    ]);
    const acceso = (r) => (r.status === 'fulfilled' ? r.value === true : null); // null = no verificable
    const accesoFinanzas = acceso(finanzas);
    const accesoIndicadores = accesoFinanzas === false ? false
      : (accesoFinanzas === null || acceso(moduloIndicadores) === null) ? null
      : acceso(moduloIndicadores);

    const fuentes = [
      { fuente: 'deudas',      acceso: accesoFinanzas,    evaluar: () => this._alertasDeudas(hoy) },
      { fuente: 'tareas',      acceso: true,              evaluar: () => this._alertasTareas(user, hoy, ahora) },
      { fuente: 'indicadores', acceso: accesoIndicadores, evaluar: () => this._alertasIndicadores(ahora) },
      { fuente: 'externos',    acceso: acceso(organizacion), evaluar: () => this._alertasExternos(hoy) },
    ].filter(f => f.acceso !== false);

    const resultados = await Promise.all(fuentes.map(f => this._evaluarFuente(f)));

    const alertas = resultados
      .flatMap(r => r.alertas)
      .sort((a, b) => SEVERIDADES.indexOf(a.severidad) - SEVERIDADES.indexOf(b.severidad));

    return {
      alertas,
      total: alertas.length,
      generado_en: ahora.toISOString(),
      parcial: resultados.some(r => r.estado === 'error'),
      fuentes: resultados.map(({ fuente, estado, motivo }) => (motivo ? { fuente, estado, motivo } : { fuente, estado })),
    };
  }
}

module.exports = new AlertasService();
