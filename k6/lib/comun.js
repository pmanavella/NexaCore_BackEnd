// Configuración compartida de las pruebas de rendimiento con k6.
//
// Solo se ejecutan contra una instancia del backend apuntada a nexacore-test
// (plan de pruebas, sección 4: prohibido cargar desarrollo o producción).
// Son de solo lectura: no crean ni modifican datos, así no alteran el seed.

import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { Rate, Trend } from 'k6/metrics';

// Los reportes se guardan en k6/resultados/ (se corre desde la raíz del repo).
export const RESULTADOS = (__ENV.RESULTADOS_DIR || 'k6/resultados').replace(/\/+$/, '');

// Concurrencia: usuarios virtuales activos en el momento de cada petición.
export const concurrencia = new Trend('usuarios_virtuales_activos');

// Proyecto de Supabase de nexacore-test. Si la URL no es esta, la prueba se aborta.
const PROYECTO_TEST = 'zngtrxgarjkvczalzvbd';

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
const SUPABASE_URL = (__ENV.SUPABASE_TEST_URL || '').replace(/\/+$/, '');
const ANON_KEY = __ENV.SUPABASE_TEST_ANON_KEY;
const PASSWORD = __ENV.TEST_USER_PASSWORD;

// Umbrales fijados ANTES de ejecutar (plan de pruebas, criterio de salida 7).
// Referencia: el smoke del PR #47 midió ~290 ms en /api/health desde GitHub Actions.
export const UMBRALES = {
  p95_ms: 1500,       // 95 % de las respuestas en menos de 1,5 s
  p99_ms: 3000,       // 99 % en menos de 3 s
  errores: 0.01,      // menos del 1 % de respuestas fallidas
  degradacion: 0.25,  // en esfuerzo sostenido, el p95 final no supera en más de 25 % al inicial
};

export const erroresFuncionales = new Rate('errores_funcionales');

// Usuarios del seed (docs/datos-de-prueba.md): Dirección (U-02) y Contable con permiso
// de editor en Finanzas (U-10). Los dos tienen acceso a todas las rutas de la mezcla.
const USUARIOS = ['test.direccion@nexacore.test', 'test.contable.editor@nexacore.test'];

// Mezcla de lecturas del módulo Financiero, con su peso relativo.
const PETICIONES = [
  { nombre: 'GET /api/health', ruta: '/api/health', peso: 1, auth: false },
  { nombre: 'GET /movimientos', ruta: '/api/finance/movimientos', peso: 5, auth: true },
  { nombre: 'GET /movimientos/metricas', ruta: '/api/finance/movimientos/metricas', peso: 2, auth: true },
  { nombre: 'GET /movimientos/flujo', ruta: '/api/finance/movimientos/flujo', peso: 2, auth: true },
];
const PESO_TOTAL = PETICIONES.reduce((s, p) => s + p.peso, 0);

// Los umbrales de latencia se evalúan por endpoint del módulo Financiero.
// /api/health queda fuera del criterio: es rápido y taparía a un endpoint lento.
export const ENDPOINTS_FINANZAS = PETICIONES.filter((p) => p.auth).map((p) => p.nombre);

function verificarDestino() {
  if (!SUPABASE_URL.includes(PROYECTO_TEST)) {
    throw new Error('SUPABASE_TEST_URL no es nexacore-test: se aborta la prueba de carga.');
  }
  if (!ANON_KEY || !PASSWORD) {
    throw new Error('Faltan SUPABASE_TEST_ANON_KEY o TEST_USER_PASSWORD.');
  }
}

// Una sola sesión por usuario para toda la prueba: así la carga mide al backend y
// no los límites de inicio de sesión de Supabase Auth.
export function iniciarSesiones() {
  verificarDestino();

  const salud = http.get(`${BASE_URL}/api/health`);
  if (salud.status !== 200) {
    throw new Error(`La instancia no está sana antes de empezar (HTTP ${salud.status}).`);
  }

  const tokens = USUARIOS.map((email) => {
    const r = http.post(
      `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
      JSON.stringify({ email, password: PASSWORD }),
      { headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' }, tags: { name: 'login (setup)' } },
    );
    const token = r.json('access_token');
    if (!token) throw new Error(`No se pudo iniciar sesión con ${email} (HTTP ${r.status}).`);
    return token;
  });

  return { tokens, version: salud.json('version') };
}

function elegirPeticion() {
  let n = Math.random() * PESO_TOTAL;
  for (const p of PETICIONES) {
    n -= p.peso;
    if (n < 0) return p;
  }
  return PETICIONES[0];
}

// Una iteración = una petición de la mezcla. Devuelve la respuesta y si la ruta es
// del módulo Financiero, para las métricas propias de cada script.
export function hacerPeticion(datos) {
  const p = elegirPeticion();
  const token = datos.tokens[Math.floor(Math.random() * datos.tokens.length)];
  const params = {
    headers: p.auth ? { Authorization: `Bearer ${token}` } : {},
    tags: { name: p.nombre },
    timeout: '30s', // plan de contingencia, E3: 30 s como máximo
  };

  const r = http.get(`${BASE_URL}${p.ruta}`, params);
  const ok = check(r, {
    'responde 200': (res) => res.status === 200,
    'devuelve JSON': (res) => (res.headers['Content-Type'] || '').includes('application/json'),
  });
  erroresFuncionales.add(!ok);
  concurrencia.add(exec.instance.vusActive);
  return { r, finanzas: p.auth };
}

export function ms(valor) {
  return valor === undefined || valor === null ? '—' : `${Math.round(valor)} ms`;
}

export function pct(valor) {
  return valor === undefined || valor === null ? '—' : `${(valor * 100).toFixed(2)} %`;
}
