// Prueba de esfuerzo sostenido (k6): carga constante y moderada durante un período
// prolongado, para ver si el backend se degrada con el tiempo (memoria, conexiones,
// caché) aunque la carga no cambie.
//
// Compara la latencia del primer 20 % de la prueba con la del último 20 %.
//
// Desde la raíz del repo, con las variables de nexacore-test en el entorno:
//   npm run test:sostenido
// Variables: BASE_URL, SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY, TEST_USER_PASSWORD
// y, opcionales, DURACION (15m por defecto, 3m en la demo) y TASA (3 pet/s).

import exec from 'k6/execution';
import { Trend } from 'k6/metrics';
import {
  iniciarSesiones, hacerPeticion, UMBRALES, RESULTADOS, ENDPOINTS_FINANZAS, ms, pct,
} from './lib/comun.js';

const DURACION = __ENV.DURACION || '15m';
const TASA = Number(__ENV.TASA || 3); // peticiones por segundo

// Degradación: solo con las peticiones del módulo Financiero (sin /api/health).
const latenciaInicio = new Trend('latencia_tramo_inicial', true);
const latenciaFinal = new Trend('latencia_tramo_final', true);

const P95 = `p(95)<${UMBRALES.p95_ms}`;
const P99 = `p(99)<${UMBRALES.p99_ms}`;

// p95 y p99 por endpoint del módulo Financiero: estos umbrales deciden el resultado.
const umbralesPorEndpoint = Object.fromEntries(
  ENDPOINTS_FINANZAS.map((e) => [`http_req_duration{name:${e}}`, [P95, P99]]),
);

export const options = {
  scenarios: {
    sostenido: {
      executor: 'constant-arrival-rate',
      rate: TASA,
      timeUnit: '1s',
      duration: DURACION,
      preAllocatedVUs: 10,
      maxVUs: 30,
    },
  },
  // Estos umbrales sí deciden el resultado: si no se cumplen, k6 termina con error.
  thresholds: {
    ...umbralesPorEndpoint,
    http_req_failed: [`rate<${UMBRALES.errores}`],
    errores_funcionales: [`rate<${UMBRALES.errores}`],
    dropped_iterations: ['count==0'],
    latencia_tramo_inicial: ['p(95)<60000'],
    latencia_tramo_final: ['p(95)<60000'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  setupTimeout: '60s',
};

export function setup() {
  return iniciarSesiones();
}

export default function (datos) {
  const { r, finanzas } = hacerPeticion(datos);
  if (!finanzas) return;
  const avance = exec.scenario.progress;
  if (avance <= 0.2) latenciaInicio.add(r.timings.duration);
  else if (avance >= 0.8) latenciaFinal.add(r.timings.duration);
}

export function handleSummary(data) {
  const m = data.metrics;
  const v = (nombre) => m[nombre]?.values || {};
  const ini = v('latencia_tramo_inicial')['p(95)'];
  const fin = v('latencia_tramo_final')['p(95)'];
  const degradacion = ini && fin ? fin / ini - 1 : undefined;
  const ok = (nombre) => Object.values(m[nombre]?.thresholds || {}).every((t) => t.ok);
  const okUmbral = (nombre, expr) => m[nombre]?.thresholds?.[expr]?.ok === true;

  const porEndpoint = ENDPOINTS_FINANZAS.flatMap((e) => {
    const nombre = `http_req_duration{name:${e}}`;
    const d = v(nombre);
    return [
      [`p95 ${e}`, `< ${UMBRALES.p95_ms} ms`, ms(d['p(95)']), okUmbral(nombre, P95)],
      [`p99 ${e}`, `< ${UMBRALES.p99_ms} ms`, ms(d['p(99)']), okUmbral(nombre, P99)],
    ];
  });

  const criterios = [
    ...porEndpoint,
    ['Respuestas fallidas', `< ${pct(UMBRALES.errores)}`, pct(v('http_req_failed').rate), ok('http_req_failed')],
    ['Errores funcionales', `< ${pct(UMBRALES.errores)}`, pct(v('errores_funcionales').rate), ok('errores_funcionales')],
    ['Iteraciones descartadas', '0', String(v('dropped_iterations').count || 0), ok('dropped_iterations')],
    ['Degradación de Finanzas (p95 final vs. inicial)', `≤ ${pct(UMBRALES.degradacion)}`,
      degradacion === undefined ? '—' : `${degradacion >= 0 ? '+' : ''}${pct(degradacion)} (${ms(ini)} → ${ms(fin)})`,
      degradacion !== undefined && degradacion <= UMBRALES.degradacion],
  ];

  const md = [
    `## Esfuerzo sostenido con k6 (versión \`${String(data.setup_data?.version || '?').slice(0, 7)}\`)`,
    '',
    `${TASA} pet/s durante ${DURACION} · ${v('http_reqs').count || 0} peticiones · usuarios virtuales activos: hasta ${v('usuarios_virtuales_activos').max ?? '—'} (promedio ${v('usuarios_virtuales_activos').avg?.toFixed(1) ?? '—'}).`,
    '',
    '| Criterio | Umbral | Resultado | Cumple |',
    '|---|---|---|---|',
    ...criterios.map(([c, u, r, cumple]) => `| ${c} | ${u} | ${r} | ${cumple ? 'Sí' : '**No**'} |`),
    '',
  ].join('\n');

  return {
    stdout: `${md}\n`,
    [`${RESULTADOS}/sostenido-resumen.md`]: md,
    [`${RESULTADOS}/sostenido.json`]: JSON.stringify(data, null, 2),
  };
}
