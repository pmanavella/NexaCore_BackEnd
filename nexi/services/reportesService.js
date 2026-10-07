const nexiPermisos = require('./nexiPermisos');
const { resolverPeriodoReporte } = require('./reportePeriodo');
const { RECOLECTORES } = require('./reporteSecciones');
const reportePdf = require('./reportePdf');
const repositorio = require('./reportesRepositorio');
const { formatear, variacion } = require('./reporteFormato');
const { SECCIONES, TIPOS, LIMITES_REPORTES } = require('../config/reportes');

// Generación de reportes bajo demanda. Etapas separadas:
//   1. validación de la solicitud (tipo, secciones, período, formato, límites);
//   2. autorización POR SECCIÓN con la regla única de Nexi
//      (nexiPermisos.evaluarRequisitos): lo no permitido se excluye y se
//      informa; si no queda ninguna sección, se deniega;
//   3. obtención y cálculo de datos (reporteSecciones, en el backend);
//   4. estructuración (resumen ejecutivo determinista);
//   5. generación del archivo (reportePdf);
//   6. almacenamiento y auditoría (reportesRepositorio).
// El modelo de IA solo elige los parámetros (validados acá) y redacta su
// respuesta en el chat a partir de los datos clave que se le devuelven.

const MOTIVOS = {
  SIN_PERMISO: 'No tenés permiso para consultar este módulo (o tu rol no tiene acceso).',
  ALCANCE_INSUFICIENTE: 'El alcance de tus permisos en este módulo no permite incluirlo en un reporte.',
};

function errorSolicitud(mensaje) {
  return Object.assign(new Error(mensaje), { status: 400, herramienta: true });
}

function denegar(mensaje, motivo) {
  return Object.assign(new Error(mensaje), { denegado: true, motivo });
}

// tipo + secciones → lista de secciones pedidas (validada).
function seccionesPedidas(tipo, secciones) {
  if (tipo === 'personalizado') {
    if (!secciones?.length) throw errorSolicitud('Para un reporte personalizado indicá qué secciones incluir.');
    return secciones;
  }
  if (secciones?.length) throw errorSolicitud('"secciones" solo se usa con tipo "personalizado".');
  return TIPOS[tipo].secciones;
}

function tituloReporte(tipo, secciones, periodo) {
  const base = tipo === 'personalizado'
    ? `Reporte de ${secciones.map(s => SECCIONES[s].titulo).join(', ')}`
    : TIPOS[tipo].titulo;
  return `${base} - ${periodo.etiqueta}`;
}

// Resumen ejecutivo determinista: variaciones más relevantes y las primeras
// observaciones de cada sección (frases armadas con números del backend).
function resumenEjecutivo(secciones) {
  const variaciones = secciones
    .flatMap(s => s.variaciones)
    .filter(v => v.variacion_pct !== null)
    .sort((a, b) => Math.abs(b.variacion_pct) - Math.abs(a.variacion_pct))
    .slice(0, 8);
  const conclusiones = secciones.flatMap(s => s.observaciones.slice(0, 2).map(o => `${s.titulo}: ${o}`));
  return { variaciones, conclusiones };
}

// Datos clave para que el modelo informe el resultado (compactos, ya formateados).
function datosClave(secciones) {
  return secciones.map(s => ({
    seccion: s.titulo,
    alcance_aplicado: s.alcance_aplicado,
    cifras: s.cifras.map(c => ({
      etiqueta: c.etiqueta,
      valor: formatear(c.valor, c.formato),
      ...(c.variacion_pct !== undefined ? { variacion: variacion(c.variacion_pct), anterior: formatear(c.anterior, c.formato) } : {}),
    })),
    observaciones: s.observaciones.slice(0, 3),
  }));
}

function fechaEmision(ahora) {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'short',
  }).format(ahora);
}

async function generar({ usuario, niveles, conversacionId, args, hoy, ahora = new Date(), plazo = null }) {
  const inicio = Date.now();
  const formato = args.formato ?? 'pdf';
  const pedidas = seccionesPedidas(args.tipo, args.secciones);
  const periodo = resolverPeriodoReporte(args, hoy);

  // Límite por hora, contado en la base (vale con varias instancias).
  const haceUnaHora = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  if (await repositorio.contarRecientes(usuario.id, haceUnaHora) >= LIMITES_REPORTES.MAX_POR_HORA) {
    throw denegar(`Alcanzaste el límite de ${LIMITES_REPORTES.MAX_POR_HORA} reportes por hora. Intentá más tarde.`, 'LIMITE_REPORTES');
  }

  const incluidas = [];
  const excluidas = [];
  for (const clave of pedidas) {
    const acceso = nexiPermisos.evaluarRequisitos(SECCIONES[clave], niveles, usuario);
    if (acceso.ok) incluidas.push({ clave, alcance: acceso.alcance });
    else excluidas.push({ seccion: clave, titulo: SECCIONES[clave].titulo, motivo: MOTIVOS[acceso.motivo] });
  }

  const titulo = tituloReporte(args.tipo, pedidas, periodo);
  const id = await repositorio.crear({
    usuarioId: usuario.id, conversacionId, tipo: args.tipo, titulo,
    secciones: incluidas.map(s => s.clave), excluidas, periodo, formato,
  });

  if (!incluidas.length) {
    await repositorio.finalizar(id, { estado: 'DENEGADO', motivo: 'SIN_SECCIONES_PERMITIDAS', duracionMs: Date.now() - inicio });
    throw denegar(
      `No se generó el reporte: no tenés permisos para incluir ninguna de las secciones pedidas (${excluidas.map(e => e.titulo).join(', ')}).`,
      'SIN_SECCIONES_PERMITIDAS'
    );
  }

  try {
    // 3. Datos y cálculos (secuencial: acota la carga y respeta el plazo global).
    const secciones = [];
    for (const { clave, alcance } of incluidas) {
      plazo?.verificar();
      secciones.push(await RECOLECTORES[clave]({ usuario, niveles, alcance, periodo, hoy, ahora }));
    }

    // 4. Estructura.
    const estructura = {
      titulo,
      periodo,
      emitido: fechaEmision(ahora),
      solicitante: `${usuario.name || 'Usuario'}${usuario.role ? ` (${usuario.role})` : ''}`,
      excluidas,
      resumen: secciones.length > 1 ? resumenEjecutivo(secciones) : null,
      secciones,
    };

    // 5. Archivo.
    plazo?.verificar();
    const archivo = await reportePdf.generarPdf(estructura);
    if (archivo.length > LIMITES_REPORTES.MAX_BYTES_ARCHIVO) {
      throw errorSolicitud('El reporte resultó demasiado grande. Probá con un período más corto o menos secciones.');
    }

    // 6. Almacenamiento.
    plazo?.verificar();
    const ruta = `${usuario.id}/${id}.pdf`;
    await repositorio.subirArchivo(ruta, archivo, 'application/pdf');
    await repositorio.finalizar(id, { estado: 'GENERADO', archivoPath: ruta, archivoBytes: archivo.length, duracionMs: Date.now() - inicio });

    return {
      reporte_id: id,
      titulo,
      formato,
      tamanio_kb: Math.ceil(archivo.length / 1024),
      periodo: periodo.etiqueta,
      en_curso: periodo.en_curso,
      comparado_con: periodo.comparacion?.etiqueta || null,
      secciones_incluidas: secciones.map(s => s.titulo),
      secciones_excluidas: excluidas.map(e => ({ seccion: e.titulo, motivo: e.motivo })),
      datos_clave: datosClave(secciones),
      descarga: 'El archivo quedó disponible para descargar desde el chat.',
    };
  } catch (err) {
    const motivo = err.codigo === 'NEXI_TIMEOUT' ? 'TIMEOUT_GLOBAL' : (err.herramienta ? 'ERROR_VALIDACION' : 'ERROR_INTERNO');
    await repositorio.finalizar(id, { estado: 'ERROR', motivo, duracionMs: Date.now() - inicio });
    throw err;
  }
}

module.exports = { generar, resumenEjecutivo, seccionesPedidas };
