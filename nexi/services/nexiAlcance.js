const nexiOrganigrama = require('./nexiOrganigrama');

// Traduce el `alcance` de un permiso a un conjunto concreto de usuarios del
// sistema, usando el organigrama real (organigrama.superior_id):
//
//   propio          → solo el usuario de la sesión
//   equipo_directo  → el usuario + quienes le reportan directamente
//   subarbol        → el usuario + todo su subárbol
//   global          → sin restricción (null)
//
// Solo se incluyen personas con usuario del sistema (los datos de negocio se
// vinculan a usuarios, no a empleados ni nodos manuales). Si el usuario no
// tiene nodo activo en el organigrama, su equipo es vacío: el alcance se
// reduce a 'propio'. Nunca se amplía.

const PROFUNDIDAD = { equipo_directo: 1, subarbol: Infinity };

async function usuariosEnAlcance(usuario, alcance) {
  if (alcance === 'global') return null;
  if (!usuario?.id) return [];
  if (alcance !== 'equipo_directo' && alcance !== 'subarbol') return [usuario.id];

  const estructura = await nexiOrganigrama.obtenerEstructura();
  const propio = nexiOrganigrama.nodoDeUsuario(estructura, usuario.id);
  if (!propio) return [usuario.id];

  const ids = new Set([usuario.id]);
  for (const n of nexiOrganigrama.descendientes(estructura, propio, PROFUNDIDAD[alcance])) {
    if (n.usuarioId) ids.add(n.usuarioId);
  }
  return [...ids];
}

// Descripción legible del alcance aplicado (para que el modelo lo informe).
const DESCRIPCION_ALCANCE = {
  propio: 'solo tus propios registros',
  equipo_directo: 'tus registros y los de quienes te reportan directamente',
  subarbol: 'tus registros y los de toda tu estructura a cargo',
  global: 'toda la organización',
};

module.exports = { usuariosEnAlcance, DESCRIPCION_ALCANCE };
