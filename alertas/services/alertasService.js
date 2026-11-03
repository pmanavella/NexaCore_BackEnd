const supabase = require('../../config/supabase');
const organizacionService = require('../../organization/services/organizacionService');
const { puedeConsultarFinanzas, esMandoAlto } = require('../../finance/config/permisos');
const tareaAsignados = require('../../operations/services/tareaAsignados');
const tablerosService = require('../../operations/services/tablerosService');
const { esTareaAbierta } = require('../../operations/config/etapas');
const indicadoresService = require('../../indicators/services/indicadoresService');
const { hoyArgentina } = require('../../indicators/services/periodos');

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
// Una fuente sin acceso no se evalúa ni se informa. Si una fuente falla (o
// tarda más de PLAZO_FUENTE_MS) se informa en `fuentes` y la respuesta queda
// `parcial`; las demás alertas se devuelven igual.
//
// Fechas: día calendario de Argentina (hoyArgentina, igual que Indicadores).
// Las fechas límite son días sin hora y vencen al terminar ese día.

const DIAS_DEUDAS_POR_VENCER = 3;     // vence hoy o en los próximos 3 días
const DIAS_TAREAS_POR_VENCER = 2;     // vence hoy o mañana (= dentro de 48 h)
const HORAS_NUEVAS_ASIGNACIONES = 24;
const PLAZO_FUENTE_MS = 5000;
const LOTE_IDS = 150;                 // largo de URL de PostgREST con in(...)

const SEVERIDADES = ['alta', 'media', 'info'];

// Destinos de navegación: valores fijos, nunca construidos con datos de la base.
const DESTINOS = Object.freeze({
  deudas:       { modulo: 'finance', seccion: 'deudas' },
  tareas:       { modulo: 'operations', seccion: null },
  indicadores:  { modulo: 'indicadores', seccion: null },
});

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

  // ── Evaluación ────────────────────────────────────────────────────────────

  // Punto de entrada único (endpoint y, a futuro, Nexi). `user` es req.user.
  // `ahora` es inyectable para pruebas.
  async evaluar(user, { ahora = new Date() } = {}) {
    if (!user?.id) throw Object.assign(new Error('No autenticado.'), { status: 401 });
    const hoy = hoyArgentina(ahora).fecha;

    // Permisos primero (en paralelo). Si no se pueden verificar, la fuente se
    // informa como error y no se evalúa: nunca se asume acceso.
    const [finanzas, moduloIndicadores] = await Promise.allSettled([
      this._puedeConsultarFinanzas(user),
      organizacionService.usuarioTieneAccesoModulo(user.id, 'indicadores'),
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
    ].filter(f => f.acceso !== false);

    const resultados = await Promise.all(fuentes.map(async (f) => {
      if (f.acceso === null) return { fuente: f.fuente, estado: 'error', motivo: 'PERMISOS_NO_VERIFICADOS', alertas: [] };
      try {
        return { fuente: f.fuente, estado: 'ok', alertas: await conPlazo(f.evaluar(), this.plazoFuenteMs) };
      } catch (err) {
        console.error(`[Alertas] Fuente ${f.fuente} no disponible:`, err.message);
        return { fuente: f.fuente, estado: 'error', motivo: err.code === 'TIMEOUT' ? 'TIMEOUT' : 'ERROR', alertas: [] };
      }
    }));

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
