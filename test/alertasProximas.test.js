// Mosaico "Alertas" del Dashboard (GET /api/alertas/proximas) y fuente nueva de
// personas externas del organigrama en el Centro de Alertas (GET /api/alertas).
// Base en memoria, reloj fijo (`ahora` inyectado) y permisos simulados.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { randomUUID } = require('node:crypto');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const organizacionService = require('../organization/services/organizacionService');
const suscripcionesService = require('../finance/services/suscripcionesService');
const errorHandler = require('../middleware/errorHandler');
const alertasService = require('../alertas/services/alertasService');

// 2026-11-25 12:00 en Argentina (UTC-3)
const AHORA = new Date('2026-11-25T15:00:00Z');
const HOY = '2026-11-25';
const dia = (n) => { const d = new Date(`${HOY}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ── Supabase en memoria ──────────────────────────────────────────────────────

function crearBase(t, { fallas = [] } = {}) {
  const db = { deudas: [], organigrama: [], tarea_asignados: [], tareas: [], indicadores: [], operativo_tablero_miembros: [] };
  const consultas = [];
  t.mock.method(supabase, 'from', (tabla) => {
    const st = { filtros: [], head: false, single: false };
    const b = {
      select(_c, opts = {}) { st.head = !!opts.head; return b; },
      eq(c, v) { st.filtros.push(f => f[c] === v); return b; },
      neq(c, v) { st.filtros.push(f => f[c] != null && f[c] !== v); return b; },
      lt(c, v) { st.filtros.push(f => f[c] != null && f[c] < v); return b; },
      lte(c, v) { st.filtros.push(f => f[c] != null && f[c] <= v); return b; },
      gte(c, v) { st.filtros.push(f => f[c] != null && f[c] >= v); return b; },
      in(c, vs) { st.filtros.push(f => vs.includes(f[c])); return b; },
      or() { return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { st.single = true; return b; },
      then(res, rej) {
        consultas.push(tabla);
        if (fallas.includes(tabla)) return Promise.resolve({ data: null, error: { message: `falla ${tabla}` } }).then(res, rej);
        const filas = (db[tabla] || []).filter(f => st.filtros.every(fn => fn(f))).map(f => ({ ...f }));
        const r = st.head ? { data: null, count: filas.length, error: null }
          : st.single ? { data: filas[0] ?? null, error: null }
          : { data: filas, error: null };
        return Promise.resolve(r).then(res, rej);
      },
    };
    return b;
  });
  return { db, consultas };
}

// Permisos: `finanzas` = permiso de Finanzas ('lector' | null) y su origen
// ('usuario' = particular, 'rol' = heredado); `organizacion` = acceso al módulo.
function simularPermisos(t, { finanzas = null, origenFinanzas = 'usuario', organizacion = false, fallaPermisos = false } = {}) {
  t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => {
    if (fallaPermisos) throw new Error('falla permisos');
    return finanzas ? [{ permiso: finanzas, alcance: 'global', source: origenFinanzas, modulos: { nombre: 'finance' } }] : [];
  });
  const llamadas = [];
  t.mock.method(organizacionService, 'usuarioTieneAccesoModulo', async (_id, modulo) => {
    llamadas.push(modulo);
    if (fallaPermisos) throw new Error('falla permisos');
    return modulo === 'organizacion' && organizacion;
  });
  return llamadas;
}

function simularSuscripciones(t, lista = []) {
  return t.mock.method(suscripcionesService, 'proximasVencer', async () => lista);
}

const OPERATIVO = () => ({ id: randomUUID(), name: 'Ana', role: 'Operativo', hierarchyLevel: 'LOW' });
const CONTABLE = () => ({ id: randomUUID(), name: 'Caro', role: 'Contable', hierarchyLevel: 'LOW' });
const DIRECCION = () => ({ id: randomUUID(), name: 'Dora', role: 'Dirección', hierarchyLevel: 'HIGH' });
const SUPERADMIN = () => ({ id: randomUUID(), name: 'Sol', role: 'Superadmin', hierarchyLevel: 'HIGH' });

const proximas = (user, params = {}) => alertasService.proximas(user, params, { ahora: AHORA });

function externo(db, datos) {
  const fila = {
    id: randomUUID(), es_externo: true, activo: true, fecha_fin: null,
    nombre_manual: null, apellido_manual: null, usuarios: null, empleados: null, ...datos,
  };
  db.organigrama.push(fila);
  return fila;
}

// ── Externos del organigrama ─────────────────────────────────────────────────

test('externos: incluye los que vencen dentro del horizonte y los ya vencidos; excluye inactivos, internos, sin fecha y fuera de horizonte', async (t) => {
  const { db } = crearBase(t);
  simularPermisos(t);
  simularSuscripciones(t);
  const dentro = externo(db, { nombre_manual: 'Pepito', apellido_manual: 'Pérez', fecha_fin: dia(5) });
  const limite = externo(db, { nombre_manual: 'Lía', apellido_manual: 'Límite', fecha_fin: dia(15) });
  const vencido = externo(db, { nombre_manual: 'Vico', apellido_manual: 'Vencido', fecha_fin: dia(-2) });
  externo(db, { nombre_manual: 'Fuera', fecha_fin: dia(16) });                     // fuera del horizonte
  externo(db, { nombre_manual: 'Inactivo', fecha_fin: dia(3), activo: false });   // inactivo
  externo(db, { nombre_manual: 'Interno', fecha_fin: dia(3), es_externo: false }); // no externo
  externo(db, { nombre_manual: 'Sin fecha', fecha_fin: null });                    // sin vencimiento

  const r = await proximas(SUPERADMIN(), { tipos: 'externos', horizonte: '15' });
  assert.deepEqual(r.alertas.map(a => a.referencia.id), [vencido.id, dentro.id, limite.id]);
  assert.equal(r.horizonte, 15);
  assert.deepEqual(r.tipos, ['externos']);
});

test('externos: texto, días restantes, severidad y referencia', async (t) => {
  const { db } = crearBase(t);
  simularPermisos(t);
  const pepito = externo(db, { nombre_manual: 'Pepito', apellido_manual: 'Pérez', fecha_fin: '2026-11-30' });
  externo(db, { nombre_manual: 'Vico', apellido_manual: 'Vencido', fecha_fin: '2026-11-23' });
  externo(db, { nombre_manual: 'Hoy', fecha_fin: HOY });
  externo(db, { nombre_manual: 'Lejano', fecha_fin: dia(20) });

  const r = await proximas(SUPERADMIN(), { tipos: ['externos'], horizonte: 30 });
  const porNombre = Object.fromEntries(r.alertas.map(a => [a.titulo.split(': ')[1], a]));

  assert.deepEqual(porNombre['Pepito Pérez'], {
    id: `externos:${pepito.id}`,
    tipo: 'externos',
    titulo: 'Acceso externo por vencer: Pepito Pérez',
    detalle: 'El acceso de Pepito Pérez vence en 5 días (30/11/2026).',
    fecha_vencimiento: '2026-11-30',
    dias_restantes: 5,
    severidad: 'proxima',
    referencia: { id: pepito.id, modulo: 'organizacion', seccion: 'organigrama' },
  });
  assert.equal(porNombre['Vico Vencido'].detalle, 'El acceso de Vico Vencido venció hace 2 días (23/11/2026).');
  assert.equal(porNombre['Vico Vencido'].dias_restantes, -2);
  assert.equal(porNombre['Vico Vencido'].severidad, 'vencida');
  assert.equal(porNombre['Vico Vencido'].titulo, 'Acceso externo vencido: Vico Vencido');
  assert.equal(porNombre.Hoy.detalle, 'El acceso de Hoy vence hoy (25/11/2026).');
  assert.equal(porNombre.Hoy.severidad, 'proxima');
  assert.equal(porNombre.Lejano.severidad, 'informativa');
});

test('externos: el nombre usa el usuario o empleado vinculado y, si no hay, el manual', async (t) => {
  const { db } = crearBase(t);
  simularPermisos(t);
  externo(db, { fecha_fin: dia(1), usuarios: { id: 'u', nombre: 'Usuario Vinculado' }, nombre_manual: 'Ignorado' });
  externo(db, { fecha_fin: dia(2), empleados: { id: 'e', nombre: 'Emma', apellido: 'Empleada' } });
  externo(db, { fecha_fin: dia(3), nombre_manual: 'Solo' });
  const r = await proximas(SUPERADMIN(), { tipos: 'externos' });
  assert.deepEqual(r.alertas.map(a => a.detalle), [
    'El acceso de Usuario Vinculado vence mañana (26/11/2026).',
    'El acceso de Emma Empleada vence en 2 días (27/11/2026).',
    'El acceso de Solo vence en 3 días (28/11/2026).',
  ]);
});

// ── Deudas y suscripciones ───────────────────────────────────────────────────

test('deudas: Pendiente/Vencida dentro del horizonte o vencidas; Pagada nunca', async (t) => {
  const { db } = crearBase(t);
  simularPermisos(t, { finanzas: 'lector' });
  db.deudas.push(
    { id: 1, acreedor: 'Banco', descripcion: 'Préstamo', estado: 'Vencida', vencimiento: dia(-10) },
    { id: 2, acreedor: 'Proveedor', descripcion: null, estado: 'Pendiente', vencimiento: dia(3) },
    { id: 3, acreedor: 'Pagado', estado: 'Pagada', vencimiento: dia(1) },
    { id: 4, acreedor: 'Lejos', estado: 'Pendiente', vencimiento: dia(8) }, // fuera de 7 días
  );
  const r = await proximas(CONTABLE(), { tipos: 'deudas', horizonte: 7 });
  assert.deepEqual(r.alertas.map(a => a.referencia), [
    { id: 1, modulo: 'finance', seccion: 'deudas' },
    { id: 2, modulo: 'finance', seccion: 'deudas' },
  ]);
  assert.equal(r.alertas[0].detalle, 'La deuda con Banco (Préstamo) venció hace 10 días (15/11/2026).');
  assert.equal(r.alertas[0].severidad, 'vencida');
  assert.equal(r.alertas[1].detalle, 'La deuda con Proveedor vence en 3 días (28/11/2026).');
  assert.ok(!JSON.stringify(r).includes('monto'), 'no expone montos');
});

test('suscripciones: reutiliza suscripcionesService.proximasVencer con el horizonte elegido', async (t) => {
  crearBase(t);
  simularPermisos(t, { finanzas: 'lector' });
  const mock = simularSuscripciones(t, [
    { id: 's1', nombre: 'Slack', proveedor: 'Slack Inc', proxima_fecha_vencimiento: dia(12), dias_restantes: 12 },
  ]);
  const r = await proximas(CONTABLE(), { tipos: 'suscripciones', horizonte: 30 });
  assert.equal(mock.mock.callCount(), 1);
  assert.deepEqual(mock.mock.calls[0].arguments, [30]);
  assert.deepEqual(r.alertas, [{
    id: 'suscripciones:s1', tipo: 'suscripciones', titulo: 'Suscripción Slack',
    detalle: 'La suscripción Slack (Slack Inc) vence en 12 días (07/12/2026).',
    fecha_vencimiento: '2026-12-07', dias_restantes: 12, severidad: 'informativa',
    referencia: { id: 's1', modulo: 'finance', seccion: 'suscripciones' },
  }]);
});

test('orden: vencidas primero y después por fecha, mezclando tipos', async (t) => {
  const { db } = crearBase(t);
  simularPermisos(t);
  simularSuscripciones(t, [{ id: 's1', nombre: 'Zoom', proxima_fecha_vencimiento: dia(2) }]);
  db.deudas.push(
    { id: 1, acreedor: 'A', estado: 'Pendiente', vencimiento: dia(10) },
    { id: 2, acreedor: 'B', estado: 'Vencida', vencimiento: dia(-1) },
  );
  externo(db, { nombre_manual: 'Ext', fecha_fin: dia(-5) });
  externo(db, { nombre_manual: 'Ext2', fecha_fin: dia(1) });
  const r = await proximas(SUPERADMIN());
  assert.deepEqual(r.alertas.map(a => [a.tipo, a.dias_restantes]), [
    ['externos', -5], ['deudas', -1], ['externos', 1], ['suscripciones', 2], ['deudas', 10],
  ]);
  assert.equal(r.horizonte, 15, 'horizonte default');
  assert.deepEqual(r.tipos, ['deudas', 'suscripciones', 'externos'], 'tipos default: todos');
});

// ── Permisos por tipo ────────────────────────────────────────────────────────

test('permisos: sin Finanzas (RN-02) se omiten deudas y suscripciones sin consultar ni dar error', async (t) => {
  const { db, consultas } = crearBase(t);
  simularPermisos(t, { finanzas: null });
  const susc = simularSuscripciones(t, [{ id: 's1', nombre: 'X', proxima_fecha_vencimiento: dia(1) }]);
  db.deudas.push({ id: 1, acreedor: 'A', estado: 'Pendiente', vencimiento: dia(1) });
  const r = await proximas(OPERATIVO(), { tipos: 'deudas,suscripciones' });
  assert.deepEqual(r, { alertas: [], total: 0, horizonte: 15, tipos: [], generado_en: AHORA.toISOString(), parcial: false, fuentes: [] });
  assert.ok(!consultas.includes('deudas'));
  assert.equal(susc.mock.callCount(), 0);
});

test('permisos: el permiso de Finanzas heredado del rol NO cuenta; el particular sí; mando alto sí', async (t) => {
  const { db } = crearBase(t);
  simularSuscripciones(t);
  db.deudas.push({ id: 1, acreedor: 'A', estado: 'Pendiente', vencimiento: dia(1) });

  simularPermisos(t, { finanzas: 'lector', origenFinanzas: 'rol' });
  assert.equal((await proximas(CONTABLE(), { tipos: 'deudas' })).total, 0);

  simularPermisos(t, { finanzas: 'lector', origenFinanzas: 'usuario' });
  assert.equal((await proximas(CONTABLE(), { tipos: 'deudas' })).total, 1);

  simularPermisos(t, { finanzas: null });
  assert.equal((await proximas(DIRECCION(), { tipos: 'deudas' })).total, 1);
});

test('permisos: externos requieren rol de organigrama + módulo Organización; Superadmin ve todo; otros roles ni consultan la Matriz', async (t) => {
  const { db, consultas } = crearBase(t);
  externo(db, { nombre_manual: 'Ext', fecha_fin: dia(1) });

  let llamadas = simularPermisos(t, { finanzas: 'lector', organizacion: true });
  const operativo = await proximas(OPERATIVO(), { tipos: 'externos' });
  assert.equal(operativo.total, 0, 'rol sin acceso al organigrama');
  assert.deepEqual(llamadas, [], 'no consulta la Matriz');
  assert.ok(!consultas.includes('organigrama'));

  simularPermisos(t, { organizacion: false });
  assert.equal((await proximas(DIRECCION(), { tipos: 'externos' })).total, 0, 'Dirección sin módulo Organización');

  simularPermisos(t, { organizacion: true });
  assert.equal((await proximas(DIRECCION(), { tipos: 'externos' })).total, 1);

  llamadas = simularPermisos(t, { organizacion: false });
  assert.equal((await proximas(SUPERADMIN(), { tipos: 'externos' })).total, 1, 'Superadmin ve todo');
  assert.deepEqual(llamadas, []);
});

test('permisos: tipos mezclados devuelven solo los permitidos', async (t) => {
  const { db } = crearBase(t);
  simularPermisos(t, { finanzas: 'lector', organizacion: false });
  simularSuscripciones(t);
  db.deudas.push({ id: 1, acreedor: 'A', estado: 'Pendiente', vencimiento: dia(1) });
  externo(db, { nombre_manual: 'Ext', fecha_fin: dia(1) });
  const r = await proximas(CONTABLE());
  assert.deepEqual(r.tipos, ['deudas', 'suscripciones']);
  assert.deepEqual(r.alertas.map(a => a.tipo), ['deudas']);
});

test('permisos: si no se pueden verificar, el tipo se informa como error y no se asume acceso', async (t) => {
  crearBase(t);
  simularPermisos(t, { fallaPermisos: true });
  const r = await proximas(DIRECCION(), { tipos: 'externos' });
  assert.equal(r.parcial, true);
  assert.deepEqual(r.fuentes, [{ fuente: 'externos', estado: 'error', motivo: 'PERMISOS_NO_VERIFICADOS' }]);
});

test('tiposPermitidos: refleja los permisos por tipo', async (t) => {
  simularPermisos(t, { finanzas: null });
  assert.deepEqual(await alertasService.tiposPermitidos(OPERATIVO()), []);
  simularPermisos(t, { finanzas: 'lector' });
  assert.deepEqual(await alertasService.tiposPermitidos(CONTABLE()), ['deudas', 'suscripciones']);
  simularPermisos(t, { organizacion: true });
  assert.deepEqual(await alertasService.tiposPermitidos(DIRECCION()), ['deudas', 'suscripciones', 'externos']);
  // Si la Matriz no responde, no se ofrecen los tipos que dependen de ella. El
  // mando alto conserva Finanzas (RN-02 no consulta la Matriz para él).
  simularPermisos(t, { fallaPermisos: true });
  assert.deepEqual(await alertasService.tiposPermitidos(CONTABLE()), []);
  assert.deepEqual(await alertasService.tiposPermitidos(DIRECCION()), ['deudas', 'suscripciones']);
});

// ── Parámetros y errores ─────────────────────────────────────────────────────

test('parámetros: tipos u horizonte inválidos → 400', async (t) => {
  crearBase(t);
  simularPermisos(t);
  await assert.rejects(proximas(SUPERADMIN(), { tipos: 'deudas,crm' }), e => e.status === 400 && /crm/.test(e.message));
  await assert.rejects(proximas(SUPERADMIN(), { horizonte: '10' }), e => e.status === 400 && /7, 15, 30/.test(e.message));
  await assert.rejects(proximas(SUPERADMIN(), { horizonte: 'abc' }), e => e.status === 400);
});

test('error parcial: si una fuente falla, se informa y el resto se devuelve', async (t) => {
  const { db } = crearBase(t, { fallas: ['organigrama'] });
  simularPermisos(t);
  simularSuscripciones(t);
  t.mock.method(console, 'error', () => {});
  db.deudas.push({ id: 1, acreedor: 'A', estado: 'Pendiente', vencimiento: dia(1) });
  const r = await proximas(SUPERADMIN());
  assert.equal(r.parcial, true);
  assert.deepEqual(r.alertas.map(a => a.tipo), ['deudas']);
  assert.deepEqual(r.fuentes.find(f => f.fuente === 'externos'), { fuente: 'externos', estado: 'error', motivo: 'ERROR' });
});

// ── Centro de Alertas (GET /api/alertas): fuente nueva "externos" ────────────

test('Centro de Alertas: agrega externos vencidos y por vencer (7 días) para quien puede ver Organización', async (t) => {
  const { db } = crearBase(t);
  simularPermisos(t);
  externo(db, { nombre_manual: 'A', fecha_fin: dia(-1) });
  externo(db, { nombre_manual: 'B', fecha_fin: dia(0) });
  externo(db, { nombre_manual: 'C', fecha_fin: dia(7) });
  externo(db, { nombre_manual: 'D', fecha_fin: dia(8) });                // fuera de 7 días
  externo(db, { nombre_manual: 'E', fecha_fin: dia(1), activo: false }); // inactivo

  const r = await alertasService.evaluar(SUPERADMIN(), { ahora: AHORA });
  const porId = Object.fromEntries(r.alertas.map(a => [a.id, a]));
  assert.equal(porId['organizacion:externos:vencidos'].cantidad, 1);
  assert.equal(porId['organizacion:externos:vencidos'].severidad, 'alta');
  assert.equal(porId['organizacion:externos:por_vencer'].cantidad, 2);
  assert.equal(porId['organizacion:externos:por_vencer'].severidad, 'media');
  assert.deepEqual(porId['organizacion:externos:por_vencer'].destino, { modulo: 'organizacion', seccion: 'organigrama' });
  assert.ok(r.fuentes.some(f => f.fuente === 'externos' && f.estado === 'ok'));
});

test('Centro de Alertas: sin permiso de Organización la fuente externos no se evalúa ni se informa', async (t) => {
  const { db, consultas } = crearBase(t);
  simularPermisos(t, { organizacion: false });
  externo(db, { nombre_manual: 'A', fecha_fin: dia(-1) });
  for (const user of [OPERATIVO(), DIRECCION()]) {
    const r = await alertasService.evaluar(user, { ahora: AHORA });
    assert.ok(!r.fuentes.some(f => f.fuente === 'externos'));
    assert.ok(!r.alertas.some(a => a.modulo === 'organizacion'));
  }
  assert.ok(!consultas.includes('organigrama'));
});

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function llamar(t, ruta, { conSesion = true } = {}) {
  t.mock.method(supabase.auth, 'getUser', async () => ({ data: { user: { email: 'sol@x' } }, error: null }));
  const fromBase = supabase.from;
  t.mock.method(supabase, 'from', (tabla) => {
    if (tabla !== 'usuarios') return fromBase(tabla);
    const perfil = { data: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nombre: 'Sol', roles: { nombre: 'Superadmin', nivel_jerarquico: 'HIGH' } }, error: null };
    const b = { select: () => b, eq: () => b, single: () => b, then: (res) => res(perfil) };
    return b;
  });
  const app = express();
  app.use(express.json());
  app.use('/api/alertas', require('../alertas/routes/alertas'));
  app.use(errorHandler);
  const server = http.createServer(app).listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ruta}`, {
      headers: conSesion ? { authorization: 'Bearer x' } : {},
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('HTTP GET /api/alertas/proximas: exige sesión, lee tipos/horizonte de la query y valida', async (t) => {
  const { db } = crearBase(t);
  simularPermisos(t);
  simularSuscripciones(t);
  externo(db, { nombre_manual: 'Pepito', apellido_manual: 'Pérez', fecha_fin: dia(400) });
  externo(db, { nombre_manual: 'Vencido', fecha_fin: '2000-01-01' });

  assert.equal((await llamar(t, '/api/alertas/proximas', { conSesion: false })).status, 401);

  const ok = await llamar(t, '/api/alertas/proximas?tipos=externos&horizonte=7');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.horizonte, 7);
  assert.deepEqual(ok.body.tipos, ['externos']);
  assert.deepEqual(ok.body.alertas.map(a => a.severidad), ['vencida']);

  const mal = await llamar(t, '/api/alertas/proximas?horizonte=99');
  assert.equal(mal.status, 400);
});
