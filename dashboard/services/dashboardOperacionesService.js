const supabase = require('../../config/supabase');
const organizacionService = require('../../organization/services/organizacionService');

const ESTADOS_TAREA    = ['Pendiente', 'En Proceso', 'Completada', 'Cancelada'];
const PRIORIDADES_TAREA = ['Baja', 'Media', 'Alta', 'Urgente'];
const CATEGORIAS_PROTOCOLO = ['robot', 'instalacion', 'hardware', 'rrhh'];

class DashboardOperacionesService {

  // ── Punto de entrada principal ─────────────────────────────────────────────

  async obtenerResumen(usuarioId) {
    const [tieneOperaciones, tieneProtocolos] = await Promise.all([
      organizacionService.usuarioTieneAccesoModulo(usuarioId, 'operations'),
      organizacionService.usuarioTieneAccesoModulo(usuarioId, 'protocolos'),
    ]);

    if (!tieneOperaciones && !tieneProtocolos) {
      throw Object.assign(
        new Error('No tenés permisos para acceder a ninguna sección de este dashboard.'),
        { status: 403 }
      );
    }

    const [tareas, protocolos] = await Promise.all([
      tieneOperaciones  ? this._resumenTareas()    : Promise.resolve(null),
      tieneProtocolos   ? this._resumenProtocolos() : Promise.resolve(null),
    ]);

    return { tareas, protocolos };
  }

  // ── Tareas ─────────────────────────────────────────────────────────────────

  async _resumenTareas() {
    const { data, error } = await supabase
      .from('tareas')
      .select('estado, prioridad, tipo, estado_propuesta');

    if (error) throw Object.assign(new Error('Error al obtener tareas.'), { status: 500 });

    const asignaciones = data.filter(t => t.tipo === 'asignacion');

    const porEstado = Object.fromEntries(
      ESTADOS_TAREA.map(e => [e, asignaciones.filter(t => t.estado === e).length])
    );

    const porPrioridad = Object.fromEntries(
      PRIORIDADES_TAREA.map(p => [p, asignaciones.filter(t => t.prioridad === p).length])
    );

    const propuestasPendientes = data.filter(
      t => t.tipo === 'propuesta' && t.estado_propuesta === 'pendiente'
    ).length;

    return {
      totalAsignaciones: asignaciones.length,
      porEstado,
      porPrioridad,
      propuestasPendientes,
    };
  }

  // ── Protocolos ─────────────────────────────────────────────────────────────

  async _resumenProtocolos() {
    const [{ data: protocolos, error: errProt }, { data: pruebas, error: errPruebas }] =
      await Promise.all([
        supabase.from('protocolos').select('categoria, activo'),
        supabase.from('protocolo_pruebas').select('resultados'),
      ]);

    if (errProt)   throw Object.assign(new Error('Error al obtener protocolos.'),  { status: 500 });
    if (errPruebas) throw Object.assign(new Error('Error al obtener pruebas.'),    { status: 500 });

    const activos = protocolos.filter(p => p.activo);

    const porCategoria = Object.fromEntries(
      CATEGORIAS_PROTOCOLO.map(c => [c, activos.filter(p => p.categoria === c).length])
    );

    let sinIncumplimientos = 0;
    let conIncumplimientos = 0;

    for (const prueba of pruebas) {
      const resultados = Array.isArray(prueba.resultados) ? prueba.resultados : [];
      const tieneFalla = resultados.some(r => r.estado === 'fail');
      if (tieneFalla) {
        conIncumplimientos++;
      } else {
        sinIncumplimientos++;
      }
    }

    return {
      totalActivos: activos.length,
      porCategoria,
      pruebas: {
        total: pruebas.length,
        sinIncumplimientos,
        conIncumplimientos,
      },
    };
  }
}

module.exports = new DashboardOperacionesService();
