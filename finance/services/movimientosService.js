const supabase = require('../../config/supabase');
const { resolverPeriodo, rangoMes, mesAnterior } = require('../../utils/periodo');

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

const TIPOS_VALIDOS = ['Ingreso', 'Gasto'];
const CATEGORIAS_VALIDAS = ['Tecnología', 'RRHH', 'Insumos', 'Servicios', 'Inversión', 'Otros', 'Suscripción'];

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
    const { fecha, descripcion, categoria, tipo, monto, proveedor_cliente, notas, cuenta_contrapartida, suscripcion_id } = body;

    if (!fecha || !String(descripcion || '').trim() || !categoria || !tipo || !monto)
      throw Object.assign(new Error('Faltan campos obligatorios: fecha, descripcion, categoria, tipo, monto'), { status: 400 });
    if (!TIPOS_VALIDOS.includes(tipo))
      throw Object.assign(new Error('Tipo debe ser Ingreso o Gasto'), { status: 400 });
    if (!CATEGORIAS_VALIDAS.includes(categoria))
      throw Object.assign(new Error(`Categoría inválida. Opciones: ${CATEGORIAS_VALIDAS.join(', ')}`), { status: 400 });
    if (Number(monto) <= 0)
      throw Object.assign(new Error('El monto debe ser mayor a 0'), { status: 400 });

    const { data, error } = await supabase
      .from('movimientos')
      .insert([{
        fecha,
        descripcion: String(descripcion).trim(),
        categoria,
        tipo,
        monto: Number(monto),
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
    const { fecha, descripcion, categoria, tipo, monto, proveedor_cliente, notas, cuenta_contrapartida, suscripcion_id } = body;

    if (!fecha || !String(descripcion || '').trim() || !categoria || !tipo || !monto)
      throw Object.assign(new Error('Faltan campos obligatorios: fecha, descripcion, categoria, tipo, monto'), { status: 400 });
    if (!TIPOS_VALIDOS.includes(tipo))
      throw Object.assign(new Error('Tipo debe ser Ingreso o Gasto'), { status: 400 });
    if (!CATEGORIAS_VALIDAS.includes(categoria))
      throw Object.assign(new Error(`Categoría inválida. Opciones: ${CATEGORIAS_VALIDAS.join(', ')}`), { status: 400 });
    if (Number(monto) <= 0)
      throw Object.assign(new Error('El monto debe ser mayor a 0'), { status: 400 });

    const { data, error } = await supabase
      .from('movimientos')
      .update({
        fecha,
        descripcion: String(descripcion).trim(),
        categoria,
        tipo,
        monto: Number(monto),
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
