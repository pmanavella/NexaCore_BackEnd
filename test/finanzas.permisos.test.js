// RN-02 — Acceso al módulo Finanzas por rol y permiso manual.
// Los códigos esperados salen de la regla del requisito, no del código actual:
// varios casos deben fallar mientras las rutas no apliquen la Matriz de permisos.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const movimientosService = require('../finance/services/movimientosService');
const comprobantesService = require('../finance/services/comprobantesService');
const suscripcionesService = require('../finance/services/suscripcionesService');
const excelService = require('../finance/services/excelService');
const migracionService = require('../finance/services/migracionService');
const salariosService = require('../finance/services/salariosService');
const errorHandler = require('../middleware/errorHandler');

const routers = {
  movimientos: require('../finance/routes/movimientos'),
  comprobantes: require('../finance/routes/comprobantes'),
  suscripciones: require('../finance/routes/suscripciones'),
  excel: require('../finance/routes/excel'),
  migracion: require('../finance/routes/migracion'),
  salarios: require('../finance/routes/salarios'),
};

// ── Dobles de prueba ────────────────────────────────────────────────────────

// Query builder falso de Supabase: registra la cadena de llamadas y, al
// awaitearse, responde con handler({ table, ops }).
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
const filtro = (st, col) => st.ops.find(o => o[0] === 'eq' && o[1] === col)?.[2];

const MANDO_ALTO = ['Superadmin', 'Dirección'];
const OTROS_ROLES = ['Contable', 'Auditor / Lector', 'Comercial', 'Operativo', 'Pasante', 'Externo'];
const MODULO_FINANCE = { id: 'mod-fin', nombre: 'finance', label: 'Finanzas' };

// Simula la sesión (supabase.auth + tabla usuarios) y la Matriz de permisos
// (modulos, usuario_modulo_permisos, rol_modulo_permisos) del módulo 'finance'.
// permiso: 'editor' | 'lector' | null (sin permiso manual).
// Al mando alto se le da además puede_ver/puede_editar por rol, como en la
// configuración real; al resto, ningún permiso por rol salvo que se pida con
// permisoPorRol: true.
function simularSesion(t, { rol, permiso = null, activo = true, permisoPorRol = false }) {
  const usuario = { id: 'u1', nombre: 'Usuario Prueba', rol_id: `rol-${rol}`, roles: { id: `rol-${rol}`, nombre: rol } };
  const permisoRol = MANDO_ALTO.includes(rol) || permisoPorRol
    ? { modulo_id: MODULO_FINANCE.id, puede_ver: true, puede_editar: true }
    : null;
  const permisoManual = permiso
    ? { id: 'p1', usuario_id: 'u1', modulo_id: MODULO_FINANCE.id, permiso, alcance: 'global', modulos: MODULO_FINANCE }
    : null;

  t.mock.method(supabase.auth, 'getUser', async () => ({ data: { user: { email: 'u@x' } }, error: null }));
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    const unico = op(st, 'single') || op(st, 'maybeSingle');
    switch (st.table) {
      case 'usuarios':
        if (filtro(st, 'email')) {
          // authenticate filtra por estado = 'Activo'
          if (!activo && filtro(st, 'estado') === 'Activo') return { data: null, error: { message: 'no rows' } };
          return { data: { id: usuario.id, nombre: usuario.nombre, roles: usuario.roles }, error: null };
        }
        return { data: usuario, error: null };
      case 'modulos':
        if (unico) return { data: filtro(st, 'nombre') === 'finance' ? { id: MODULO_FINANCE.id } : null, error: null };
        return { data: [MODULO_FINANCE], error: null };
      case 'usuario_modulo_permisos':
        if (unico) return { data: permisoManual ? { permiso: permisoManual.permiso } : null, error: null };
        return { data: permisoManual ? [permisoManual] : [], error: null };
      case 'rol_modulo_permisos':
        if (unico) return { data: permisoRol, error: null };
        return { data: permisoRol ? [permisoRol] : [], error: null };
      default:
        throw new Error(`tabla inesperada ${st.table}`);
    }
  }));
}

// Todos los métodos de los services devuelven datos vacíos: lo que se prueba
// es el código HTTP que deciden los middlewares, no la lógica de negocio.
function simularServices(t) {
  const services = [movimientosService, comprobantesService, suscripcionesService, excelService, migracionService, salariosService];
  for (const svc of services) {
    for (const nombre of Object.getOwnPropertyNames(Object.getPrototypeOf(svc))) {
      if (nombre === 'constructor' || typeof svc[nombre] !== 'function') continue;
      t.mock.method(svc, nombre, async () => ({ data: [] }));
    }
  }
}

function appFinanzas() {
  const app = express();
  app.use(express.json());
  for (const [nombre, router] of Object.entries(routers)) app.use(`/api/finance/${nombre}`, router);
  app.use(errorHandler);
  return app;
}

// Archivos válidos para las rutas con multer, así el controller no corta con 400.
const ARCHIVOS = {
  pdf: { nombre: 'comprobante.pdf', tipo: 'application/pdf', contenido: '%PDF-1.4' },
  xlsx: { nombre: 'planilla.xlsx', tipo: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contenido: 'x' },
};

async function llamar(app, ruta, { conSesion = true } = {}) {
  const server = http.createServer(app).listen(0);
  try {
    const { port } = server.address();
    const headers = conSesion ? { authorization: 'Bearer token-de-prueba' } : {};
    let body;
    if (ruta.archivo) {
      const a = ARCHIVOS[ruta.archivo];
      body = new FormData();
      body.append('archivo', new Blob([a.contenido], { type: a.tipo }), a.nombre);
      for (const [k, v] of Object.entries(ruta.campos ?? {})) body.append(k, v);
    } else if (ruta.metodo !== 'GET') {
      headers['content-type'] = 'application/json';
      body = JSON.stringify({});
    }
    const res = await fetch(`http://127.0.0.1:${port}/api/finance${ruta.path}`, { method: ruta.metodo, headers, body });
    return { status: res.status };
  } finally {
    server.close();
  }
}

// ── Inventario de rutas ─────────────────────────────────────────────────────

// "Finanzas": movimientos, comprobantes, suscripciones, excel, migración
// (preview y consultas) y cotización.
const FINANZAS_CONSULTA = [
  { metodo: 'GET', path: '/movimientos' },
  { metodo: 'GET', path: '/movimientos/metricas' },
  { metodo: 'GET', path: '/movimientos/flujo' },
  { metodo: 'GET', path: '/movimientos/m1' },
  { metodo: 'GET', path: '/comprobantes' },
  { metodo: 'GET', path: '/suscripciones' },
  { metodo: 'GET', path: '/suscripciones/proximas-vencer' },
  { metodo: 'GET', path: '/suscripciones/s1' },
  { metodo: 'GET', path: '/excel/plantilla' },
  { metodo: 'GET', path: '/migracion/tipos' },
  { metodo: 'GET', path: '/migracion/batches' },
  { metodo: 'GET', path: '/migracion/batches/b1' },
  { metodo: 'GET', path: '/salarios/cotizacion-dolar' },
];

const FINANZAS_CARGA = [
  { metodo: 'POST', path: '/movimientos' },
  { metodo: 'PUT', path: '/movimientos/m1' },
  { metodo: 'DELETE', path: '/movimientos/m1' },
  { metodo: 'POST', path: '/comprobantes/upload', archivo: 'pdf' },
  { metodo: 'DELETE', path: '/comprobantes/c1' },
  { metodo: 'POST', path: '/suscripciones' },
  { metodo: 'PUT', path: '/suscripciones/s1' },
  { metodo: 'DELETE', path: '/suscripciones/s1' },
  { metodo: 'POST', path: '/excel/validar', archivo: 'xlsx' },
  { metodo: 'POST', path: '/excel/importar', archivo: 'xlsx' },
  { metodo: 'POST', path: '/migracion/preview', archivo: 'xlsx', campos: { tipo_migracion: 'GASTOS_HISTORICOS' } },
  { metodo: 'POST', path: '/salarios/cotizacion-dolar' },
];

const FINANZAS = [...FINANZAS_CONSULTA, ...FINANZAS_CARGA];

// Sueldos: salarios/* salvo cotización (que es Finanzas).
const SUELDOS = [
  { metodo: 'GET', path: '/salarios/metricas' },
  { metodo: 'GET', path: '/salarios/empleados' },
  { metodo: 'GET', path: '/salarios/empleados/e1' },
  { metodo: 'POST', path: '/salarios/empleados' },
  { metodo: 'PUT', path: '/salarios/empleados/e1' },
  { metodo: 'DELETE', path: '/salarios/empleados/e1' },
  { metodo: 'GET', path: '/salarios/categorias' },
  { metodo: 'POST', path: '/salarios/categorias' },
  { metodo: 'DELETE', path: '/salarios/categorias/k1' },
  { metodo: 'GET', path: '/salarios/movimientos' },
  { metodo: 'POST', path: '/salarios/movimientos' },
  { metodo: 'PUT', path: '/salarios/movimientos/x1' },
  { metodo: 'DELETE', path: '/salarios/movimientos/x1' },
];

const TRAZABILIDAD = [{ metodo: 'GET', path: '/movimientos/trazabilidad' }];

const MIGRACION_ALTO = [
  { metodo: 'POST', path: '/migracion/confirmar', archivo: 'xlsx', campos: { tipo_migracion: 'GASTOS_HISTORICOS' } },
  { metodo: 'POST', path: '/migracion/batches/b1/revertir' },
];

const TODAS = [...FINANZAS, ...SUELDOS, ...TRAZABILIDAD, ...MIGRACION_ALTO];

// ── Tabla de casos: rol × ruta × método → código esperado ──────────────────

const casos = [];
const agregar = (id, rutas, sesion, esperado, extra = {}) => {
  for (const ruta of rutas) casos.push({ id, ruta, sesion, esperado, ...extra });
};

// Métodos de los services de Finanzas que escriben datos. Con sinEscritura: true,
// el caso verifica además que no se llamó a ninguno (la tabla no cambia).
const ESCRITURA = [
  [movimientosService, ['crear', 'actualizar', 'eliminar']],
  [comprobantesService, ['subirArchivo', 'persistir', 'persistirItems', 'eliminar', 'limpiarVencidos']],
  [suscripcionesService, ['crear', 'actualizar', 'eliminar']],
  [excelService, ['importar']],
  [migracionService, ['confirmar', '_insertarRegistros', 'revertirBatch']],
  [salariosService, ['guardarCotizacion', 'crearEmpleado', 'actualizarEmpleado', 'eliminarEmpleado',
    'crearCategoria', 'eliminarCategoria', 'crearMovimiento', 'actualizarMovimiento', 'eliminarMovimiento']],
];
const escriturasLlamadas = () => ESCRITURA.flatMap(([svc, metodos]) =>
  metodos.filter(m => svc[m].mock.callCount() > 0).map(m => `${svc.constructor.name}.${m}`));

agregar('CP-FIN-16-01', TODAS, null, '401');
agregar('CP-FIN-16-02', TODAS, { rol: 'Superadmin', activo: false }, '403');
for (const rol of MANDO_ALTO) agregar('CP-FIN-16-03', FINANZAS, { rol }, '2xx');
for (const rol of OTROS_ROLES) agregar('CP-FIN-16-04', FINANZAS_CONSULTA, { rol }, '403');
for (const rol of OTROS_ROLES) agregar('CP-FIN-16-05', FINANZAS_CARGA, { rol }, '403');
agregar('CP-FIN-16-06', FINANZAS, { rol: 'Contable', permiso: 'editor' }, '2xx');
agregar('CP-FIN-16-07', FINANZAS_CONSULTA, { rol: 'Auditor / Lector', permiso: 'lector' }, '2xx');
agregar('CP-FIN-16-08', FINANZAS_CARGA, { rol: 'Auditor / Lector', permiso: 'lector' }, '403');
agregar('CP-FIN-17-01', SUELDOS, { rol: 'Contable', permiso: 'editor' }, '403');
agregar('CP-FIN-17-01', SUELDOS, { rol: 'Auditor / Lector', permiso: 'lector' }, '403');
for (const rol of MANDO_ALTO) agregar('CP-FIN-17-02', SUELDOS, { rol }, '2xx');
for (const rol of MANDO_ALTO) agregar('CP-FIN-17-04', TRAZABILIDAD, { rol }, '200');
for (const rol of OTROS_ROLES) agregar('CP-FIN-17-04', TRAZABILIDAD, { rol, permiso: 'editor' }, '403');
for (const rol of MANDO_ALTO) agregar('CP-FIN-17-05', MIGRACION_ALTO, { rol }, '2xx');
for (const rol of OTROS_ROLES) agregar('CP-FIN-17-05', MIGRACION_ALTO, { rol, permiso: 'editor' }, '403');
// El permiso de finance cargado por rol no habilita Finanzas a quien no es mando alto.
agregar('CP-FIN-16-12', FINANZAS_CONSULTA, { rol: 'Contable', permisoPorRol: true }, '403');
agregar('CP-FIN-16-12', FINANZAS_CARGA, { rol: 'Contable', permisoPorRol: true }, '403', { sinEscritura: true });

function describirSesion(sesion) {
  if (!sesion) return 'sin sesión';
  const partes = [sesion.rol];
  if (sesion.activo === false) partes.push('inactivo');
  partes.push(sesion.permiso ? `permiso ${sesion.permiso}` : 'sin permiso manual');
  if (sesion.permisoPorRol) partes.push('permiso finance por rol');
  return partes.join(', ');
}

// '2xx' acepta cualquier código 200–299; el resto se compara exacto.
const clase = (status, esperado) => (esperado === '2xx' && status >= 200 && status < 300 ? '2xx' : String(status));

for (const c of casos) {
  test(`${c.id} ${describirSesion(c.sesion)}: ${c.ruta.metodo} /api/finance${c.ruta.path} → ${c.esperado}`, async (t) => {
    // Arrange
    simularServices(t);
    if (c.sesion) simularSesion(t, c.sesion);
    const app = appFinanzas();

    // Act
    const r = await llamar(app, c.ruta, { conSesion: !!c.sesion });

    // Assert
    if (c.sinEscritura) assert.deepEqual(escriturasLlamadas(), [], 'no debe llamarse a ningún service que escriba');
    assert.equal(clase(r.status, c.esperado), c.esperado);
  });
}
