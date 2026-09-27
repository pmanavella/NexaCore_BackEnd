const { TIPOS_VALIDOS, CATEGORIAS_VALIDAS } = require('../../finance/config/movimientos');

// Catálogo de variables que una fórmula de Indicadores puede usar. Se deriva de
// las constantes de Finanzas (fuente de verdad): no hay una lista paralela de
// categorías. Cada variable se resuelve SOLO desde public.movimientos con los
// valores exactos de `tipo` y `categoria` (el frontend nunca envía columnas).
const PREFIJO_POR_TIPO = { Ingreso: 'INGRESOS', Gasto: 'GASTOS' };
const LABEL_POR_TIPO = { Ingreso: 'Ingresos', Gasto: 'Gastos' };

// 'Tecnología' → 'TECNOLOGIA', 'Suscripción' → 'SUSCRIPCION'.
function claveCategoria(categoria) {
  return categoria
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function construirCatalogo() {
  const variables = [];
  for (const tipo of TIPOS_VALIDOS) {
    const prefijo = PREFIJO_POR_TIPO[tipo];
    if (!prefijo) throw new Error(`Tipo de movimiento sin variable de Indicadores: "${tipo}".`);
    variables.push({ key: `${prefijo}_TOTAL`, label: `${LABEL_POR_TIPO[tipo]} totales`, tipo, categoria: null });
    for (const categoria of CATEGORIAS_VALIDAS) {
      variables.push({
        key: `${prefijo}_${claveCategoria(categoria)}`,
        label: `${LABEL_POR_TIPO[tipo]} · ${categoria}`,
        tipo,
        categoria,
      });
    }
  }
  return variables;
}

const VARIABLES = construirCatalogo();
const VARIABLES_POR_CLAVE = new Map(VARIABLES.map(v => [v.key, v]));
const CLAVES_VARIABLES = new Set(VARIABLES_POR_CLAVE.keys());

// Suma los totales agregados por (mes, tipo, categoria) que devuelve
// public.indicadores_totales_movimientos para las variables pedidas, dentro del
// rango [desde, hasta). Las fechas son 'YYYY-MM-DD', comparables como string.
function calcularVariables(filas, { desde, hasta }, claves) {
  const valores = {};
  for (const clave of claves) {
    const variable = VARIABLES_POR_CLAVE.get(clave);
    let total = 0;
    for (const fila of filas) {
      if (fila.mes < desde || fila.mes >= hasta) continue;
      if (fila.tipo !== variable.tipo) continue;
      if (variable.categoria !== null && fila.categoria !== variable.categoria) continue;
      total += Number(fila.total);
    }
    valores[clave] = Math.round(total * 100) / 100;
  }
  return valores;
}

module.exports = { VARIABLES, VARIABLES_POR_CLAVE, CLAVES_VARIABLES, claveCategoria, calcularVariables };
