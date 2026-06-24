const supabase = require('../../config/supabase');
const gastosHistoricos = require('./migradores/gastosHistoricos');
const comprasInternacionales = require('./migradores/comprasInternacionales');
const sueldosHistoricos = require('./migradores/sueldosHistoricos');
const cuentasPorCobrar = require('./migradores/cuentasPorCobrar');
const totalesFinancieros = require('./migradores/totalesFinancieros');

const MIGRADORES = {
  GASTOS_HISTORICOS: gastosHistoricos,
  COMPRAS_INTERNACIONALES: comprasInternacionales,
  SUELDOS_HISTORICOS: sueldosHistoricos,
  CUENTAS_POR_COBRAR: cuentasPorCobrar,
  TOTALES_FINANCIEROS: totalesFinancieros,
};

// Tabla destino por tipo de migración
const TABLA_DESTINO = {
  GASTOS_HISTORICOS: 'movimientos',
  COMPRAS_INTERNACIONALES: 'inversiones_historicas',
  SUELDOS_HISTORICOS: 'sueldos_historicos',
  CUENTAS_POR_COBRAR: 'cuentas_por_cobrar',
  TOTALES_FINANCIEROS: 'conciliaciones_migracion',
};

const TIPOS_INFO = [
  {
    id: 'GASTOS_HISTORICOS',
    label: 'Gastos Históricos',
    descripcion: 'Planilla de gastos mensuales. Columnas: Nombre, Cantidad, Concepto, Descripción, Total, Entregado.',
    columnas_esperadas: ['Nombre', 'Total'],
    columnas_opcionales: ['Cantidad', 'Concepto', 'Descripción', 'Entregado'],
    requiere_fecha_global: true,
    destino: 'movimientos',
  },
  {
    id: 'COMPRAS_INTERNACIONALES',
    label: 'Compras Internacionales / Inversiones',
    descripcion: 'Planilla de compras China. Columnas: Nombre, Cantidad, Concepto, Total USD, Total Pesos, USD Fecha.',
    columnas_esperadas: ['Nombre', 'Total USD o Total Pesos'],
    columnas_opcionales: ['Cantidad', 'Concepto', 'USD Fecha'],
    requiere_fecha_global: false,
    destino: 'inversiones_historicas',
  },
  {
    id: 'SUELDOS_HISTORICOS',
    label: 'Sueldos Históricos',
    descripcion: 'Planilla de sueldos consolidados por mes. Columnas: Mes, Fijo USD, Fijo Pesos, Pasantes, Polo Pasan, Por Hora, Total Pesos, Total USD.',
    columnas_esperadas: ['Mes', 'Total Pesos o Total USD'],
    columnas_opcionales: ['Fijo USD', 'Fijo Pesos', 'Pasantes', 'Polo Pasan', 'Por Hora'],
    requiere_fecha_global: false,
    destino: 'sueldos_historicos',
  },
  {
    id: 'CUENTAS_POR_COBRAR',
    label: 'Cuentas por Cobrar',
    descripcion: 'Planilla de deudores pendientes. Columnas: Nombre, Cantidad, Costo Total, Concepto.',
    columnas_esperadas: ['Nombre', 'Costo Total'],
    columnas_opcionales: ['Cantidad', 'Concepto'],
    requiere_fecha_global: false,
    destino: 'cuentas_por_cobrar',
  },
  {
    id: 'TOTALES_FINANCIEROS',
    label: 'Totales Financieros (Conciliación)',
    descripcion: 'Resumen financiero para auditoría. No genera movimientos — guarda el archivo completo como registro de conciliación.',
    columnas_esperadas: ['Cualquier columna de totales'],
    columnas_opcionales: [],
    requiere_fecha_global: false,
    destino: 'conciliaciones_migracion',
  },
];

class MigracionService {
  listarTipos() {
    return { tipos: TIPOS_INFO };
  }

  // Preview sin writes: parsea, valida y devuelve muestra de las primeras filas
  async preview(buffer, { tipo_migracion, ...params }) {
    const migrador = MIGRADORES[tipo_migracion];
    if (!migrador)
      throw Object.assign(new Error(`Tipo de migración desconocido: "${tipo_migracion}". Opciones: ${Object.keys(MIGRADORES).join(', ')}`), { status: 400 });

    const resultado = migrador.procesar(buffer, params);

    return {
      tipo_migracion,
      destino: TABLA_DESTINO[tipo_migracion],
      filas_total: resultado.filas_total,
      registros_validos: resultado.registros.length,
      registros_rechazados: resultado.errores.length,
      errores: resultado.errores,
      preview: resultado.registros.slice(0, 10).map(r => {
        const { _fila, ...datos } = r;
        return { fila: _fila, ...datos };
      }),
    };
  }

  // Confirmar: crea batch + inserta registros válidos en la tabla destino
  async confirmar(buffer, { tipo_migracion, nombre_archivo, usuario_id, created_by, ...params }) {
    const migrador = MIGRADORES[tipo_migracion];
    if (!migrador)
      throw Object.assign(new Error(`Tipo de migración desconocido: "${tipo_migracion}"`), { status: 400 });

    const resultado = migrador.procesar(buffer, params);

    // Crear el batch de auditoría antes de insertar datos
    const { data: batch, error: batchError } = await supabase
      .from('migration_batches')
      .insert([{
        tipo_migracion,
        nombre_archivo: nombre_archivo || null,
        usuario_id: usuario_id || null,
        registros_detectados: resultado.filas_total,
        registros_creados: 0,
        registros_rechazados: resultado.errores.length,
        estado: 'procesando',
        errores: resultado.errores.length > 0 ? resultado.errores : null,
      }])
      .select()
      .single();

    if (batchError) throw new Error(`Error al registrar el batch: ${batchError.message}`);

    const batchId = batch.id;
    let insertados = 0;

    try {
      insertados = await this._insertarRegistros(tipo_migracion, resultado.registros, batchId, created_by);

      await supabase
        .from('migration_batches')
        .update({ registros_creados: insertados, estado: 'completado' })
        .eq('id', batchId);

    } catch (err) {
      await supabase
        .from('migration_batches')
        .update({ estado: 'fallido', errores: [{ mensaje: err.message }] })
        .eq('id', batchId);
      throw err;
    }

    return {
      success: true,
      batch_id: batchId,
      tipo_migracion,
      destino: TABLA_DESTINO[tipo_migracion],
      registros_detectados: resultado.filas_total,
      registros_creados: insertados,
      registros_rechazados: resultado.errores.length,
      errores: resultado.errores,
    };
  }

  async _insertarRegistros(tipo, registros, batchId, createdBy) {
    if (registros.length === 0) return 0;

    const tabla = TABLA_DESTINO[tipo];
    let insertados = 0;

    const limpios = registros.map(r => {
      const { _fila, ...datos } = r;
      return { ...datos, migration_batch_id: batchId, created_by: createdBy };
    });

    // Insertar en lotes de 100 para respetar límites de Supabase
    for (let i = 0; i < limpios.length; i += 100) {
      const lote = limpios.slice(i, i + 100);
      const { data, error } = await supabase.from(tabla).insert(lote).select('id');
      if (error) throw new Error(`Error al insertar en "${tabla}" (lote ${Math.floor(i / 100) + 1}): ${error.message}`);
      insertados += data.length;
    }

    return insertados;
  }

  async listarBatches({ page = 1, limit = 20, tipo_migracion, estado } = {}) {
    const from = (page - 1) * limit;

    let query = supabase
      .from('migration_batches')
      .select('id, tipo_migracion, nombre_archivo, usuario_id, fecha_importacion, registros_detectados, registros_creados, registros_rechazados, estado, created_at', { count: 'exact' })
      .order('fecha_importacion', { ascending: false })
      .range(from, from + limit - 1);

    if (tipo_migracion) query = query.eq('tipo_migracion', tipo_migracion);
    if (estado) query = query.eq('estado', estado);

    const { data, error, count } = await query;
    if (error) throw error;
    return { data, total: count, page, limit };
  }

  async obtenerBatch(id) {
    const { data, error } = await supabase
      .from('migration_batches')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) throw Object.assign(new Error('Batch de migración no encontrado'), { status: 404 });
    return data;
  }

  async revertirBatch(id) {
    const batch = await this.obtenerBatch(id);

    if (batch.estado === 'revertido')
      throw Object.assign(new Error('Este batch ya fue revertido previamente'), { status: 400 });

    if (batch.estado === 'procesando')
      throw Object.assign(new Error('El batch está siendo procesado, espere a que finalice'), { status: 409 });

    const tabla = TABLA_DESTINO[batch.tipo_migracion];
    const { error } = await supabase
      .from(tabla)
      .delete()
      .eq('migration_batch_id', id);

    if (error) throw new Error(`Error al revertir registros en "${tabla}": ${error.message}`);

    await supabase
      .from('migration_batches')
      .update({ estado: 'revertido' })
      .eq('id', id);

    return {
      success: true,
      batch_id: id,
      tipo_migracion: batch.tipo_migracion,
      tabla_afectada: tabla,
      mensaje: `Migración revertida. Se eliminaron los registros del batch "${id}" de la tabla "${tabla}".`,
    };
  }
}

module.exports = new MigracionService();
