// Alertas dinámicas (GET /api/alertas, alertas/services/alertasService.js).
// Base en memoria, reloj fijo (`ahora` inyectado) y permisos simulados con las
// mismas funciones que usan los middlewares de cada módulo.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { randomUUID } = require('node:crypto');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const organizacionService = require('../organization/services/organizacionService');
const errorHandler = require('../middleware/errorHandler');
const alertasService = require('../alertas/services/alertasService');

// 2026-11-02 12:00 en Argentina (UTC-3)
const AHORA = new Date('2026-11-02T15:00:00Z');
const HOY = '2026-11-02';
const dia = (n) => { const d = new Date(`${HOY}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ── Supabase en memoria ──────────────────────────────────────────────────────

function crearBase(t, { fallas = [], lentas = [] } = {}) {
  const db = {
    deudas: [], comprobantes: [], tareas: [], tarea_asignados: [], operativo_tablero_miembros: [], indicadores: [], movimientos: [],
    operativo_etapas: [
      { id: 'e-pend', tipo_base: 'pendiente' }, { id: 'e-curso', tipo_base: 'en_curso' },
      { id: 'e-reva', tipo_base: 'en_revision_abierta' }, { id: 'e-revc', tipo_base: 'en_revision_cerrada' },
      { id: 'e-ok', tipo_base: 'completada' }, { id: 'e-canc', tipo_base: 'cancelada' },
    ],
  };
  const consultas = [];

  t.mock.method(supabase, 'from', (tabla) => {
    const st = { filtros: [], head: false, single: false };
    const b = {
      select(_cols, opts = {}) { st.head = !!opts.head; return b; },
      eq(c, v) { st.filtros.push(f => f[c] === v); return b; },
      neq(c, v) { st.filtros.push(f => f[c] != null && f[c] !== v); return b; },
      lt(c, v) { st.filtros.push(f => f[c] != null && f[c] < v); return b; },
      lte(c, v) { st.filtros.push(f => f[c] != null && f[c] <= v); return b; },
      gte(c, v) { st.filtros.push(f => f[c] != null && f[c] >= v); return b; },
      in(c, vs) { st.filtros.push(f => vs.includes(f[c])); return b; },
      or(expr) {
        assert.equal(expr, 'tipo.is.null,tipo.eq.asignacion');
        st.filtros.push(f => f.tipo == null || f.tipo === 'asignacion');
        return b;
      },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { st.single = true; return b; },
      then(res, rej) {
        consultas.push(tabla);
        if (lentas.includes(tabla)) return new Promise(() => {}).then(res, rej);
        if (fallas.includes(tabla)) return Promise.resolve({ data: null, error: { message: `falla ${tabla}` } }).then(res, rej);
        const filas = db[tabla].filter(f => st.filtros.every(fn => fn(f))).map(f => (tabla === 'tareas'
          ? { ...f, operativo_etapas: db.operativo_etapas.find(e => e.id === f.etapa_id) ?? null }
          : { ...f }));
        const r = st.head ? { data: null, count: filas.length, error: null }
          : st.single ? { data: filas[0] ?? null, error: null }
          : { data: filas, error: null };
        return Promise.resolve(r).then(res, rej);
      },
    };
    return b;
  });

  t.mock.method(supabase, 'rpc', async (nombre, { p_desde, p_hasta }) => {
    assert.equal(nombre, 'indicadores_totales_movimientos');
    consultas.push('rpc');
    if (fallas.includes('rpc')) return { data: null, error: { message: 'falla rpc' } };
    return { data: db.movimientos.filter(m => m.mes >= p_desde && m.mes < p_hasta), error: null };
  });

  return { db, consultas };
}

// Permisos: `finanzas` = permiso particular de Finanzas ('lector' | 'editor' | null),
// `indicadores` = acceso al módulo Indicadores (usuarioTieneAccesoModulo).
function simularPermisos(t, { finanzas = null, indicadores = false, fallaPermisos = false } = {}) {
  t.mock.method(organizacionService, 'obtenerPermisosUsuario', async () => {
    if (fallaPermisos) throw new Error('falla permisos');
    return finanzas ? [{ permiso: finanzas, alcance: 'global', source: 'usuario', modulos: { nombre: 'finance' } }] : [];
  });
  t.mock.method(organizacionService, 'usuarioTieneAccesoModulo', async (_id, modulo) => {
    if (fallaPermisos) throw new Error('falla permisos');
    return modulo === 'indicadores' && indicadores;
  });
}

const usuario = (hierarchyLevel = 'LOW') => ({ id: randomUUID(), name: 'Ana', role: 'Operativo', hierarchyLevel });
const DIRECCION = () => ({ id: randomUUID(), name: 'Dora', role: 'Dirección', hierarchyLevel: 'HIGH' });
const evaluar = (user) => alertasService.evaluar(user, { ahora: AHORA });
const porId = (r) => Object.fromEntries(r.alertas.map(a => [a.id, a]));

// Tarea de `user` en `tablero` (y miembro del tablero), asignada hace `horas`.
function tareaDe(db, user, { tablero = 'tab-1', etapa = 'e-pend', fecha_limite = null, tipo = 'asignacion', asignadaHaceHoras = 72, miembro = true } = {}) {
  const id = randomUUID();
  db.tareas.push({ id, tipo, etapa_id: etapa, fecha_limite, tablero_id: tablero, estado: 'Pendiente' });
  db.tarea_asignados.push({ tarea_id: id, usuario_id: user.id, created_at: new Date(AHORA.getTime() - asignadaHaceHoras * 3600e3).toISOString() });
  if (miembro && tablero && !db.operativo_tablero_miembros.some(m => m.usuario_id === user.id && m.tablero_id === tablero)) {
    db.operativo_tablero_miembros.push({ tablero_id: tablero, usuario_id: user.id });
  }
  return id;
}

// ── Finanzas ─────────────────────────────────────────────────────────────────

test('deudas: vencidas (impagas con vencimiento anterior a hoy) y por vencer (hoy a hoy+3), sin duplicar', async (t) => {
  const { db } = crearBase(t);
  simularPermisos(t, { finanzas: 'lector' });
  db.deudas.push(
    { id: 1, estado: 'Pendiente', vencimiento: dia(-1) },  // vencida
    { id: 2, estado: 'Vencida',   vencimiento: dia(-30) }, // vencida
    { id: 3, estado: 'Pagada',    vencimiento: dia(-5) },  // pagada: no
    { id: 4, estado: 'Pendiente', vencimiento: HOY },      // por vencer (vence hoy)
    { id: 5, estado: 'Pendiente', vencimiento: dia(3) },   // por vencer (límite)
    { id: 6, estado: 'Pendiente', vencimiento: dia(4) },   // fuera de la ventana
    { id: 7, estado: 'Pagada',    vencimiento: dia(1) },   // pagada: no
  );
  const a = porId(await evaluar(usuario()));
  assert.equal(a['finance:deudas:vencidas'].cantidad, 2);
  assert.equal(a['finance:deudas:vencidas'].severidad, 'alta');
  assert.equal(a['finance:deudas:por_vencer'].cantidad, 2);
  assert.deepEqual(a['finance:deudas:vencidas'].destino, { modulo: 'finance', seccion: 'deudas' });
  assert.ok(!JSON.stringify(a).includes('monto'), 'no expone montos');
});

test('deudas: la fecha es la de Argentina (a las 22 h del 2/11 en Argentina, una deuda del 2/11 todavía no venció)', async (t) => {
  const { db } = crearBase(t);
  simularPermisos(t, { finanzas: 'lector' });
  db.deudas.push({ id: 1, estado: 'Pendiente', vencimiento: HOY });
  const r = await alertasService.evaluar(usuario(), { ahora: new Date('2026-11-03T01:00:00Z') });
  assert.equal(porId(r)['finance:deudas:vencidas'], undefined);
  assert.equal(porId(r)['finance:deudas:por_vencer'].cantidad, 1);
});

test('comprobantes: no generan alertas ni se consultan, aunque haya comprobantes en revisión', async (t) => {
  const { db, consultas } = crearBase(t);
  db.comprobantes.push(
    { id: 1, estado_analisis: 'requiere_revision' }, { id: 2, estado_analisis: 'requiere_revision' },
    { id: 3, estado_analisis: 'procesado' }, { id: 4, estado_analisis: 'error' },
  );
  for (const user of [usuario(), DIRECCION()]) {
    simularPermisos(t, { finanzas: 'lector', indicadores: true });
    const r = await evaluar(user);
    assert.ok(!r.alertas.some(a => a.id.includes('comprobantes') || a.destino.seccion === 'comprobantes'));
    assert.ok(!r.fuentes.some(f => f.fuente === 'comprobantes'));
  }
  assert.ok(!consultas.includes('comprobantes'), 'no consulta la tabla comprobantes');
});

test('el endpoint solo puede devolver las siete categorías vigentes', async (t) => {
  const { db } = crearBase(t);
  simularPermisos(t, { finanzas: 'lector', indicadores: true });
  const dir = DIRECCION();
  db.deudas.push({ id: 1, estado: 'Pendiente', vencimiento: dia(-1) }, { id: 2, estado: 'Pendiente', vencimiento: dia(1) });
  db.comprobantes.push({ id: 1, estado_analisis: 'requiere_revision' });
  tareaDe(db, dir, { fecha_limite: dia(-1) });
  tareaDe(db, dir, { fecha_limite: dia(1), asignadaHaceHoras: 1 });
  db.movimientos.push({ mes: '2026-10-01', tipo: 'Ingreso', categoria: 'Servicios', total: 800 });
  indicador(db, { nombre: 'Riesgo', objetivo: 1000, limite: 700 });
  indicador(db, { nombre: 'Crítico', objetivo: 2000, limite: 1500 });

  const r = await evaluar(dir);
  assert.deepEqual(r.alertas.map(a => a.id).sort(), [
    'finance:deudas:por_vencer', 'finance:deudas:vencidas',
    'indicadores:fuera_de_objetivo:critico', 'indicadores:fuera_de_objetivo:en_riesgo',
    'operations:tareas:nuevas_asignaciones', 'operations:tareas:por_vencer', 'operations:tareas:vencidas',
  ]);
  assert.deepEqual(r.fuentes.map(f => f.fuente), ['deudas', 'tareas', 'indicadores']);
});

test('permisos de Finanzas (RN-02): sin permiso particular no hay alertas ni consultas financieras; mando alto sí', async (t) => {
  const { db, consultas } = crearBase(t);
  db.deudas.push({ id: 1, estado: 'Pendiente', vencimiento: dia(-1) });
  db.comprobantes.push({ id: 1, estado_analisis: 'requiere_revision' });

  simularPermisos(t, { finanzas: null }); // rol con Finanzas pero sin permiso particular
  const sinPermiso = await evaluar(usuario());
  assert.equal(sinPermiso.alertas.filter(x => x.modulo === 'finance').length, 0);
  assert.ok(!consultas.includes('deudas'), 'ni siquiera consulta');
  assert.deepEqual(sinPermiso.fuentes.map(f => f.fuente), ['tareas'], 'no informa fuentes sin acceso');

  const dir = await evaluar(DIRECCION());
  assert.deepEqual(dir.alertas.filter(x => x.modulo === 'finance').map(x => x.id), ['finance:deudas:vencidas']);
});

// ── Operativo ────────────────────────────────────────────────────────────────

test('tareas: vencidas y por vencer (hoy o mañana) del usuario, abiertas según tipo_base, sin duplicar', async (t) => {
  const { db } = crearBase(t);
  simularPermisos(t);
  const ana = usuario();
  tareaDe(db, ana, { fecha_limite: dia(-2) });                       // vencida
  tareaDe(db, ana, { etapa: 'e-reva', fecha_limite: dia(-1) });      // vencida (revisión ABIERTA)
  tareaDe(db, ana, { etapa: 'e-revc', fecha_limite: dia(-1) });      // revisión CERRADA: no
  tareaDe(db, ana, { etapa: 'e-ok', fecha_limite: dia(-1) });        // completada: no
  tareaDe(db, ana, { etapa: 'e-canc', fecha_limite: dia(-1) });      // cancelada: no
  tareaDe(db, ana, { etapa: 'e-curso', fecha_limite: HOY });         // por vencer
  tareaDe(db, ana, { fecha_limite: dia(1) });                        // por vencer
  tareaDe(db, ana, { fecha_limite: dia(2) });                        // más de 48 h: no
  tareaDe(db, ana, { fecha_limite: null });                          // sin fecha: no
  tareaDe(db, ana, { tipo: 'propuesta', fecha_limite: dia(-1) });    // propuesta: no
  // Tarea de otra persona en el mismo tablero
  tareaDe(db, usuario(), { fecha_limite: dia(-1) });

  const a = porId(await evaluar(ana));
  assert.equal(a['operations:tareas:vencidas'].cantidad, 2);
  assert.equal(a['operations:tareas:por_vencer'].cantidad, 2);
  assert.deepEqual(a['operations:tareas:vencidas'].destino, { modulo: 'operations', seccion: null });
});

test('tareas: tareas compartidas cuentan para cada responsable; sin acceso al tablero no hay alerta', async (t) => {
  const { db } = crearBase(t);
  simularPermisos(t);
  const ana = usuario(), beto = usuario();
  const compartida = tareaDe(db, ana, { fecha_limite: dia(-1) });
  db.tarea_asignados.push({ tarea_id: compartida, usuario_id: beto.id, created_at: AHORA.toISOString() });
  db.operativo_tablero_miembros.push({ tablero_id: 'tab-1', usuario_id: beto.id });
  // Ana sigue asignada a una tarea de un tablero del que la quitaron
  tareaDe(db, ana, { tablero: 'tab-2', fecha_limite: dia(-1), miembro: false });
  // Tarea sin tablero (backend anterior): solo el mando alto
  tareaDe(db, ana, { tablero: null, fecha_limite: dia(-1) });

  assert.equal(porId(await evaluar(ana))['operations:tareas:vencidas'].cantidad, 1);
  assert.equal(porId(await evaluar(beto))['operations:tareas:vencidas'].cantidad, 1);
});

test('tareas: el mando alto ve sus tareas de cualquier tablero; los roles no cambian qué tareas son "suyas"', async (t) => {
  const { db } = crearBase(t);
  simularPermisos(t);
  const dir = DIRECCION();
  tareaDe(db, dir, { tablero: 'tab-9', fecha_limite: dia(-1), miembro: false });
  tareaDe(db, dir, { tablero: null, fecha_limite: dia(-1) });
  tareaDe(db, usuario(), { fecha_limite: dia(-1) }); // de otro: nunca
  assert.equal(porId(await evaluar(dir))['operations:tareas:vencidas'].cantidad, 2);
  for (const nivel of ['MEDIUM', 'NONE']) {
    const u = usuario(nivel);
    tareaDe(db, u, { fecha_limite: dia(1) });
    assert.equal(porId(await evaluar(u))['operations:tareas:por_vencer'].cantidad, 1, nivel);
  }
});

test('tareas: nuevas asignaciones de las últimas 24 h, solo abiertas', async (t) => {
  const { db } = crearBase(t);
  simularPermisos(t);
  const ana = usuario();
  tareaDe(db, ana, { asignadaHaceHoras: 1 });
  tareaDe(db, ana, { asignadaHaceHoras: 23.9, fecha_limite: dia(-1) }); // nueva y vencida: cuenta en ambas
  tareaDe(db, ana, { asignadaHaceHoras: 24.1 });                       // fuera de la ventana
  tareaDe(db, ana, { asignadaHaceHoras: 2, etapa: 'e-ok' });          // cerrada: no
  const a = porId(await evaluar(ana));
  assert.equal(a['operations:tareas:nuevas_asignaciones'].cantidad, 2);
  assert.equal(a['operations:tareas:nuevas_asignaciones'].severidad, 'info');
  assert.equal(a['operations:tareas:vencidas'].cantidad, 1);
});

// ── Indicadores ──────────────────────────────────────────────────────────────

function indicador(db, { nombre, formula = 'INGRESOS_TOTAL', sentido = 'MAYOR_ES_MEJOR', objetivo, limite, frecuencia = 'MENSUAL', activo = true }) {
  db.indicadores.push({ id: randomUUID(), nombre, formula, sentido, valor_objetivo: objetivo, limite_aceptable: limite, frecuencia, activo });
}

test('indicadores: alerta según objetivo, límite y sentido en el último período cerrado (octubre)', async (t) => {
  const { db } = crearBase(t);
  simularPermisos(t, { finanzas: 'lector', indicadores: true });
  db.movimientos.push(
    { mes: '2026-10-01', tipo: 'Ingreso', categoria: 'Servicios', total: 800 },
    { mes: '2026-10-01', tipo: 'Gasto', categoria: 'Servicios', total: 600 },
    { mes: '2026-11-01', tipo: 'Ingreso', categoria: 'Servicios', total: 1 }, // noviembre en curso: no se evalúa
  );
  indicador(db, { nombre: 'Ingresos OK', objetivo: 700, limite: 500 });                                 // 800 → EN_OBJETIVO
  indicador(db, { nombre: 'Ingresos riesgo', objetivo: 1000, limite: 700 });                            // 800 → EN_RIESGO
  indicador(db, { nombre: 'Ingresos crítico', objetivo: 2000, limite: 1500 });                          // 800 → CRITICO
  indicador(db, { nombre: 'Gastos crítico', formula: 'GASTOS_TOTAL', sentido: 'MENOR_ES_MEJOR', objetivo: 300, limite: 500 }); // 600 → CRITICO
  indicador(db, { nombre: 'Gastos OK', formula: 'GASTOS_TOTAL', sentido: 'MENOR_ES_MEJOR', objetivo: 600, limite: 800 });     // 600 → EN_OBJETIVO
  indicador(db, { nombre: 'Sin valor', formula: 'GASTOS_TOTAL / (INGRESOS_TOTAL - 800)', objetivo: 1, limite: 0 });       // ÷0 → sin estado
  indicador(db, { nombre: 'Inactivo', objetivo: 5000, limite: 4000, activo: false });

  const a = porId(await evaluar(usuario()));
  assert.equal(a['indicadores:fuera_de_objetivo:critico'].cantidad, 2);
  assert.equal(a['indicadores:fuera_de_objetivo:en_riesgo'].cantidad, 1);
  assert.deepEqual(a['indicadores:fuera_de_objetivo:critico'].destino, { modulo: 'indicadores', seccion: null });
});

test('indicadores: sin movimientos en el período cerrado no hay alerta; trimestral usa el trimestre anterior', async (t) => {
  const { db } = crearBase(t);
  simularPermisos(t, { finanzas: 'lector', indicadores: true });
  indicador(db, { nombre: 'Mensual', objetivo: 1000, limite: 500 });                          // octubre sin datos
  indicador(db, { nombre: 'Trimestral', objetivo: 1000, limite: 500, frecuencia: 'TRIMESTRAL' }); // Q3: jul-sep
  db.movimientos.push({ mes: '2026-08-01', tipo: 'Ingreso', categoria: 'Servicios', total: 100 });
  const a = porId(await evaluar(usuario()));
  assert.equal(a['indicadores:fuera_de_objetivo:critico'].cantidad, 1, 'solo el trimestral (Q3 con datos)');
});

test('indicadores: requiere acceso a Indicadores Y consulta de Finanzas (como GET /indicadores/:id/valor)', async (t) => {
  const { db, consultas } = crearBase(t);
  db.movimientos.push({ mes: '2026-10-01', tipo: 'Ingreso', categoria: 'Servicios', total: 1 });
  indicador(db, { nombre: 'Crítico', objetivo: 1000, limite: 500 });

  simularPermisos(t, { finanzas: null, indicadores: true });
  assert.equal((await evaluar(usuario())).alertas.filter(x => x.modulo === 'indicadores').length, 0);
  simularPermisos(t, { finanzas: 'lector', indicadores: false });
  assert.equal((await evaluar(usuario())).alertas.filter(x => x.modulo === 'indicadores').length, 0);
  assert.ok(!consultas.includes('indicadores') && !consultas.includes('rpc'));

  simularPermisos(t, { finanzas: 'lector', indicadores: true });
  assert.equal((await evaluar(usuario())).alertas.filter(x => x.modulo === 'indicadores').length, 1);
});

// ── Respuesta, estabilidad y errores ─────────────────────────────────────────

test('sin alertas: lista vacía, no parcial, con las fuentes evaluadas', async (t) => {
  crearBase(t);
  simularPermisos(t, { finanzas: 'lector', indicadores: true });
  const r = await evaluar(usuario());
  assert.deepEqual(r, {
    alertas: [], total: 0, generado_en: AHORA.toISOString(), parcial: false,
    fuentes: [{ fuente: 'deudas', estado: 'ok' }, { fuente: 'tareas', estado: 'ok' }, { fuente: 'indicadores', estado: 'ok' }],
  });
});

test('las alertas desaparecen al resolverse la condición; ids estables entre evaluaciones; orden por severidad', async (t) => {
  const { db } = crearBase(t);
  simularPermisos(t, { finanzas: 'lector' });
  const ana = usuario();
  db.deudas.push({ id: 1, estado: 'Pendiente', vencimiento: dia(1) }, { id: 2, estado: 'Pendiente', vencimiento: dia(-1) });
  const tarea = tareaDe(db, ana, { fecha_limite: dia(-1) });

  const r1 = await evaluar(ana);
  const r2 = await evaluar(ana);
  assert.deepEqual(r1.alertas.map(a => a.id), r2.alertas.map(a => a.id));
  assert.deepEqual(r1.alertas.map(a => a.severidad), ['alta', 'alta', 'media']);
  assert.equal(new Set(r1.alertas.map(a => a.id)).size, r1.alertas.length, 'sin duplicados');

  // Se paga la deuda vencida y se completa la tarea
  db.deudas.find(d => d.id === 2).estado = 'Pagada';
  db.tareas.find(x => x.id === tarea).etapa_id = 'e-ok';
  const r3 = await evaluar(ana);
  assert.deepEqual(r3.alertas.map(a => a.id), ['finance:deudas:por_vencer']);
});

test('error parcial: si una fuente falla se informa, la respuesta queda parcial y el resto se devuelve', async (t) => {
  const { db } = crearBase(t, { fallas: ['tarea_asignados', 'rpc'] });
  simularPermisos(t, { finanzas: 'lector', indicadores: true });
  t.mock.method(console, 'error', () => {});
  db.deudas.push({ id: 1, estado: 'Pendiente', vencimiento: dia(-1) });
  db.indicadores.push({ id: randomUUID(), nombre: 'X', formula: 'INGRESOS_TOTAL', sentido: 'MAYOR_ES_MEJOR', valor_objetivo: 1, limite_aceptable: 0, frecuencia: 'MENSUAL', activo: true });

  const r = await evaluar(usuario());
  assert.equal(r.parcial, true);
  assert.deepEqual(r.alertas.map(a => a.id), ['finance:deudas:vencidas']);
  assert.deepEqual(r.fuentes, [
    { fuente: 'deudas', estado: 'ok' },
    { fuente: 'tareas', estado: 'error', motivo: 'ERROR' },
    { fuente: 'indicadores', estado: 'error', motivo: 'ERROR' },
  ]);
});

test('una fuente lenta no bloquea la respuesta (TIMEOUT); si no se pueden verificar permisos, no se asume acceso', async (t) => {
  const { db } = crearBase(t, { lentas: ['tarea_asignados'] });
  simularPermisos(t, { finanzas: 'lector' });
  t.mock.method(console, 'error', () => {});
  const plazoOriginal = alertasService.plazoFuenteMs;
  alertasService.plazoFuenteMs = 30;
  t.after(() => { alertasService.plazoFuenteMs = plazoOriginal; });
  db.deudas.push({ id: 1, estado: 'Pendiente', vencimiento: dia(-1) });
  const r = await evaluar(usuario());
  assert.equal(r.parcial, true);
  assert.deepEqual(r.fuentes.find(f => f.fuente === 'tareas'), { fuente: 'tareas', estado: 'error', motivo: 'TIMEOUT' });
  assert.deepEqual(r.alertas.map(a => a.id), ['finance:deudas:vencidas']);

  simularPermisos(t, { fallaPermisos: true });
  const sinPermisos = await evaluar(usuario());
  assert.equal(sinPermisos.alertas.filter(a => a.modulo !== 'operations').length, 0);
  assert.deepEqual(sinPermisos.fuentes.filter(f => f.fuente !== 'tareas').map(f => [f.fuente, f.motivo]),
    [['deudas', 'PERMISOS_NO_VERIFICADOS'], ['indicadores', 'PERMISOS_NO_VERIFICADOS']]);
});

test('rendimiento: conteos de deudas sin traer filas; sin tareas asignadas no consulta tareas; nunca consulta comprobantes', async (t) => {
  const { consultas } = crearBase(t);
  simularPermisos(t, { finanzas: 'lector' });
  await evaluar(usuario());
  assert.deepEqual(consultas.filter(c => c === 'deudas').length, 2);
  assert.ok(!consultas.includes('tareas'));
  assert.ok(!consultas.includes('comprobantes'));
});

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function llamar(t, { conSesion = true } = {}) {
  t.mock.method(supabase.auth, 'getUser', async () => ({ data: { user: { email: 'ana@x' } }, error: null }));
  const fromBase = supabase.from;
  t.mock.method(supabase, 'from', (tabla) => {
    if (tabla !== 'usuarios') return fromBase(tabla);
    const perfil = { data: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nombre: 'Ana', roles: { nombre: 'Operativo', nivel_jerarquico: 'LOW' } }, error: null };
    const b = { select: () => b, eq: () => b, single: () => b, then: (res) => res(perfil) };
    return b;
  });
  const app = express();
  app.use(express.json());
  app.use('/api/alertas', require('../alertas/routes/alertas'));
  app.use(errorHandler);
  const server = http.createServer(app).listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/alertas?usuario_id=otro`, {
      headers: conSesion ? { authorization: 'Bearer x' } : {},
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('HTTP: exige sesión; usa la identidad del token e ignora identificadores del cliente', async (t) => {
  const { db } = crearBase(t);
  simularPermisos(t);
  assert.equal((await llamar(t, { conSesion: false })).status, 401);

  tareaDe(db, { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, { fecha_limite: '2000-01-01' });
  tareaDe(db, { id: 'otro' }, { fecha_limite: '2000-01-01' });
  const r = await llamar(t);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.alertas.map(a => [a.id, a.cantidad]), [['operations:tareas:vencidas', 1]]);
  assert.ok(r.body.generado_en);
});
