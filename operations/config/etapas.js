// Catálogo de `tipo_base` de las etapas del tablero Operativo (public.operativo_etapas).
// Única fuente en el backend: debe coincidir con el CHECK operativo_etapas_tipo_base_check
// (migraciones 2026-09-28_etapas_operativo y 2026-10-05_etapas_en_revision).
//
// Cada tipo_base define:
//   - abierta:  si la etapa cuenta como Abierta (true) o Cerrada (false) para
//               totales y "vencida".
//   - estado:   valor canónico que se guarda en tareas.estado. Esa columna tiene un
//               CHECK preexistente con solo 4 valores y la siguen usando Nexi y el
//               dashboard, así que "En Revisión" se proyecta al equivalente más cercano.
const TIPOS_BASE_CONFIG = Object.freeze({
  pendiente:           { abierta: true,  estado: 'Pendiente'  }, // Abierta · Pendiente
  en_curso:            { abierta: true,  estado: 'En Proceso' }, // Abierta · En curso
  en_revision_abierta: { abierta: true,  estado: 'En Proceso' }, // Abierta · En Revisión
  completada:          { abierta: false, estado: 'Completada' }, // Cerrada · Completada
  cancelada:           { abierta: false, estado: 'Cancelada'  }, // Cerrada · Cancelada
  en_revision_cerrada: { abierta: false, estado: 'Completada' }, // Cerrada · En Revisión
});

const TIPOS_BASE = Object.freeze(Object.keys(TIPOS_BASE_CONFIG));

const TIPOS_BASE_CERRADOS = Object.freeze(TIPOS_BASE.filter(t => !TIPOS_BASE_CONFIG[t].abierta));

const ESTADO_CANONICO_POR_TIPO_BASE = Object.freeze(
  Object.fromEntries(TIPOS_BASE.map(t => [t, TIPOS_BASE_CONFIG[t].estado]))
);

// Valores de tareas.estado que solo aparecen en etapas cerradas (Completada,
// Cancelada). Respaldo para tareas sin etapa (anteriores a las etapas).
const ESTADOS_CERRADOS = Object.freeze([...new Set(TIPOS_BASE_CERRADOS.map(t => TIPOS_BASE_CONFIG[t].estado))]);

// Una tarea está abierta según el tipo_base de su etapa (operativo_etapas
// embebida). Sin etapa, según su estado canónico: abierta salvo que sea de
// cierre. Nunca se mira el nombre visible de la etapa.
function esTareaAbierta(tarea) {
  const config = TIPOS_BASE_CONFIG[tarea?.operativo_etapas?.tipo_base];
  if (config) return config.abierta;
  return !ESTADOS_CERRADOS.includes(tarea?.estado);
}

// ── Finalización (Kanban de 7 días) ──────────────────────────────────────────
// tipo_base finales: la tarea terminó (completada) o se descartó (cancelada).
// Guardan tareas.fecha_finalizacion y el Kanban las oculta pasadas 168 horas.
// 'en_revision_cerrada' es cerrada pero NO final: sigue siempre visible.
// La función SQL public.tarea_es_final (migración
// 2026-11-03_tareas_comentarios_y_tiempos) replica este criterio para cerrar
// temporizadores e impedir iniciarlos: si cambia acá, cambiarlo también ahí.
const TIPOS_BASE_FINALES = Object.freeze(['completada', 'cancelada']);
const VENTANA_KANBAN_MS = 7 * 24 * 60 * 60 * 1000; // 168 horas

// Final por tipo_base; sin etapa, por su estado canónico (Completada / Cancelada).
function esTareaFinal(tarea) {
  const tipoBase = tarea?.operativo_etapas?.tipo_base;
  if (TIPOS_BASE_CONFIG[tipoBase]) return TIPOS_BASE_FINALES.includes(tipoBase);
  return ESTADOS_CERRADOS.includes(tarea?.estado);
}

// Visible en el Kanban salvo que sea final y su fecha_finalizacion tenga 168
// horas o más. Sin fecha confiable (tareas finalizadas antes de la columna),
// visible: no se oculta por una fecha inferida.
function esVisibleEnKanban(tarea, ahora = Date.now()) {
  if (!esTareaFinal(tarea) || !tarea.fecha_finalizacion) return true;
  const finalizada = Date.parse(tarea.fecha_finalizacion);
  if (Number.isNaN(finalizada)) return true;
  return ahora - finalizada < VENTANA_KANBAN_MS;
}

module.exports = {
  TIPOS_BASE,
  TIPOS_BASE_CERRADOS,
  TIPOS_BASE_FINALES,
  ESTADO_CANONICO_POR_TIPO_BASE,
  VENTANA_KANBAN_MS,
  esTareaAbierta,
  esTareaFinal,
  esVisibleEnKanban,
};
