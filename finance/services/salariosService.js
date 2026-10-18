const supabase = require('../../config/supabase')
const { resolverPeriodo, rangoMes } = require('../../utils/periodo')

// Normaliza contacto opcional: "", "   " o undefined pasan a null.
// Evita que valores vacíos choquen contra los índices únicos parciales de email/teléfono.
function normalizarContacto(valor) {
  if (valor === undefined || valor === null) return null
  const trimmed = String(valor).trim()
  return trimmed === '' ? null : trimmed
}

// Traduce violaciones de unicidad de Postgres (23505) a mensajes claros para el frontend,
// en vez de exponer el detalle técnico del constraint/índice.
function mapearErrorDuplicado(error) {
  if (error?.code !== '23505') return null
  const detalle = `${error.message || ''} ${error.details || ''}`.toLowerCase()
  if (detalle.includes('email')) {
    return Object.assign(new Error('Ya existe un empleado registrado con ese email.'), { status: 409 })
  }
  if (detalle.includes('telefono')) {
    return Object.assign(new Error('Ya existe un empleado registrado con ese teléfono.'), { status: 409 })
  }
  return Object.assign(new Error('El registro ya existe.'), { status: 409 })
}

const presente = (valor) => valor !== undefined && valor !== null && valor !== ''

// Movimientos en pesos: la cantidad, si se envía, y el monto final deben ser mayores a 0.
function validarCantidadPesos(cantidad) {
  if (presente(cantidad) && !(Number(cantidad) > 0))
    throw Object.assign(new Error('La cantidad debe ser mayor a 0'), { status: 400 })
}

function validarMontoPesos(monto) {
  if (!(monto > 0))
    throw Object.assign(new Error('El monto debe ser mayor a 0'), { status: 400 })
}

// Alta: moneda_origen 'USD' solo es válida para empleados que cobran en dólares.
function validarMonedaOrigen(empleado, moneda_origen) {
  if (moneda_origen === 'USD' && empleado.moneda !== 'USD') {
    throw Object.assign(
      new Error(`Moneda inconsistente con el empleado: se informó USD pero el empleado cobra en ${empleado.moneda || 'ARS'}.`),
      { status: 400 }
    )
  }
}

// La moneda de un movimiento guardado no se puede cambiar en la edición.
function validarMonedaSinCambios(guardado, moneda_origen) {
  const monedaGuardada = guardado.moneda_origen || 'ARS'
  if (presente(moneda_origen) && moneda_origen !== monedaGuardada) {
    throw Object.assign(
      new Error(`No se puede cambiar la moneda del movimiento: está registrado en ${monedaGuardada} y se envió ${moneda_origen}.`),
      { status: 400 }
    )
  }
}

// RN-03 (docs/convencion-identificadores.md, sección 6). Los pesos que se guardan
// siempre los calcula el backend: dólares × cotización, a 2 decimales. Si se envió
// un monto en pesos (monto_ars o monto) que difiere en más de 1 peso, se rechaza.
function convertirUsdAPesos(usd, cotizacion, { monto_ars, monto }) {
  if (!(cotizacion > 0))
    throw Object.assign(new Error('Los movimientos en dólares requieren la cotización usada (mayor a 0).'), { status: 400 })
  if (!(usd > 0))
    throw Object.assign(new Error('El monto en dólares debe ser mayor a cero.'), { status: 400 })

  const ars = Math.round(usd * cotizacion * 100) / 100
  const arsEnviado = presente(monto_ars) ? monto_ars : monto
  if (presente(arsEnviado) && !(Math.abs(Number(arsEnviado) - ars) <= 1)) {
    throw Object.assign(
      new Error(`El monto en pesos (${arsEnviado}) no coincide con USD ${usd} × ${cotizacion} = ${ars}. Ajustá el monto en dólares.`),
      { status: 400 }
    )
  }
  return { usd, cotizacion, ars }
}

// Alta: los dólares salen del empleado (por hora o turno: monto base × cantidad;
// mensual: el monto_origen enviado o, si no viene, el monto base).
function calcularMontosUsdAlta(empleado, body) {
  const base = Number(empleado.monto_base) || 0
  const usd = empleado.tipo_salario === 'mensual'
    ? (presente(body.monto_origen) ? Number(body.monto_origen) : base)
    : base * Number(body.cantidad)
  return convertirUsdAPesos(usd, Number(body.cotizacion_usada), body)
}

// Edición: solo cuenta el movimiento guardado, no el empleado actual. monto_origen y
// cotización son los enviados o, si no vienen, los guardados.
function calcularMontosUsdEdicion(guardado, body) {
  const usd = Number(presente(body.monto_origen) ? body.monto_origen : guardado.monto_origen)
  const cotizacion = Number(presente(body.cotizacion_usada) ? body.cotizacion_usada : guardado.cotizacion_usada)
  return convertirUsdAPesos(usd, cotizacion, body)
}

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
        nombre, apellido,
        email: normalizarContacto(email),
        telefono: normalizarContacto(telefono),
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
    if (error) throw mapearErrorDuplicado(error) || error
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
      nombre, apellido,
      email: normalizarContacto(email),
      telefono: normalizarContacto(telefono),
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
    if (error) throw mapearErrorDuplicado(error) || error
    return data
  }

  async eliminarEmpleado(id) {
    // Un empleado que integra (o integró) el organigrama no se borra físicamente:
    // se preserva para trazabilidad histórica y solo se desactiva. La FK
    // organigrama_empleado_id_fkey (ON DELETE RESTRICT) refuerza esto en la base.
    const { data: nodos, error: nodoErr } = await supabase
      .from('organigrama')
      .select('id')
      .eq('empleado_id', id)
      .limit(1)
    if (nodoErr) throw nodoErr

    if (nodos?.length) {
      const { data, error } = await supabase
        .from('empleados')
        .update({ estado: 'Inactivo' })
        .eq('id', id)
        .select()
        .single()
      if (error) throw error
      return {
        message: 'El empleado forma parte del organigrama y no puede eliminarse físicamente: se marcó como Inactivo.',
        data,
      }
    }

    const { error } = await supabase.from('empleados').delete().eq('id', id)
    if (error) {
      if (error.code === '23503') {
        throw Object.assign(
          new Error('No se puede eliminar: el empleado está vinculado al organigrama. Se recomienda marcarlo como Inactivo.'),
          { status: 409 }
        )
      }
      throw error
    }
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

  async obtenerMovimientoPorId(id) {
    const { data, error } = await supabase
      .from('movimientos_salario')
      .select('*')
      .eq('id', id)
      .single()
    // PGRST116: .single() sin filas
    if (error && error.code && error.code !== 'PGRST116') throw error
    if (!data) throw Object.assign(new Error('Movimiento no encontrado'), { status: 404 })
    return data
  }

  async crearMovimiento(body, email = null) {
    const {
      empleado_id, categoria_id, monto, fecha, descripcion, cantidad,
      moneda_origen, monto_origen, cotizacion_usada, monto_ars,
    } = body
    if (!empleado_id || !categoria_id || !fecha)
      throw Object.assign(new Error('Faltan campos obligatorios: empleado_id, categoria_id, fecha'), { status: 400 })

    let montoFinal = Number(monto) || 0
    const empleado = await this.obtenerEmpleadoPorId(empleado_id)
    validarMonedaOrigen(empleado, moneda_origen)
    // En el alta, el movimiento es en dólares si el empleado cobra en dólares
    const usd = empleado.moneda === 'USD' ? calcularMontosUsdAlta(empleado, body) : null

    if (usd) {
      montoFinal = usd.ars
    } else {
      if (cantidad !== undefined) {
        // Movimiento ARS con cantidad (hora/turno): el backend recalcula
        validarCantidadPesos(cantidad)
        const base = Number(empleado.monto_base) || 0
        const cant = Number(cantidad)
        montoFinal = empleado.tipo_salario === 'mensual' ? base : base * cant
      }
      validarMontoPesos(montoFinal)
    }

    if (!montoFinal || montoFinal === 0)
      throw Object.assign(new Error('El monto no puede ser cero'), { status: 400 })

    const { data, error } = await supabase
      .from('movimientos_salario')
      .insert([{
        empleado_id, categoria_id, monto: montoFinal, fecha, descripcion,
        cuenta_contrapartida: body.cuenta_contrapartida || null,
        moneda_origen:    usd ? 'USD' : (moneda_origen || 'ARS'),
        monto_origen:     usd ? usd.usd : (monto_origen ? Number(monto_origen) : null),
        cotizacion_usada: usd ? usd.cotizacion : (cotizacion_usada ? Number(cotizacion_usada) : null),
        monto_ars:        usd ? usd.ars : null,
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
    const { empleado_id, categoria_id, monto, fecha, descripcion, cantidad, moneda_origen } = body
    if (!empleado_id || !categoria_id || !fecha)
      throw Object.assign(new Error('Faltan campos obligatorios: empleado_id, categoria_id, fecha'), { status: 400 })

    let montoFinal = Number(monto) || 0
    const guardado = await this.obtenerMovimientoPorId(id)
    // En la edición manda el movimiento guardado: su moneda no cambia y, si es en
    // dólares, los montos salen de él y no del empleado actual
    validarMonedaSinCambios(guardado, moneda_origen)
    const usd = guardado.moneda_origen === 'USD' ? calcularMontosUsdEdicion(guardado, body) : null

    if (usd) {
      montoFinal = usd.ars
    } else {
      if (cantidad !== undefined) {
        validarCantidadPesos(cantidad)
        const empleado = await this.obtenerEmpleadoPorId(empleado_id)
        const base = Number(empleado.monto_base) || 0
        const cant = Number(cantidad)
        montoFinal = empleado.tipo_salario === 'mensual' ? base : base * cant
      }
      validarMontoPesos(montoFinal)
    }

    if (!montoFinal || montoFinal === 0)
      throw Object.assign(new Error('El monto no puede ser cero'), { status: 400 })

    const cambios = { empleado_id, categoria_id, monto: montoFinal, fecha, descripcion, cuenta_contrapartida: body.cuenta_contrapartida || null }
    if (usd) Object.assign(cambios, { moneda_origen: 'USD', monto_origen: usd.usd, cotizacion_usada: usd.cotizacion, monto_ars: usd.ars })

    const { data, error } = await supabase
      .from('movimientos_salario')
      .update(cambios)
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

  async getMetricas({ mes, anio } = {}) {
    const { mes: targetMes, anio: targetAnio } = resolverPeriodo(mes, anio)
    const { desde: firstDay, hasta: nextMonthFirstDay } = rangoMes(targetMes, targetAnio)

    const [{ count: totalEmpleados }, { data: movMes }] = await Promise.all([
      supabase.from('empleados').select('id', { count: 'exact', head: true }).eq('estado', 'Activo'),
      supabase.from('movimientos_salario').select('monto, categorias_salariales(nombre)').gte('fecha', firstDay).lt('fecha', nextMonthFirstDay),
    ])

    const totalNomina = movMes
      ? movMes.reduce((sum, m) => sum + Number(m.monto), 0)
      : 0

    return { totalEmpleados: totalEmpleados || 0, totalNomina }
  }
}

module.exports = new SalariosService()
