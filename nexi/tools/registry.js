const finanzasTools = require('./finanzasTools');
const indicadoresTools = require('./indicadoresTools');
const operativoTools = require('./operativoTools');
const crmTools = require('./crmTools');
const dashboardTools = require('./dashboardTools');
const organizacionTools = require('./organizacionTools');
const protocolosTools = require('./protocolosTools');
const reportesTools = require('./reportesTools');
const { validarParametros } = require('./validarParametros');
const nexiPermisos = require('../services/nexiPermisos');
const auditoriaService = require('../services/auditoriaService');
const { hoyArgentina } = require('../../indicators/services/periodos');
const { LIMITES, ALCANCES } = require('../config/nexi');

// Registro CERRADO de herramientas de Nexi. Solo lectura, con UNA excepción
// controlada: herramientas con efecto 'GENERACION' (generar_reporte), que
// producen un archivo a partir de datos leídos con las mismas reglas de
// permisos y nunca modifican datos de negocio. No existen herramientas de
// escritura sobre los módulos.
//
// Cada herramienta declara: nombre, descripcion, parametros (JSON Schema con
// additionalProperties: false), requisitos [{ modulo, permiso }], alcance
// (tipo de dato: AGREGADA | PERSONAL), alcancesPermitidos (alcances de permiso
// que puede respetar; por defecto solo 'global'), requisitosRol opcional y
// handler(args, ctx).
//
// evaluarAcceso() es la ÚNICA regla de autorización y se aplica dos veces:
//   - al armar la lista de herramientas que se ofrece al modelo;
//   - de nuevo, con permisos releídos, en cada ejecución.
//
// ejecutar() es el único camino hacia un handler y, en cada llamada:
//   1. rechaza herramientas no registradas o fuera del foco;
//   2. rechaza parámetros de identidad (usuario_id, email, ...);
//   3. valida los parámetros contra el esquema;
//   4. vuelve a leer los permisos reales del usuario (Matriz de permisos) y
//      verifica módulos requeridos, rol y alcance;
//   5. recién entonces ejecuta el handler con el usuario de la sesión y el
//      alcance efectivo;
//   6. registra la llamada en nexi_tool_calls.

const PERMISOS_V1 = ['lector'];
const EFECTOS = ['LECTURA', 'GENERACION'];
const TIPOS_DATO = ['AGREGADA', 'PERSONAL'];
const NOMBRE_REGEX = /^[a-z][a-z0-9_]{2,63}$/;
// Herramientas genéricas que nunca deben existir.
const NOMBRES_PROHIBIDOS = /(sql|tabla|endpoint|comando|shell|exec|ejecutar|query|http|fetch|crear|editar|eliminar|borrar|actualizar|salari|sueldo|nomina)/;
// Parámetros que identificarían a otra persona: la identidad sale solo de req.user.
// Incluye identificadores de empresa/organización/tenant: no existe
// multi-empresa y nunca se aceptan desde el modelo.
const PARAMETROS_IDENTIDAD = /^(usuario|user|empleado|persona|empresa|company|organizacion|organization|org|tenant)?_?(id|email|mail|nombre|name|rol|role)$|^(asignado_?a|responsable|propuesto_?por|realizado_?por|created_?by|creado_?por)$/i;

const MENSAJES = {
  NO_REGISTRADA: 'La herramienta solicitada no existe. Usá solo las herramientas disponibles.',
  FUERA_DE_CONTEXTO: 'Esta conversación está enfocada en otro módulo. Usá solo las herramientas disponibles.',
  IDENTIDAD: 'No se admite indicar usuarios: la consulta siempre corresponde al usuario autenticado.',
  SIN_PERMISO: 'El usuario no tiene permisos para usar esta función. No es una limitación de Nexi: está bloqueada por sus permisos.',
  ALCANCE_INSUFICIENTE: 'El alcance de los permisos del usuario en este módulo no permite consultar esta información.',
  LIMITE_GENERACION: 'Solo se puede generar un reporte por mensaje.',
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
  if (!TIPOS_DATO.includes(h.alcance)) fallas.push('alcance inválido');
  if (h.alcancesPermitidos !== undefined) {
    if (!Array.isArray(h.alcancesPermitidos) || h.alcancesPermitidos.length === 0 ||
        h.alcancesPermitidos.some(a => !ALCANCES.includes(a)))
      fallas.push('alcancesPermitidos inválido');
  }
  if (typeof h.handler !== 'function') fallas.push('sin handler');
  if (h.efecto !== undefined && !EFECTOS.includes(h.efecto)) fallas.push('efecto inválido');
  if (h.artefacto !== undefined && (h.efecto !== 'GENERACION' || typeof h.artefacto !== 'function')) fallas.push('artefacto solo en herramientas de generación');
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
    // Sin declaración explícita, la herramienta solo atiende alcance global.
    registro.set(h.nombre, Object.freeze({ ...h, efecto: h.efecto || 'LECTURA', alcancesPermitidos: h.alcancesPermitidos || ['global'] }));
  }
  return registro;
}

const REGISTRO = crearRegistro([
  ...finanzasTools, ...indicadoresTools, ...operativoTools, ...crmTools,
  ...dashboardTools, ...organizacionTools, ...protocolosTools, ...reportesTools,
]);

// Módulo al que pertenece una herramienta: el primero de sus requisitos
// (valor_indicador → indicadores, aunque además exija finance).
function moduloPrincipal(herramienta) {
  return herramienta.requisitos[0].modulo;
}

// Regla única de autorización de una herramienta para un usuario:
// nivel mínimo en TODOS los módulos requeridos, rol (si la herramienta lo
// declara) y alcance de permiso admitido en todos los módulos requeridos.
// Devuelve { ok, motivo, alcance } — alcance = el del módulo principal.
// Sin usuario (o sin rol) una herramienta con requisitosRol nunca se habilita.
function evaluarAcceso(herramienta, niveles, usuario) {
  return nexiPermisos.evaluarRequisitos(herramienta, niveles, usuario);
}

// Herramientas que el usuario puede usar (mismas reglas que ejecutar()).
// `modulo` (opcional) solo restringe: se aplica DESPUÉS de la autorización.
function herramientasDisponibles(niveles, modulo = null, usuario = null) {
  return [...REGISTRO.values()]
    .filter(h => evaluarAcceso(h, niveles, usuario).ok)
    .filter(h => !modulo || moduloPrincipal(h) === modulo);
}

// Módulos de Nexi para los que el usuario no tiene NINGUNA herramienta
// habilitada, con la causa (SIN_PERMISO | ALCANCE_INSUFICIENTE). Se informa al
// modelo para que responda "no tenés permisos" en vez de "Nexi no puede".
// Misma regla que herramientasDisponibles; no incluye detalles de roles.
function modulosSinAcceso(niveles, usuario = null) {
  const porModulo = new Map();
  for (const h of REGISTRO.values()) {
    const modulo = moduloPrincipal(h);
    const r = evaluarAcceso(h, niveles, usuario);
    const actual = porModulo.get(modulo) || { habilitado: false, motivos: new Set() };
    if (r.ok) actual.habilitado = true;
    else actual.motivos.add(r.motivo);
    porModulo.set(modulo, actual);
  }
  return [...porModulo.entries()]
    .filter(([, v]) => !v.habilitado)
    .map(([modulo, v]) => ({
      modulo,
      label: niveles.get(modulo)?.label || modulo,
      // Si el nivel alcanza pero el alcance no, se informa como alcance insuficiente.
      motivo: v.motivos.has('ALCANCE_INSUFICIENTE') ? 'ALCANCE_INSUFICIENTE' : 'SIN_PERMISO',
    }));
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
// plazo (opcional): plazo global de la consulta (nexi/utils/plazo.js). Si vence
// durante el handler se audita como TIMEOUT_GLOBAL y el error se propaga.
// permitirGeneracion: false deniega herramientas con efecto GENERACION (límite
// de reportes por mensaje, controlado por nexiService).
async function ejecutar({ nombre, argumentos, usuario, conversacionId, ahora = new Date(), herramientasPermitidas = null, plazo = null, permitirGeneracion = true }) {
  const inicio = Date.now();
  const nombreSeguro = typeof nombre === 'string' ? nombre.slice(0, 100) : '';

  const finalizar = async (estado, motivo, resultado, argumentosAuditoria, artefacto = null) => {
    await auditoriaService.registrar({
      conversacionId,
      usuarioId: usuario?.id,
      herramienta: nombreSeguro,
      argumentos: argumentosAuditoria,
      estado,
      motivo,
      duracionMs: Date.now() - inicio,
    });
    return artefacto ? { estado, motivo, resultado, artefacto } : { estado, motivo, resultado };
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

  if (herramienta.efecto === 'GENERACION' && !permitirGeneracion) {
    return finalizar('DENEGADO', 'LIMITE_GENERACION', fallo(MENSAJES.LIMITE_GENERACION), clavesRecibidas(argumentos));
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
  const acceso = evaluarAcceso(herramienta, niveles, usuario);
  if (!acceso.ok) {
    // Causa estructurada para el modelo (sin detalles de roles ni de la Matriz).
    const modulo = moduloPrincipal(herramienta);
    return finalizar('DENEGADO', acceso.motivo, {
      ...fallo(MENSAJES[acceso.motivo]),
      causa: acceso.motivo,
      modulo: niveles.get(modulo)?.label || modulo,
    }, valores);
  }

  // 5. Handler con el usuario de la sesión
  try {
    // No se inicia un handler si el plazo global ya venció.
    plazo?.verificar();
    const ctx = { usuario, hoy: hoyArgentina(ahora), ahora, alcance: acceso.alcance, niveles, plazo, conversacionId };
    const datos = plazo ? await plazo.carrera(herramienta.handler(valores, ctx)) : await herramienta.handler(valores, ctx);
    const resultado = { ok: true, datos };
    if (JSON.stringify(resultado).length > LIMITES.MAX_RESULTADO_CARACTERES) {
      return finalizar('ERROR', 'RESULTADO_DEMASIADO_GRANDE', fallo(MENSAJES.DEMASIADO_GRANDE), valores);
    }
    return finalizar('OK', null, resultado, valores, herramienta.artefacto ? herramienta.artefacto(datos) : null);
  } catch (err) {
    if (err.codigo === 'NEXI_TIMEOUT') {
      await finalizar('ERROR', 'TIMEOUT_GLOBAL', fallo(MENSAJES.INTERNO), valores);
      throw err;
    }
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
  evaluarAcceso,
  herramientasDisponibles,
  modulosSinAcceso,
  moduloPrincipal,
  declaraciones,
  _REGISTRO: REGISTRO,
  _crearRegistro: crearRegistro,
  _PARAMETROS_IDENTIDAD: PARAMETROS_IDENTIDAD,
};
