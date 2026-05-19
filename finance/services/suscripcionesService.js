const supabase = require('../../config/supabase');

const ESTADOS_VALIDOS    = ['activa', 'pausada', 'cancelada'];
const MONEDAS_VALIDAS    = ['ARS', 'USD'];
const FRECUENCIAS_VALIDAS = ['mensual', 'trimestral', 'semestral', 'anual'];

class SuscripcionesService {
  async listar({ estado, search } = {}) {
    let query = supabase
      .from('suscripciones')
      .select('*')
      .order('nombre', { ascending: true });

    if (estado && estado !== 'Todas') query = query.eq('estado', estado);
    if (search) {
      query = query.or(
        `nombre.ilike.%${search}%,detalle.ilike.%${search}%,proveedor.ilike.%${search}%`
      );
    }

    const { data, error } = await query;
    if (error) throw error;
    return { data, total: data.length };
  }

  async obtenerPorId(id) {
    const { data, error } = await supabase
      .from('suscripciones')
      .select('*')
      .eq('id', id)
      .single();
    if (error) throw error;
    if (!data) throw Object.assign(new Error('Suscripción no encontrada'), { status: 404 });
    return data;
  }

  _validar({ nombre, monto, moneda, dia_vencimiento, estado, frecuencia }) {
    if (!String(nombre || '').trim())
      throw Object.assign(new Error('El nombre es obligatorio'), { status: 400 });
    if (monto === undefined || monto === null || monto === '')
      throw Object.assign(new Error('El monto es obligatorio'), { status: 400 });
    if (Number(monto) < 0)
      throw Object.assign(new Error('El monto debe ser mayor o igual a 0'), { status: 400 });
    if (!MONEDAS_VALIDAS.includes(moneda))
      throw Object.assign(new Error('Moneda inválida. Opciones: ARS, USD'), { status: 400 });
    const dia = parseInt(dia_vencimiento);
    if (!dia || dia < 1 || dia > 31)
      throw Object.assign(new Error('Día de vencimiento debe ser entre 1 y 31'), { status: 400 });
    if (estado && !ESTADOS_VALIDOS.includes(estado))
      throw Object.assign(new Error(`Estado inválido. Opciones: ${ESTADOS_VALIDOS.join(', ')}`), { status: 400 });
    if (frecuencia !== undefined && !FRECUENCIAS_VALIDAS.includes(frecuencia))
      throw Object.assign(new Error(`Frecuencia inválida. Opciones: ${FRECUENCIAS_VALIDAS.join(', ')}`), { status: 400 });
  }

  async crear(body, email = null) {
    const { nombre, detalle, proveedor, monto, moneda, dia_vencimiento, frecuencia, estado } = body;
    const monedaFinal = MONEDAS_VALIDAS.includes(moneda) ? moneda : 'ARS';
    const frecuenciaFinal = FRECUENCIAS_VALIDAS.includes(frecuencia) ? frecuencia : 'mensual';
    this._validar({ nombre, monto, moneda: monedaFinal, dia_vencimiento, estado, frecuencia: frecuenciaFinal });

    const { data, error } = await supabase
      .from('suscripciones')
      .insert([{
        nombre:          String(nombre).trim(),
        detalle:         detalle ? String(detalle).trim() : null,
        proveedor:       proveedor ? String(proveedor).trim() : null,
        monto:           Number(monto),
        moneda:          monedaFinal,
        dia_vencimiento: parseInt(dia_vencimiento),
        frecuencia:      frecuenciaFinal,
        estado:          ESTADOS_VALIDOS.includes(estado) ? estado : 'activa',
        created_by:      email,
      }])
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async actualizar(id, body, email = null) {
    const { nombre, detalle, proveedor, monto, moneda, dia_vencimiento, frecuencia, estado } = body;
    const monedaFinal    = MONEDAS_VALIDAS.includes(moneda) ? moneda : 'ARS';
    const frecuenciaFinal = FRECUENCIAS_VALIDAS.includes(frecuencia) ? frecuencia : 'mensual';
    this._validar({ nombre, monto, moneda: monedaFinal, dia_vencimiento, estado, frecuencia: frecuenciaFinal });

    const { data, error } = await supabase
      .from('suscripciones')
      .update({
        nombre:          String(nombre).trim(),
        detalle:         detalle ? String(detalle).trim() : null,
        proveedor:       proveedor ? String(proveedor).trim() : null,
        monto:           Number(monto),
        moneda:          monedaFinal,
        dia_vencimiento: parseInt(dia_vencimiento),
        frecuencia:      frecuenciaFinal,
        estado:          ESTADOS_VALIDOS.includes(estado) ? estado : 'activa',
        updated_at:      new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async eliminar(id) {
    const { error } = await supabase.from('suscripciones').delete().eq('id', id);
    if (error) throw error;
    return { message: 'Suscripción eliminada correctamente' };
  }

  _proximaFecha(susc, hoy) {
    const dia = susc.dia_vencimiento;

    function clampedDate(year, month, day) {
      // month is 0-indexed; clamp day to last valid day of month
      const lastDay = new Date(year, month + 1, 0).getDate();
      return new Date(year, month, Math.min(day, lastDay));
    }

    if (susc.frecuencia === 'mensual') {
      const thisMonth = clampedDate(hoy.getFullYear(), hoy.getMonth(), dia);
      if (thisMonth >= hoy) return thisMonth;
      return clampedDate(hoy.getFullYear(), hoy.getMonth() + 1, dia);
    }

    const PERIOD = { trimestral: 3, semestral: 6, anual: 12 };
    const period = PERIOD[susc.frecuencia];
    if (!period) return null;

    // Use created_at as the cycle anchor
    const base = new Date(susc.created_at);
    let year  = base.getFullYear();
    let month = base.getMonth();

    let candidate = clampedDate(year, month, dia);
    while (candidate < hoy) {
      month += period;
      while (month >= 12) { month -= 12; year++; }
      candidate = clampedDate(year, month, dia);
    }
    return candidate;
  }

  // Returns the billing period window for the upcoming vencimiento.
  // mensual  → calendar month of proxima
  // others   → window of N months ending on proxima (inclusive)
  _calcularPeriodo(susc, proxima) {
    if (susc.frecuencia === 'mensual') {
      const inicio = new Date(proxima.getFullYear(), proxima.getMonth(), 1);
      const fin    = new Date(proxima.getFullYear(), proxima.getMonth() + 1, 0);
      return { inicio, fin };
    }
    const MESES = { trimestral: 3, semestral: 6, anual: 12 };
    const meses = MESES[susc.frecuencia] || 1;
    const fin    = new Date(proxima);
    const inicio = new Date(proxima);
    inicio.setMonth(inicio.getMonth() - meses);
    inicio.setDate(inicio.getDate() + 1);
    return { inicio, fin };
  }

  async proximasVencer(dias = 7) {
    const { data, error } = await supabase
      .from('suscripciones')
      .select('*')
      .eq('estado', 'activa');
    if (error) throw error;

    const hoy    = new Date(); hoy.setHours(0, 0, 0, 0);
    const limite = new Date(hoy); limite.setDate(hoy.getDate() + dias);

    // Step 1 — find candidates within the alert window
    const candidatos = [];
    for (const susc of data) {
      if (!susc.dia_vencimiento || !susc.frecuencia) continue;
      const proxima = this._proximaFecha(susc, hoy);
      if (!proxima || proxima < hoy || proxima > limite) continue;
      candidatos.push({ susc, proxima, diasRestantes: Math.round((proxima - hoy) / 86400000) });
    }
    if (candidatos.length === 0) return [];

    // Step 2 — bulk-fetch gastos (13-month window covers even anual cycles)
    const ventanaInicio = new Date(hoy);
    ventanaInicio.setMonth(ventanaInicio.getMonth() - 13);
    const ventanaInicioStr = ventanaInicio.toISOString().split('T')[0];
    const hoyStr           = hoy.toISOString().split('T')[0];

    const suscIds = candidatos.map(c => c.susc.id);

    // Primary: gastos linked directly via suscripcion_id
    const { data: gastosLinked } = await supabase
      .from('movimientos')
      .select('id, suscripcion_id, fecha')
      .eq('tipo', 'Gasto')
      .in('suscripcion_id', suscIds)
      .gte('fecha', ventanaInicioStr)
      .lte('fecha', hoyStr);

    // Fallback: unlinked gastos for text-based matching
    const { data: gastosFallback } = await supabase
      .from('movimientos')
      .select('id, descripcion, proveedor_cliente, fecha')
      .eq('tipo', 'Gasto')
      .is('suscripcion_id', null)
      .gte('fecha', ventanaInicioStr)
      .lte('fecha', hoyStr);

    const linked   = gastosLinked   ?? [];
    const fallback = gastosFallback ?? [];

    // Step 3 — exclude suscripciones that are already paid for this period
    const resultado = [];
    for (const { susc, proxima, diasRestantes } of candidatos) {
      const { inicio, fin } = this._calcularPeriodo(susc, proxima);
      const inicioStr = inicio.toISOString().split('T')[0];
      const finStr    = fin.toISOString().split('T')[0];

      // Primary: direct suscripcion_id match within period
      const pagadoPrimary = linked.some(g =>
        g.suscripcion_id === susc.id &&
        g.fecha >= inicioStr && g.fecha <= finStr
      );
      if (pagadoPrimary) continue;

      // Fallback 1: exact proveedor match (case-insensitive, trimmed, min 3 chars)
      let pagadoFallback = false;
      const provNorm = susc.proveedor?.trim().toLowerCase() ?? '';
      if (provNorm.length >= 3) {
        pagadoFallback = fallback.some(g =>
          g.fecha >= inicioStr && g.fecha <= finStr &&
          g.proveedor_cliente?.trim().toLowerCase() === provNorm
        );
      }

      // Fallback 2: description starts with nombre (case-insensitive, min 5 chars)
      if (!pagadoFallback && susc.nombre?.trim().length >= 5) {
        const nomNorm = susc.nombre.trim().toLowerCase();
        pagadoFallback = fallback.some(g =>
          g.fecha >= inicioStr && g.fecha <= finStr &&
          g.descripcion?.trim().toLowerCase().startsWith(nomNorm)
        );
      }

      if (pagadoFallback) continue;

      resultado.push({
        id:                        susc.id,
        nombre:                    susc.nombre,
        proveedor:                 susc.proveedor,
        monto:                     susc.monto,
        moneda:                    susc.moneda,
        dia_vencimiento:           susc.dia_vencimiento,
        frecuencia:                susc.frecuencia,
        proxima_fecha_vencimiento: proxima.toISOString().split('T')[0],
        dias_restantes:            diasRestantes,
      });
    }

    resultado.sort((a, b) => a.dias_restantes - b.dias_restantes);
    return resultado;
  }
}

module.exports = new SuscripcionesService();
