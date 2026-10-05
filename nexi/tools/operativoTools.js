const nexiDatos = require('../services/nexiDatos');
const { PARAM_MES, PARAM_ANIO, resolverMes, denegar } = require('./comunes');

// Herramientas de Operativo.
// - resumen_operativo: solo conteos globales (sin títulos ni responsables).
// - mis_tareas_pendientes: PERSONAL. Usa siempre la identidad de la sesión
//   (req.user.id + req.user.name): tareas vinculadas al usuario en
//   tarea_asignados (incluidas las compartidas) más las históricas que solo
//   tienen su NOMBRE en tareas.asignado_a. Por esas últimas solo se ejecuta si
//   el nombre es único en public.usuarios; si no lo es, se niega: no puede
//   garantizarse que las tareas sean del usuario autenticado.

const ESTADOS = ['Pendiente', 'En Proceso', 'Completada', 'Cancelada'];
const PRIORIDADES = ['Baja', 'Media', 'Alta', 'Urgente'];
const ESTADOS_ABIERTOS = ['Pendiente', 'En Proceso'];

const resumenOperativo = {
  nombre: 'resumen_operativo',
  descripcion: 'Conteos globales de tareas asignadas por estado y prioridad, tareas abiertas vencidas y propuestas pendientes. Con mes/anio filtra por fecha límite dentro de ese mes; sin parámetros = todas.',
  parametros: {
    type: 'object',
    properties: { mes: PARAM_MES, anio: PARAM_ANIO },
    additionalProperties: false,
  },
  requisitos: [{ modulo: 'operations', permiso: 'lector' }],
  alcance: 'AGREGADA',
  async handler(args, { hoy }) {
    const conPeriodo = args.mes !== undefined || args.anio !== undefined;
    const periodo = conPeriodo ? resolverMes(args, hoy) : null;
    const rango = periodo ? { desde: periodo.desde, hasta: periodo.hasta } : {};

    const [total, porEstado, porPrioridad, vencidas, propuestasPendientes] = await Promise.all([
      nexiDatos.contarTareas(rango),
      Promise.all(ESTADOS.map(estado => nexiDatos.contarTareas({ ...rango, estado }))),
      Promise.all(PRIORIDADES.map(prioridad => nexiDatos.contarTareas({ ...rango, prioridad }))),
      nexiDatos.contarTareas({ ...rango, estadosAbiertos: ESTADOS_ABIERTOS, venceAntesDe: hoy.fecha }),
      nexiDatos.contarTareas({ tipo: 'propuesta', estadoPropuesta: 'pendiente' }),
    ]);

    return {
      periodo: periodo ? { clave: periodo.clave, criterio: 'fecha_limite dentro del mes' } : 'todas las tareas',
      total_asignadas: total,
      por_estado: Object.fromEntries(ESTADOS.map((e, i) => [e, porEstado[i]])),
      por_prioridad: Object.fromEntries(PRIORIDADES.map((p, i) => [p, porPrioridad[i]])),
      abiertas_vencidas: vencidas,
      propuestas_pendientes: propuestasPendientes,
    };
  },
};

const misTareasPendientes = {
  nombre: 'mis_tareas_pendientes',
  descripcion: 'Tareas abiertas (Pendiente o En Proceso) asignadas al usuario que está conversando, ordenadas por fecha límite. Solo del propio usuario: no admite consultar tareas de otras personas.',
  parametros: {
    type: 'object',
    properties: {
      limite: { type: 'integer', minimum: 1, maximum: 20, description: 'Máximo de tareas a devolver (1-20). Por defecto 10.' },
    },
    additionalProperties: false,
  },
  requisitos: [{ modulo: 'operations', permiso: 'lector' }],
  alcance: 'PERSONAL',
  async handler(args, { usuario, hoy }) {
    // Identidad SIEMPRE desde la sesión (req.user), nunca desde argumentos.
    const nombre = typeof usuario?.name === 'string' ? usuario.name : '';
    if (!nombre.trim()) {
      throw denegar('No se pudo identificar al usuario para consultar sus tareas.', 'USUARIO_SIN_NOMBRE');
    }
    const coincidencias = await nexiDatos.contarUsuariosConNombre(nombre);
    if (coincidencias !== 1) {
      throw denegar(
        'No se pueden consultar tus tareas de forma segura: las tareas se asignan por nombre y hay más de un usuario con tu nombre. Consultá el módulo Operativo.',
        'ALCANCE_NO_GARANTIZADO'
      );
    }

    const { filas, total } = await nexiDatos.tareasAbiertasAsignadasA({ id: usuario.id, nombre }, args.limite ?? 10);
    return {
      total_abiertas: total,
      mostradas: filas.length,
      tareas: filas.map(t => ({
        titulo: t.titulo,
        estado: t.estado,
        prioridad: t.prioridad,
        fecha_limite: t.fecha_limite || null,
        vencida: !!t.fecha_limite && t.fecha_limite < hoy.fecha,
      })),
    };
  },
};

module.exports = [resumenOperativo, misTareasPendientes];
