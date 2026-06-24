const { parseBuffer, toNumber } = require('./migradorUtils');

// Columnas esperadas (normalizadas): mes, fijo_usd, fijo_pesos, pasantes, polo_pasan, por_hora, total_pesos, total_usd
// Destino: tabla sueldos_historicos (totales mensuales consolidados, NO empleados individuales)

const MESES_ES = {
  enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
  julio: '07', agosto: '08', septiembre: '09', octubre: '10', noviembre: '11', diciembre: '12',
  ene: '01', feb: '02', mar: '03', abr: '04', may: '05', jun: '06',
  jul: '07', ago: '08', sep: '09', oct: '10', nov: '11', dic: '12',
};

function parsearMesAnio(valor) {
  if (!valor) return null;

  // Excel serial number
  if (typeof valor === 'number') {
    const date = new Date((valor - 25569) * 86400 * 1000);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}-01`;
  }

  const str = String(valor).trim().toLowerCase()
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u');

  // "2024-01" o "2024-01-dd"
  const isoMatch = str.match(/^(\d{4})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-01`;

  // "01/2024" o "1/2024"
  const mmYYYY = str.match(/^(\d{1,2})\/(\d{4})$/);
  if (mmYYYY) return `${mmYYYY[2]}-${mmYYYY[1].padStart(2, '0')}-01`;

  // "Enero 2024", "ene-24", "ene 2024", "enero-2024"
  const wordMatch = str.match(/^([a-z]+)[\s\-_\/](\d{2,4})$/);
  if (wordMatch) {
    const mesNum = MESES_ES[wordMatch[1]];
    if (mesNum) {
      let anio = wordMatch[2];
      if (anio.length === 2) anio = anio >= '50' ? `19${anio}` : `20${anio}`;
      return `${anio}-${mesNum}-01`;
    }
  }

  // "2024 enero" (invertido)
  const invertedMatch = str.match(/^(\d{4})[\s\-_]([a-z]+)$/);
  if (invertedMatch) {
    const mesNum = MESES_ES[invertedMatch[2]];
    if (mesNum) return `${invertedMatch[1]}-${mesNum}-01`;
  }

  return null;
}

function validarFila(fila, num) {
  const errores = [];

  const mesAnio = parsearMesAnio(fila.mes);
  if (!mesAnio)
    errores.push({ fila: num, campo: 'mes', motivo: `No se pudo interpretar el mes: "${fila.mes}". Usar "Enero 2024", "01/2024" o "2024-01"` });

  const totalPesos = toNumber(fila.total_pesos);
  const totalUsd = toNumber(fila.total_usd);
  if (totalPesos === null && totalUsd === null)
    errores.push({ fila: num, campo: 'total_pesos / total_usd', motivo: 'Se requiere al menos un total (Total Pesos o Total USD)' });

  return errores;
}

function mapearFila(fila, num) {
  // Guardar columnas extra como metadata para auditoria
  const camposEstandar = new Set(['mes', 'fijo_usd', 'fijo_pesos', 'pasantes', 'polo_pasan', 'por_hora', 'total_pesos', 'total_usd']);
  const metadata = {};
  Object.keys(fila).forEach(k => {
    if (!camposEstandar.has(k) && fila[k] != null) metadata[k] = fila[k];
  });

  return {
    mes_anio: parsearMesAnio(fila.mes),
    fijo_usd: toNumber(fila.fijo_usd),
    fijo_pesos: toNumber(fila.fijo_pesos),
    pasantes: toNumber(fila.pasantes),
    polo_pasan: toNumber(fila.polo_pasan),
    por_hora: toNumber(fila.por_hora),
    total_pesos: toNumber(fila.total_pesos),
    total_usd: toNumber(fila.total_usd),
    metadata: Object.keys(metadata).length > 0 ? metadata : null,
    _fila: num,
  };
}

function procesar(buffer, params = {}) {
  const filas = parseBuffer(buffer);
  const errores = [];
  const registros = [];

  filas.forEach((fila, i) => {
    const num = i + 2;
    const errs = validarFila(fila, num);
    if (errs.length > 0) {
      errores.push(...errs);
    } else {
      registros.push(mapearFila(fila, num));
    }
  });

  return { filas_total: filas.length, registros, errores };
}

module.exports = { procesar };
