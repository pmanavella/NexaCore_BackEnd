const nexiOrganigrama = require('../services/nexiOrganigrama');
const { denegar } = require('./comunes');

// Herramientas de Organización (solo lectura) sobre el organigrama real
// (organizacionService.obtenerOrganigrama, vía nexiOrganigrama).
//
// Privacidad: solo nombre, cargo, área, nivel y tipo de persona (usuario del
// sistema / empleado / externo / manual). Nunca emails, teléfonos, ids,
// credenciales, roles de sistema ni permisos.
//
// Autorización (además del permiso de lectura sobre 'organizacion'):
//   - mi_posicion_organigrama: datos propios → cualquier alcance.
//   - mi_equipo: reportes directos → alcance equipo_directo o mayor; la
//     estructura completa a cargo → subarbol o global.
//   - estructura_organizacion / buscar_puesto: toda la organización → alcance
//     global y los mismos roles que GET /api/organizacion/organigrama
//     (organization/routes/organizacion.js: Dirección, Superadmin, Director).

const ROLES_ORGANIGRAMA_COMPLETO = ['Dirección', 'Superadmin', 'Director'];
const REQUISITOS = [{ modulo: 'organizacion', permiso: 'lector' }];
const MAX_PERSONAS = 50;
// Texto libre acotado (letras con tildes, números y puntuación básica).
const PATRON_TEXTO = "^[A-Za-zÀ-ÿ0-9 .,&/()'-]{2,60}$";

// Comparación sin mayúsculas ni tildes.
function normalizar(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function contarPor(nodos, campo) {
  const conteo = {};
  for (const n of nodos) {
    const clave = n[campo] || 'Sin dato';
    conteo[clave] = (conteo[clave] || 0) + 1;
  }
  return conteo;
}

const miPosicion = {
  nombre: 'mi_posicion_organigrama',
  descripcion: 'Posición del usuario que conversa dentro del organigrama: su cargo, área y nivel, quién es su responsable directo y cuántas personas le reportan directamente.',
  parametros: { type: 'object', properties: {}, additionalProperties: false },
  requisitos: REQUISITOS,
  alcance: 'PERSONAL',
  alcancesPermitidos: ['propio', 'equipo_directo', 'subarbol', 'global'],
  async handler(args, { usuario }) {
    const estructura = await nexiOrganigrama.obtenerEstructura();
    const propio = nexiOrganigrama.nodoDeUsuario(estructura, usuario.id);
    if (!propio) {
      return { en_organigrama: false, mensaje: 'No tenés una posición activa cargada en el organigrama.' };
    }
    const superior = propio.superiorId ? estructura.porId.get(propio.superiorId) : null;
    return {
      en_organigrama: true,
      posicion: nexiOrganigrama.presentar(propio),
      responsable_directo: superior ? nexiOrganigrama.presentar(superior) : null,
      reportes_directos: (estructura.hijos.get(propio.id) || []).length,
    };
  },
};

const miEquipo = {
  nombre: 'mi_equipo',
  descripcion: 'Personas que dependen del usuario que conversa en el organigrama. alcance_equipo "directos" = solo quienes le reportan directamente; "estructura_completa" = toda su estructura a cargo (requiere alcance de subárbol o global).',
  parametros: {
    type: 'object',
    properties: {
      alcance_equipo: { type: 'string', enum: ['directos', 'estructura_completa'], description: 'Por defecto "directos".' },
    },
    additionalProperties: false,
  },
  requisitos: REQUISITOS,
  alcance: 'PERSONAL',
  alcancesPermitidos: ['equipo_directo', 'subarbol', 'global'],
  async handler(args, { usuario, alcance }) {
    const completa = args.alcance_equipo === 'estructura_completa';
    if (completa && alcance === 'equipo_directo') {
      throw denegar('Tu alcance de permisos en Organización solo permite ver a quienes te reportan directamente.', 'ALCANCE_INSUFICIENTE');
    }
    const estructura = await nexiOrganigrama.obtenerEstructura();
    const propio = nexiOrganigrama.nodoDeUsuario(estructura, usuario.id);
    if (!propio) {
      return { en_organigrama: false, mensaje: 'No tenés una posición activa cargada en el organigrama.' };
    }
    const personas = nexiOrganigrama.descendientes(estructura, propio, completa ? Infinity : 1);
    return {
      en_organigrama: true,
      criterio: completa ? 'estructura completa a cargo' : 'reportes directos',
      total: personas.length,
      por_tipo: contarPor(personas, 'tipo'),
      mostradas: Math.min(personas.length, MAX_PERSONAS),
      personas: personas.slice(0, MAX_PERSONAS).map(p => ({ ...nexiOrganigrama.presentar(p), niveles_debajo_tuyo: p.distancia })),
    };
  },
};

const estructuraOrganizacion = {
  nombre: 'estructura_organizacion',
  descripcion: 'Composición de toda la organización según el organigrama: total de personas activas por área, por nivel y por tipo (usuario del sistema, empleado, externo, manual). Con `area` devuelve además las personas de esa área (nombre, cargo, nivel).',
  parametros: {
    type: 'object',
    properties: {
      area: { type: 'string', maxLength: 60, pattern: PATRON_TEXTO, description: 'Área a detallar (ej. "Operativo", "Finanzas").' },
    },
    additionalProperties: false,
  },
  requisitos: REQUISITOS,
  requisitosRol: ROLES_ORGANIGRAMA_COMPLETO,
  alcance: 'AGREGADA',
  alcancesPermitidos: ['global'],
  async handler(args) {
    const { nodos } = await nexiOrganigrama.obtenerEstructura();
    const resultado = {
      total_personas: nodos.length,
      por_area: contarPor(nodos, 'area'),
      por_nivel: contarPor(nodos, 'nivel'),
      por_tipo: contarPor(nodos, 'tipo'),
    };
    if (args.area) {
      const enArea = nodos.filter(n => normalizar(n.area) === normalizar(args.area));
      resultado.area = {
        nombre: args.area,
        total: enArea.length,
        personas: enArea.slice(0, MAX_PERSONAS).map(nexiOrganigrama.presentar),
      };
    }
    return resultado;
  },
};

const buscarPuesto = {
  nombre: 'buscar_puesto',
  descripcion: 'Quién ocupa un puesto: busca en el organigrama las personas activas cuyo cargo contiene el texto indicado (ej. "CFO", "Project Manager").',
  parametros: {
    type: 'object',
    properties: {
      cargo: { type: 'string', maxLength: 60, pattern: PATRON_TEXTO, description: 'Texto del cargo a buscar.' },
    },
    required: ['cargo'],
    additionalProperties: false,
  },
  requisitos: REQUISITOS,
  requisitosRol: ROLES_ORGANIGRAMA_COMPLETO,
  alcance: 'AGREGADA',
  alcancesPermitidos: ['global'],
  async handler(args) {
    const { nodos, porId } = await nexiOrganigrama.obtenerEstructura();
    const buscado = normalizar(args.cargo);
    const encontrados = nodos.filter(n => normalizar(n.cargo).includes(buscado));
    return {
      cargo_buscado: args.cargo,
      total: encontrados.length,
      personas: encontrados.slice(0, 20).map(n => ({
        ...nexiOrganigrama.presentar(n),
        responsable_directo: n.superiorId && porId.get(n.superiorId) ? porId.get(n.superiorId).nombre : null,
      })),
    };
  },
};

module.exports = [miPosicion, miEquipo, estructuraOrganizacion, buscarPuesto];
module.exports.ROLES_ORGANIGRAMA_COMPLETO = ROLES_ORGANIGRAMA_COMPLETO;
module.exports.contarPor = contarPor;
