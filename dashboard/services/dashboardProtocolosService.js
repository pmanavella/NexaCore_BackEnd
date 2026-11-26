const supabase = require('../../config/supabase');
const organizacionService = require('../../organization/services/organizacionService');
const { hoyArgentina } = require('../../indicators/services/periodos');
const { WIDGET_PERIODS } = require('../config/widgets');

// Datos de los mosaicos de Protocolos del Dashboard (solo lectura, informativos).
//
// Permiso: mismo criterio que el resto del Dashboard para Protocolos
// (dashboardOperacionesService y el catálogo de mosaicos): acceso al módulo
// 'protocolos' en la Matriz de permisos.
//
// Período ('month' | '3m' | '6m' | '12m'): 'month' = mes en curso; '3m'/'6m'/'12m'
// = últimos N meses calendario contando el actual. Fechas en hora de Argentina.
// Acota "registros" e "incumplimientos". "Protocolos activos", "últimos registros"
// y "sin registros en 30 días" no dependen del período.
//
// Incumplimiento: un registro (protocolo_pruebas) tiene incumplimientos si algún
// elemento de `resultados` ([{ item_id, estado: 'ok'|'fail'|'na', tildado, texto? }])
// tiene estado === 'fail' (misma regla que GET /api/protocolos/metrics).

const CATEGORIAS = ['robot', 'instalacion', 'hardware', 'rrhh'];
const MESES_POR_PERIODO = { month: 1, '3m': 3, '6m': 6, '12m': 12 };
const DIAS_SIN_REGISTROS = 30;
const LIMITE_DEFAULT = 10;
const LIMITE_MAX = 50;

function error(status, mensaje) {
  return Object.assign(new Error(mensaje), { status });
}

function claveMes(anio, mes) {
  return `${anio}-${String(mes).padStart(2, '0')}`;
}

// Meses calendario [{ clave: 'YYYY-MM' }] que terminan en el mes actual.
function mesesDelPeriodo(periodo, { anio, mes }) {
  const n = MESES_POR_PERIODO[periodo];
  const meses = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(anio, mes - 1 - i, 1));
    meses.push(claveMes(d.getUTCFullYear(), d.getUTCMonth() + 1));
  }
  return meses;
}

function primerDiaMesSiguiente(clave) {
  const [a, m] = clave.split('-').map(Number);
  const d = new Date(Date.UTC(a, m, 1));
  return d.toISOString().slice(0, 10);
}

function restarDias(fecha, dias) {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

function itemsFallidos(resultados) {
  return Array.isArray(resultados) ? resultados.filter(r => r?.estado === 'fail').length : 0;
}

function porcentaje(parte, total) {
  return total > 0 ? Math.round((parte / total) * 1000) / 10 : 0;
}

class DashboardProtocolosService {
  normalizarParametros({ period, limite } = {}) {
    const periodo = period === undefined || period === '' ? 'month' : period;
    if (!WIDGET_PERIODS.includes(periodo)) {
      throw error(400, `Período inválido: "${period}". Opciones: ${WIDGET_PERIODS.join(', ')}.`);
    }
    let n = LIMITE_DEFAULT;
    if (limite !== undefined && limite !== '') {
      n = Number(limite);
      if (!Number.isInteger(n) || n < 1 || n > LIMITE_MAX) {
        throw error(400, `"limite" debe ser un entero entre 1 y ${LIMITE_MAX}.`);
      }
    }
    return { periodo, limite: n };
  }

  async obtener(user, params = {}, { ahora = new Date() } = {}) {
    const { periodo, limite } = this.normalizarParametros(params);
    const tieneAcceso = await organizacionService.usuarioTieneAccesoModulo(user?.id, 'protocolos');
    if (!tieneAcceso) throw error(403, 'No tiene permisos para acceder al módulo Protocolos.');

    const hoyArg = hoyArgentina(ahora);
    const hoy = hoyArg.fecha;
    const meses = mesesDelPeriodo(periodo, hoyArg);
    const desde = `${meses[0]}-01`;
    const hasta = primerDiaMesSiguiente(meses[meses.length - 1]); // exclusivo
    const desdeSinRegistros = restarDias(hoy, DIAS_SIN_REGISTROS);

    const [protocolosRes, periodoRes, ultimosRes, recientesRes] = await Promise.all([
      supabase.from('protocolos').select('id, nombre, categoria, activo'),
      supabase.from('protocolo_pruebas')
        .select('id, protocolo_id, fecha, resultados')
        .gte('fecha', desde)
        .lt('fecha', hasta),
      supabase.from('protocolo_pruebas')
        .select('id, protocolo_id, fecha, realizado_por, resultados, created_at, protocolos(id, nombre, categoria)')
        .order('fecha', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(limite),
      supabase.from('protocolo_pruebas')
        .select('protocolo_id')
        .gte('fecha', desdeSinRegistros),
    ]);
    for (const r of [protocolosRes, periodoRes, ultimosRes, recientesRes]) if (r.error) throw r.error;

    const activos = (protocolosRes.data || []).filter(p => p.activo === true);
    const registros = periodoRes.data || [];

    // Activos y desglose por categoría
    const porCategoria = Object.fromEntries(CATEGORIAS.map(c => [c, activos.filter(p => p.categoria === c).length]));

    // Registros e incumplimientos en el período, con serie mensual
    const serie = meses.map(mes => ({ mes, total: 0, conIncumplimientos: 0 }));
    const porMes = new Map(serie.map(s => [s.mes, s]));
    let conIncumplimientos = 0;
    for (const r of registros) {
      const fallo = itemsFallidos(r.resultados) > 0;
      if (fallo) conIncumplimientos++;
      const s = porMes.get(String(r.fecha).slice(0, 7));
      if (s) { s.total++; if (fallo) s.conIncumplimientos++; }
    }

    // Últimos registros (los N más recientes, sin importar el período)
    const ultimosRegistros = (ultimosRes.data || []).map(r => {
      const fallidos = itemsFallidos(r.resultados);
      return {
        id: r.id,
        protocoloId: r.protocolo_id,
        protocolo: r.protocolos?.nombre ?? null,
        categoria: r.protocolos?.categoria ?? null,
        fecha: r.fecha,
        realizadoPor: r.realizado_por ?? null,
        conIncumplimientos: fallidos > 0,
        itemsFallidos: fallidos,
      };
    });

    // Protocolos activos sin registros en los últimos 30 días
    const conRegistroReciente = new Set((recientesRes.data || []).map(r => r.protocolo_id));
    const sinRegistros = activos.filter(p => !conRegistroReciente.has(p.id));
    const ultimoPorProtocolo = await this._ultimoRegistroPorProtocolo(sinRegistros.map(p => p.id));
    const protocolosSinRegistros = sinRegistros
      .map(p => ({ id: p.id, nombre: p.nombre, categoria: p.categoria, ultimoRegistro: ultimoPorProtocolo.get(p.id) ?? null }))
      .sort((a, b) => {
        if (a.ultimoRegistro !== b.ultimoRegistro) {
          if (a.ultimoRegistro === null) return -1;
          if (b.ultimoRegistro === null) return 1;
          return a.ultimoRegistro < b.ultimoRegistro ? -1 : 1;
        }
        return String(a.nombre).localeCompare(String(b.nombre), 'es');
      });

    return {
      periodo: { period: periodo, desde, hasta: restarDias(hasta, 1), meses },
      protocolosActivos: { total: activos.length, porCategoria },
      registros: { total: registros.length, serie },
      incumplimientos: {
        registrosConIncumplimientos: conIncumplimientos,
        totalRegistros: registros.length,
        porcentaje: porcentaje(conIncumplimientos, registros.length),
      },
      ultimosRegistros,
      sinRegistrosRecientes: { dias: DIAS_SIN_REGISTROS, desde: desdeSinRegistros, protocolos: protocolosSinRegistros },
      generadoEn: ahora.toISOString(),
    };
  }

  // Fecha del último registro de cada protocolo (para el listado "sin registros").
  async _ultimoRegistroPorProtocolo(ids) {
    const ultimo = new Map();
    for (let i = 0; i < ids.length; i += 150) {
      const { data, error: err } = await supabase
        .from('protocolo_pruebas')
        .select('protocolo_id, fecha')
        .in('protocolo_id', ids.slice(i, i + 150))
        .order('fecha', { ascending: false });
      if (err) throw err;
      for (const r of data || []) if (!ultimo.has(r.protocolo_id)) ultimo.set(r.protocolo_id, r.fecha);
    }
    return ultimo;
  }
}

module.exports = new DashboardProtocolosService();
