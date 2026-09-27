// Valores admitidos para public.movimientos. Deben coincidir con los CHECK
// movimientos_tipo_check y movimientos_categoria_check de la base.
// Fuente única consumida por Finanzas (movimientosService) e Indicadores
// (catálogo de variables financieras).
const TIPOS_VALIDOS = ['Ingreso', 'Gasto'];
const CATEGORIAS_VALIDAS = ['Tecnología', 'RRHH', 'Insumos', 'Servicios', 'Inversión', 'Otros', 'Suscripción'];

module.exports = { TIPOS_VALIDOS, CATEGORIAS_VALIDAS };
