// REQ-FIN-05 y REQ-FIN-06 — Liquidación de sueldos en pesos y en dólares.
// Los resultados esperados salen de la regla del requisito, no del código actual:
// varios casos deben fallar mientras el backend no valide cantidades, montos,
// tipo de salario y conversión a pesos.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const supabase = require('../config/supabase');
const salariosRoutes = require('../finance/routes/salarios');
const errorHandler = require('../middleware/errorHandler');

const COTIZACION = { compra: 1000, venta: 1050 };
const USD = { cotizacion_valor: COTIZACION.compra, cotizacion_tipo: 'compra', cotizacion_fecha: '2026-10-15', cotizacion_fuente: 'TEST' };
const SIN_USD = { cotizacion_valor: null, cotizacion_tipo: null, cotizacion_fecha: null, cotizacion_fuente: null };

// Empleados del seed (docs/datos-de-prueba.md) usados por estos casos.
const EMPLEADOS = {
  'E-01': { nombre: 'Empleado', apellido: 'Uno',   tipo_permanencia: 'Planta',   tipo_salario: 'mensual', moneda: 'ARS', monto_base: 800000, ...SIN_USD },
  'E-02': { nombre: 'Empleado', apellido: 'Dos',   tipo_permanencia: 'Temporal', tipo_salario: 'hora',    moneda: 'ARS', monto_base: 5000,   ...SIN_USD },
  'E-03': { nombre: 'Empleado', apellido: 'Tres',  tipo_permanencia: 'Planta',   tipo_salario: 'turno',   moneda: 'ARS', monto_base: 40000,  ...SIN_USD },
  'E-04': { nombre: 'Empleado', apellido: 'Cuatro', tipo_permanencia: 'Temporal', tipo_salario: 'mensual', moneda: 'USD', monto_base: 1000,   ...USD },
  'E-05': { nombre: 'Empleado', apellido: 'Cinco', tipo_permanencia: 'Planta',   tipo_salario: 'hora',    moneda: 'USD', monto_base: 10,     ...USD },
};

const MOVIMIENTO_BASE = { categoria_id: 'cat-sueldo', fecha: '2026-10-15', descripcion: 'TEST sueldo' };
// Movimiento ya registrado en dólares para E-04 (USD 1.000 a 1000 = $1.000.000).
const MOVIMIENTO_USD_E04 = {
  id: 'MS-USD', empleado_id: 'E-04', ...MOVIMIENTO_BASE, monto: 1000000,
  moneda_origen: 'USD', monto_origen: 1000, cotizacion_usada: 1000, monto_ars: 1000000,
};
// Movimiento viejo en dólares de E-01, que hoy cobra en pesos.
const MOVIMIENTO_USD_E01 = {
  id: 'MS-USD-E01', empleado_id: 'E-01', ...MOVIMIENTO_BASE, monto: 1000000,
  moneda_origen: 'USD', monto_origen: 1000, cotizacion_usada: 1000, monto_ars: 1000000,
};
// Movimiento en pesos de E-01 (mensual, ARS).
const MOVIMIENTO_ARS_E01 = {
  id: 'MS-ARS-E01', empleado_id: 'E-01', ...MOVIMIENTO_BASE, monto: 800000,
  moneda_origen: 'ARS', monto_origen: null, cotizacion_usada: null, monto_ars: null,
};
// Movimientos viejos en pesos de E-04, de cuando cobraba en pesos (moneda_origen 'ARS' o nula).
const MOVIMIENTOS_ARS_E04 = [
  { id: 'MS-ARS', empleado_id: 'E-04', ...MOVIMIENTO_BASE, monto: 500000, moneda_origen: 'ARS', monto_origen: null, cotizacion_usada: null, monto_ars: null },
  { id: 'MS-NULA', empleado_id: 'E-04', ...MOVIMIENTO_BASE, monto: 500000, moneda_origen: null, monto_origen: null, cotizacion_usada: null, monto_ars: null },
];
const EMPLEADO_NUEVO = {
  nombre: 'TEST', apellido: 'Alta', tipo_permanencia: 'Planta', fecha_ingreso: '2026-10-01',
  tipo_salario: 'mensual', monto_base: 500000, moneda: 'ARS',
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
const sinIndefinidos = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

// Sesión de un usuario Dirección (mando alto) para aislar la validación de los
// permisos. Simula `empleados` (con E-01 a E-05), `movimientos_salario`,
// `categorias_salariales` y `cotizaciones_dolar`; acepta cualquier inserción o
// actualización y la registra en `base`. En `movimientos_salario` existe
// MOVIMIENTO_USD_E04, MOVIMIENTO_USD_E01, MOVIMIENTO_ARS_E01 y MOVIMIENTOS_ARS_E04
// para los casos de edición.
function simularBase(t) {
  const base = {
    empleados: Object.fromEntries(Object.entries(EMPLEADOS).map(([id, e]) => [id, { id, estado: 'Activo', ...e }])),
    empleadosInsertados: [],
    movimientos: Object.fromEntries(
      [MOVIMIENTO_USD_E04, MOVIMIENTO_USD_E01, MOVIMIENTO_ARS_E01, ...MOVIMIENTOS_ARS_E04].map(m => [m.id, { ...m }]),
    ),
    movimientosInsertados: [],
    movimientosActualizados: [],
  };
  const MODULO_FINANCE = { id: 'mod-fin', nombre: 'finance', label: 'Finanzas' };

  t.mock.method(supabase.auth, 'getUser', async () => ({ data: { user: { email: 'direccion@test' } }, error: null }));
  t.mock.method(supabase, 'from', fakeFrom((st) => {
    const unico = op(st, 'single') || op(st, 'maybeSingle');
    switch (st.table) {
      case 'usuarios':
        return { data: { id: 'u1', nombre: 'Dirección Prueba', rol_id: 'rol-dir', roles: { id: 'rol-dir', nombre: 'Dirección' } }, error: null };
      case 'modulos':
        return unico ? { data: { id: MODULO_FINANCE.id }, error: null } : { data: [MODULO_FINANCE], error: null };
      case 'usuario_modulo_permisos':
        return { data: unico ? null : [], error: null };
      case 'rol_modulo_permisos': {
        const permiso = { modulo_id: MODULO_FINANCE.id, puede_ver: true, puede_editar: true };
        return { data: unico ? permiso : [permiso], error: null };
      }
      case 'cotizaciones_dolar': {
        const fila = { id: 'cot1', fecha: '2026-10-15', fuente: 'TEST', tipo: 'oficial', valor_compra: COTIZACION.compra, valor_venta: COTIZACION.venta };
        return { data: unico ? fila : [fila], error: null };
      }
      case 'categorias_salariales':
        return { data: { id: 'cat-sueldo', nombre: 'Sueldo' }, error: null };
      case 'empleados': {
        if (op(st, 'insert')) {
          const [fila] = op(st, 'insert')[1];
          base.empleadosInsertados.push(fila);
          return { data: { id: `nuevo${base.empleadosInsertados.length}`, ...fila }, error: null };
        }
        const id = filtro(st, 'id');
        if (op(st, 'update')) {
          base.empleados[id] = { ...base.empleados[id], ...sinIndefinidos(op(st, 'update')[1]) };
          return { data: base.empleados[id], error: null };
        }
        if (id) {
          const e = base.empleados[id];
          return e ? { data: e, error: null } : { data: null, error: { message: 'no rows' } };
        }
        return { data: Object.values(base.empleados), error: null };
      }
      case 'movimientos_salario': {
        if (op(st, 'insert')) {
          const [fila] = op(st, 'insert')[1];
          base.movimientosInsertados.push(fila);
          return { data: { id: `ms${base.movimientosInsertados.length}`, ...fila }, error: null };
        }
        const id = filtro(st, 'id');
        if (op(st, 'update')) {
          const cambios = sinIndefinidos(op(st, 'update')[1]);
          base.movimientosActualizados.push({ id, ...cambios });
          base.movimientos[id] = { ...base.movimientos[id], ...cambios };
          return { data: base.movimientos[id], error: null };
        }
        if (id) {
          const m = base.movimientos[id];
          return m ? { data: m, error: null } : { data: null, error: { message: 'no rows' } };
        }
        return { data: [], error: null };
      }
      default:
        throw new Error(`tabla inesperada ${st.table}`);
    }
  }));
  return base;
}

function appSalarios() {
  const app = express();
  app.use(express.json());
  app.use('/api/finance/salarios', salariosRoutes);
  app.use(errorHandler);
  return app;
}

async function llamar(app, metodo, path, body) {
  const server = http.createServer(app).listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/finance/salarios${path}`, {
      method: metodo,
      headers: { authorization: 'Bearer token-de-prueba', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

const detalle = (r) => `HTTP ${r.status}: ${JSON.stringify(r.body.error ?? r.body)}`;
const describir = (obj) => Object.entries(obj).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(', ');

// ── Movimientos salariales: POST /salarios/movimientos ──────────────────────
// montos: lista de resultados aceptados. Un número es el monto que debe
// guardarse en pesos (HTTP 201); RECHAZO es HTTP 400 sin inserción.
const RECHAZO = '400 sin inserción';
// RN-03 (4): el rechazo por diferencia en pesos indica ajustar el monto en dólares.
const MENSAJE_AJUSTE_USD = /ajust.*d[oó]lares/i;

const casosMovimientos = [
  // Mensual: el frontend propone monto_base y envía el monto confirmado.
  { id: 'CP-FIN-05-01', empleado: 'E-01', datos: { monto: 800000 },    montos: [800000] },
  { id: 'CP-FIN-05-02', empleado: 'E-02', datos: { cantidad: 10 },     montos: [50000] },
  { id: 'CP-FIN-05-03', empleado: 'E-03', datos: { cantidad: 3 },      montos: [120000] },
  { id: 'CP-FIN-05-04', empleado: 'E-02', datos: { cantidad: 0 },      montos: [RECHAZO] },
  { id: 'CP-FIN-05-05', empleado: 'E-02', datos: { cantidad: 1 },      montos: [5000] },
  { id: 'CP-FIN-05-06', empleado: 'E-02', datos: { cantidad: -5 },     montos: [RECHAZO] },
  { id: 'CP-FIN-05-07', empleado: 'E-01', datos: { monto: -1000 },     montos: [RECHAZO] },
  { id: 'CP-FIN-05-08', empleado: 'E-02', datos: { cantidad: 'abc' },  montos: [RECHAZO] },
  // Dólares: se acepta rechazar o convertir a pesos; nunca guardar dólares como pesos.
  { id: 'CP-FIN-06-07', empleado: 'E-05', datos: { moneda_origen: 'USD', cantidad: 10 },  montos: [RECHAZO, 100000] },
  { id: 'CP-FIN-06-08', empleado: 'E-04', datos: { moneda_origen: 'USD', monto_ars: 1 }, montos: [RECHAZO, 1000000] },
  // RN-03: los pesos los calcula el backend (dólares × cotización, a 2 decimales);
  // un monto_ars que difiere en más de 1 peso se rechaza pidiendo ajustar los dólares.
  { id: 'CP-FIN-06-11', empleado: 'E-04', datos: { moneda_origen: 'USD', monto_origen: 1000, cotizacion_usada: 1000, monto_ars: 1000000 }, montos: [1000000] },
  { id: 'CP-FIN-06-12', empleado: 'E-05', datos: { moneda_origen: 'USD', cantidad: 10, cotizacion_usada: 1000 }, montos: [100000] },
  { id: 'CP-FIN-06-13', empleado: 'E-05', datos: { moneda_origen: 'USD', cantidad: 1, cotizacion_usada: 1052.37, monto_ars: 10524 }, montos: [10523.70] },
  { id: 'CP-FIN-06-13', empleado: 'E-05', datos: { moneda_origen: 'USD', cantidad: 1, cotizacion_usada: 1052.37, monto_ars: 10525.50 }, montos: [RECHAZO], mensaje: MENSAJE_AJUSTE_USD },
  // moneda_origen 'USD' para un empleado que cobra en pesos: moneda inconsistente.
  { id: 'CP-FIN-06-16', empleado: 'E-01', datos: { moneda_origen: 'USD', monto: 800000, cotizacion_usada: 1000 }, montos: [RECHAZO], mensaje: /moneda inconsistente/i },
];

const textoResultado = (m) => (m === RECHAZO ? m : `guarda ${m} en pesos`);

for (const c of casosMovimientos) {
  test(`${c.id} POST /salarios/movimientos ${c.empleado} ${describir(c.datos) || 'sin cantidad'} → ${c.montos.map(textoResultado).join(' o ')}`, async (t) => {
    // Arrange
    const base = simularBase(t);
    const body = { ...MOVIMIENTO_BASE, empleado_id: c.empleado, ...c.datos };

    // Act
    const r = await llamar(appSalarios(), 'POST', '/movimientos', body);

    // Assert
    const insertados = base.movimientosInsertados;
    let obtenido;
    if (r.status === 400) obtenido = insertados.length === 0 ? RECHAZO : `HTTP 400 pero con ${insertados.length} inserción(es)`;
    else if (r.status === 201 && insertados.length === 1) obtenido = insertados[0].monto;
    else obtenido = `${detalle(r)} (${insertados.length} inserciones)`;
    assert.ok(
      c.montos.includes(obtenido),
      `se esperaba ${c.montos.map(textoResultado).join(' o ')}; se obtuvo ${typeof obtenido === 'number' ? textoResultado(obtenido) : obtenido}`,
    );
    if (c.mensaje) assert.match(String(r.body.error), c.mensaje);
  });
}

// ── Edición de movimientos salariales: PUT /salarios/movimientos/:id ────────

// mensaje: lo que debe indicar el error de la respuesta 400.
const casosEdicionMovimientos = [
  { id: 'CP-FIN-06-14', movimiento: MOVIMIENTO_USD_E04.id, datos: { moneda_origen: 'USD', monto_origen: 1000, cotizacion_usada: 1000, monto_ars: 1 }, mensaje: MENSAJE_AJUSTE_USD },
  { id: 'CP-FIN-05-13', movimiento: MOVIMIENTO_ARS_E01.id, datos: { monto: -1000 }, mensaje: /monto debe ser mayor a 0/i },
];

for (const c of casosEdicionMovimientos) {
  test(`${c.id} PUT /salarios/movimientos/${c.movimiento} con ${describir(c.datos)} → 400 y el movimiento no cambia`, async (t) => {
    // Arrange
    const base = simularBase(t);
    const original = { ...base.movimientos[c.movimiento] };
    const { id: _, ...actual } = original;
    const body = { ...actual, ...c.datos };

    // Act
    const r = await llamar(appSalarios(), 'PUT', `/movimientos/${c.movimiento}`, body);

    // Assert
    assert.equal(r.status, 400, `se esperaba HTTP 400; se obtuvo ${detalle(r)}`);
    assert.match(String(r.body.error), c.mensaje);
    assert.equal(base.movimientosActualizados.length, 0, 'no debe actualizarse el movimiento');
    assert.deepEqual(base.movimientos[c.movimiento], original);
  });
}

// En la edición manda la moneda del movimiento guardado: un movimiento viejo en
// pesos se edita como pesos aunque el empleado hoy cobre en dólares.
const casosEdicionMovimientosPesos = MOVIMIENTOS_ARS_E04.map(m => (
  { id: 'CP-FIN-06-15', movimiento: m.id, monedaGuardada: m.moneda_origen, datos: { monto: 600000 } }
));

for (const c of casosEdicionMovimientosPesos) {
  test(`${c.id} PUT /salarios/movimientos/${c.movimiento} (guardado en moneda ${JSON.stringify(c.monedaGuardada)}, empleado hoy en USD) con ${describir(c.datos)} sin cotización → 200 y guarda ${c.datos.monto} en pesos`, async (t) => {
    // Arrange
    const base = simularBase(t);
    const { id: _, ...actual } = base.movimientos[c.movimiento];
    const body = { ...actual, ...c.datos };

    // Act
    const r = await llamar(appSalarios(), 'PUT', `/movimientos/${c.movimiento}`, body);

    // Assert
    assert.equal(r.status, 200, `se esperaba HTTP 200; se obtuvo ${detalle(r)}`);
    const guardado = base.movimientos[c.movimiento];
    assert.equal(guardado.monto, c.datos.monto);
    assert.equal(guardado.moneda_origen, c.monedaGuardada, 'la moneda del movimiento no debe cambiar');
    assert.equal(guardado.cotizacion_usada, null);
  });
}

// Un movimiento guardado en dólares se edita con sus propios montos, aunque el
// empleado hoy cobre en pesos; su moneda no se puede cambiar.
const EDICION_FRONTEND_USD_E01 = {
  empleado_id: MOVIMIENTO_USD_E01.empleado_id, categoria_id: MOVIMIENTO_USD_E01.categoria_id,
  fecha: MOVIMIENTO_USD_E01.fecha, descripcion: 'TEST sueldo editado', monto: 1000000,
};

test(`CP-FIN-06-17 PUT /salarios/movimientos/${MOVIMIENTO_USD_E01.id} (guardado en USD, empleado hoy en ARS) con solo descripción y monto 1000000 → 200 y conserva los montos en dólares`, async (t) => {
  // Arrange
  const base = simularBase(t);

  // Act
  const r = await llamar(appSalarios(), 'PUT', `/movimientos/${MOVIMIENTO_USD_E01.id}`, EDICION_FRONTEND_USD_E01);

  // Assert
  assert.equal(r.status, 200, `se esperaba HTTP 200; se obtuvo ${detalle(r)}`);
  const guardado = base.movimientos[MOVIMIENTO_USD_E01.id];
  assert.equal(guardado.descripcion, EDICION_FRONTEND_USD_E01.descripcion);
  assert.equal(guardado.moneda_origen, 'USD');
  assert.equal(guardado.monto_origen, 1000);
  assert.equal(guardado.cotizacion_usada, 1000);
  assert.equal(guardado.monto, 1000000);
});

test(`CP-FIN-06-17 PUT /salarios/movimientos/${MOVIMIENTO_USD_E01.id} (guardado en USD) con moneda_origen "ARS" → 400 y el movimiento no cambia`, async (t) => {
  // Arrange
  const base = simularBase(t);
  const original = { ...base.movimientos[MOVIMIENTO_USD_E01.id] };

  // Act
  const r = await llamar(appSalarios(), 'PUT', `/movimientos/${MOVIMIENTO_USD_E01.id}`, { ...EDICION_FRONTEND_USD_E01, moneda_origen: 'ARS' });

  // Assert
  assert.equal(r.status, 400, `se esperaba HTTP 400; se obtuvo ${detalle(r)}`);
  assert.match(String(r.body.error), /no se puede cambiar la moneda/i);
  assert.equal(base.movimientosActualizados.length, 0, 'no debe actualizarse el movimiento');
  assert.deepEqual(base.movimientos[MOVIMIENTO_USD_E01.id], original);
});

// ── Alta de empleados: POST /salarios/empleados ─────────────────────────────

const casosAlta = [
  { id: 'CP-FIN-05-09', datos: { tipo_salario: 'semanal' } },
  { id: 'CP-FIN-06-09', datos: { moneda: 'USD', monto_base: 1000, cotizacion_valor: 1000, cotizacion_fecha: '2026-10-15', cotizacion_fuente: 'TEST' } },
];

for (const c of casosAlta) {
  test(`${c.id} POST /salarios/empleados con ${describir(c.datos)} → 400 sin empleado nuevo`, async (t) => {
    // Arrange
    const base = simularBase(t);
    const body = { ...EMPLEADO_NUEVO, ...c.datos };

    // Act
    const r = await llamar(appSalarios(), 'POST', '/empleados', body);

    // Assert
    assert.equal(r.status, 400, `se esperaba HTTP 400; se obtuvo ${detalle(r)}`);
    assert.equal(base.empleadosInsertados.length, 0, 'no debe crearse ningún empleado');
  });
}

// ── Edición de empleados: PUT /salarios/empleados/:id ───────────────────────

const casosEdicion = [
  { id: 'CP-FIN-05-10', empleado: 'E-02', datos: { apellido: 'Apellido Nuevo' }, conserva: { tipo_salario: 'hora' } },
];

for (const c of casosEdicion) {
  test(`${c.id} PUT /salarios/empleados/${c.empleado} con solo ${describir(c.datos)} → conserva ${describir(c.conserva)}`, async (t) => {
    // Arrange
    const base = simularBase(t);

    // Act
    const r = await llamar(appSalarios(), 'PUT', `/empleados/${c.empleado}`, c.datos);

    // Assert
    assert.equal(r.status, 200, `se esperaba HTTP 200; se obtuvo ${detalle(r)}`);
    const guardado = base.empleados[c.empleado];
    for (const [campo, valor] of Object.entries(c.datos)) assert.equal(guardado[campo], valor);
    for (const [campo, valor] of Object.entries(c.conserva)) {
      assert.equal(guardado[campo], valor, `${campo} debe seguir en ${JSON.stringify(valor)}; quedó ${JSON.stringify(guardado[campo])}`);
    }
  });
}
