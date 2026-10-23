const supabase = require('../../config/supabase');
const { resolverPeriodo, rangoMes, mesAnterior } = require('../../utils/periodo');
const { TIPOS_VALIDOS, CATEGORIAS_VALIDAS } = require('../config/movimientos');

async function adjuntarUrlsFirmadas(movimientos) {
  return Promise.all((movimientos || []).map(async movimiento => {
    const comprobantes = await Promise.all((movimiento.comprobantes || []).map(async comprobante => {
      if (!comprobante.storage_path) return { ...comprobante, archivo_url: null };
      const { data, error } = await supabase.storage.from('comprobantes').createSignedUrl(comprobante.storage_path, 600);
      if (error) throw new Error(`No se pudo generar acceso seguro al comprobante: ${error.message}`);
      return { ...comprobante, archivo_url: data.signedUrl };
    }));
    return { ...movimiento, comprobantes };
  }));
}

// Máximo de la columna movimientos.monto (numeric(15,2)).
const MONTO_MAXIMO = 9999999999999.99;

const errorValidacion = (mensaje) => Object.assign(new Error(mensaje), { status: 400 });

// Faltante = ausente, null o texto vacío. El número 0 no es un campo faltante.
const faltante = (valor) => valor === undefined || valor === null || (typeof valor === 'string' && !valor.trim());

// Devuelve el monto redondeado a 2 decimales, que es el que se guarda.
function validarMonto(monto) {
  const numero = typeof monto === 'number' ? monto
    : typeof monto === 'string' && monto.trim() ? Number(monto) : NaN;
  if (!Number.isFinite(numero))
    throw errorValidacion('El monto debe ser un número válido');
  if (numero <= 0)
    throw errorValidacion('El monto debe ser mayor a 0');
  const redondeado = Math.round(numero * 100) / 100;
  // Tolerancia de unos pocos ULP: acepta residuos de punto flotante
  // (0.30000000000000004) pero no decimales reales de más (0.001, 1.005).
  if (Math.abs(numero - redondeado) > numero * Number.EPSILON * 4)
    throw errorValidacion('El monto puede tener como máximo 2 decimales');
  if (redondeado > MONTO_MAXIMO)
    throw errorValidacion(`El monto no puede superar ${MONTO_MAXIMO}`);
  return redondeado;
}

// AAAA-MM-DD y que exista en el calendario (2026-02-31 no es válida).
function validarFecha(fecha) {
  const partes = typeof fecha === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (partes) {
    const [, anio, mes, dia] = partes.map(Number);
    const d = new Date(Date.UTC(anio, mes - 1, dia));
    if (d.getUTCFullYear() === anio && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia) return;
  }
  throw errorValidacion('La fecha debe tener formato AAAA-MM-DD y ser una fecha existente');
}

// Devuelve los valores normalizados para guardar.
function validarMovimiento({ fecha, descripcion, categoria, tipo, monto }) {
  if ([fecha, descripcion, categoria, tipo, monto].some(faltante))
    throw errorValidacion('Faltan campos obligatorios: fecha, descripcion, categoria, tipo, monto');
  if (!TIPOS_VALIDOS.includes(tipo))
    throw errorValidacion('Tipo debe ser Ingreso o Gasto');
  if (!CATEGORIAS_VALIDAS.includes(categoria))
    throw errorValidacion(`Categoría inválida. Opciones: ${CATEGORIAS_VALIDAS.join(', ')}`);
  const montoNormalizado = validarMonto(monto);
  validarFecha(fecha);
  return { monto: montoNormalizado };
}

class MovimientosService {
  async listar({ tipo, categoria, fecha_desde, fecha_hasta, search } = {}) {
    let query = supabase
      .from('movimientos')
      .select('*, comprobantes (id, nombre_archivo, storage_path, estado_analisis)')
      .order('fecha', { ascending: false });

    if (tipo && tipo !== 'Todos') query = query.eq('tipo', tipo);
    if (categoria && categoria !== 'Todos') query = query.eq('categoria', categoria);
    if (fecha_desde) query = query.gte('fecha', fecha_desde);
    if (fecha_hasta) query = query.lte('fecha', fecha_hasta);
    if (search) query = query.ilike('descripcion', `%${search}%`);

    const { data, error } = await query;
    if (error) throw error;
    return { data: await adjuntarUrlsFirmadas(data), total: data.length };
  }

  async obtenerMetricas({ mes, anio } = {}) {
    const { mes: targetMes, anio: targetAnio } = resolverPeriodo(mes, anio);
    const { desde: firstDay, hasta: nextMonthFirstDay } = rangoMes(targetMes, targetAnio);

    const { mes: prevMes, anio: prevAnio } = mesAnterior(targetMes, targetAnio);
    const { desde: prevFirst, hasta: prevNextFirstDay } = rangoMes(prevMes, prevAnio);

    const [{ data: mesActual }, { data: mesAnteriorData }, { count: comprobantesRevision }, { data: porCategoria }] = await Promise.all([
      supabase.from('movimientos').select('tipo, monto').gte('fecha', firstDay).lt('fecha', nextMonthFirstDay),
      supabase.from('movimientos').select('tipo, monto').gte('fecha', prevFirst).lt('fecha', prevNextFirstDay),
      supabase.from('comprobantes').select('id', { count: 'exact' }).eq('estado_analisis', 'requiere_revision'),
      supabase.from('movimientos').select('categoria, monto').eq('tipo', 'Gasto').gte('fecha', firstDay).lt('fecha', nextMonthFirstDay),
    ]);

    const calcTotales = (arr) => {
      if (!arr) return { ingresos: 0, gastos: 0 };
      return arr.reduce((acc, m) => {
        if (m.tipo === 'Ingreso') acc.ingresos += Number(m.monto);
        else acc.gastos += Number(m.monto);
        return acc;
      }, { ingresos: 0, gastos: 0 });
    };

    const actual = calcTotales(mesActual);
    const anterior = calcTotales(mesAnteriorData);

    const categoriaMap = {};
    if (porCategoria) {
      porCategoria.forEach(m => {
        categoriaMap[m.categoria] = (categoriaMap[m.categoria] || 0) + Number(m.monto);
      });
    }
    const gastosPorCategoria = Object.entries(categoriaMap).map(([cat, total]) => ({ categoria: cat, total }));

    const pctIngreso = anterior.ingresos > 0
      ? ((actual.ingresos - anterior.ingresos) / anterior.ingresos * 100).toFixed(1) : 0;
    const pctGasto = anterior.gastos > 0
      ? ((actual.gastos - anterior.gastos) / anterior.gastos * 100).toFixed(1) : 0;

    return {
      ingresos: actual.ingresos,
      gastos: actual.gastos,
      balance: actual.ingresos - actual.gastos,
      comprobantesRevision: comprobantesRevision || 0,
      pctIngreso: Number(pctIngreso),
      pctGasto: Number(pctGasto),
      gastosPorCategoria,
    };
  }

  // Retorna ingresos y gastos mensuales de los últimos N meses
  // mes y anio opcionales: si se proveen, se usan como mes de referencia (último mes de la ventana)
  async obtenerFlujo({ meses = 6, mes = null, anio = null } = {}) {
    const n = Math.min(Math.max(parseInt(meses) || 6, 1), 24);
    const parsedMes  = mes  ? parseInt(mes)  : null;
    const parsedAnio = anio ? parseInt(anio) : null;
    const refDate = (parsedMes && parsedAnio)
      ? new Date(parsedAnio, parsedMes - 1, 1)
      : new Date();
    const resultado = [];

    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(refDate.getFullYear(), refDate.getMonth() - i, 1);
      const mes = d.getMonth() + 1;
      const anio = d.getFullYear();
      const firstDay = `${anio}-${String(mes).padStart(2, '0')}-01`;
      const lastDayDate = new Date(anio, mes, 0);
      const lastDay = `${anio}-${String(mes).padStart(2, '0')}-${String(lastDayDate.getDate()).padStart(2, '0')}`;
      const label = d.toLocaleDateString('es-AR', { month: 'short' });
      const labelCapital = label.charAt(0).toUpperCase() + label.slice(1);

      const { data } = await supabase
        .from('movimientos')
        .select('tipo, monto')
        .gte('fecha', firstDay)
        .lte('fecha', lastDay);

      const ingresos = (data || []).filter(m => m.tipo === 'Ingreso').reduce((s, m) => s + Number(m.monto), 0);
      const gastos   = (data || []).filter(m => m.tipo === 'Gasto').reduce((s, m) => s + Number(m.monto), 0);

      resultado.push({ mes: labelCapital, ingresos, gastos });
    }

    return { data: resultado };
  }

  async obtenerPorId(id) {
    const { data, error } = await supabase
      .from('movimientos')
      .select('*, comprobantes(*)')
      .eq('id', id)
      .single();
    if (error) throw error;
    if (!data) throw Object.assign(new Error('No encontrado'), { status: 404 });
    const [presentado] = await adjuntarUrlsFirmadas([data]);
    return presentado;
  }

  async crear(body, email = null) {
    const { fecha, descripcion, categoria, tipo, proveedor_cliente, notas, cuenta_contrapartida, suscripcion_id } = body;

    const { monto } = validarMovimiento(body);

    const { data, error } = await supabase
      .from('movimientos')
      .insert([{
        fecha,
        descripcion: String(descripcion).trim(),
        categoria,
        tipo,
        monto,
        proveedor_cliente: proveedor_cliente ? String(proveedor_cliente).trim() : null,
        notas: notas ? String(notas).trim() : null,
        cuenta_contrapartida: cuenta_contrapartida || null,
        suscripcion_id: suscripcion_id || null,
        created_by: email,
      }])
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async actualizar(id, body, email = null) {
    const { fecha, descripcion, categoria, tipo, proveedor_cliente, notas, cuenta_contrapartida, suscripcion_id } = body;

    const { monto } = validarMovimiento(body);

    const { data, error } = await supabase
      .from('movimientos')
      .update({
        fecha,
        descripcion: String(descripcion).trim(),
        categoria,
        tipo,
        monto,
        proveedor_cliente: proveedor_cliente ? String(proveedor_cliente).trim() : null,
        notas: notas ? String(notas).trim() : null,
        cuenta_contrapartida: cuenta_contrapartida || null,
        suscripcion_id: suscripcion_id || null,
        updated_by: email,
      })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async listarTrazabilidad() {
    const { data, error } = await supabase
      .from('movimientos')
      .select('id, fecha, descripcion, tipo, monto, created_by, created_at, updated_by, updated_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { data, total: data.length };
  }

  async eliminar(id) {
    const { data: comps } = await supabase
      .from('comprobantes')
      .select('storage_path')
      .eq('movimiento_id', id);

    if (comps && comps.length > 0) {
      const paths = comps.map(c => c.storage_path);
      await supabase.storage.from('comprobantes').remove(paths);
      await supabase.from('comprobantes').delete().eq('movimiento_id', id);
    }

    const { error } = await supabase.from('movimientos').delete().eq('id', id);
    if (error) throw error;
    return { message: 'Movimiento eliminado correctamente' };
  }
}

module.exports = new MovimientosService();
