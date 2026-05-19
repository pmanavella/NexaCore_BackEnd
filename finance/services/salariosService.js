const supabase = require('../../config/supabase')

class SalariosService {
  // ── Empleados ────────────────────────────────────────────────

  async listarEmpleados({ estado, search } = {}) {
    let query = supabase
      .from('empleados')
      .select('*')
      .order('apellido', { ascending: true })

    if (estado && estado !== 'Todos') query = query.eq('estado', estado)
    if (search) query = query.or(`nombre.ilike.%${search}%,apellido.ilike.%${search}%,email.ilike.%${search}%`)

    const { data, error } = await query
    if (error) throw error
    return { data, total: data.length }
  }

  async obtenerEmpleadoPorId(id) {
    const { data, error } = await supabase
      .from('empleados')
      .select('*')
      .eq('id', id)
      .single()
    if (error) throw error
    if (!data) throw Object.assign(new Error('Empleado no encontrado'), { status: 404 })
    return data
  }

  async crearEmpleado(body) {
    const {
      nombre, apellido, email, telefono, tipo_permanencia, fecha_ingreso, estado,
      tipo_salario, monto_base, moneda,
      cotizacion_tipo, cotizacion_valor, cotizacion_fecha, cotizacion_fuente,
    } = body
    if (!nombre || !apellido || !tipo_permanencia)
      throw Object.assign(new Error('Faltan campos obligatorios: nombre, apellido, tipo_permanencia'), { status: 400 })

    const tipoSalarioValido = ['mensual', 'hora', 'turno']
    const tipoSalarioFinal = tipoSalarioValido.includes(tipo_salario) ? tipo_salario : 'mensual'
    const modalidadDerived = { mensual: 'Mensual', hora: 'Por Horas', turno: 'Por Turno' }[tipoSalarioFinal]
    const monedaFinal = ['ARS', 'USD'].includes(moneda) ? moneda : 'ARS'

    if (monedaFinal === 'USD' && (!cotizacion_tipo || !cotizacion_valor || !cotizacion_fecha || !cotizacion_fuente)) {
      throw Object.assign(
        new Error('Para empleados en USD debe seleccionar una cotización válida (compra o venta).'),
        { status: 400 }
      )
    }

    const { data, error } = await supabase
      .from('empleados')
      .insert([{
        nombre, apellido, email, telefono,
        tipo_permanencia,
        modalidad_trabajo: modalidadDerived,
        fecha_ingreso,
        estado: estado || 'Activo',
        tipo_salario: tipoSalarioFinal,
        monto_base: monto_base ? Number(monto_base) : 0,
        moneda: monedaFinal,
        cotizacion_tipo:   monedaFinal === 'USD' ? cotizacion_tipo                : null,
        cotizacion_valor:  monedaFinal === 'USD' ? Number(cotizacion_valor)       : null,
        cotizacion_fecha:  monedaFinal === 'USD' ? cotizacion_fecha               : null,
        cotizacion_fuente: monedaFinal === 'USD' ? cotizacion_fuente              : null,
      }])
      .select()
      .single()
    if (error) throw error
    return data
  }

  async actualizarEmpleado(id, body) {
    const {
      nombre, apellido, email, telefono, tipo_permanencia, fecha_ingreso, estado,
      tipo_salario, monto_base, moneda,
      cotizacion_tipo, cotizacion_valor, cotizacion_fecha, cotizacion_fuente,
    } = body
    const tipoSalarioValido = ['mensual', 'hora', 'turno']
    const tipoSalarioFinal = tipoSalarioValido.includes(tipo_salario) ? tipo_salario : 'mensual'
    const monedaFinal = ['ARS', 'USD'].includes(moneda) ? moneda : 'ARS'

    if (monedaFinal === 'USD' && (!cotizacion_tipo || !cotizacion_valor || !cotizacion_fecha || !cotizacion_fuente)) {
      throw Object.assign(
        new Error('Para empleados en USD debe seleccionar una cotización válida (compra o venta).'),
        { status: 400 }
      )
    }

    const updates = {
      nombre, apellido, email, telefono,
      tipo_permanencia, fecha_ingreso, estado,
      modalidad_trabajo: { mensual: 'Mensual', hora: 'Por Horas', turno: 'Por Turno' }[tipoSalarioFinal],
      tipo_salario: tipoSalarioFinal,
      moneda: monedaFinal,
      cotizacion_tipo:   monedaFinal === 'USD' ? cotizacion_tipo                : null,
      cotizacion_valor:  monedaFinal === 'USD' ? Number(cotizacion_valor)       : null,
      cotizacion_fecha:  monedaFinal === 'USD' ? cotizacion_fecha               : null,
      cotizacion_fuente: monedaFinal === 'USD' ? cotizacion_fuente              : null,
    }
    if (monto_base !== undefined) updates.monto_base = Number(monto_base) || 0

    const { data, error } = await supabase
      .from('empleados')
      .update(updates)
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  }

  async eliminarEmpleado(id) {
    const { error } = await supabase.from('empleados').delete().eq('id', id)
    if (error) throw error
    return { message: 'Empleado eliminado correctamente' }
  }

  // ── Cotización del dólar ─────────────────────────────────────

  async getCotizacionDiaria() {
    const hoy = new Date().toISOString().split('T')[0]
    const { data, error } = await supabase
      .from('cotizaciones_dolar')
      .select('*')
      .eq('fecha', hoy)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return { data }
  }

  async guardarCotizacion({ fecha, fuente, tipo, valor_compra, valor_venta, valor_referencia }) {
    // Idempotente: no duplica si ya existe para esa fecha+fuente
    const { data: existente } = await supabase
      .from('cotizaciones_dolar')
      .select('id')
      .eq('fecha', fecha)
      .eq('fuente', fuente)
      .limit(1)
      .maybeSingle()

    if (existente) return { data: existente }

    const { data, error } = await supabase
      .from('cotizaciones_dolar')
      .insert([{
        fecha,
        fuente,
        tipo:             tipo || 'oficial',
        valor_compra:     valor_compra ? Number(valor_compra) : null,
        valor_venta:      valor_venta  ? Number(valor_venta)  : null,
        valor_referencia: valor_referencia ? Number(valor_referencia) : (valor_venta ? Number(valor_venta) : null),
      }])
      .select()
      .single()
    if (error) throw error
    return { data }
  }

  // ── Categorías salariales ────────────────────────────────────

  async listarCategorias() {
    const { data, error } = await supabase
      .from('categorias_salariales')
      .select('*')
      .order('nombre', { ascending: true })
    if (error) throw error
    return { data, total: data.length }
  }

  async crearCategoria(body) {
    const { nombre, descripcion } = body
    if (!nombre)
      throw Object.assign(new Error('El campo nombre es obligatorio'), { status: 400 })
    const { data, error } = await supabase
      .from('categorias_salariales')
      .insert([{ nombre, descripcion }])
      .select()
      .single()
    if (error) throw error
    return data
  }

  async eliminarCategoria(id) {
    const { error } = await supabase.from('categorias_salariales').delete().eq('id', id)
    if (error) throw error
    return { message: 'Categoría eliminada correctamente' }
  }

  // ── Movimientos salariales ───────────────────────────────────

  async listarMovimientos({ empleado_id, categoria_id, fecha_desde, fecha_hasta } = {}) {
    let query = supabase
      .from('movimientos_salario')
      .select(`
        *,
        empleados (id, nombre, apellido),
        categorias_salariales (id, nombre)
      `)
      .order('fecha', { ascending: false })

    if (empleado_id) query = query.eq('empleado_id', empleado_id)
    if (categoria_id) query = query.eq('categoria_id', categoria_id)
    if (fecha_desde) query = query.gte('fecha', fecha_desde)
    if (fecha_hasta) query = query.lte('fecha', fecha_hasta)

    const { data, error } = await query
    if (error) throw error
    return { data, total: data.length }
  }

  async crearMovimiento(body, email = null) {
    const {
      empleado_id, categoria_id, monto, fecha, descripcion, cantidad,
      moneda_origen, monto_origen, cotizacion_usada, monto_ars,
    } = body
    if (!empleado_id || !categoria_id || !fecha)
      throw Object.assign(new Error('Faltan campos obligatorios: empleado_id, categoria_id, fecha'), { status: 400 })

    let montoFinal = Number(monto) || 0

    if (moneda_origen === 'USD' && monto_ars) {
      // Movimiento en dólares: el frontend ya calculó el equivalente ARS
      montoFinal = Number(monto_ars)
    } else if (cantidad !== undefined) {
      // Movimiento ARS con cantidad (hora/turno): el backend recalcula
      const empleado = await this.obtenerEmpleadoPorId(empleado_id)
      const base = Number(empleado.monto_base) || 0
      const cant = Number(cantidad)
      montoFinal = empleado.tipo_salario === 'mensual' ? base : base * cant
    }

    if (!montoFinal || montoFinal === 0)
      throw Object.assign(new Error('El monto no puede ser cero'), { status: 400 })

    const { data, error } = await supabase
      .from('movimientos_salario')
      .insert([{
        empleado_id, categoria_id, monto: montoFinal, fecha, descripcion,
        cuenta_contrapartida: body.cuenta_contrapartida || null,
        moneda_origen:    moneda_origen || 'ARS',
        monto_origen:     monto_origen  ? Number(monto_origen)     : null,
        cotizacion_usada: cotizacion_usada ? Number(cotizacion_usada) : null,
        monto_ars:        moneda_origen === 'USD' ? montoFinal : null,
        created_by:       email,
      }])
      .select(`
        *,
        empleados (id, nombre, apellido),
        categorias_salariales (id, nombre)
      `)
      .single()
    if (error) throw error
    return data
  }

  async actualizarMovimiento(id, body) {
    const { empleado_id, categoria_id, monto, fecha, descripcion, cantidad } = body
    if (!empleado_id || !categoria_id || !fecha)
      throw Object.assign(new Error('Faltan campos obligatorios: empleado_id, categoria_id, fecha'), { status: 400 })

    let montoFinal = Number(monto) || 0

    if (cantidad !== undefined) {
      const empleado = await this.obtenerEmpleadoPorId(empleado_id)
      const base = Number(empleado.monto_base) || 0
      const cant = Number(cantidad)
      montoFinal = empleado.tipo_salario === 'mensual' ? base : base * cant
    }

    if (!montoFinal || montoFinal === 0)
      throw Object.assign(new Error('El monto no puede ser cero'), { status: 400 })

    const { data, error } = await supabase
      .from('movimientos_salario')
      .update({ empleado_id, categoria_id, monto: montoFinal, fecha, descripcion, cuenta_contrapartida: body.cuenta_contrapartida || null })
      .eq('id', id)
      .select(`
        *,
        empleados (id, nombre, apellido),
        categorias_salariales (id, nombre)
      `)
      .single()
    if (error) throw error
    return data
  }

  async eliminarMovimiento(id) {
    const { error } = await supabase.from('movimientos_salario').delete().eq('id', id)
    if (error) throw error
    return { message: 'Movimiento eliminado correctamente' }
  }

  // ── Métricas ─────────────────────────────────────────────────

  async getMetricas() {
    const now = new Date()
    const year = now.getFullYear()
    const month = now.getMonth() + 1
    const firstDay = `${year}-${String(month).padStart(2, '0')}-01`
    const lastDay = new Date(year, month, 0)
    const lastDayStr = `${year}-${String(month).padStart(2, '0')}-${String(lastDay.getDate()).padStart(2, '0')}`

    const [{ count: totalEmpleados }, { data: movMes }] = await Promise.all([
      supabase.from('empleados').select('id', { count: 'exact', head: true }).eq('estado', 'Activo'),
      supabase.from('movimientos_salario').select('monto, categorias_salariales(nombre)').gte('fecha', firstDay).lte('fecha', lastDayStr),
    ])

    const totalNomina = movMes
      ? movMes.reduce((sum, m) => sum + Number(m.monto), 0)
      : 0

    return { totalEmpleados: totalEmpleados || 0, totalNomina }
  }
}

module.exports = new SalariosService()
