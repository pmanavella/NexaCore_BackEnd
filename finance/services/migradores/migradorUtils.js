const XLSX = require('xlsx');

const CATEGORIAS_VALIDAS = ['Tecnología', 'RRHH', 'Insumos', 'Servicios', 'Inversión', 'Otros', 'Suscripción'];

// Mapeo flexible concepto → categoría del sistema
const CONCEPTO_A_CATEGORIA = {
  'tecnologia': 'Tecnología', 'tecnología': 'Tecnología', 'tech': 'Tecnología', 'software': 'Tecnología', 'hardware': 'Tecnología',
  'rrhh': 'RRHH', 'recursos humanos': 'RRHH', 'personal': 'RRHH', 'sueldos': 'RRHH', 'sueldo': 'RRHH',
  'insumos': 'Insumos', 'insumo': 'Insumos', 'materiales': 'Insumos', 'material': 'Insumos', 'papeleria': 'Insumos',
  'servicios': 'Servicios', 'servicio': 'Servicios', 'consultoria': 'Servicios', 'consultoría': 'Servicios',
  'inversion': 'Inversión', 'inversión': 'Inversión', 'compra': 'Inversión', 'compras': 'Inversión', 'importacion': 'Inversión', 'importación': 'Inversión',
  'suscripcion': 'Suscripción', 'suscripción': 'Suscripción', 'subscripcion': 'Suscripción', 'licencia': 'Suscripción',
};

function parsearFecha(valor) {
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

function mapearCategoria(concepto) {
  if (!concepto) return 'Otros';
  const clave = String(concepto).toLowerCase().trim().replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i').replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u');
  // Búsqueda exacta primero
  if (CONCEPTO_A_CATEGORIA[clave]) return CONCEPTO_A_CATEGORIA[clave];
  // Búsqueda parcial
  for (const [key, cat] of Object.entries(CONCEPTO_A_CATEGORIA)) {
    if (clave.includes(key) || key.includes(clave)) return cat;
  }
  return 'Otros';
}

function parseBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { raw: true, defval: null });
  if (rows.length === 0) throw Object.assign(new Error('El archivo está vacío o no tiene datos'), { status: 400 });
  return rows.map(row => {
    const normalized = {};
    Object.keys(row).forEach(k => {
      const key = k.toLowerCase().trim()
        .replace(/\s+/g, '_')
        .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i').replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u')
        .replace(/u\$s/g, 'usd')  // "U$S" → "usd"
        .replace(/us\$/g, 'usd')  // "US$" → "usd"
        .replace(/[^a-z0-9_]/g, '');
      normalized[key] = row[k];
    });
    return normalized;
  });
}

// Convierte a número, tolerando strings con comas y signos de moneda
function toNumber(val) {
  if (val === null || val === undefined || val === '') return null;
  const cleaned = String(val).replace(/[$,\s]/g, '').replace(',', '.').trim();
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
}

// Convierte a importe monetario redondeado a 2 decimales
function toMoney(val) {
  const n = toNumber(val);
  return n === null ? null : Math.round(n * 100) / 100;
}

module.exports = { parsearFecha, mapearCategoria, parseBuffer, toNumber, toMoney, CATEGORIAS_VALIDAS };
