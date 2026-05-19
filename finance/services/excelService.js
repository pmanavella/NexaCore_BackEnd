const XLSX = require('xlsx');
const supabase = require('../../config/supabase');

const CATEGORIAS_VALIDAS = ['Tecnología', 'RRHH', 'Insumos', 'Servicios', 'Inversión', 'Otros'];
const TIPOS_VALIDOS = ['Ingreso', 'Gasto'];
const COLUMNAS_REQUERIDAS = ['fecha', 'descripcion', 'categoria', 'tipo', 'monto'];

class ExcelService {
  parsearFecha(valor) {
    if (!valor) return null;
    if (typeof valor === 'number') {
      const date = new Date((valor - 25569) * 86400 * 1000);
      return date.toISOString().split('T')[0];
    }
    const str = String(valor).trim();
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
      const [d, m, y] = str.split('/');
      return `${y}-${m}-${d}`;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    const parsed = new Date(str);
    if (!isNaN(parsed.getTime())) return parsed.toISOString().split('T')[0];
    return null;
  }

  validarFila(fila, index) {
    const errores = [];
    const num = index + 2;
    for (const col of COLUMNAS_REQUERIDAS) {
      if (!fila[col] && fila[col] !== 0) errores.push(`Fila ${num}: falta la columna "${col}"`);
    }
    if (fila.tipo && !TIPOS_VALIDOS.includes(fila.tipo))
      errores.push(`Fila ${num}: tipo "${fila.tipo}" inválido. Debe ser "Ingreso" o "Gasto"`);
    if (fila.categoria && !CATEGORIAS_VALIDAS.includes(fila.categoria))
      errores.push(`Fila ${num}: categoría "${fila.categoria}" inválida. Opciones: ${CATEGORIAS_VALIDAS.join(', ')}`);
    if (fila.monto && (isNaN(Number(fila.monto)) || Number(fila.monto) <= 0))
      errores.push(`Fila ${num}: monto "${fila.monto}" debe ser un número positivo`);
    if (fila.fecha) {
      const fecha = new Date(fila.fecha);
      if (isNaN(fecha.getTime()))
        errores.push(`Fila ${num}: fecha "${fila.fecha}" inválida. Usar formato YYYY-MM-DD o DD/MM/YYYY`);
    }
    return errores;
  }

  parseBuffer(buffer) {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { raw: true });
    if (rows.length === 0) throw Object.assign(new Error('El archivo está vacío o no tiene datos'), { status: 400 });
    return rows.map(row => {
      const normalized = {};
      Object.keys(row).forEach(k => { normalized[k.toLowerCase().trim().replace(/\s+/g, '_')] = row[k]; });
      return normalized;
    });
  }

  async validar(buffer) {
    const filas = this.parseBuffer(buffer);
    const faltantes = COLUMNAS_REQUERIDAS.filter(c => !Object.keys(filas[0]).includes(c));
    if (faltantes.length > 0)
      throw Object.assign(new Error(`Columnas faltantes: ${faltantes.join(', ')}`), { status: 400 });

    const errores = [];
    filas.forEach((fila, i) => errores.push(...this.validarFila(fila, i)));

    return {
      valido: errores.length === 0,
      totalFilas: filas.length,
      errores,
      preview: filas.slice(0, 5).map(f => ({ ...f, fecha: this.parsearFecha(f.fecha), monto: Number(f.monto) }))
    };
  }

  async importar(buffer, email = null) {
    const filas = this.parseBuffer(buffer);
    const errores = [];
    filas.forEach((fila, i) => errores.push(...this.validarFila(fila, i)));
    if (errores.length > 0)
      throw Object.assign(new Error('El archivo tiene errores de validación'), { status: 400, errores: errores.slice(0, 20) });

    const registros = filas.map(f => ({
      fecha: this.parsearFecha(f.fecha),
      descripcion: String(f.descripcion).trim(),
      categoria: String(f.categoria).trim(),
      tipo: String(f.tipo).trim(),
      monto: Number(f.monto),
      proveedor_cliente: f.proveedor_cliente ? String(f.proveedor_cliente).trim() : null,
      notas: f.notas ? String(f.notas).trim() : null,
      created_by: email,
    }));

    let insertados = 0;
    for (let i = 0; i < registros.length; i += 100) {
      const lote = registros.slice(i, i + 100);
      const { data, error } = await supabase.from('movimientos').insert(lote).select('id');
      if (error) throw new Error(`Error en lote ${Math.floor(i / 100) + 1}: ${error.message}`);
      insertados += data.length;
    }
    return { success: true, insertados, mensaje: `Se importaron ${insertados} registros exitosamente` };
  }

  getPlantillaInfo() {
    return {
      columnas: [
        { nombre: 'fecha', tipo: 'fecha', formato: 'YYYY-MM-DD o DD/MM/YYYY', requerido: true },
        { nombre: 'descripcion', tipo: 'texto', requerido: true },
        { nombre: 'categoria', tipo: 'texto', opciones: CATEGORIAS_VALIDAS, requerido: true },
        { nombre: 'tipo', tipo: 'texto', opciones: TIPOS_VALIDOS, requerido: true },
        { nombre: 'monto', tipo: 'numero', requerido: true },
        { nombre: 'proveedor_cliente', tipo: 'texto', requerido: false },
        { nombre: 'notas', tipo: 'texto', requerido: false }
      ],
      ejemplo: [
        { fecha: '2026-04-01', descripcion: 'Servidor AWS', categoria: 'Tecnología', tipo: 'Gasto', monto: 38400, proveedor_cliente: 'AWS' },
        { fecha: '2026-04-02', descripcion: 'Cobro Cliente A', categoria: 'Servicios', tipo: 'Ingreso', monto: 120000, proveedor_cliente: 'Cliente A' }
      ]
    };
  }
}

module.exports = new ExcelService();
