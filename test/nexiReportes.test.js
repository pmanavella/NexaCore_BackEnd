const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const registry = require('../nexi/tools/registry');
const nexiDatos = require('../nexi/services/nexiDatos');
const nexiService = require('../nexi/services/nexiService');
const conversacionesService = require('../nexi/services/conversacionesService');
const auditoriaService = require('../nexi/services/auditoriaService');
const repositorio = require('../nexi/services/reportesRepositorio');
const reportePdf = require('../nexi/services/reportePdf');
const organizacionService = require('../organization/services/organizacionService');
const protocolosService = require('../protocolos/services/protocolosService');
const indicadoresService = require('../indicators/services/indicadoresService');
const suscripcionesService = require('../finance/services/suscripcionesService');
const nexiController = require('../nexi/controllers/nexiController');
const { resolverPeriodoReporte } = require('../nexi/services/reportePeriodo');
const { crearPlazo } = require('../nexi/utils/plazo');
const { LIMITES_REPORTES } = require('../nexi/config/reportes');

const AHORA = new Date('2026-10-07T15:00:00Z');
const HOY = { anio: 2026, mes: 10, fecha: '2026-10-07' };
const ANA = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'ana@nexacore.test', name: 'Ana Pérez', role: 'Operativo' };
const DIRECTORA = { ...ANA, role: 'Dirección' };
const REPORTE_ID = '99999999-9999-4999-8999-999999999999';
const CONV_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function permisos(niveles) {
  return Object.entries(niveles).map(([nombre, v]) => ({
    permiso: typeof v === 'string' ? v : v.permiso,
    alcance: typeof v === 'string' ? 'global' : v.alcance,
    source: 'usuario',
    modulos: { nombre, label: nombre },
  }));
}

// Repositorio y auditoría simulados: registra lo que se persistiría.
function preparar(t, niveles, { recientes = 0 } = {}) {
  t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => permisos(niveles));
  const m = {
    auditoria: t.mock.method(auditoriaService, 'registrar', async () => {}),
    crear: t.mock.method(repositorio, 'crear', async () => REPORTE_ID),
    finalizar: t.mock.method(repositorio, 'finalizar', async () => {}),
    contar: t.mock.method(repositorio, 'contarRecientes', async () => recientes),
    subir: t.mock.method(repositorio, 'subirArchivo', async () => {}),
  };
  return m;
}

function ejecutar(argumentos, usuario = DIRECTORA, extra = {}) {
  return registry.ejecutar({ nombre: 'generar_reporte', argumentos, usuario, conversacionId: CONV_ID, ahora: AHORA, ...extra });
}

const FILAS_SEP = [
  { mes: '2026-09-01', tipo: 'Ingreso', categoria: 'Servicios', total: '1000' },
  { mes: '2026-09-01', tipo: 'Gasto', categoria: 'Tecnología', total: '300' },
  { mes: '2026-09-01', tipo: 'Gasto', categoria: 'Insumos', total: '100' },
];
const FILAS_AGO = [
  { mes: '2026-08-01', tipo: 'Ingreso', categoria: 'Servicios', total: '800' },
  { mes: '2026-08-01', tipo: 'Gasto', categoria: 'Tecnología', total: '400' },
];

function datosFinanzas(t) {
  t.mock.method(nexiDatos, 'totalesMovimientos', async (desde) => (desde === '2026-09-01' ? FILAS_SEP : desde === '2026-08-01' ? FILAS_AGO : []));
  t.mock.method(nexiDatos, 'deudasPorVencer', async () => ({ filas: [{ acreedor: 'Proveedor SA', monto: '500', vencimiento: '2026-09-15', estado: 'Pendiente' }], total: 1 }));
  t.mock.method(nexiDatos, 'contarComprobantesEnRevision', async () => 2);
  t.mock.method(suscripcionesService, 'proximasVencer', async () => []);
}

// ── Período ─────────────────────────────────────────────────────────────────

test('período: mes, trimestre, semestre, año y rango personalizado', () => {
  const sep = resolverPeriodoReporte({ periodo: '2026-09' }, HOY);
  assert.deepEqual([sep.desde, sep.hasta, sep.etiqueta, sep.en_curso], ['2026-09-01', '2026-10-01', 'Septiembre 2026', false]);
  assert.deepEqual([sep.comparacion.desde, sep.comparacion.hasta], ['2026-08-01', '2026-09-01']);
  const q3 = resolverPeriodoReporte({ periodo: '2026-Q3' }, HOY);
  assert.deepEqual([q3.desde, q3.hasta, q3.meses.length, q3.comparacion.etiqueta], ['2026-07-01', '2026-10-01', 3, 'T2 2026']);
  const s2 = resolverPeriodoReporte({ periodo: '2026-S2' }, HOY);
  assert.equal(s2.en_curso, true);
  assert.equal(s2.datos_hasta, '2026-10-07');
  // En curso: se compara contra el mismo tramo transcurrido del período anterior.
  assert.deepEqual([s2.comparacion.desde, s2.comparacion.hasta], ['2026-01-01', '2026-04-08']);
  const oct = resolverPeriodoReporte({ periodo: '2026-10' }, HOY);
  assert.deepEqual([oct.comparacion.desde, oct.comparacion.hasta], ['2026-09-01', '2026-09-08']);
  assert.match(oct.comparacion.etiqueta, /mismo tramo: 01\/09\/2026 al 07\/09\/2026/);
  const anio = resolverPeriodoReporte({ periodo: '2026', comparar_con: 'ninguno' }, HOY);
  assert.equal(anio.meses.length, 12);
  assert.equal(anio.comparacion, null);
  const rango = resolverPeriodoReporte({ desde: '2026-09-10', hasta: '2026-09-19' }, HOY);
  assert.deepEqual([rango.desde, rango.hasta, rango.comparacion.desde, rango.comparacion.hasta], ['2026-09-10', '2026-09-20', '2026-08-31', '2026-09-10']);
  const explicita = resolverPeriodoReporte({ periodo: '2026-09', comparar_con: '2026-08' }, HOY);
  assert.equal(explicita.comparacion.etiqueta, 'Agosto 2026');
});

test('período inválido: faltante, futuro, mayor a 12 meses, mezcla de formatos', () => {
  const casos = [
    [{}, /Falta el período/],
    [{ periodo: '2026-11' }, /todavía no comenzó/],
    [{ periodo: '2026-Q4', comparar_con: '2027' }, /todavía no comenzó/],
    [{ desde: '2025-01-01', hasta: '2026-03-01' }, /12 meses/],
    [{ periodo: '2026-09', desde: '2026-09-01', hasta: '2026-09-30' }, /no ambos/],
    [{ desde: '2026-02-30', hasta: '2026-03-10' }, /no son válidas/],
    [{ desde: '2026-09-10', hasta: '2026-09-01' }, /anterior o igual/],
  ];
  for (const [args, mensaje] of casos) {
    assert.throws(() => resolverPeriodoReporte(args, HOY), err => err.status === 400 && mensaje.test(err.message), JSON.stringify(args));
  }
});

// ── Generación ──────────────────────────────────────────────────────────────

test('reporte financiero: datos del backend, PDF real, archivo privado por usuario y auditoría GENERADO', async (t) => {
  const m = preparar(t, { reportes: 'lector', finance: 'lector' });
  datosFinanzas(t);
  const r = await ejecutar({ tipo: 'financiero', periodo: '2026-09' });
  assert.equal(r.estado, 'OK', JSON.stringify(r.resultado));
  const d = r.resultado.datos;
  assert.equal(d.reporte_id, REPORTE_ID);
  assert.equal(d.periodo, 'Septiembre 2026');
  assert.equal(d.comparado_con, 'Agosto 2026');
  const fin = d.datos_clave[0];
  assert.deepEqual(fin.cifras.map(c => c.valor), ['$ 1.000,00', '$ 400,00', '$ 600,00']);
  assert.equal(fin.cifras[0].variacion, '+25,0 %');

  // Archivo: PDF real, en la carpeta del usuario.
  const [ruta, buffer, tipo] = m.subir.mock.calls[0].arguments;
  assert.equal(ruta, `${DIRECTORA.id}/${REPORTE_ID}.pdf`);
  assert.equal(tipo, 'application/pdf');
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');

  // Auditoría: tipo, secciones, período; luego GENERADO con duración y ubicación.
  const creado = m.crear.mock.calls[0].arguments[0];
  assert.equal(creado.usuarioId, DIRECTORA.id);
  assert.equal(creado.tipo, 'financiero');
  assert.deepEqual(creado.secciones, ['finanzas']);
  assert.equal(creado.periodo.desde, '2026-09-01');
  const [idFin, fin2] = m.finalizar.mock.calls[0].arguments;
  assert.equal(idFin, REPORTE_ID);
  assert.equal(fin2.estado, 'GENERADO');
  assert.equal(fin2.archivoPath, ruta);
  assert.ok(Number.isInteger(fin2.duracionMs));

  // Artefacto para el frontend y auditoría de la herramienta sin resultados.
  assert.deepEqual(r.artefacto, { tipo: 'reporte', id: REPORTE_ID, titulo: d.titulo, formato: 'pdf', descargaUrl: `/api/nexi/reportes/${REPORTE_ID}/descarga` });
  const aud = m.auditoria.mock.calls[0].arguments[0];
  assert.deepEqual(aud.argumentos, { tipo: 'financiero', periodo: '2026-09' });
  assert.doesNotMatch(JSON.stringify(aud), /1\.000|Proveedor SA/);
});

test('reporte operativo con alcance propio: solo tareas del alcance (sin conteos globales)', async (t) => {
  preparar(t, { reportes: 'lector', operations: { permiso: 'lector', alcance: 'propio' } });
  const global = t.mock.method(nexiDatos, 'contarTareas', async () => 999);
  t.mock.method(nexiDatos, 'contarUsuariosConNombre', async () => 1);
  t.mock.method(nexiDatos, 'idsTareasDeUsuarios', async () => ['t1', 't2']);
  t.mock.method(nexiDatos, 'filasTareasPorIds', async () => [
    { id: 't1', estado: 'Completada', prioridad: 'Alta', fecha_limite: '2026-08-10', tipo: 'asignacion' },
    { id: 't2', estado: 'Pendiente', prioridad: 'Media', fecha_limite: '2026-09-05', tipo: null },
  ]);
  const r = await ejecutar({ tipo: 'operativo', periodo: '2026-Q3' }, ANA);
  assert.equal(r.estado, 'OK', JSON.stringify(r.resultado));
  assert.equal(global.mock.callCount(), 0);
  const op = r.resultado.datos.datos_clave[0];
  assert.equal(op.alcance_aplicado, 'propio');
  assert.equal(op.cifras[0].valor, '2');
  assert.equal(op.cifras[1].valor, '1');
});

test('reporte de protocolos: ejecuciones, cumplimiento y responsables del período', async (t) => {
  const m = preparar(t, { reportes: 'lector', protocolos: 'lector' });
  t.mock.method(nexiDatos, 'pruebasProtocolos', async ({ desde }) => ({
    filas: desde === '2026-01-01' ? [
      { protocolo_id: 'p1', fecha: '2026-03-01', realizado_por: 'Victoria', resultados: [{ texto: 'Sensor', estado: 'fail' }], observaciones: 'Wifi débil', action_items: [], created_by: ANA.id },
      { protocolo_id: 'p1', fecha: '2026-04-01', realizado_por: 'Victoria', resultados: [{ texto: 'Sensor', estado: 'ok' }], created_by: ANA.id },
    ] : [],
    total: desde === '2026-01-01' ? 2 : 0,
  }));
  t.mock.method(protocolosService, 'obtenerProtocolo', async () => ({ id: 'p1', nombre: 'Prueba de robot', categoria: 'robot' }));
  t.mock.method(protocolosService, 'listarProtocolos', async () => ({ data: [{ id: 'p1', categoria: 'robot', created_by: ANA.id }], total: 1 }));
  const r = await ejecutar({ tipo: 'protocolos', periodo: '2026' });
  assert.equal(r.estado, 'OK', JSON.stringify(r.resultado));
  const p = r.resultado.datos.datos_clave[0];
  assert.deepEqual(p.cifras.map(c => c.valor), ['2', '1', '50,0 %', '1']);
  assert.match(p.observaciones[0], /2 ejecución/);
  assert.equal(m.subir.mock.callCount(), 1);
});

test('reporte multi-módulo (ejecutivo): CRM sin permiso se excluye y se explica; el resto se genera', async (t) => {
  const m = preparar(t, { reportes: 'lector', finance: 'lector', operations: 'lector' });
  datosFinanzas(t);
  t.mock.method(nexiDatos, 'contarTareas', async () => 0);
  let estructura;
  const original = reportePdf.generarPdf;
  t.mock.method(reportePdf, 'generarPdf', async (e) => { estructura = e; return original(e); });
  const r = await ejecutar({ tipo: 'ejecutivo', periodo: '2026-09' }, ANA);
  assert.equal(r.estado, 'OK', JSON.stringify(r.resultado));
  const d = r.resultado.datos;
  assert.deepEqual(d.secciones_incluidas, ['Finanzas', 'Operativo']);
  assert.deepEqual(d.secciones_excluidas.map(e => e.seccion), ['Indicadores (KPI)', 'CRM', 'Protocolos']);
  assert.match(d.secciones_excluidas[1].motivo, /permiso/);
  assert.deepEqual(m.crear.mock.calls[0].arguments[0].secciones, ['finanzas', 'operativo']);
  assert.equal(m.crear.mock.calls[0].arguments[0].excluidas.length, 3);
  // Resumen ejecutivo determinista: variaciones calculadas y conclusiones por sección.
  assert.ok(estructura.resumen);
  assert.ok(estructura.resumen.variaciones.some(v => v.etiqueta === 'Finanzas: Ingresos' && v.variacion_pct === 25));
  assert.ok(estructura.resumen.conclusiones.every(c => /^(Finanzas|Operativo): /.test(c)));
  assert.deepEqual(estructura.excluidas.map(e => e.seccion), ['indicadores', 'crm', 'protocolos']);
});

test('reporte personalizado Finanzas + CRM: rol sin acceso a CRM → CRM excluido; con rol habilitado → incluido', async (t) => {
  preparar(t, { reportes: 'lector', finance: 'lector', crm: 'lector' });
  datosFinanzas(t);
  t.mock.method(nexiDatos, 'contarContactos', async () => 3);
  const sinRol = await ejecutar({ tipo: 'personalizado', secciones: ['finanzas', 'crm'], periodo: '2026-Q3' }, ANA);
  assert.deepEqual(sinRol.resultado.datos.secciones_incluidas, ['Finanzas']);
  const conRol = await ejecutar({ tipo: 'personalizado', secciones: ['finanzas', 'crm'], periodo: '2026-Q3' }, DIRECTORA);
  assert.deepEqual(conRol.resultado.datos.secciones_incluidas, ['Finanzas', 'CRM']);
  assert.doesNotMatch(JSON.stringify(conRol.resultado), /@|telefono|email/);
});

test('módulo sin permiso: ninguna sección permitida → DENEGADO, auditado, sin datos ni archivo', async (t) => {
  const m = preparar(t, { reportes: 'lector', finance: 'lector' });
  const contactos = t.mock.method(nexiDatos, 'contarContactos', async () => 1);
  const r = await ejecutar({ tipo: 'crm', periodo: '2026-09' }, DIRECTORA);
  assert.equal(r.estado, 'DENEGADO');
  assert.equal(r.motivo, 'SIN_SECCIONES_PERMITIDAS');
  assert.match(r.resultado.error, /CRM/);
  assert.equal(contactos.mock.callCount(), 0);
  assert.equal(m.subir.mock.callCount(), 0);
  assert.equal(m.finalizar.mock.calls[0].arguments[1].estado, 'DENEGADO');
});

test('sin permiso en Reportes: generar_reporte no se ofrece ni se ejecuta (un reporte no saltea permisos)', async (t) => {
  const niveles = new Map([['finance', { nivel: 'lector', alcance: 'global' }]]);
  assert.ok(!registry.herramientasDisponibles(niveles, null, DIRECTORA).some(h => h.nombre === 'generar_reporte'));
  const m = preparar(t, { finance: 'lector' });
  const r = await ejecutar({ tipo: 'financiero', periodo: '2026-09' });
  assert.equal(r.estado, 'DENEGADO');
  assert.equal(r.motivo, 'SIN_PERMISO');
  assert.equal(m.crear.mock.callCount(), 0);
});

test('alcance propio en Finanzas: la sección financiera se excluye (nunca datos globales)', async (t) => {
  preparar(t, { reportes: 'lector', finance: { permiso: 'lector', alcance: 'propio' } });
  const totales = t.mock.method(nexiDatos, 'totalesMovimientos', async () => FILAS_SEP);
  const r = await ejecutar({ tipo: 'financiero', periodo: '2026-09' });
  assert.equal(r.estado, 'DENEGADO');
  assert.equal(totales.mock.callCount(), 0);
});

test('período inválido → ERROR_VALIDACION sin crear registro ni consultar datos', async (t) => {
  const m = preparar(t, { reportes: 'lector', finance: 'lector' });
  const totales = t.mock.method(nexiDatos, 'totalesMovimientos', async () => []);
  for (const args of [{ tipo: 'financiero' }, { tipo: 'financiero', periodo: '2027' }, { tipo: 'financiero', desde: '2024-01-01', hasta: '2026-01-01' }]) {
    const r = await ejecutar(args);
    assert.equal(r.motivo, 'ERROR_VALIDACION', JSON.stringify(args));
  }
  // Formato inválido o secciones incoherentes: rechazados por esquema/validación.
  assert.equal((await ejecutar({ tipo: 'financiero', periodo: 'septiembre' })).motivo, 'PARAMETROS_INVALIDOS');
  assert.equal((await ejecutar({ tipo: 'financiero', periodo: '2026-09', formato: 'docx' })).motivo, 'PARAMETROS_INVALIDOS');
  assert.equal((await ejecutar({ tipo: 'personalizado', secciones: ['finanzas', 'finanzas'], periodo: '2026-09' })).motivo, 'PARAMETROS_INVALIDOS');
  assert.equal((await ejecutar({ tipo: 'personalizado', secciones: ['salarios'], periodo: '2026-09' })).motivo, 'PARAMETROS_INVALIDOS');
  assert.equal((await ejecutar({ tipo: 'financiero', secciones: ['crm'], periodo: '2026-09' })).motivo, 'ERROR_VALIDACION');
  assert.equal(m.crear.mock.callCount(), 0);
  assert.equal(totales.mock.callCount(), 0);
});

test('ausencia de datos: el reporte se genera con ceros y lo dice, sin inventar', async (t) => {
  const m = preparar(t, { reportes: 'lector', finance: 'lector' });
  t.mock.method(nexiDatos, 'totalesMovimientos', async () => []);
  t.mock.method(nexiDatos, 'deudasPorVencer', async () => ({ filas: [], total: 0 }));
  t.mock.method(nexiDatos, 'contarComprobantesEnRevision', async () => 0);
  const r = await ejecutar({ tipo: 'financiero', periodo: '2026-01', comparar_con: 'ninguno' });
  assert.equal(r.estado, 'OK');
  const fin = r.resultado.datos.datos_clave[0];
  assert.deepEqual(fin.cifras.map(c => c.valor), ['$ 0,00', '$ 0,00', '$ 0,00']);
  assert.ok(!fin.cifras.some(c => c.variacion));
  assert.equal(m.subir.mock.callCount(), 1);
});

test('límites: por hora (en la base) y uno por mensaje', async (t) => {
  const m = preparar(t, { reportes: 'lector', finance: 'lector' }, { recientes: LIMITES_REPORTES.MAX_POR_HORA });
  const r = await ejecutar({ tipo: 'financiero', periodo: '2026-09' });
  assert.equal(r.estado, 'DENEGADO');
  assert.equal(r.motivo, 'LIMITE_REPORTES');
  assert.equal(m.crear.mock.callCount(), 0);
  const r2 = await ejecutar({ tipo: 'financiero', periodo: '2026-09' }, DIRECTORA, { permitirGeneracion: false });
  assert.equal(r2.motivo, 'LIMITE_GENERACION');
});

test('timeout global durante la generación: no se sube archivo, registro en ERROR (TIMEOUT_GLOBAL), error propagado', async (t) => {
  const m = preparar(t, { reportes: 'lector', finance: 'lector', operations: 'lector' });
  // Finanzas tarda más que el plazo; Operativo nunca debería empezar.
  t.mock.method(nexiDatos, 'totalesMovimientos', () => new Promise(r => setTimeout(() => r([]), 80)));
  t.mock.method(nexiDatos, 'deudasPorVencer', async () => ({ filas: [], total: 0 }));
  t.mock.method(nexiDatos, 'contarComprobantesEnRevision', async () => 0);
  const tareas = t.mock.method(nexiDatos, 'contarTareas', async () => 0);
  const plazo = crearPlazo(30);
  await assert.rejects(
    () => ejecutar({ tipo: 'personalizado', secciones: ['finanzas', 'operativo'], periodo: '2026-09' }, DIRECTORA, { plazo }),
    err => err.codigo === 'NEXI_TIMEOUT'
  );
  await new Promise(r => setTimeout(r, 120)); // el handler en segundo plano llega al siguiente control
  assert.equal(m.subir.mock.callCount(), 0);
  assert.equal(tareas.mock.callCount(), 0);
  const fin = m.finalizar.mock.calls.at(-1).arguments[1];
  assert.equal(fin.estado, 'ERROR');
  assert.equal(fin.motivo, 'TIMEOUT_GLOBAL');
  assert.ok(m.auditoria.mock.calls.some(c => c.arguments[0].motivo === 'TIMEOUT_GLOBAL'));
});

test('error al guardar el archivo → ERROR auditado, el modelo recibe un mensaje genérico', async (t) => {
  const m = preparar(t, { reportes: 'lector', finance: 'lector' });
  datosFinanzas(t);
  t.mock.method(console, 'error', () => {});
  m.subir.mock.mockImplementation(async () => { throw new Error('storage: bucket not found'); });
  const r = await ejecutar({ tipo: 'financiero', periodo: '2026-09' });
  assert.equal(r.estado, 'ERROR');
  assert.equal(r.motivo, 'ERROR_INTERNO');
  assert.doesNotMatch(r.resultado.error, /bucket|storage/);
  assert.equal(m.finalizar.mock.calls[0].arguments[1].estado, 'ERROR');
});

// ── Chat ────────────────────────────────────────────────────────────────────

function prepararChat(t, niveles) {
  const m = preparar(t, niveles);
  t.mock.method(conversacionesService, 'obtenerPropia', async () => ({ id: CONV_ID, titulo: 'x' }));
  t.mock.method(conversacionesService, 'historialReciente', async () => []);
  t.mock.method(conversacionesService, 'guardarIntercambio', async (id, { respuesta }) => ({ id: 'm', rol: 'asistente', contenido: respuesta }));
  t.mock.method(conversacionesService, 'eliminarSiVacia', async () => {});
  return m;
}

function respuestas(t, ...secuencia) {
  let i = 0;
  return t.mock.method(nexiService.proveedor, 'generar', async () => {
    const r = secuencia[Math.min(i++, secuencia.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  });
}

test('chat: genera un reporte y lo devuelve en `reportes`; un segundo reporte en el mismo mensaje se deniega', async (t) => {
  const m = prepararChat(t, { reportes: 'lector', finance: 'lector' });
  datosFinanzas(t);
  const llamada = id => ({ id, nombre: 'generar_reporte', argumentos: { tipo: 'financiero', periodo: '2026-09' } });
  respuestas(t,
    { texto: '', llamadas: [llamada('a'), llamada('b')], crudo: {}, truncado: false },
    { texto: 'Listo, generé el reporte financiero de septiembre.', llamadas: [], crudo: null, truncado: false },
  );
  const r = await nexiService.chat({ usuario: DIRECTORA, conversationId: CONV_ID, mensaje: 'Generame un reporte financiero de septiembre', ahora: AHORA });
  assert.equal(r.reportes.length, 1);
  assert.deepEqual(r.reportes[0], { id: REPORTE_ID, titulo: r.reportes[0].titulo, formato: 'pdf', descargaUrl: `/api/nexi/reportes/${REPORTE_ID}/descarga` });
  assert.equal(m.subir.mock.callCount(), 1);
  assert.deepEqual(m.auditoria.mock.calls.map(c => c.arguments[0].motivo), [null, 'LIMITE_GENERACION']);
});

test('chat: error del proveedor → error público; no se genera ningún reporte', async (t) => {
  const m = prepararChat(t, { reportes: 'lector', finance: 'lector' });
  t.mock.method(console, 'error', () => {});
  respuestas(t, Object.assign(new Error('Gemini 500'), { proveedor: true, codigo: 'ERROR_PROVEEDOR' }));
  await assert.rejects(
    () => nexiService.chat({ usuario: DIRECTORA, conversationId: CONV_ID, mensaje: 'Generame un reporte', ahora: AHORA }),
    err => err.publico && err.status === 502
  );
  assert.equal(m.crear.mock.callCount(), 0);
});

test('chat: sin reportes generados el campo `reportes` es una lista vacía (contrato estable)', async (t) => {
  prepararChat(t, { reportes: 'lector' });
  respuestas(t, { texto: 'Hola', llamadas: [], crudo: null, truncado: false });
  const r = await nexiService.chat({ usuario: DIRECTORA, conversationId: CONV_ID, mensaje: 'hola' });
  assert.deepEqual(r.reportes, []);
});

test('instrucción de sistema: regla de reportes y de cifras controladas por backend', () => {
  const { construirInstruccionSistema } = require('../nexi/services/contextoService');
  const s = construirInstruccionSistema({ usuario: ANA, modulosHabilitados: [], herramientas: [], hoy: HOY });
  assert.match(s, /Todo dato numérico o factual incluido en un reporte debe provenir de una tool o cálculo controlado del backend/);
  assert.match(s, /pedí únicamente ese dato/);
});

// ── PDF ─────────────────────────────────────────────────────────────────────

test('PDF: sanea caracteres fuera de WinAnsi y genera un archivo válido con tablas largas', async () => {
  assert.equal(reportePdf.sanear('Año 2026 – ñandú 😀 中'), 'Año 2026 – ñandú ? ?');
  const pdf = await reportePdf.generarPdf({
    titulo: 'Reporte de prueba 😀',
    periodo: { etiqueta: 'Septiembre 2026', en_curso: false, comparacion: null },
    emitido: '07/10/26 12:00',
    solicitante: 'Ana',
    excluidas: [{ titulo: 'CRM', motivo: 'Sin permiso' }],
    resumen: { variaciones: [{ etiqueta: 'Finanzas: Ingresos', actual: 10, anterior: 5, variacion_pct: 100, formato: 'moneda' }], conclusiones: ['Uno'] },
    secciones: [{
      titulo: 'Finanzas', cifras: [{ etiqueta: 'Ingresos', valor: 10, formato: 'moneda', anterior: 5, variacion_pct: 100 }],
      tablas: [{ titulo: 'Larga', columnas: [{ titulo: 'A' }, { titulo: 'B', formato: 'numero' }], filas: Array.from({ length: 120 }, (_, i) => [`Fila ${i}`, i]) }],
      observaciones: ['Obs'], notas: ['Nota'],
    }],
  });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 2000);
});

// ── Endpoints de descarga ───────────────────────────────────────────────────

function respuestaFalsa() {
  const res = new EventEmitter();
  res.headers = {};
  res.set = (h) => { Object.assign(res.headers, h); return res; };
  res.send = (b) => { res.body = b; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('descarga: solo el dueño, con permiso vigente de Reportes y archivo generado', async (t) => {
  let nivel = 'lector';
  t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => permisos({ reportes: nivel }));
  const obtener = t.mock.method(repositorio, 'obtenerPropio', async (id, usuarioId) => {
    if (usuarioId !== ANA.id) throw Object.assign(new Error('Reporte no encontrado.'), { status: 404, publico: true });
    return { id, titulo: 'Reporte financiero - Septiembre 2026', formato: 'pdf', estado: 'GENERADO', archivo_path: `${ANA.id}/${id}.pdf` };
  });
  t.mock.method(repositorio, 'descargarArchivo', async () => Buffer.from('%PDF-1.3 x'));

  // Dueño con permiso → archivo con headers seguros.
  const res = respuestaFalsa();
  let error;
  await nexiController.descargarReporte({ params: { id: REPORTE_ID }, user: ANA }, res, e => { error = e; });
  assert.equal(error, undefined);
  assert.equal(res.headers['Content-Type'], 'application/pdf');
  assert.match(res.headers['Content-Disposition'], /^attachment; filename="Reporte_financiero_-_Septiembre_2026\.pdf"$/);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');

  // Otro usuario → 404 (no revela existencia).
  await nexiController.descargarReporte({ params: { id: REPORTE_ID }, user: { ...ANA, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }, respuestaFalsa(), e => { error = e; });
  assert.equal(error.status, 404);

  // Permiso revocado → 403 sin consultar el reporte.
  nivel = 'sin_acceso';
  const llamadas = obtener.mock.callCount();
  await nexiController.descargarReporte({ params: { id: REPORTE_ID }, user: ANA }, respuestaFalsa(), e => { error = e; });
  assert.equal(error.status, 403);
  assert.equal(obtener.mock.callCount(), llamadas);
});

test('descarga: reporte denegado o con error → 409 sin leer Storage', async (t) => {
  t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => permisos({ reportes: 'lector' }));
  t.mock.method(repositorio, 'obtenerPropio', async () => ({ id: REPORTE_ID, estado: 'DENEGADO', archivo_path: null }));
  const descargar = t.mock.method(repositorio, 'descargarArchivo', async () => Buffer.from(''));
  let error;
  await nexiController.descargarReporte({ params: { id: REPORTE_ID }, user: ANA }, respuestaFalsa(), e => { error = e; });
  assert.equal(error.status, 409);
  assert.equal(descargar.mock.callCount(), 0);
});

test('repositorio: obtenerPropio rechaza ids no-uuid sin consultar la base', async () => {
  await assert.rejects(() => repositorio.obtenerPropio('1 OR 1=1', ANA.id), err => err.status === 404);
  await assert.rejects(() => repositorio.obtenerPropio(REPORTE_ID, undefined), err => err.status === 401);
});

test('variación porcentual: con base negativa el signo indica si el valor subió o bajó', () => {
  const { variacionPct } = require('../nexi/tools/finanzasTools');
  assert.equal(variacionPct(50, -100), 150);
  assert.equal(variacionPct(-150, -100), -50);
  assert.equal(variacionPct(120, 100), 20);
  assert.equal(variacionPct(10, 0), null);
});
