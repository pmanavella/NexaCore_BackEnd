// Prueba de stress (k6): carga creciente por escalones hasta encontrar el punto en que
// el backend deja de cumplir los umbrales.
//
// Cada escalón es un escenario con una tasa fija de peticiones por segundo. Así cada
// escalón tiene sus propias métricas y el resumen muestra en cuál se rompe el sistema.
// Si el sistema no llega a atender la tasa pedida, k6 lo registra como iteraciones
// descartadas (dropped_iterations): también es una señal de saturación.
//
// Desde la raíz del repo, con las variables de nexacore-test en el entorno:
//   npm run test:stress
// Variables: BASE_URL, SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY, TEST_USER_PASSWORD
// y, opcional, ESCALON_S (segundos por escalón: 90 por defecto, 30 en la demo).

import {
  iniciarSesiones, hacerPeticion, UMBRALES, RESULTADOS, ENDPOINTS_FINANZAS, ms, pct,
} from './lib/comun.js';

// Escalones en peticiones por segundo. Tope en 30/s por los límites del plan gratuito
// de Supabase (matriz de riesgos, R-20): cada petición autenticada hace 3 consultas.
const ESCALONES = [2, 5, 10, 20, 30];
const DURACION_S = Number(__ENV.ESCALON_S || 90); // segundos por escalón
const PAUSA_S = 10;

const scenarios = {};
const thresholds = {
  // Corte de seguridad: si falla más del 10 % se aborta para no castigar nexacore-test.
  http_req_failed: [{ threshold: 'rate<0.10', abortOnFail: true, delayAbortEval: '30s' }],
};

ESCALONES.forEach((tasa, i) => {
  const nombre = `escalon_${String(tasa).padStart(2, '0')}rps`;
  scenarios[nombre] = {
    executor: 'constant-arrival-rate',
    rate: tasa,
    timeUnit: '1s',
    duration: `${DURACION_S}s`,
    startTime: `${i * (DURACION_S + PAUSA_S)}s`,
    preAllocatedVUs: Math.max(5, tasa * 2),
    maxVUs: Math.max(20, tasa * 6),
    gracefulStop: '30s',
  };
  // Umbrales amplios por escalón: no hacen fallar la prueba, solo crean las métricas
  // por escalón que el resumen compara contra UMBRALES.
  ENDPOINTS_FINANZAS.forEach((endpoint) => {
    thresholds[`http_req_duration{scenario:${nombre},name:${endpoint}}`] = ['p(95)<60000'];
  });
  thresholds[`http_req_failed{scenario:${nombre}}`] = ['rate<=1'];
  thresholds[`dropped_iterations{scenario:${nombre}}`] = ['count>=0'];
  thresholds[`usuarios_virtuales_activos{scenario:${nombre}}`] = ['max>=0'];
});

export const options = {
  scenarios,
  thresholds,
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  setupTimeout: '60s',
};

export function setup() {
  return iniciarSesiones();
}

export default function (datos) {
  hacerPeticion(datos);
}

export function handleSummary(data) {
  const m = data.metrics;
  const filas = ESCALONES.map((tasa) => {
    const esc = `escalon_${String(tasa).padStart(2, '0')}rps`;
    // p95 de cada endpoint del módulo Financiero en este escalón.
    const p95s = ENDPOINTS_FINANZAS.map(
      (e) => m[`http_req_duration{scenario:${esc},name:${e}}`]?.values?.['p(95)'],
    );
    const fal = m[`http_req_failed{scenario:${esc}}`]?.values || {};
    const drop = m[`dropped_iterations{scenario:${esc}}`]?.values?.count || 0;
    const vus = m[`usuarios_virtuales_activos{scenario:${esc}}`]?.values?.max;
    const ejecutado = p95s.some((v) => v !== undefined);
    // Cumple si TODOS los endpoints de Finanzas están bajo el umbral.
    const cumple = ejecutado
      && p95s.every((v) => v !== undefined && v < UMBRALES.p95_ms)
      && (fal.rate ?? 1) < UMBRALES.errores
      && drop === 0;
    return { tasa, p95s, errores: fal.rate, drop, vus, ejecutado, cumple };
  });

  const ejecutados = filas.filter((f) => f.ejecutado);
  const ultimoQueCumple = [...ejecutados].reverse().find((f) => f.cumple);
  const primeroQueFalla = ejecutados.find((f) => !f.cumple);

  const lineas = [
    `## Stress con k6 (versión \`${String(data.setup_data?.version || '?').slice(0, 7)}\`)`,
    '',
    `Umbrales fijados antes de ejecutar: p95 < ${UMBRALES.p95_ms} ms en cada endpoint del módulo Financiero, errores < ${pct(UMBRALES.errores)}, sin iteraciones descartadas. Escalones de ${DURACION_S} s.`,
    '',
    `| Escalón | Usuarios virtuales (máx.) | ${ENDPOINTS_FINANZAS.map((e) => `p95 ${e}`).join(' | ')} | Errores | Descartadas | Cumple |`,
    `|---|---|${ENDPOINTS_FINANZAS.map(() => '---').join('|')}|---|---|---|`,
    ...filas.map((f) => `| ${f.tasa} pet/s | ${f.vus ?? '—'} | ${f.p95s.map(ms).join(' | ')} | ${pct(f.errores)} | ${f.drop} | ${!f.ejecutado ? 'no se ejecutó' : f.cumple ? 'Sí' : '**No**'} |`),
    '',
    `**Capacidad dentro de los umbrales:** ${ultimoQueCumple ? `${ultimoQueCumple.tasa} pet/s` : 'ningún escalón cumple'}.`,
    `**Primer escalón fuera de los umbrales:** ${primeroQueFalla ? `${primeroQueFalla.tasa} pet/s` : 'ninguno (el sistema soportó el tope probado)'}.`,
    '',
  ];

  const md = lineas.join('\n');
  return {
    stdout: `${md}\n`,
    [`${RESULTADOS}/stress-resumen.md`]: md,
    [`${RESULTADOS}/stress.json`]: JSON.stringify(data, null, 2),
  };
}
