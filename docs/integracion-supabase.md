# Integración externa: Supabase

**Responsable:** Valentina · **Versión:** 1.0 · **Consigna:** "Documentación de la integración externa (MCP o plataforma)".

**Resultado:** el módulo Financiero depende de Supabase para la autenticación, la base de datos y el almacenamiento de comprobantes. La integración se prueba contra una base real y aislada (nexacore-test) en cada pull request: 13 pruebas de integración y 4 de smoke posteriores al despliegue, que detectaron y verifican la corrección de DEF-018.

---

## 1. Contrato: qué usa el backend de Supabase

| Servicio | Uso en el módulo Financiero | Cómo lo llama el backend |
|---|---|---|
| **Auth** | Cada petición a `/api/finance/*` valida el token del usuario | `middleware/` (`authenticate`): `supabase.auth.getUser(token)`; si no es válido, 401 |
| **Base de datos (PostgreSQL)** | Perfiles, roles y permisos (RN-02); movimientos, sueldos, suscripciones, comprobantes, importaciones | Cliente `@supabase/supabase-js` con la clave de servicio, desde los servicios de `finance/` |
| **Storage** | Comprobantes en un bucket privado, con URL firmada para verlos | Servicio de comprobantes |
| **Políticas RLS** | Bloquean el acceso directo con la clave pública (anon) | Migración `database/migrations/2026-10-22_quitar_acceso_anon.sql` (DEF-018) |

Cada petición autenticada hace, como mínimo, tres llamadas a Supabase: validar el token, leer el perfil y leer los datos pedidos. Por eso la carga de las pruebas de rendimiento está acotada (riesgo R-20).

**Variables que necesita el backend:** `SUPABASE_URL` y `SUPABASE_SERVICE_KEY`. El frontend usa la URL y la clave pública (anon), que después de DEF-018 solo sirve para iniciar sesión.

## 2. Ambiente de pruebas: nexacore-test

| Ambiente | Proyecto de Supabase | Uso permitido |
|---|---|---|
| Producción | nexacore_db | Datos reales del cliente. Nunca se ejecutan pruebas, cargas ni seeds |
| Desarrollo | Developer | Trabajo diario del equipo. No se usa para las pruebas del trabajo |
| **Pruebas** | **nexacore-test** (sa-east-1) | Todas las pruebas que tocan una base real: integración, smoke y carga |

- **Esquema:** copia del de Developer, en `supabase/test/schema.sql` (tablas, restricciones, políticas RLS, funciones y triggers), sin datos.
- **Datos:** solo ficticios, definidos en `docs/datos-de-prueba.md` y sembrados con `scripts/test-db/seed.js`. Los usuarios de prueba cubren los roles y permisos de la tabla de decisión (por ejemplo, U-02 Dirección y U-10 Contable con permiso manual de editor).
- **Reinicio:** `npm run test:db:reset` vacía y vuelve a sembrar, para que cada ejecución parta del mismo estado.
- **Cambios de esquema:** cada migración de `database/migrations/` se aplica a mano en cada base (nexacore-test, Developer y producción).

## 3. Credenciales

- **En GitHub:** solo como secretos del repositorio: `SUPABASE_TEST_URL`, `SUPABASE_TEST_SERVICE_ROLE_KEY`, `SUPABASE_TEST_ANON_KEY` y `TEST_USER_PASSWORD`. Los workflows los pasan como variables de entorno; nunca aparecen en el código ni en los logs.
- **En local:** en `.env.test`, que no se versiona (`.gitignore`).
- **Protección contra errores de destino:** las pruebas de carga (`k6/lib/comun.js`) verifican que la URL sea la de nexacore-test y se abortan si no. El job de despliegue del pipeline arma la instancia solo con los secretos de nexacore-test.
- Las credenciales de Developer y de producción no se usan en ninguna prueba.

## 4. Tratamiento de respuestas

| Situación | Respuesta actual del backend | Estado |
|---|---|---|
| Token ausente o inválido | 401 | Correcto (lo verifica el smoke) |
| Usuario sin permiso en Finanzas | 403 | Correcto (433 pruebas de permisos) |
| Supabase no responde, en `/api/health` | 503, sin detalles del error | **Corregido** (H-37, PR #47) |
| Supabase falla en una operación del módulo | 500 con el mensaje técnico; nunca 503 | Pendiente (H-38) |
| Supabase Auth caído | 401 "Token inválido o expirado", igual que un token inválido | Pendiente (H-39) |
| Petición colgada | Sin timeout en el cliente de Supabase ni en Express | Pendiente (H-40) |

El plan de contingencia (`docs/plan-contingencia.md`) describe la respuesta esperada para cada escenario de caída. De sus pruebas (CP-FIN-18-01 a 18-12), al 25/10 se ejecutó CP-FIN-18-01 (detección de la caída por el health); las demás quedan pendientes.

## 5. Cómo se prueba la integración

| Prueba | Qué verifica | Dónde corre | Comando |
|---|---|---|---|
| Integración (13) | Acceso con la clave pública (DEF-018), API contra datos sembrados | Pipeline, job "Integración con Supabase" | `npm run test:integracion` |
| Smoke (4) | Health con la base conectada, versión desplegada, 401 sin token, inicio de sesión y lectura de movimientos | Pipeline, job "Despliegue de prueba y smoke" | `npm run test:smoke` |
| Carga (k6) | Latencia y errores bajo carga, solo lectura | Workflow "Rendimiento", con etiqueta | `npm run test:stress`, `npm run test:sostenido` |

**Defecto detectado:** DEF-018 (#39, crítico). Con la clave pública se podían leer usuarios, roles, permisos, empleados y sueldos, y crear un permiso de editor en Finanzas sin iniciar sesión. Ninguna prueba con Supabase simulado podía verlo: apareció recién al probar contra una base real. Corregido en nexacore-test y en Developer; producción, según la sección 9.2 del informe.
