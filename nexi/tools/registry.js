const finanzasTools = require('./finanzasTools');
const indicadoresTools = require('./indicadoresTools');
const operativoTools = require('./operativoTools');
const crmTools = require('./crmTools');
const { validarParametros } = require('./validarParametros');
const nexiPermisos = require('../services/nexiPermisos');
const auditoriaService = require('../services/auditoriaService');
const { hoyArgentina } = require('../../indicators/services/periodos');
const { LIMITES } = require('../config/nexi');

// Registro CERRADO de herramientas de Nexi (V1: solo lectura).
//
// Cada herramienta declara: nombre, descripcion, parametros (JSON Schema con
// additionalProperties: false), requisitos [{ modulo, permiso }], alcance
// (AGREGADA | PERSONAL) y handler(args, { usuario, hoy, ahora }).
//
// ejecutar() es el único camino hacia un handler y, en cada llamada:
//   1. rechaza herramientas no registradas;
//   2. rechaza parámetros de identidad (usuario_id, email, ...);
//   3. valida los parámetros contra el esquema;
//   4. vuelve a leer los permisos reales del usuario (Matriz de permisos) y
//      verifica todos los módulos requeridos;
//   5. recién entonces ejecuta el handler con el usuario de la sesión;
//   6. registra la llamada en nexi_tool_calls.

const PERMISOS_V1 = ['lector'];
const ALCANCES = ['AGREGADA', 'PERSONAL'];
const NOMBRE_REGEX = /^[a-z][a-z0-9_]{2,63}$/;
// Herramientas genéricas que nunca deben existir.
const NOMBRES_PROHIBIDOS = /(sql|tabla|endpoint|comando|shell|exec|ejecutar|query|http|fetch|crear|editar|eliminar|borrar|actualizar|salari|sueldo|nomina)/;
// Parámetros que identificarían a otra persona: la identidad sale solo de req.user.
const PARAMETROS_IDENTIDAD = /^(usuario|user|empleado|persona)?_?(id|email|mail|nombre|name|rol|role)$|^(asignado_?a|responsable|propuesto_?por)$/i;

const MENSAJES = {
  NO_REGISTRADA: 'La herramienta solicitada no existe. Usá solo las herramientas disponibles.',
  FUERA_DE_CONTEXTO: 'Esta conversación está enfocada en otro módulo. Usá solo las herramientas disponibles.',
  IDENTIDAD: 'No se admite indicar usuarios: la consulta siempre corresponde al usuario autenticado.',
  SIN_PERMISO: 'El usuario no tiene permiso para consultar esta información.',
  INTERNO: 'No pude obtener la información necesaria para responder.',
  DEMASIADO_GRANDE: 'El resultado es demasiado grande. Probá con un rango o filtro más acotado.',
};

function validarDefinicion(h) {
  const fallas = [];
  if (!NOMBRE_REGEX.test(h.nombre || '')) fallas.push('nombre inválido');
  if (NOMBRES_PROHIBIDOS.test(h.nombre || '')) fallas.push('nombre prohibido');
  if (!h.descripcion) fallas.push('sin descripción');
  if (h.parametros?.type !== 'object' || h.parametros.additionalProperties !== false) fallas.push('esquema debe ser object cerrado');
  for (const clave of Object.keys(h.parametros?.properties || {})) {
    if (PARAMETROS_IDENTIDAD.test(clave)) fallas.push(`parámetro de identidad "${clave}"`);
  }
  if (!Array.isArray(h.requisitos) || h.requisitos.length === 0) fallas.push('sin requisitos de permiso');
  for (const r of h.requisitos || []) {
    if (!r.modulo || !PERMISOS_V1.includes(r.permiso)) fallas.push('requisito inválido');
  }
  if (!ALCANCES.includes(h.alcance)) fallas.push('alcance inválido');
  if (typeof h.handler !== 'function') fallas.push('sin handler');
  if (h.requisitosRol !== undefined) {
    if (!Array.isArray(h.requisitosRol) || h.requisitosRol.length === 0 ||
        h.requisitosRol.some(r => typeof r !== 'string' || !r))
      fallas.push('requisitosRol debe ser un array no vacío de strings');
  }
  if (fallas.length) throw new Error(`Herramienta Nexi "${h.nombre}" inválida: ${fallas.join(', ')}.`);
}

function crearRegistro(herramientas) {
  const registro = new Map();
  for (const h of herramientas) {
    validarDefinicion(h);
    if (registro.has(h.nombre)) throw new Error(`Herramienta Nexi duplicada: ${h.nombre}`);
    registro.set(h.nombre, Object.freeze({ ...h }));
  }
  return registro;
}

const REGISTRO = crearRegistro([...finanzasTools, ...indicadoresTools, ...operativoTools, ...crmTools]);

// Módulo al que pertenece una herramienta: el primero de sus requisitos
// (valor_indicador → indicadores, aunque además exija finance).
function moduloPrincipal(herramienta) {
  return herramienta.requisitos[0].modulo;
}

// Herramientas que el usuario puede usar según sus niveles (Map de nexiPermisos).
// `modulo` (opcional) solo restringe: se aplica DESPUÉS del filtro de permisos,
// que sigue exigiendo todos los requisitos de cada herramienta.
function herramientasDisponibles(niveles, modulo = null) {
  return [...REGISTRO.values()]
    .filter(h => nexiPermisos.cumpleRequisitos(niveles, h.requisitos))
    .filter(h => !modulo || moduloPrincipal(h) === modulo);
}

// Declaraciones neutrales para el proveedor (sin handler ni requisitos).
function declaraciones(herramientas) {
  return herramientas.map(h => ({ nombre: h.nombre, descripcion: h.descripcion, parametros: h.parametros }));
}

function clavesRecibidas(argumentos) {
  if (!argumentos || typeof argumentos !== 'object' || Array.isArray(argumentos)) return { claves: [] };
  return { claves: Object.keys(argumentos).slice(0, 10).map(k => k.slice(0, 40)) };
}

// herramientasPermitidas (opcional): Set de nombres ofrecidos al modelo cuando
// hay foco de módulo; cualquier otra herramienta se deniega aunque el usuario
// tenga permiso. Sin foco (null) no cambia el comportamiento.
async function ejecutar({ nombre, argumentos, usuario, conversacionId, ahora = new Date(), herramientasPermitidas = null }) {
  const inicio = Date.now();
  const nombreSeguro = typeof nombre === 'string' ? nombre.slice(0, 100) : '';

  const finalizar = async (estado, motivo, resultado, argumentosAuditoria) => {
    await auditoriaService.registrar({
      conversacionId,
      usuarioId: usuario?.id,
      herramienta: nombreSeguro,
      argumentos: argumentosAuditoria,
      estado,
      motivo,
      duracionMs: Date.now() - inicio,
    });
    return { estado, motivo, resultado };
  };
  const fallo = mensaje => ({ ok: false, error: mensaje });

  // 1. Solo herramientas registradas
  const herramienta = REGISTRO.get(nombreSeguro);
  if (!herramienta) {
    return finalizar('DENEGADO', 'HERRAMIENTA_NO_REGISTRADA', fallo(MENSAJES.NO_REGISTRADA), clavesRecibidas(argumentos));
  }
  if (herramientasPermitidas && !herramientasPermitidas.has(nombreSeguro)) {
    return finalizar('DENEGADO', 'FUERA_DE_CONTEXTO', fallo(MENSAJES.FUERA_DE_CONTEXTO), clavesRecibidas(argumentos));
  }

  // 2. El modelo nunca elige la identidad
  const args = argumentos ?? {};
  if (args && typeof args === 'object' && Object.keys(args).some(k => PARAMETROS_IDENTIDAD.test(k))) {
    return finalizar('DENEGADO', 'PARAMETRO_DE_IDENTIDAD', fallo(MENSAJES.IDENTIDAD), clavesRecibidas(args));
  }

  // 3. Parámetros según esquema
  const validacion = validarParametros(args, herramienta.parametros);
  if (!validacion.ok) {
    return finalizar('ERROR', 'PARAMETROS_INVALIDOS', fallo(validacion.error), clavesRecibidas(args));
  }
  const valores = validacion.valores;

  // 4. Permisos reales, releídos en cada llamada
  let niveles;
  try {
    niveles = await nexiPermisos.obtenerNiveles(usuario);
  } catch (err) {
    console.error(`[Nexi] Error al verificar permisos para ${nombreSeguro}:`, err.message);
    return finalizar('ERROR', 'ERROR_PERMISOS', fallo(MENSAJES.INTERNO), valores);
  }
  if (!nexiPermisos.cumpleRequisitos(niveles, herramienta.requisitos)) {
    return finalizar('DENEGADO', 'SIN_PERMISO', fallo(MENSAJES.SIN_PERMISO), valores);
  }

  // 4b. Restricción de rol (campo opcional: solo aplica si la herramienta lo declara).
  // Herramientas sin `requisitosRol` pasan siempre este punto sin cambios.
  if (herramienta.requisitosRol && !herramienta.requisitosRol.includes(usuario?.role)) {
    return finalizar('DENEGADO', 'SIN_PERMISO', fallo(MENSAJES.SIN_PERMISO), valores);
  }

  // 5. Handler con el usuario de la sesión
  try {
    const datos = await herramienta.handler(valores, { usuario, hoy: hoyArgentina(ahora), ahora });
    const resultado = { ok: true, datos };
    if (JSON.stringify(resultado).length > LIMITES.MAX_RESULTADO_CARACTERES) {
      return finalizar('ERROR', 'RESULTADO_DEMASIADO_GRANDE', fallo(MENSAJES.DEMASIADO_GRANDE), valores);
    }
    return finalizar('OK', null, resultado, valores);
  } catch (err) {
    if (err.denegado) {
      return finalizar('DENEGADO', err.motivo || 'ALCANCE_NO_GARANTIZADO', fallo(err.message), valores);
    }
    // Errores de validación de dominio (período inválido, indicador inexistente):
    // mensajes redactados por el backend, seguros para el modelo. Los errores de
    // Supabase/PostgREST (con `code`) nunca pasan su mensaje.
    if ((err.herramienta || [400, 404, 409].includes(err.status)) && !err.code) {
      return finalizar('ERROR', 'ERROR_VALIDACION', fallo(err.message), valores);
    }
    console.error(`[Nexi] Error interno en herramienta ${nombreSeguro}:`, err.message);
    return finalizar('ERROR', 'ERROR_INTERNO', fallo(MENSAJES.INTERNO), valores);
  }
}

module.exports = {
  ejecutar,
  herramientasDisponibles,
  moduloPrincipal,
  declaraciones,
  _REGISTRO: REGISTRO,
  _crearRegistro: crearRegistro,
  _PARAMETROS_IDENTIDAD: PARAMETROS_IDENTIDAD,
};
