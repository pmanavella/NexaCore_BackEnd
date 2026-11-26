// Mosaicos de Protocolos del Dashboard (GET /api/dashboard/protocolos,
// dashboard/services/dashboardProtocolosService.js). Base en memoria y reloj fijo.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const organizacionService = require('../organization/services/organizacionService');
const svc = require('../dashboard/services/dashboardProtocolosService');

// 2026-11-25 12:00 en Argentina (UTC-3)
const AHORA = new Date('2026-11-25T15:00:00Z');
const USER = { id: randomUUID(), role: 'Operativo', hierarchyLevel: 'LOW' };

// ── Supabase en memoria ──────────────────────────────────────────────────────

function crearBase(t) {
  const db = { protocolos: [], protocolo_pruebas: [] };
  const consultas = [];
  t.mock.method(supabase, 'from', (tabla) => {
    const st = { filtros: [], orden: [], limite: null, escrito: false };
    const b = {
      select() { return b; },
      eq(c, v) { st.filtros.push(f => f[c] === v); return b; },
      lt(c, v) { st.filtros.push(f => f[c] != null && f[c] < v); return b; },
      lte(c, v) { st.filtros.push(f => f[c] != null && f[c] <= v); return b; },
      gte(c, v) { st.filtros.push(f => f[c] != null && f[c] >= v); return b; },
      in(c, vs) { st.filtros.push(f => vs.includes(f[c])); return b; },
      order(c, { ascending = true } = {}) { st.orden.push([c, ascending]); return b; },
      limit(n) { st.limite = n; return b; },
      insert() { st.escrito = true; return b; },
      update() { st.escrito = true; return b; },
      delete() { st.escrito = true; return b; },
      then(res, rej) {
        consultas.push({ tabla, escrito: st.escrito });
        let filas = db[tabla].filter(f => st.filtros.every(fn => fn(f))).map(f => ({ ...f }));
        filas.sort((a, b2) => {
          for (const [c, asc] of st.orden) {
            if (a[c] === b2[c]) continue;
            return (a[c] < b2[c] ? -1 : 1) * (asc ? 1 : -1);
          }
          return 0;
        });
        if (st.limite !== null) filas = filas.slice(0, st.limite);
        if (tabla === 'protocolo_pruebas') {
          filas = filas.map(f => {
            const p = db.protocolos.find(x => x.id === f.protocolo_id);
            return { ...f, protocolos: p ? { id: p.id, nombre: p.nombre, categoria: p.categoria } : null };
          });
        }
        return Promise.resolve({ data: filas, error: null }).then(res, rej);
      },
    };
    return b;
  });
  return { db, consultas };
}

function simularAcceso(t, tiene = true) {
  return t.mock.method(organizacionService, 'usuarioTieneAccesoModulo', async (_id, modulo) => modulo === 'protocolos' && tiene);
}

function protocolo(db, datos) {
  const p = { id: randomUUID(), nombre: 'Protocolo', categoria: 'robot', activo: true, ...datos };
  db.protocolos.push(p);
  return p;
}

let seq = 0;
function registro(db, p, fecha, estados, datos = {}) {
  const r = {
    id: randomUUID(), protocolo_id: p.id, fecha, realizado_por: 'Victoria',
    created_at: `${fecha}T12:00:${String(seq++ % 60).padStart(2, '0')}Z`,
    // Formato real: [{ texto, estado: 'ok'|'fail'|'na', item_id, tildado }]
    resultados: estados.map((estado, i) => ({ texto: `Ítem ${i + 1}`, estado, item_id: randomUUID(), tildado: estado === 'ok' })),
    ...datos,
  };
  db.protocolo_pruebas.push(r);
  return r;
}

const obtener = (params = {}) => svc.obtener(USER, params, { ahora: AHORA });

// ── Métricas ─────────────────────────────────────────────────────────────────

test('protocolos activos: total y desglose por categoría (inactivos excluidos)', async (t) => {
  const { db } = crearBase(t);
  simularAcceso(t);
  protocolo(db, { categoria: 'robot' });
  protocolo(db, { categoria: 'robot' });
  protocolo(db, { categoria: 'instalacion' });
  protocolo(db, { categoria: 'hardware' });
  protocolo(db, { categoria: 'rrhh' });
  protocolo(db, { categoria: 'rrhh', activo: false });
  const r = await obtener();
  assert.deepEqual(r.protocolosActivos, { total: 5, porCategoria: { robot: 2, instalacion: 1, hardware: 1, rrhh: 1 } });
});

test('registros en el período: month = mes en curso; 3m = últimos 3 meses calendario contando el actual, con serie mensual', async (t) => {
  const { db } = crearBase(t);
  simularAcceso(t);
  const p = protocolo(db, {});
  registro(db, p, '2026-11-01', ['ok']);
  registro(db, p, '2026-11-25', ['ok']);
  registro(db, p, '2026-10-15', ['fail']);
  registro(db, p, '2026-09-01', ['ok']);
  registro(db, p, '2026-08-31', ['ok']); // fuera de 3m

  const mes = await obtener({ period: 'month' });
  assert.deepEqual(mes.periodo, { period: 'month', desde: '2026-11-01', hasta: '2026-11-30', meses: ['2026-11'] });
  assert.equal(mes.registros.total, 2);

  const tri = await obtener({ period: '3m' });
  assert.deepEqual(tri.periodo, { period: '3m', desde: '2026-09-01', hasta: '2026-11-30', meses: ['2026-09', '2026-10', '2026-11'] });
  assert.equal(tri.registros.total, 4);
  assert.deepEqual(tri.registros.serie, [
    { mes: '2026-09', total: 1, conIncumplimientos: 0 },
    { mes: '2026-10', total: 1, conIncumplimientos: 1 },
    { mes: '2026-11', total: 2, conIncumplimientos: 0 },
  ]);

  const anual = await obtener({ period: '12m' });
  assert.equal(anual.periodo.desde, '2025-12-01');
  assert.equal(anual.registros.serie.length, 12);
});

test('incumplimientos: cuenta registros con algún "fail" (una vez por registro); "ok" y "na" no cuentan; % sobre el total', async (t) => {
  const { db } = crearBase(t);
  simularAcceso(t);
  const p = protocolo(db, {});
  registro(db, p, '2026-11-02', ['ok', 'ok']);
  registro(db, p, '2026-11-03', ['ok', 'na']);
  registro(db, p, '2026-11-04', ['fail', 'fail', 'ok']); // un registro, dos fails
  registro(db, p, '2026-11-05', ['na', 'fail']);
  registro(db, p, '2026-11-06', [], { resultados: null }); // sin resultados: sin incumplimientos
  registro(db, p, '2026-10-30', ['fail']); // fuera del mes

  const r = await obtener({ period: 'month' });
  assert.deepEqual(r.incumplimientos, { registrosConIncumplimientos: 2, totalRegistros: 5, porcentaje: 40 });
});

test('incumplimientos: sin registros en el período el porcentaje es 0 (sin dividir por cero)', async (t) => {
  crearBase(t);
  simularAcceso(t);
  const r = await obtener();
  assert.deepEqual(r.incumplimientos, { registrosConIncumplimientos: 0, totalRegistros: 0, porcentaje: 0 });
});

test('incumplimientos: porcentaje redondeado a un decimal', async (t) => {
  const { db } = crearBase(t);
  simularAcceso(t);
  const p = protocolo(db, {});
  registro(db, p, '2026-11-02', ['fail']);
  registro(db, p, '2026-11-03', ['ok']);
  registro(db, p, '2026-11-04', ['ok']);
  assert.equal((await obtener()).incumplimientos.porcentaje, 33.3);
});

test('últimos registros: los N más recientes (fecha y luego carga), con protocolo, realizado_por y con/sin incumplimientos', async (t) => {
  const { db } = crearBase(t);
  simularAcceso(t);
  const robot = protocolo(db, { nombre: 'Prueba de robot', categoria: 'robot' });
  const inst = protocolo(db, { nombre: 'Instalación', categoria: 'instalacion' });
  registro(db, robot, '2026-01-10', ['ok']);
  const b = registro(db, inst, '2026-11-20', ['ok', 'fail', 'fail'], { realizado_por: 'Juan' });
  const c = registro(db, robot, '2026-11-24', ['ok']);
  const d = registro(db, robot, '2026-11-20', ['na'], { created_at: '2026-11-20T23:00:00Z' });

  const r = await obtener({ limite: '3' });
  assert.deepEqual(r.ultimosRegistros.map(x => x.id), [c.id, d.id, b.id]);
  assert.deepEqual(r.ultimosRegistros[2], {
    id: b.id, protocoloId: inst.id, protocolo: 'Instalación', categoria: 'instalacion',
    fecha: '2026-11-20', realizadoPor: 'Juan', conIncumplimientos: true, itemsFallidos: 2,
  });
  assert.equal(r.ultimosRegistros[0].conIncumplimientos, false);
});

test('protocolos sin registros en los últimos 30 días: activos, primero los nunca registrados, con su último registro', async (t) => {
  const { db } = crearBase(t);
  simularAcceso(t);
  const reciente = protocolo(db, { nombre: 'Reciente' });
  const viejo = protocolo(db, { nombre: 'Viejo', categoria: 'hardware' });
  const nunca = protocolo(db, { nombre: 'Nunca' });
  const borde = protocolo(db, { nombre: 'Borde' });
  protocolo(db, { nombre: 'Inactivo', activo: false });
  registro(db, reciente, '2026-11-10', ['ok']);
  registro(db, viejo, '2026-09-01', ['ok']);
  registro(db, viejo, '2026-08-01', ['ok']);
  registro(db, borde, '2026-10-26', ['ok']); // exactamente hace 30 días: cuenta como reciente

  const r = await obtener();
  assert.equal(r.sinRegistrosRecientes.dias, 30);
  assert.equal(r.sinRegistrosRecientes.desde, '2026-10-26');
  assert.deepEqual(r.sinRegistrosRecientes.protocolos, [
    { id: nunca.id, nombre: 'Nunca', categoria: 'robot', ultimoRegistro: null },
    { id: viejo.id, nombre: 'Viejo', categoria: 'hardware', ultimoRegistro: '2026-09-01' },
  ]);
});

// ── Permisos, parámetros y solo lectura ──────────────────────────────────────

test('permisos: sin acceso al módulo Protocolos → 403 sin consultar datos', async (t) => {
  const { consultas } = crearBase(t);
  simularAcceso(t, false);
  await assert.rejects(obtener(), e => e.status === 403);
  assert.equal(consultas.length, 0);
});

test('parámetros: period y limite inválidos → 400', async (t) => {
  crearBase(t);
  simularAcceso(t);
  await assert.rejects(obtener({ period: '2m' }), e => e.status === 400);
  await assert.rejects(obtener({ limite: '0' }), e => e.status === 400);
  await assert.rejects(obtener({ limite: '51' }), e => e.status === 400);
  await assert.rejects(obtener({ limite: 'x' }), e => e.status === 400);
});

test('solo lectura: nunca escribe', async (t) => {
  const { db, consultas } = crearBase(t);
  simularAcceso(t);
  const p = protocolo(db, {});
  registro(db, p, '2026-11-02', ['fail']);
  await obtener({ period: '6m' });
  assert.ok(consultas.length > 0);
  assert.ok(consultas.every(c => !c.escrito));
});
