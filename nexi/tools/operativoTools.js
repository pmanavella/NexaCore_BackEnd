const nexiDatos = require('../services/nexiDatos');
const nexiAlcance = require('../services/nexiAlcance');
const { PARAM_MES, PARAM_ANIO, resolverMes, denegar } = require('./comunes');

// Herramientas de Operativo.
// - resumen_operativo: solo conteos (sin títulos ni responsables). Respeta el
//   alcance del permiso de Operativo:
//     global          → todas las tareas;
//     propio / equipo_directo / subarbol → solo tareas vinculadas (tarea_asignados)
//       a los usuarios del alcance según el organigrama. Las tareas históricas
//       asignadas solo por NOMBRE se incluyen únicamente para el propio usuario
//       y solo si su nombre es único en public.usuarios.
// - mis_tareas_pendientes: PERSONAL. Usa siempre la identidad de la sesión
//   (req.user.id + req.user.name): tareas vinculadas al usuario en
//   tarea_asignados (incluidas las compartidas) más las históricas que solo
//   tienen su NOMBRE en tareas.asignado_a. Por esas últimas solo se ejecuta si
//   el nombre es único en public.usuarios; si no lo es, se niega: no puede
//   garantizarse que las tareas sean del usuario autenticado.

const ESTADOS = ['Pendiente', 'En Proceso', 'Completada', 'Cancelada'];
const PRIORIDADES = ['Baja', 'Media', 'Alta', 'Urgente'];
const ESTADOS_ABIERTOS = ['Pendiente', 'En Proceso'];
const TODOS_LOS_ALCANCES = ['propio', 'equipo_directo', 'subarbol', 'global'];

function esAsignacion(t) {
  return t.tipo === null || t.tipo === undefined || t.tipo === 'asignacion';
}

// Conteos globales: consultas `count` en la base (sin traer filas).
async function conteosGlobales(rango, hoy) {
  const [total, porEstado, porPrioridad, vencidas, propuestasPendientes] = await Promise.all([
    nexiDatos.contarTareas(rango),
    Promise.all(ESTADOS.map(estado => nexiDatos.contarTareas({ ...rango, estado }))),
    Promise.all(PRIORIDADES.map(prioridad => nexiDatos.contarTareas({ ...rango, prioridad }))),
    nexiDatos.contarTareas({ ...rango, estadosAbiertos: ESTADOS_ABIERTOS, venceAntesDe: hoy.fecha }),
    nexiDatos.contarTareas({ tipo: 'propuesta', estadoPropuesta: 'pendiente' }),
  ]);
  return {
    total_asignadas: total,
    por_estado: Object.fromEntries(ESTADOS.map((e, i) => [e, porEstado[i]])),
    por_prioridad: Object.fromEntries(PRIORIDADES.map((p, i) => [p, porPrioridad[i]])),
    abiertas_vencidas: vencidas,
    propuestas_pendientes: propuestasPendientes,
  };
}

// Ids de tareas dentro del alcance (no global) del usuario.
async function idsEnAlcance(usuario, alcance) {
  const usuarioIds = await nexiAlcance.usuariosEnAlcance(usuario, alcance);
  // Asignaciones históricas por nombre: solo del propio usuario y solo si el
  // nombre lo identifica de forma única (misma regla que mis_tareas_pendientes).
  const nombre = typeof usuario?.name === 'string' ? usuario.name.trim() : '';
  const nombreUnico = nombre && (await nexiDatos.contarUsuariosConNombre(usuario.name)) === 1;
  const ids = await nexiDatos.idsTareasDeUsuarios(usuarioIds, nombreUnico ? usuario.name : null);
  return { ids, usuarios: usuarioIds.length, incluyeAsignacionesPorNombre: !!nombreUnico };
}

// Conteos en memoria sobre las tareas del alcance (mismos criterios que los globales).
function conteosAcotados(filas, rango, hoy) {
  const enRango = filas
    .filter(esAsignacion)
    .filter(t => (!rango.desde || (t.fecha_limite && t.fecha_limite >= rango.desde))
      && (!rango.hasta || (t.fecha_limite && t.fecha_limite < rango.hasta)));
  return {
    total_asignadas: enRango.length,
    por_estado: Object.fromEntries(ESTADOS.map(e => [e, enRango.filter(t => t.estado === e).length])),
    por_prioridad: Object.fromEntries(PRIORIDADES.map(p => [p, enRango.filter(t => t.prioridad === p).length])),
    abiertas_vencidas: enRango.filter(t => ESTADOS_ABIERTOS.includes(t.estado) && t.fecha_limite && t.fecha_limite < hoy.fecha).length,
    // Las propuestas no tienen un vínculo confiable con usuarios: no se informan
    // con alcance restringido (se reduce, no se estima).
    propuestas_pendientes: null,
  };
}

// Resumen de tareas reutilizable (también lo usan Dashboard y Reportes).
// rango: { desde?, hasta? } sobre fecha_limite ([desde, hasta)).
async function resumenTareas({ usuario, alcance, hoy, rango = {} }) {
  if (alcance === 'global') {
    return { alcance_aplicado: 'global', ...(await conteosGlobales(rango, hoy)) };
  }
  const { ids, usuarios, incluyeAsignacionesPorNombre } = await idsEnAlcance(usuario, alcance);
  const filas = ids.length ? await nexiDatos.filasTareasPorIds(ids) : [];
  return {
    alcance_aplicado: alcance,
    descripcion_alcance: nexiAlcance.DESCRIPCION_ALCANCE[alcance],
    usuarios_en_alcance: usuarios,
    incluye_asignaciones_historicas_por_nombre: incluyeAsignacionesPorNombre,
    ...conteosAcotados(filas, rango, hoy),
  };
}

const resumenOperativo = {
  nombre: 'resumen_operativo',
  descripcion: 'Conteos de tareas asignadas por estado y prioridad, tareas abiertas vencidas y propuestas pendientes. Con mes/anio filtra por fecha límite dentro de ese mes; sin parámetros = todas. Respeta el alcance de permisos del usuario (si su alcance no es global, solo cuenta las tareas de su alcance e informa cuál se aplicó).',
  parametros: {
    type: 'object',
    properties: { mes: PARAM_MES, anio: PARAM_ANIO },
    additionalProperties: false,
  },
  requisitos: [{ modulo: 'operations', permiso: 'lector' }],
  alcance: 'AGREGADA',
  alcancesPermitidos: TODOS_LOS_ALCANCES,
  async handler(args, { usuario, hoy, alcance }) {
    const conPeriodo = args.mes !== undefined || args.anio !== undefined;
    const periodo = conPeriodo ? resolverMes(args, hoy) : null;
    const rango = periodo ? { desde: periodo.desde, hasta: periodo.hasta } : {};
    const resumen = await resumenTareas({ usuario, alcance, hoy, rango });
    return {
      periodo: periodo ? { clave: periodo.clave, criterio: 'fecha_limite dentro del mes' } : 'todas las tareas',
      ...resumen,
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
  // Datos del propio usuario: cualquier alcance los cubre.
  alcancesPermitidos: TODOS_LOS_ALCANCES,
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
module.exports.resumenTareas = resumenTareas;
module.exports.idsEnAlcance = idsEnAlcance;
module.exports.conteosAcotados = conteosAcotados;
module.exports.ESTADOS = ESTADOS;
module.exports.PRIORIDADES = PRIORIDADES;
