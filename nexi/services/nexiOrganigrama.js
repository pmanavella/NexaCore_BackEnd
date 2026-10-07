const organizacionService = require('../../organization/services/organizacionService');

// Lectura del organigrama para Nexi. Reutiliza organizacionService (única
// fuente del organigrama) y lo reduce a una forma mínima y SIN datos de
// contacto: nunca expone emails, teléfonos, ids de usuario/empleado ni permisos.
//
// Relaciones: solo se usan las que existen en la base (organigrama.superior_id).
// Solo se recorren nodos ACTIVOS; un nodo inactivo corta la cadena (reduce,
// nunca amplía el alcance).

// Tipo de persona según cómo está cargado el nodo:
// - usuario: tiene usuario del sistema (con o sin empleado vinculado);
// - empleado: empleado registrado sin usuario del sistema;
// - externo: nodo marcado como externo (o nivel 'Externo');
// - manual: persona cargada a mano en el organigrama, sin usuario ni empleado.
function tipoPersona(nodo) {
  if (nodo.es_externo || nodo.nivel === 'Externo') return 'externo';
  if (nodo.usuario_id) return 'usuario';
  if (nodo.empleado_id) return 'empleado';
  return 'manual';
}

function nombrePersona(nodo) {
  if (nodo.usuarios?.nombre) return nodo.usuarios.nombre;
  if (nodo.empleados) return [nodo.empleados.nombre, nodo.empleados.apellido].filter(Boolean).join(' ');
  return [nodo.nombre_manual, nodo.apellido_manual].filter(Boolean).join(' ') || 'Sin nombre';
}

// Nodo interno (con ids para recorrer) — no se envía al modelo tal cual.
function aNodo(n) {
  return {
    id: n.id,
    usuarioId: n.usuario_id || null,
    superiorId: n.superior_id || null,
    nombre: nombrePersona(n),
    cargo: n.cargo || null,
    area: n.area || null,
    nivel: n.nivel || null,
    tipo: tipoPersona(n),
    rol: n.rol || null,
  };
}

// Forma pública mínima para el modelo.
function presentar(nodo) {
  return { nombre: nodo.nombre, cargo: nodo.cargo, area: nodo.area, nivel: nodo.nivel, tipo: nodo.tipo };
}

async function obtenerEstructura() {
  const nodos = (await organizacionService.obtenerOrganigrama())
    .filter(n => n.activo !== false)
    .map(aNodo);
  const porId = new Map(nodos.map(n => [n.id, n]));
  const hijos = new Map();
  for (const n of nodos) {
    if (!n.superiorId || !porId.has(n.superiorId)) continue;
    if (!hijos.has(n.superiorId)) hijos.set(n.superiorId, []);
    hijos.get(n.superiorId).push(n);
  }
  return { nodos, porId, hijos };
}

// Nodo activo del usuario de la sesión (único por índice parcial en la base).
function nodoDeUsuario(estructura, usuarioId) {
  return estructura.nodos.find(n => n.usuarioId && n.usuarioId === usuarioId) || null;
}

// Descendientes del nodo. profundidad: 1 = reportes directos; Infinity = subárbol.
// Protegido contra ciclos (un nodo se visita una sola vez).
function descendientes(estructura, nodo, profundidad = Infinity) {
  const resultado = [];
  const visitados = new Set([nodo.id]);
  let frontera = [{ nodo, nivel: 0 }];
  while (frontera.length) {
    const siguiente = [];
    for (const { nodo: actual, nivel } of frontera) {
      if (nivel >= profundidad) continue;
      for (const hijo of estructura.hijos.get(actual.id) || []) {
        if (visitados.has(hijo.id)) continue;
        visitados.add(hijo.id);
        resultado.push({ ...hijo, distancia: nivel + 1 });
        siguiente.push({ nodo: hijo, nivel: nivel + 1 });
      }
    }
    frontera = siguiente;
  }
  return resultado;
}

module.exports = { obtenerEstructura, nodoDeUsuario, descendientes, presentar, tipoPersona, nombrePersona };
