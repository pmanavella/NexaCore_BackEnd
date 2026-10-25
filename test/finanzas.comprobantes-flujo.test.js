// Flujo de carga de comprobantes (REQ-FIN-09, REQ-FIN-11 y REQ-FIN-12):
// procesado o revisión manual, duplicados, almacenamiento privado y limpieza.
// Tests unitarios de finance/services/comprobantesService.js. Gemini, la validación
// de la extracción, Supabase y el almacenamiento se simulan; la validación en sí
// se prueba en documentExtraction.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const movimientosService = require('../finance/services/movimientosService');
const gemini = require('../finance/services/geminiDocumentService');
const extraccion = require('../finance/services/documentExtraction');

// comprobantesService toma estas funciones al cargarse: se reemplazan antes de
// requerirlo por dobles que cada test configura.
const dobles = {};
gemini.analyzeDocument = (...args) => dobles.analizar(...args);
extraccion.validateExtraction = (...args) => dobles.validar(...args);
extraccion.hasAllowedSignature = (...args) => dobles.firmaValida(...args);
const comprobantesService = require('../finance/services/comprobantesService');

function fakeFrom(handler) {
  return (table) => {
    const st = { table, ops: [] };
    const builder = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve(handler(st)).then(res, rej);
        return (...args) => { st.ops.push([prop, ...args]); return builder; };
      },
    });
    return builder;
  };
}
const op = (st, nombre) => st.ops.find(o => o[0] === nombre);

function simularStorage(t, bucket) {
  const original = Object.getOwnPropertyDescriptor(supabase, 'storage');
  Object.defineProperty(supabase, 'storage', { configurable: true, writable: true, value: { from: () => bucket } });
  t.after(() => {
    if (original) Object.defineProperty(supabase, 'storage', original);
    else delete supabase.storage;
  });
}

const archivo = { originalname: 'factura.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4') };
const extraido = { total: 1210, items: [{ code: 'A1', description: 'Servicio', quantity: 1, unitPrice: 1000, discount: 0, ivaRate: 21, lineTotal: 1210 }] };
const movimientoPropuesto = { fecha: '2026-10-15', descripcion: 'Servicio', categoria: 'Servicios', tipo: 'Gasto', monto: 1210 };

// Escenario base: archivo válido, Gemini extrae bien, la validación pasa y no hay duplicado.
function escenario(t, { validacion = {}, duplicado = null, insertar, actualizar } = {}) {
  dobles.firmaValida = () => true;
  dobles.analizar = async () => extraido;
  dobles.validar = () => ({ valid: true, errors: [], warnings: [], fingerprint: 'huella-1', movimiento: movimientoPropuesto, ...validacion });
  const subidos = [];
  simularStorage(t, {
    upload: async (path) => { subidos.push(path); return { error: null }; },
    createSignedUrl: async (path) => ({ data: { signedUrl: `https://firmada/${path}` }, error: null }),
  });
  const registros = [];
  let siguienteId = 1;
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    if (st.table === 'comprobantes' && op(st, 'maybeSingle')) {
      return { data: typeof duplicado === 'function' ? duplicado() : duplicado, error: null };
    }
    if (st.table === 'comprobantes' && op(st, 'insert')) {
      const fila = op(st, 'insert')[1][0];
      if (insertar) { const r = insertar(fila); if (r) return r; }
      const guardado = { id: `c${siguienteId++}`, ...fila };
      registros.push(guardado);
      return { data: guardado, error: null };
    }
    if (st.table === 'comprobante_items') return { data: op(st, 'insert')[1], error: null };
    if (st.table === 'comprobantes' && op(st, 'update')) {
      if (actualizar) return actualizar(op(st, 'update')[1]);
      return { data: { id: 'c1', storage_path: 'comprobantes/x.pdf', ...op(st, 'update')[1] }, error: null };
    }
    throw new Error(`consulta inesperada a ${st.table}`);
  }));
  return { subidos, registros };
}

// ── REQ-FIN-09 · Flujo binario: procesado o revisión manual ──────────────────

test('comprobante válido → se guarda privado, queda procesado y crea el movimiento automático', async (t) => {
  // Arrange
  const { subidos, registros } = escenario(t);
  const crear = t.mock.method(movimientosService, 'crear', async () => ({ id: 'm1', ...movimientoPropuesto }));

  // Act
  const r = await comprobantesService.subirArchivo(archivo, 'contable@nexacore.test');

  // Assert
  assert.match(subidos[0], /^comprobantes\/[0-9a-f-]{36}\.pdf$/);
  assert.equal(registros[0].estado_analisis, 'procesado');
  assert.equal(registros[0].document_fingerprint, 'huella-1');
  assert.equal(crear.mock.calls[0].arguments[1], 'contable@nexacore.test');
  assert.equal(r.movimiento.id, 'm1');
  assert.equal(r.analysis.auto_created, true);
  assert.equal(r.comprobante.movimiento_id, 'm1');
  assert.match(r.comprobante.archivo_url, /^https:\/\/firmada\//);
});

test('comprobante con errores de validación → queda en revisión manual y no crea movimiento', async (t) => {
  // Arrange
  const { registros } = escenario(t, { validacion: { valid: false, errors: ['Falta el CUIT del emisor'] } });
  const crear = t.mock.method(movimientosService, 'crear', async () => ({ id: 'm1' }));

  // Act
  const r = await comprobantesService.subirArchivo(archivo);

  // Assert
  assert.equal(registros[0].estado_analisis, 'requiere_revision');
  assert.deepEqual(r.analysis.errors, ['Falta el CUIT del emisor']);
  assert.equal(r.movimiento, null);
  assert.equal(crear.mock.callCount(), 0);
});

test('Gemini falla → el comprobante queda con estado error y el motivo, sin movimiento', async (t) => {
  // Arrange
  const { registros } = escenario(t);
  dobles.analizar = async () => { throw new Error('Gemini no respondió'); };

  // Act
  const r = await comprobantesService.subirArchivo(archivo);

  // Assert
  assert.equal(registros[0].estado_analisis, 'error');
  assert.deepEqual(r.analysis.errors, ['Gemini no respondió']);
  assert.equal(r.movimiento, null);
});

test('no se puede crear el movimiento automático → el comprobante pasa a revisión manual con el motivo', async (t) => {
  // Arrange
  let cambios;
  escenario(t, { actualizar: (c) => { cambios = c; return { data: { id: 'c1', ...c }, error: null }; } });
  t.mock.method(movimientosService, 'crear', async () => { throw new Error('Categoría inválida'); });

  // Act
  const r = await comprobantesService.subirArchivo(archivo);

  // Assert
  assert.equal(cambios.estado_analisis, 'requiere_revision');
  assert.match(r.analysis.errors[0], /No se pudo crear el movimiento autom.{1,2}tico: Categoría inválida/);
  assert.equal(r.movimiento, null);
});

test('falla también la actualización tras el error del movimiento → se propaga el error', async (t) => {
  // Arrange
  escenario(t, { actualizar: () => ({ data: null, error: new Error('Supabase no disponible') }) });
  t.mock.method(movimientosService, 'crear', async () => { throw new Error('Categoría inválida'); });

  // Act y Assert
  await assert.rejects(comprobantesService.subirArchivo(archivo), /Supabase no disponible/);
});

// ── Seguridad del archivo y almacenamiento (REQ-FIN-12) ──────────────────────

test('el contenido no coincide con el formato declarado → HTTP 400 y no se sube nada', async (t) => {
  // Arrange
  const { subidos } = escenario(t);
  dobles.firmaValida = () => false;

  // Act y Assert
  await assert.rejects(comprobantesService.subirArchivo(archivo), (err) => err.status === 400 && /no coincide con el formato/.test(err.message));
  assert.deepEqual(subidos, []);
});

for (const [mimetype, extension] of [['image/png', 'png'], ['image/jpeg', 'jpg']]) {
  test(`imagen ${mimetype} → se guarda con extensión .${extension}`, async (t) => {
    // Arrange
    const { subidos } = escenario(t, { validacion: { valid: false } });

    // Act
    await comprobantesService.subirArchivo({ ...archivo, mimetype });

    // Assert
    assert.ok(subidos[0].endsWith(`.${extension}`), subidos[0]);
  });
}

test('falla la subida al almacenamiento → error claro y no se analiza el documento', async (t) => {
  // Arrange
  escenario(t);
  let analizado = false;
  dobles.analizar = async () => { analizado = true; return extraido; };
  simularStorage(t, { upload: async () => ({ error: new Error('cuota excedida') }) });

  // Act y Assert
  await assert.rejects(comprobantesService.subirArchivo(archivo), /No se pudo guardar el comprobante: cuota excedida/);
  assert.equal(analizado, false);
});

test('URL firmada: sin archivo → null; con error del almacenamiento → mensaje claro', async (t) => {
  // Arrange
  simularStorage(t, { createSignedUrl: async () => ({ data: null, error: new Error('objeto inexistente') }) });

  // Act y Assert
  assert.equal(await comprobantesService.crearUrlFirmada(null), null);
  assert.equal(await comprobantesService.presentar(null), null);
  await assert.rejects(comprobantesService.crearUrlFirmada('x.pdf'), /No se pudo generar acceso seguro al comprobante: objeto inexistente/);
});

// ── REQ-FIN-11 · Duplicados ──────────────────────────────────────────────────

test('comprobante ya cargado → queda en revisión, vinculado al original, sin movimiento', async (t) => {
  // Arrange
  const { registros } = escenario(t, { duplicado: { id: 'c-original' } });
  const crear = t.mock.method(movimientosService, 'crear', async () => ({ id: 'm1' }));

  // Act
  const r = await comprobantesService.subirArchivo(archivo);

  // Assert
  assert.equal(registros[0].estado_analisis, 'requiere_revision');
  assert.equal(registros[0].duplicate_of_id, 'c-original');
  assert.equal(r.analysis.duplicate_of_id, 'c-original');
  assert.equal(crear.mock.callCount(), 0);
});

test('dos usuarios cargan el mismo comprobante a la vez (clave única) → el segundo queda como duplicado', async (t) => {
  // Arrange
  // La primera búsqueda no encuentra el comprobante; al guardarlo la base informa
  // clave duplicada (23505) porque otro usuario lo guardó en ese instante.
  const busquedas = [null, { id: 'c-otro' }];
  let insercion = 0;
  const { registros } = escenario(t, {
    duplicado: () => busquedas.shift(),
    insertar: () => {
      insercion += 1;
      return insercion === 1 ? { data: null, error: Object.assign(new Error('duplicate key'), { code: '23505' }) } : null;
    },
  });
  const crear = t.mock.method(movimientosService, 'crear', async () => ({ id: 'm1' }));

  // Act
  const r = await comprobantesService.subirArchivo(archivo);

  // Assert
  assert.equal(registros[0].estado_analisis, 'requiere_revision');
  assert.equal(registros[0].duplicate_of_id, 'c-otro');
  assert.match(r.analysis.errors[0], /simult.{1,2}neamente por otro usuario/);
  assert.equal(r.movimiento, null);
  assert.equal(crear.mock.callCount(), 0);
});

test('error de base distinto de clave duplicada al guardar → se propaga', async (t) => {
  // Arrange
  escenario(t, { insertar: () => ({ data: null, error: Object.assign(new Error('sin conexión'), { code: '08006' }) }) });

  // Act y Assert
  await assert.rejects(comprobantesService.subirArchivo(archivo), /sin conexión/);
});

test('búsqueda de duplicado con error de Supabase → se propaga', async (t) => {
  // Arrange
  t.mock.method(supabase, 'from', fakeFrom(() => ({ data: null, error: new Error('timeout') })));

  // Act y Assert
  await assert.rejects(comprobantesService.buscarDuplicado('huella'), /timeout/);
});

test('ítems: sin ítems no consulta la base; con error al guardarlos → se propaga', async (t) => {
  // Arrange
  const from = t.mock.method(supabase, 'from', fakeFrom(() => ({ data: null, error: new Error('ítem inválido') })));

  // Act y Assert
  assert.deepEqual(await comprobantesService.persistirItems('c1', []), []);
  assert.equal(from.mock.callCount(), 0);
  await assert.rejects(comprobantesService.persistirItems('c1', extraido.items), /ítem inválido/);
});

// ── Consulta, baja y limpieza ────────────────────────────────────────────────

test('listar → devuelve los comprobantes con su URL firmada; con error → se propaga', async (t) => {
  // Arrange
  const respuestas = [{ data: [{ id: 'c1', storage_path: 'a.pdf' }, { id: 'c2', storage_path: null }], error: null }, { data: null, error: new Error('falla') }];
  t.mock.method(supabase, 'from', fakeFrom(() => respuestas.shift()));
  simularStorage(t, { createSignedUrl: async (p) => ({ data: { signedUrl: `https://firmada/${p}` }, error: null }) });

  // Act
  const r = await comprobantesService.listar();

  // Assert
  assert.deepEqual(r.data.map(c => c.archivo_url), ['https://firmada/a.pdf', null]);
  await assert.rejects(comprobantesService.listar(), /falla/);
});

test('eliminar → borra el archivo y después el registro', async (t) => {
  // Arrange
  const pasos = [];
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    if (op(st, 'select')) return { data: { storage_path: 'a.pdf' }, error: null };
    pasos.push('delete registro');
    return { error: null };
  }));
  simularStorage(t, { remove: async (paths) => { pasos.push(`remove ${paths}`); return { error: null }; } });

  // Act
  const r = await comprobantesService.eliminar('c1');

  // Assert
  assert.equal(r.message, 'Comprobante eliminado');
  assert.deepEqual(pasos, ['remove a.pdf', 'delete registro']);
});

test('eliminar: no se puede borrar el archivo → error claro y el registro no se toca', async (t) => {
  // Arrange
  const pasos = [];
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    if (op(st, 'select')) return { data: { storage_path: 'a.pdf' }, error: null };
    pasos.push('delete registro');
    return { error: null };
  }));
  simularStorage(t, { remove: async () => ({ error: new Error('permiso denegado') }) });

  // Act y Assert
  await assert.rejects(comprobantesService.eliminar('c1'), /No se pudo eliminar el archivo: permiso denegado/);
  assert.deepEqual(pasos, []);
});

test('eliminar: sin archivo guardado solo borra el registro; errores de lectura o de baja se propagan', async (t) => {
  // Arrange
  const respuestas = [
    { data: { storage_path: null }, error: null }, { error: null },
    { data: null, error: new Error('no encontrado') },
    { data: { storage_path: null }, error: null }, { error: new Error('restricción') },
  ];
  t.mock.method(supabase, 'from', fakeFrom(() => respuestas.shift()));

  // Act y Assert
  assert.equal((await comprobantesService.eliminar('c1')).message, 'Comprobante eliminado');
  await assert.rejects(comprobantesService.eliminar('c2'), /no encontrado/);
  await assert.rejects(comprobantesService.eliminar('c3'), /restricción/);
});

test('limpieza → borra los archivos de más de 6 meses y conserva el registro sin archivo', async (t) => {
  // Arrange
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-19T12:00:00Z').getTime() });
  let limite;
  let actualizados;
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    if (op(st, 'lt')) { limite = op(st, 'lt')[2]; return { data: [{ id: 'c1', storage_path: 'a.pdf' }, { id: 'c2', storage_path: 'b.pdf' }], error: null }; }
    actualizados = [op(st, 'update')[1], op(st, 'in')[2]];
    return { error: null };
  }));
  const removidos = [];
  simularStorage(t, { remove: async (paths) => { removidos.push(...paths); return { error: null }; } });

  // Act
  const r = await comprobantesService.limpiarVencidos();

  // Assert
  assert.equal(r.eliminados, 2);
  assert.ok(limite.startsWith('2026-04-19'), limite);
  assert.deepEqual(removidos, ['a.pdf', 'b.pdf']);
  assert.deepEqual(actualizados, [{ storage_path: null }, ['c1', 'c2']]);
});

test('limpieza sin vencidos → no borra nada; con errores → se propagan', async (t) => {
  // Arrange
  const respuestas = [
    { data: [], error: null },
    { data: null, error: new Error('consulta fallida') },
    { data: [{ id: 'c1', storage_path: 'a.pdf' }], error: null },
    { data: [{ id: 'c1', storage_path: 'a.pdf' }], error: null }, { error: new Error('update fallido') },
  ];
  t.mock.method(supabase, 'from', fakeFrom(() => respuestas.shift()));
  const errorRemove = [new Error('remove fallido'), null];
  simularStorage(t, { remove: async () => ({ error: errorRemove.shift() }) });

  // Act y Assert
  assert.deepEqual(await comprobantesService.limpiarVencidos(), { eliminados: 0 });
  await assert.rejects(comprobantesService.limpiarVencidos(), /consulta fallida/);
  await assert.rejects(comprobantesService.limpiarVencidos(), /remove fallido/);
  await assert.rejects(comprobantesService.limpiarVencidos(), /update fallido/);
});
