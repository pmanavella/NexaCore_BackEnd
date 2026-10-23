#!/usr/bin/env node
// Reinicio y siembra de la base de pruebas nexacore-test (Anexo A del plan).
//
// Uso:  npm run test:db:reset
//
// Variables (nunca en el repositorio; en local van en .env.test, en CI son secretos):
//   SUPABASE_TEST_URL               URL del proyecto nexacore-test
//   SUPABASE_TEST_SERVICE_ROLE_KEY  service_role de nexacore-test
//   TEST_USER_PASSWORD              contraseña común de los usuarios de prueba
//
// Qué hace: vacía todas las tablas de public, borra los usuarios de Auth con
// correo @nexacore.test, y siembra los catálogos (copiados de Developer) y los
// datos ficticios de docs/datos-de-prueba.md. Las fechas "relativas" se
// calculan a partir de hoy en UTC, igual que el backend en el pipeline.
//
// Protecciones: lee solo variables SUPABASE_TEST_*; se niega a correr si la URL
// coincide con la de .env o .env.development, o si la base contiene usuarios o
// movimientos que no son de prueba.

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const catalogos = require('./catalogos.json');

const RAIZ = path.resolve(__dirname, '..', '..');
const DOMINIO = '@nexacore.test';

// ── Configuración y protecciones ───────────────────────────────────────────

const envTest = path.join(RAIZ, '.env.test');
if (fs.existsSync(envTest)) dotenv.config({ path: envTest });

const URL_TEST = process.env.SUPABASE_TEST_URL;
const KEY_TEST = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const PASSWORD = process.env.TEST_USER_PASSWORD;

function abortar(mensaje) {
  console.error(`\n✖ ${mensaje}\n`);
  process.exit(1);
}

if (!URL_TEST || !KEY_TEST || !PASSWORD) {
  abortar('Faltan SUPABASE_TEST_URL, SUPABASE_TEST_SERVICE_ROLE_KEY o TEST_USER_PASSWORD.');
}
if (PASSWORD.length < 8) abortar('TEST_USER_PASSWORD debe tener al menos 8 caracteres.');

for (const archivo of ['.env', '.env.development']) {
  const ruta = path.join(RAIZ, archivo);
  if (!fs.existsSync(ruta)) continue;
  const otra = dotenv.parse(fs.readFileSync(ruta)).SUPABASE_URL;
  if (otra && otra.replace(/\/+$/, '') === URL_TEST.replace(/\/+$/, '')) {
    abortar(`SUPABASE_TEST_URL coincide con la de ${archivo}. Este script solo corre sobre nexacore-test.`);
  }
}

const db = createClient(URL_TEST, KEY_TEST, { auth: { persistSession: false, autoRefreshToken: false } });

async function q(promesa, contexto) {
  const { data, error } = await promesa;
  if (error) throw new Error(`${contexto}: ${error.message}`);
  return data;
}

async function verificarQueEsBaseDePrueba() {
  const ajenos = await q(
    db.from('usuarios').select('email').not('email', 'like', `%${DOMINIO}`).limit(1),
    'verificación de usuarios'
  );
  const reales = await q(
    db.from('movimientos').select('id').not('descripcion', 'like', 'TEST%').limit(1),
    'verificación de movimientos'
  );
  if (ajenos.length || reales.length) {
    abortar('La base tiene usuarios o movimientos que no son de prueba. No se modifica nada.');
  }
}

// ── Fechas (UTC) ───────────────────────────────────────────────────────────

const HOY = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
const iso = d => d.toISOString().slice(0, 10);
const masDias = (d, n) => new Date(d.getTime() + n * 86400000);
function menosMeses(d, n) {
  const r = new Date(d);
  r.setUTCMonth(r.getUTCMonth() - n);
  return r;
}

// ── Reinicio ───────────────────────────────────────────────────────────────

// Orden: primero las tablas que referencian a otras.
const TABLAS = [
  ['comprobante_items', 'id'], ['comprobantes', 'id'], ['integracion_movimientos_financieros', 'id'],
  ['movimientos_salario', 'id'], ['salarios', 'id'], ['conciliaciones_migracion', 'id'],
  ['cuentas_por_cobrar', 'id'], ['inversiones_historicas', 'id'], ['sueldos_historicos', 'id'],
  ['movimientos', 'id'], ['migration_batches', 'id'], ['suscripciones', 'id'],
  ['cotizaciones_dolar', 'id'], ['deudas', 'id'], ['organigrama', 'id'], ['empleados', 'id'],
  ['nexi_tool_calls', 'id'], ['nexi_reportes', 'id'], ['nexi_mensajes', 'id'], ['nexi_conversaciones', 'id'],
  ['dashboard_vistas', 'id'], ['dashboard_configuraciones', 'id'],
  ['tarea_historial', 'id'], ['tarea_asignados', 'id'], ['tareas', 'id'],
  ['operativo_tablero_miembros', 'tablero_id'], ['operativo_tableros', 'id'], ['operativo_etapas', 'id'],
  ['protocolo_pruebas', 'id'], ['protocolo_items', 'id'], ['protocolos', 'id'],
  ['contactos', 'id'], ['proyectos', 'id'], ['indicadores', 'id'],
  ['usuario_modulo_permisos', 'id'], ['usuarios', 'id'], ['rol_modulo_permisos', 'id'],
  ['roles', 'id'], ['modulos', 'id'], ['categorias_salariales', 'id'],
];

async function vaciarTablas() {
  for (const [tabla, columna] of TABLAS) {
    await q(db.from(tabla).delete().not(columna, 'is', null), `vaciar ${tabla}`);
  }
}

async function borrarUsuariosAuth() {
  for (let pagina = 1; ; pagina++) {
    const { data, error } = await db.auth.admin.listUsers({ page: pagina, perPage: 200 });
    if (error) throw new Error(`listar usuarios de Auth: ${error.message}`);
    const dePrueba = data.users.filter(u => u.email?.endsWith(DOMINIO));
    for (const u of dePrueba) {
      const { error: e } = await db.auth.admin.deleteUser(u.id);
      if (e) throw new Error(`borrar ${u.email}: ${e.message}`);
    }
    if (data.users.length < 200) break;
  }
}

// ── Siembra ────────────────────────────────────────────────────────────────

async function sembrarCatalogos() {
  const roles = await q(db.from('roles').insert(catalogos.roles).select('id, nombre'), 'roles');
  const modulos = await q(db.from('modulos').insert(catalogos.modulos).select('id, nombre'), 'modulos');
  const rolId = Object.fromEntries(roles.map(r => [r.nombre, r.id]));
  const moduloId = Object.fromEntries(modulos.map(m => [m.nombre, m.id]));

  const matriz = catalogos.rol_modulo_permisos.map(([rol, modulo, ver, editar]) => ({
    rol_id: rolId[rol], modulo_id: moduloId[modulo], puede_ver: ver, puede_editar: editar,
  }));
  await q(db.from('rol_modulo_permisos').insert(matriz), 'rol_modulo_permisos');

  const categorias = await q(
    db.from('categorias_salariales').insert(catalogos.categorias_salariales).select('id, nombre'),
    'categorias_salariales'
  );
  return { rolId, moduloId, categoriaId: Object.fromEntries(categorias.map(c => [c.nombre, c.id])) };
}

// docs/datos-de-prueba.md §1. U-12 usa un rol legacy (existe en la base pero no
// en la matriz del frontend): supuesto a confirmar por Pilar.
const USUARIOS = [
  { id: 'U-01', email: 'test.superadmin', rol: 'Superadmin' },
  { id: 'U-02', email: 'test.direccion', rol: 'Dirección' },
  { id: 'U-03', email: 'test.contable', rol: 'Contable' },
  { id: 'U-04', email: 'test.auditor', rol: 'Auditor / Lector' },
  { id: 'U-05', email: 'test.comercial', rol: 'Comercial' },
  { id: 'U-06', email: 'test.operativo', rol: 'Operativo' },
  { id: 'U-07', email: 'test.pasante', rol: 'Pasante' },
  { id: 'U-08', email: 'test.externo', rol: 'Externo' },
  { id: 'U-09', email: 'test.contable.inactivo', rol: 'Contable', estado: 'Inactivo' },
  { id: 'U-10', email: 'test.contable.editor', rol: 'Contable', permisoFinanzas: 'editor' },
  { id: 'U-11', email: 'test.auditor.lector', rol: 'Auditor / Lector', permisoFinanzas: 'lector' },
  { id: 'U-12', email: 'test.rol-legacy', rol: 'Mando Medio' },
];

async function sembrarUsuarios({ rolId, moduloId }) {
  const ids = {};
  for (const u of USUARIOS) {
    const email = `${u.email}${DOMINIO}`;
    const { data, error } = await db.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (error) throw new Error(`crear ${email} en Auth: ${error.message}`);
    const [fila] = await q(
      db.from('usuarios').insert({
        email, nombre: `TEST ${u.id} ${u.rol}`, rol_id: rolId[u.rol],
        estado: u.estado || 'Activo', auth_user_id: data.user.id,
      }).select('id'),
      `usuario ${u.id}`
    );
    ids[u.id] = fila.id;
    if (u.permisoFinanzas) {
      await q(db.from('usuario_modulo_permisos').insert({
        usuario_id: fila.id, modulo_id: moduloId.finance, permiso: u.permisoFinanzas, alcance: 'global',
      }), `permiso manual ${u.id}`);
    }
  }
  return ids;
}

// §2. Planta y temporal se alternan; cotización compra 1000 / venta 1050.
const EMPLEADOS = [
  ['E-01', 'Planta', 'mensual', 'ARS', null, 800000],
  ['E-02', 'Temporal', 'hora', 'ARS', null, 5000],
  ['E-03', 'Planta', 'turno', 'ARS', null, 40000],
  ['E-04', 'Temporal', 'mensual', 'USD', 'compra', 1000],
  ['E-05', 'Planta', 'hora', 'USD', 'compra', 10],
  ['E-06', 'Temporal', 'turno', 'USD', 'compra', 80],
  ['E-07', 'Planta', 'mensual', 'USD', 'venta', 1000],
  ['E-08', 'Temporal', 'hora', 'USD', 'venta', 10],
  ['E-09', 'Planta', 'turno', 'USD', 'venta', 80],
];
const MODALIDAD = { mensual: 'Mensual', hora: 'Por Horas', turno: 'Por Turno' };

async function sembrarEmpleados() {
  const filas = EMPLEADOS.map(([id, permanencia, salario, moneda, cotizacion, base]) => ({
    nombre: 'TEST', apellido: id, tipo_permanencia: permanencia,
    tipo_salario: salario, modalidad_trabajo: MODALIDAD[salario],
    moneda, monto_base: base, estado: 'Activo',
    cotizacion_tipo: cotizacion,
    cotizacion_valor: cotizacion ? (cotizacion === 'compra' ? 1000 : 1050) : null,
    cotizacion_fecha: cotizacion ? iso(HOY) : null,
    cotizacion_fuente: cotizacion ? 'TEST' : null,
  }));
  const creados = await q(db.from('empleados').insert(filas).select('id, apellido'), 'empleados');
  return Object.fromEntries(creados.map(e => [e.apellido, e.id]));
}

async function sembrarCotizacion() {
  await q(db.from('cotizaciones_dolar').insert({
    fecha: iso(HOY), fuente: 'TEST', tipo: 'oficial',
    valor_compra: 1000, valor_venta: 1050, valor_referencia: 1050,
  }), 'cotización del día');
}

// §3. Movimientos de septiembre de 2026 (libro diario).
const MOVIMIENTOS_SEPTIEMBRE = [
  ['M-01', '2026-09-02', 'Ingreso', 'Servicios', 'TEST Abono soporte cliente A', 500000],
  ['M-02', '2026-09-05', 'Ingreso', 'Tecnología', 'TEST Licencia de software', 300000],
  ['M-03', '2026-09-08', 'Gasto', 'RRHH', 'TEST Capacitación del equipo', 120000],
  ['M-04', '2026-09-10', 'Gasto', 'Insumos', 'TEST Resmas de papel', 45000],
  ['M-05', '2026-09-12', 'Gasto', 'Servicios', 'TEST Cuota social del club', 15000],
  ['M-06', '2026-09-15', 'Gasto', 'Otros', 'TEST Interés por pago fuera de término', 8000],
  ['M-07', '2026-09-15', 'Gasto', 'Otros', 'TEST Comisión bancaria por transferencia', 2500],
  ['M-08', '2026-09-20', 'Gasto', 'Suscripción', 'TEST Hosting mensual', 30000],
  ['M-09', '2026-09-25', 'Gasto', 'Insumos', 'TEST Café 1', 0.5],
  ['M-10', '2026-09-25', 'Gasto', 'Insumos', 'TEST Café 2', 0.5],
  ['M-11', '2026-09-25', 'Gasto', 'Insumos', 'TEST Café 3', 0.5],
];
const CATEGORIAS = ['RRHH', 'Insumos', 'Servicios', 'Otros', 'Suscripción', 'Tecnología', 'Inversión'];

async function sembrarMovimientos() {
  const septiembre = MOVIMIENTOS_SEPTIEMBRE.map(([id, fecha, tipo, categoria, descripcion, monto]) => ({
    fecha, tipo, categoria, descripcion, monto, notas: id, created_by: 'seed',
  }));
  const octubre = CATEGORIAS.map((categoria, i) => ({
    fecha: `2026-10-${String(i + 1).padStart(2, '0')}`, tipo: 'Gasto', categoria,
    descripcion: `TEST Octubre ${categoria}`, monto: 1000, notas: 'listado-octubre', created_by: 'seed',
  }));
  const creados = await q(
    db.from('movimientos').insert([...septiembre, ...octubre]).select('id, notas, categoria'),
    'movimientos'
  );
  return {
    porId: Object.fromEntries(creados.filter(m => m.notas !== 'listado-octubre').map(m => [m.notas, m.id])),
    octubre: Object.fromEntries(creados.filter(m => m.notas === 'listado-octubre').map(m => [m.categoria, m.id])),
  };
}

async function sembrarSueldos(empleados, categoriaId) {
  await q(db.from('movimientos_salario').insert([
    { empleado_id: empleados['E-01'], categoria_id: categoriaId['Sueldo Base'], monto: 800000,
      fecha: '2026-09-30', descripcion: 'TEST SA-01 sueldo mensual E-01', moneda_origen: 'ARS', created_by: 'seed' },
    { empleado_id: empleados['E-03'], categoria_id: categoriaId['Sueldo Base'], monto: 200000,
      fecha: '2026-09-30', descripcion: 'TEST SA-02 E-03 por 5 turnos', moneda_origen: 'ARS', created_by: 'seed' },
  ]), 'movimientos_salario');
}

// §4. El día de vencimiento sale de la fecha objetivo: el backend lo lleva al
// mes siguiente si ya pasó, igual que con "hoy + N" cuando cruza de mes.
async function sembrarSuscripciones() {
  const dia = n => masDias(HOY, n).getUTCDate();
  const s08 = masDias(HOY, 5);
  const filas = [
    { id: 'S-01', dia_vencimiento: dia(0) },
    { id: 'S-02', dia_vencimiento: dia(7) },
    { id: 'S-03', dia_vencimiento: dia(8) },
    { id: 'S-04', dia_vencimiento: dia(-1) },
    { id: 'S-05', dia_vencimiento: dia(3) },
    { id: 'S-06', dia_vencimiento: dia(2), estado: 'pausada' },
    { id: 'S-07', dia_vencimiento: 31 },
    // El ciclo trimestral se ancla en created_at: un trimestre antes de hoy + 5.
    { id: 'S-08', dia_vencimiento: s08.getUTCDate(), frecuencia: 'trimestral', created_at: menosMeses(s08, 3).toISOString() },
  ].map(s => ({
    nombre: `TEST ${s.id}`, detalle: s.id, proveedor: 'TEST Proveedor', monto: 10000, moneda: 'ARS',
    dia_vencimiento: s.dia_vencimiento, frecuencia: s.frecuencia || 'mensual', estado: s.estado || 'activa',
    created_by: 'seed', ...(s.created_at ? { created_at: s.created_at } : {}),
  }));
  const creadas = await q(db.from('suscripciones').insert(filas).select('id, detalle'), 'suscripciones');
  const ids = Object.fromEntries(creadas.map(s => [s.detalle, s.id]));

  // S-05: gasto vinculado en el período de su próximo vencimiento (hoy + 3).
  const vence = masDias(HOY, 3);
  if (vence.getUTCMonth() !== HOY.getUTCMonth()) {
    console.warn('  ⚠ S-05 vence el mes que viene: el gasto vinculado de hoy queda fuera de su período.');
  }
  await q(db.from('movimientos').insert({
    fecha: iso(HOY), tipo: 'Gasto', categoria: 'Suscripción', descripcion: 'TEST Pago S-05',
    monto: 10000, suscripcion_id: ids['S-05'], notas: 'S-05', created_by: 'seed',
  }), 'gasto vinculado a S-05');
  return ids;
}

// §5. Comprobantes y batches de migración.
async function sembrarComprobantesYMigraciones(movimientos, usuarios) {
  await q(db.from('comprobantes').insert([
    { nombre_archivo: 'TEST-C-01-factura.pdf', tipo_archivo: 'application/pdf', estado_analisis: 'procesado',
      document_fingerprint: 'TEST-FP-C-01', movimiento_id: movimientos.octubre.Insumos,
      diagnostico: { errors: [], auto_created: true } },
    { nombre_archivo: 'TEST-C-02-ticket.jpg', tipo_archivo: 'image/jpeg', estado_analisis: 'requiere_revision',
      diagnostico: { errors: ['TEST: requiere revisión manual'], auto_created: false } },
  ]), 'comprobantes');

  const batch = (estado, creados) => ({
    tipo_migracion: 'GASTOS_HISTORICOS', nombre_archivo: `TEST-${estado}.xlsx`, usuario_id: usuarios['U-02'],
    registros_detectados: creados, registros_creados: creados, registros_rechazados: 0, estado,
  });
  const [b01] = await q(db.from('migration_batches').insert(batch('completado', 3)).select('id'), 'batch B-01');
  await q(db.from('migration_batches').insert([batch('revertido', 0), batch('procesando', 0)]), 'batches B-02 y B-03');

  await q(db.from('movimientos').insert([1, 2, 3].map(n => ({
    fecha: `2025-06-0${n}`, tipo: 'Gasto', categoria: 'Otros', descripcion: `TEST Gasto histórico B-01 #${n}`,
    monto: 100 * n, migration_batch_id: b01.id, notas: 'B-01', created_by: 'seed',
  }))), 'gastos del batch B-01');
}

// ── Principal ──────────────────────────────────────────────────────────────

(async () => {
  const proyecto = new URL(URL_TEST).hostname.split('.')[0];
  console.log(`Reinicio de nexacore-test (${proyecto}) · fecha de referencia ${iso(HOY)} UTC`);
  try {
    await verificarQueEsBaseDePrueba();
    console.log('· Vaciando tablas y usuarios de prueba…');
    await vaciarTablas();
    await borrarUsuariosAuth();

    console.log('· Sembrando catálogos, usuarios y datos de prueba…');
    const cat = await sembrarCatalogos();
    const usuarios = await sembrarUsuarios(cat);
    const empleados = await sembrarEmpleados();
    await sembrarCotizacion();
    const movimientos = await sembrarMovimientos();
    await sembrarSueldos(empleados, cat.categoriaId);
    await sembrarSuscripciones();
    await sembrarComprobantesYMigraciones(movimientos, usuarios);

    console.log(`✔ Listo: ${USUARIOS.length} usuarios, ${EMPLEADOS.length} empleados, ` +
      `${MOVIMIENTOS_SEPTIEMBRE.length + CATEGORIAS.length + 4} movimientos, 2 sueldos, 8 suscripciones, ` +
      '1 cotización, 2 comprobantes, 3 batches.');
  } catch (err) {
    abortar(err.message);
  }
})();
