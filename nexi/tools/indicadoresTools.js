const indicadoresService = require('../../indicators/services/indicadoresService');
const { PERSPECTIVAS, MESES_POR_VENTANA } = require('../../indicators/config/indicadores');

// Herramientas de Indicadores. Reutilizan indicadoresService (solo lectura).
// Los valores se calculan en el backend: el modelo solo los informa.
// valor/histórico exigen además acceso a Finanzas, igual que
// GET /api/indicadores/:id/valor y /:id/historico.

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const PARAM_INDICADOR_ID = {
  type: 'string',
  pattern: UUID_PATTERN,
  description: 'id del indicador, obtenido de listar_indicadores.',
};
const MAX_INDICADORES = 50;

function presentarPeriodo(p) {
  return { clave: p.clave, label: p.label, en_curso: p.parcial };
}

const listarIndicadores = {
  nombre: 'listar_indicadores',
  descripcion: 'Lista los indicadores (KPI) activos con su id, nombre, perspectiva, frecuencia, unidad, sentido, objetivo y límite aceptable. Usar para obtener el id antes de pedir un valor o un histórico.',
  parametros: {
    type: 'object',
    properties: {
      perspectiva: { type: 'string', enum: PERSPECTIVAS, description: 'Filtra por perspectiva del Balanced Scorecard.' },
    },
    additionalProperties: false,
  },
  requisitos: [{ modulo: 'indicadores', permiso: 'lector' }],
  alcance: 'AGREGADA',
  async handler(args) {
    const { data, total } = await indicadoresService.listar({ perspectiva: args.perspectiva });
    return {
      total,
      mostrados: Math.min(total, MAX_INDICADORES),
      indicadores: data.slice(0, MAX_INDICADORES).map(ind => ({
        id: ind.id,
        nombre: ind.nombre,
        perspectiva: ind.perspectiva,
        frecuencia: ind.frecuencia,
        unidad: ind.unidad,
        sentido: ind.sentido,
        valor_objetivo: Number(ind.valor_objetivo),
        limite_aceptable: Number(ind.limite_aceptable),
      })),
    };
  },
};

const valorIndicador = {
  nombre: 'valor_indicador',
  descripcion: 'Valor calculado de un indicador para un período, con su estado (EN_OBJETIVO, EN_RIESGO, CRITICO) y las variables usadas. Sin período = período en curso según la frecuencia del indicador.',
  parametros: {
    type: 'object',
    properties: {
      indicador_id: PARAM_INDICADOR_ID,
      periodo: {
        type: 'string',
        pattern: '^\\d{4}(-(0[1-9]|1[0-2]|Q[1-4]|S[12]))?$',
        description: 'Período: 2026-09 (mes), 2026-Q3 (trimestre), 2026-S2 (semestre) o 2026 (año).',
      },
    },
    required: ['indicador_id'],
    additionalProperties: false,
  },
  requisitos: [{ modulo: 'indicadores', permiso: 'lector' }, { modulo: 'finance', permiso: 'lector' }],
  alcance: 'AGREGADA',
  async handler(args, { ahora }) {
    const r = await indicadoresService.calcularValor(args.indicador_id, args.periodo, { ahora });
    return {
      indicador: r.indicador,
      periodo: presentarPeriodo(r.periodo),
      valor: r.valor,
      estado: r.estado,
      variables: r.variables,
      error_calculo: r.error,
    };
  },
};

const historicoIndicador = {
  nombre: 'historico_indicador',
  descripcion: 'Evolución de un indicador en una ventana de tiempo que termina en el período en curso: valor y estado por período, último valor válido y tendencia.',
  parametros: {
    type: 'object',
    properties: {
      indicador_id: PARAM_INDICADOR_ID,
      ventana: { type: 'string', enum: Object.keys(MESES_POR_VENTANA), description: 'month, 3m, 6m o 12m. Por defecto 12m.' },
    },
    required: ['indicador_id'],
    additionalProperties: false,
  },
  requisitos: [{ modulo: 'indicadores', permiso: 'lector' }, { modulo: 'finance', permiso: 'lector' }],
  alcance: 'AGREGADA',
  async handler(args, { ahora }) {
    const r = await indicadoresService.calcularHistorico(args.indicador_id, args.ventana, { ahora });
    return {
      indicador: r.indicador,
      ventana: r.period,
      puntos: r.puntos.map(p => ({ ...presentarPeriodo(p.periodo), valor: p.valor, estado: p.estado })),
      ultimo_valido: r.ultimoValido
        ? { periodo: r.ultimoValido.periodo.clave, valor: r.ultimoValido.valor, estado: r.ultimoValido.estado }
        : null,
      tendencia: r.tendencia,
    };
  },
};

module.exports = [listarIndicadores, valorIndicador, historicoIndicador];
