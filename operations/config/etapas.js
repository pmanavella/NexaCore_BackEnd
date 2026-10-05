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

module.exports = {
  TIPOS_BASE,
  TIPOS_BASE_CERRADOS,
  ESTADO_CANONICO_POR_TIPO_BASE,
};
