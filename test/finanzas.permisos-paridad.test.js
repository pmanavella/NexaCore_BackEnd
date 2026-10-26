// RN-02 en todos lados (fase 0 de la evolución de Nexi).
// La API (consultaFinanzas / cargaFinanzas), Indicadores y Nexi deciden el acceso
// a Finanzas con la misma regla: mando alto o permiso particular de la matriz;
// el permiso heredado del rol no habilita a quien no es mando alto.
// Los roles y la matriz por rol salen del seed (scripts/test-db/catalogos.json).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const organizacionService = require('../organization/services/organizacionService');
const indicadoresService = require('../indicators/services/indicadoresService');
const dashboardService = require('../dashboard/services/dashboardService');
const errorHandler = require('../middleware/errorHandler');
const { resolverNivelJerarquico } = require('../rbac/config/jerarquia');
const permisosFinanzas = require('../finance/config/permisos');
const registry = require('../nexi/tools/registry');
const nexiPermisos = require('../nexi/services/nexiPermisos');
const nexiDatos = require('../nexi/services/nexiDatos');
const auditoriaService = require('../nexi/services/auditoriaService');
const repositorio = require('../nexi/services/reportesRepositorio');
const catalogos = require('../scripts/test-db/catalogos.json');

const AHORA = new Date('2026-09-27T15:00:00Z');
const HERRAMIENTAS_FINANZAS = ['flujo_financiero', 'proximos_vencimientos', 'resumen_finanzas', 'total_movimientos_periodo'];

// ── Seed ────────────────────────────────────────────────────────────────────

const ROLES = new Map(catalogos.roles.map(r => [r.nombre, r]));
const MODULOS = catalogos.modulos;

// Usuarios de prueba: uno por rol del seed (sin permiso particular), más los
// usuarios del seed con permiso particular de Finanzas (U-10, U-11).
const USUARIOS = [
  ...catalogos.roles.map(r => ({ etiqueta: r.nombre, rol: r.nombre })),
  { etiqueta: 'U-10 Contable con permiso particular editor', rol: 'Contable', particular: 'editor' },
  { etiqueta: 'U-11 Auditor con permiso particular lector', rol: 'Auditor / Lector', particular: 'lector' },
];

// Mismo armado que organizacionService.obtenerPermisosUsuario:
// permiso particular > permiso del rol (puede_ver) > sin acceso.
function permisosDelSeed({ rol, particular = null }, { sinFilaFinanzas = false } = {}) {
  return MODULOS.map(mod => {
    if (mod.nombre === 'finance' && particular) {
      return { permiso: particular, alcance: 'global', source: 'usuario', modulos: mod };
    }
    const rp = catalogos.rol_modulo_permisos.find(([r, m]) => r === rol && m === mod.nombre);
    if (rp?.[2] && !(sinFilaFinanzas && mod.nombre === 'finance')) {
      return { permiso: rp[3] ? 'editor' : 'lector', alcance: 'global', source: 'rol', modulos: mod };
    }
    return { permiso: 'sin_acceso', alcance: null, source: 'ninguno', modulos: mod };
  });
}

function usuarioSesion({ rol }) {
  return { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Usuario Prueba', role: rol, hierarchyLevel: resolverNivelJerarquico(ROLES.get(rol)) };
}

// Decisión real del middleware: 'pasa' (next) o el código HTTP con que corta.
function decidir(middleware, user) {
  return new Promise((resolve, reject) => {
    const res = { status: code => ({ json: () => resolve(code) }) };
    middleware({ user }, res, err => (err ? reject(err) : resolve('pasa')));
  });
}

// Regla esperada según RN-02, escrita a partir del requisito.
function esperado({ rol, particular }) {
  if (ROLES.get(rol).nivel_jerarquico === 'HIGH') return { consulta: true, carga: true };
  return { consulta: !!particular, carga: particular === 'editor' };
}

// ── Paridad REST ↔ Nexi ────────────────────────────────────────────────────

for (const u of USUARIOS) {
  test(`paridad RN-02 · ${u.etiqueta}: API (consulta/carga) y Nexi deciden lo mismo`, async (t) => {
    t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => permisosDelSeed(u));
    const user = usuarioSesion(u);
    const esp = esperado(u);

    const consulta = await decidir(permisosFinanzas.consultaFinanzas, user);
    const carga = await decidir(permisosFinanzas.cargaFinanzas, user);
    assert.equal(consulta, esp.consulta ? 'pasa' : 403, 'API consulta');
    assert.equal(carga, esp.carga ? 'pasa' : 403, 'API carga');

    const niveles = await nexiPermisos.obtenerNiveles(user);
    const ofrecidas = registry.herramientasDisponibles(niveles, null, user).map(h => h.nombre);
    const nexiConsulta = HERRAMIENTAS_FINANZAS.every(n => ofrecidas.includes(n));
    assert.equal(nexiConsulta, esp.consulta, 'Nexi');
    assert.ok(nexiConsulta || !HERRAMIENTAS_FINANZAS.some(n => ofrecidas.includes(n)), 'Nexi no ofrece herramientas de Finanzas sueltas');
  });
}

test('paridad RN-02 · mando alto SIN fila de Finanzas en la matriz: pasa en la API y en Nexi', async (t) => {
  for (const rol of ['Superadmin', 'Dirección']) {
    t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => permisosDelSeed({ rol }, { sinFilaFinanzas: true }));
    const user = usuarioSesion({ rol });
    assert.equal(await decidir(permisosFinanzas.consultaFinanzas, user), 'pasa', rol);
    assert.equal(await decidir(permisosFinanzas.cargaFinanzas, user), 'pasa', rol);
    const niveles = await nexiPermisos.obtenerNiveles(user);
    assert.equal(niveles.get('finance').nivel, 'administrador', rol);
    assert.ok(registry.herramientasDisponibles(niveles, null, user).some(h => h.nombre === 'resumen_finanzas'), rol);
    t.mock.restoreAll();
  }
});

// Excepción documentada (decisión de la fase 0, opción a): un permiso particular
// de Finanzas acota al mando alto en Nexi, aunque la API lo deje pasar. Nexi es
// más estricto, nunca más permisivo. En el seed no hay ningún caso así.
test('excepción de paridad (opción a): mando alto con permiso particular sin_acceso → API pasa, Nexi niega', async (t) => {
  t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => [
    { permiso: 'sin_acceso', alcance: 'global', source: 'usuario', modulos: { nombre: 'finance', label: 'Finanzas' } },
  ]);
  const user = usuarioSesion({ rol: 'Dirección' });
  assert.equal(await decidir(permisosFinanzas.consultaFinanzas, user), 'pasa');
  const niveles = await nexiPermisos.obtenerNiveles(user);
  assert.equal(niveles.get('finance').nivel, 'sin_acceso');
  assert.ok(!registry.herramientasDisponibles(niveles, null, user).some(h => h.nombre === 'resumen_finanzas'));
});

// ── Matriz rol × herramienta de Finanzas (ofrecer y ejecutar) ──────────────

const MATRIZ = [
  { u: { rol: 'Superadmin' }, ok: true },
  { u: { rol: 'Dirección' }, ok: true },
  { u: { rol: 'Contable' }, ok: false },
  { u: { rol: 'Auditor / Lector' }, ok: false },
  { u: { rol: 'Pasante' }, ok: false },
  { u: { rol: 'Externo' }, ok: false },
  { u: { rol: 'Contable', particular: 'editor' }, ok: true },
  { u: { rol: 'Auditor / Lector', particular: 'lector' }, ok: true },
];

for (const { u, ok } of MATRIZ) {
  const nombre = `${u.rol}${u.particular ? ` con permiso particular ${u.particular}` : ' (solo permisos del rol)'}`;
  test(`matriz Finanzas en Nexi · ${nombre}: ${ok ? 'se ofrecen y ejecutan' : 'no se ofrecen y se deniegan'}`, async (t) => {
    t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => permisosDelSeed(u));
    t.mock.method(auditoriaService, 'registrar', async () => {});
    const datos = t.mock.method(nexiDatos, 'totalesMovimientos', async () => []);
    t.mock.method(nexiDatos, 'contarComprobantesEnRevision', async () => 0);
    const user = usuarioSesion(u);

    const ofrecidas = registry.herramientasDisponibles(await nexiPermisos.obtenerNiveles(user), null, user).map(h => h.nombre);
    for (const h of HERRAMIENTAS_FINANZAS) assert.equal(ofrecidas.includes(h), ok, `ofrecer ${h}`);

    for (const [h, args] of [
      ['resumen_finanzas', {}],
      ['flujo_financiero', { meses: 3 }],
      ['total_movimientos_periodo', { tipo: 'Gasto', desde: '2026-01-01', hasta: '2026-06-30' }],
    ]) {
      const r = await registry.ejecutar({ nombre: h, argumentos: args, usuario: user, conversacionId: 'conv-1', ahora: AHORA });
      assert.equal(r.estado, ok ? 'OK' : 'DENEGADO', `ejecutar ${h}`);
      if (!ok) assert.equal(r.motivo, 'SIN_PERMISO', `ejecutar ${h}`);
    }
    if (!ok) assert.equal(datos.mock.callCount(), 0, 'sin permiso no se consultan datos');
  });
}

// ── Mosaicos y reportes en Nexi siguen la regla ────────────────────────────

test('mosaico financiero en Nexi: Auditor con Finanzas solo por rol → datos no disponibles', async (t) => {
  const u = { rol: 'Auditor / Lector' };
  t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => permisosDelSeed(u));
  t.mock.method(auditoriaService, 'registrar', async () => {});
  t.mock.method(dashboardService, 'obtenerConfiguracion', async () => ({
    dashboard: { name: 'Panel General', widgets: [{ id: 'finanzas_ingresos_mes', instanceId: 'w1', period: 'month', chartType: 'kpi', size: 'sm' }] },
    hasConfiguration: true,
  }));
  const datos = t.mock.method(nexiDatos, 'totalesMovimientos', async () => []);
  const r = await registry.ejecutar({ nombre: 'datos_widget_dashboard', argumentos: { instancia: 'w1' }, usuario: usuarioSesion(u), conversacionId: 'conv-1', ahora: AHORA });
  assert.equal(r.estado, 'OK');
  assert.equal(r.resultado.datos.datos.disponible, false);
  assert.match(r.resultado.datos.datos.motivo, /Sin permiso/);
  assert.equal(datos.mock.callCount(), 0);
});

test('reporte financiero en Nexi: Auditor con Finanzas solo por rol → sección excluida, sin datos', async (t) => {
  const u = { rol: 'Auditor / Lector' };
  t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => permisosDelSeed(u));
  t.mock.method(auditoriaService, 'registrar', async () => {});
  t.mock.method(repositorio, 'contarRecientes', async () => 0);
  t.mock.method(repositorio, 'crear', async () => '99999999-9999-4999-8999-999999999999');
  const finalizar = t.mock.method(repositorio, 'finalizar', async () => {});
  const subir = t.mock.method(repositorio, 'subirArchivo', async () => {});
  const datos = t.mock.method(nexiDatos, 'totalesMovimientos', async () => []);
  const r = await registry.ejecutar({
    nombre: 'generar_reporte', argumentos: { tipo: 'financiero', periodo: '2026-08' },
    usuario: usuarioSesion(u), conversacionId: 'conv-1', ahora: AHORA,
  });
  assert.equal(r.estado, 'DENEGADO');
  assert.equal(r.motivo, 'SIN_SECCIONES_PERMITIDAS');
  assert.equal(finalizar.mock.calls[0].arguments[1].estado, 'DENEGADO');
  assert.equal(subir.mock.callCount(), 0);
  assert.equal(datos.mock.callCount(), 0);
});

// ── Indicadores (REST): valor, histórico y variables exigen RN-02 ──────────

function simularSesion(t, u) {
  const rol = ROLES.get(u.rol);
  t.mock.method(supabase.auth, 'getUser', async () => ({ data: { user: { email: 'u@x' } }, error: null }));
  t.mock.method(supabase, 'from', () => {
    const builder = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') return (res) => res({ data: { id: 'u1', nombre: 'Usuario', roles: { nombre: rol.nombre, nivel_jerarquico: rol.nivel_jerarquico } }, error: null });
        return () => builder;
      },
    });
    return builder;
  });
  // Misma resolución que organizacionService.usuarioTieneAccesoModulo (particular >
  // rol > sin acceso) sobre el seed. Indicadores se da como permiso particular:
  // solo se prueba el requisito de Finanzas.
  t.mock.method(organizacionService, 'usuarioTieneAccesoModulo', async (id, modulo) => {
    if (modulo === 'indicadores') return true;
    const p = permisosDelSeed(u).find(x => x.modulos.nombre === modulo);
    return !!p && p.permiso !== 'sin_acceso';
  });
  t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => permisosDelSeed(u));
}

async function llamar(path, metodo = 'GET', { conSesion = true } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/indicadores', require('../indicators/routes/indicadores'));
  app.use('/api/finance/deudas', require('../finance/routes/deudas'));
  app.use(errorHandler);
  const server = http.createServer(app).listen(0);
  try {
    const headers = conSesion ? { authorization: 'Bearer x' } : {};
    let body;
    if (metodo !== 'GET') {
      headers['content-type'] = 'application/json';
      body = JSON.stringify({});
    }
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: metodo, headers, body });
    return res.status;
  } finally {
    server.close();
  }
}

const RUTAS_INDICADORES_FINANZAS = ['/api/indicadores/11111111-1111-4111-8111-111111111111/valor', '/api/indicadores/11111111-1111-4111-8111-111111111111/historico', '/api/indicadores/variables'];

for (const { u, esperado: codigo } of [
  { u: { rol: 'Contable' }, esperado: 403 },
  { u: { rol: 'Auditor / Lector' }, esperado: 403 },
  { u: { rol: 'Dirección' }, esperado: 200 },
  { u: { rol: 'Contable', particular: 'lector' }, esperado: 200 },
]) {
  test(`Indicadores REST · ${u.rol}${u.particular ? ' con permiso particular' : ' (Finanzas solo por rol)'}: valor, histórico y variables → ${codigo}`, async (t) => {
    simularSesion(t, u);
    const calcular = t.mock.method(indicadoresService, 'calcularValor', async () => ({ valor: 1 }));
    t.mock.method(indicadoresService, 'calcularHistorico', async () => ({ puntos: [] }));
    for (const ruta of RUTAS_INDICADORES_FINANZAS) assert.equal(await llamar(ruta), codigo, ruta);
    if (codigo === 403) assert.equal(calcular.mock.callCount(), 0);
  });
}

// ── Deudas (REST): RN-02 en las 6 rutas ─────────────────────────────────────

const deudasService = require('../finance/services/deudasService');

const DEUDAS_CONSULTA = [['GET', '/api/finance/deudas'], ['GET', '/api/finance/deudas/metricas'], ['GET', '/api/finance/deudas/d1']];
const DEUDAS_CARGA = [['POST', '/api/finance/deudas'], ['PUT', '/api/finance/deudas/d1'], ['DELETE', '/api/finance/deudas/d1']];
const DEUDAS = [...DEUDAS_CONSULTA, ...DEUDAS_CARGA];

function simularDeudas(t) {
  const metodos = ['listar', 'getMetricas', 'obtenerPorId', 'crear', 'actualizar', 'eliminar'];
  return Object.fromEntries(metodos.map(m => [m, t.mock.method(deudasService, m, async () => ({ data: [] }))]));
}
const escriturasDeudas = mocks => ['crear', 'actualizar', 'eliminar'].filter(m => mocks[m].mock.callCount() > 0);
const es2xx = status => status >= 200 && status < 300;

const CASOS_DEUDAS = [
  { u: { rol: 'Pasante' }, rutas: DEUDAS, esperado: 403 },
  { u: { rol: 'Externo' }, rutas: DEUDAS, esperado: 403 },
  { u: { rol: 'Contable' }, rutas: DEUDAS, esperado: 403 },
  { u: { rol: 'Auditor / Lector' }, rutas: DEUDAS, esperado: 403 },
  { u: { rol: 'Superadmin' }, rutas: DEUDAS, esperado: '2xx' },
  { u: { rol: 'Dirección' }, rutas: DEUDAS, esperado: '2xx' },
  { u: { rol: 'Contable', particular: 'editor' }, rutas: DEUDAS, esperado: '2xx' },
  { u: { rol: 'Auditor / Lector', particular: 'lector' }, rutas: DEUDAS_CONSULTA, esperado: '2xx' },
  { u: { rol: 'Auditor / Lector', particular: 'lector' }, rutas: DEUDAS_CARGA, esperado: 403 },
];

for (const { u, rutas, esperado: codigo } of CASOS_DEUDAS) {
  const quien = `${u.rol}${u.particular ? ` con permiso particular ${u.particular}` : ' (solo permisos del rol)'}`;
  for (const [metodo, path] of rutas) {
    test(`Deudas REST · ${quien}: ${metodo} ${path} → ${codigo}`, async (t) => {
      simularSesion(t, u);
      const mocks = simularDeudas(t);
      const status = await llamar(path, metodo);
      if (codigo === '2xx') assert.ok(es2xx(status), `status ${status}`);
      else {
        assert.equal(status, codigo);
        assert.deepEqual(escriturasDeudas(mocks), [], 'no debe escribirse ninguna deuda');
      }
    });
  }
}

test('Deudas REST · sin sesión: las 6 rutas → 401', async (t) => {
  const mocks = simularDeudas(t);
  for (const [metodo, path] of DEUDAS) assert.equal(await llamar(path, metodo, { conSesion: false }), 401, `${metodo} ${path}`);
  assert.deepEqual(escriturasDeudas(mocks), []);
});
