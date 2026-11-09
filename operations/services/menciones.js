// Menciones con @ en los comentarios de tareas (migración
// 2026-11-09_comentarios_menciones_y_notificaciones). Contrato completo en
// docs/operativo-actualizaciones-contratos.md.
//
// Serialización dentro de `contenido` (texto plano):
//
//     @[Etiqueta](uuid)
//
//   - uuid: id del usuario mencionado (es la identidad; soporta nombres
//     repetidos). Sin distinguir mayúsculas; se guarda en minúsculas.
//   - Etiqueta: 1..100 caracteres sin [ ] ni saltos de línea. Es solo
//     presentación: al guardar, el backend la reemplaza por el nombre actual del
//     usuario (no se puede mostrar "@Dirección" apuntando a otra persona).
//   - Cualquier otro texto (incluido "@Nombre" sin token o un token con un id
//     que no es UUID) es texto común: no menciona ni notifica.
//
// A quién menciona un comentario lo dice la tabla tarea_comentario_menciones
// (la respuesta la devuelve en `menciones`), no el texto: los comentarios
// históricos no tienen tokens y quedan sin menciones.

const PATRON_TOKEN = /@\[([^[\]\r\n]{1,100})\]\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;

const MAX_ETIQUETA_LENGTH = 100;

// Ids mencionados en el texto, sin repetir, en orden de primera aparición.
function idsMencionados(texto) {
  const ids = [];
  for (const m of String(texto ?? '').matchAll(PATRON_TOKEN)) {
    const id = m[2].toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

// Nombre apto para la etiqueta de un token.
function etiquetaDe(nombre) {
  const limpia = String(nombre ?? '').replace(/[[\]\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ETIQUETA_LENGTH).trim();
  return limpia || 'usuario';
}

// Reescribe cada token con el id en minúsculas y, si el id está en
// `nombresPorId`, con el nombre actual como etiqueta. Los tokens de ids que no
// están en el mapa quedan como estaban.
function normalizarTokens(texto, nombresPorId) {
  return String(texto).replace(PATRON_TOKEN, (token, etiqueta, uuid) => {
    const id = uuid.toLowerCase();
    const nombre = nombresPorId.get(id);
    return `@[${nombre === undefined ? etiqueta : etiquetaDe(nombre)}](${id})`;
  });
}

module.exports = {
  PATRON_TOKEN,
  MAX_ETIQUETA_LENGTH,
  idsMencionados,
  etiquetaDe,
  normalizarTokens,
};
