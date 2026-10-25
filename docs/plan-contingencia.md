# Plan de contingencia ante la indisponibilidad de Supabase

**NexaCore · Módulo Financiero · TP Integrador de Calidad de Software**
Versión 1.0 · 18 de octubre de 2026 · Responsable: Pilar · Verificación: Valentina
Riesgo asociado: R-10 · Requisito: REQ-FIN-18 · Característica ISO/IEC 25010: fiabilidad (tolerancia a fallos y capacidad de recuperación)

## 1. Objetivo y alcance

Definir cómo se detecta, se maneja, se comunica y se recupera una indisponibilidad de Supabase (base de datos, autenticación y almacenamiento de archivos) sin perder ni duplicar información financiera, y cómo se verifica que el sistema funciona correctamente después.

El plan tiene tres partes:
- **Comportamiento esperado** del sistema ante cada escenario (secciones 3 y 4): es el criterio contra el que se prueba.
- **Procedimiento del equipo** con el sistema tal como está hoy (secciones 5 a 8): cómo actuar mientras las brechas no estén resueltas.
- **Pruebas que verifican el plan** (sección 9): para que quede comprobado y no solo escrito.

## 2. Diagnóstico del sistema actual (18/10/2026)

Relevado del código de ambos repositorios. Cada brecha queda registrada como hallazgo en `docs/hallazgos.md`.

| Aspecto | Comportamiento actual | Hallazgo |
|---|---|---|
| Detección | `GET /api/health` siempre responde 200 sin consultar Supabase; no hay `HEALTHCHECK` en el Dockerfile; los logs son solo de consola, sin ruta, usuario ni hora | H-37, H-44 |
| Errores de la API | Una falla de Supabase llega al cliente como HTTP 500 con el mensaje técnico de la librería (o con el HTML de la página de error); nunca 503. Un batch de migración inexistente y una caída se informan igual (404) | H-38 |
| Autenticación | Si cae Supabase Auth, el middleware responde 401 "Token inválido o expirado", igual que con un token realmente inválido | H-39 |
| Tiempos de espera | Sin timeouts en el cliente de Supabase, en Express ni en las llamadas del frontend: una petición puede quedar colgada varios minutos | H-40 |
| Operaciones de varios pasos | Sin transacciones: una caída a mitad de camino deja archivos huérfanos, comprobantes procesados sin movimiento, batches de migración trabados en "procesando" (no revertibles desde la API) e importaciones de Excel parciales sin forma de revertir | H-41 |
| Interfaz | Ante un error, las listas muestran "No hay … registradas", sin aviso ni botón de reintento; los mensajes de error son técnicos (`Failed to fetch`) | H-42 |
| Inicio de sesión | Una caída se informa como "Email o contraseña incorrectos"; pueden quedar sesiones a medias | H-43 |
| Gasto con suscripción nueva | Se crea primero la suscripción y después el movimiento; si falla el segundo paso, reintentar duplica la suscripción | H-45 |
| Recuperación | El backend se recupera solo cuando Supabase vuelve, sin reiniciar: el cliente no mantiene conexiones persistentes | — |
| Reintentos | La librería reintenta hasta 3 veces solo las lecturas (unos 7 s en total); las escrituras no se reintentan | — |

## 3. Escenarios

| ID | Escenario | Cómo se manifiesta |
|---|---|---|
| E1 | Caída total de Supabase | Ninguna consulta, inicio de sesión ni archivo funciona |
| E2 | Autenticación disponible, base de datos no | Los usuarios inician sesión, pero las consultas fallan |
| E3 | Supabase lento (responde, pero tarda) | Pantallas que quedan cargando; peticiones colgadas |
| E4 | Caída durante una operación de varios pasos | Importación, migración o alta de comprobante a medio hacer |
| E5 | Caída durante un proceso programado | Falla la limpieza nocturna de comprobantes (02:00) |

## 4. Comportamiento esperado del sistema

Este es el criterio que verifican las pruebas de la sección 9. El tiempo máximo de espera es una propuesta del equipo, a confirmar.

| Escenario | Comportamiento esperado |
|---|---|
| E1, E2 | `GET /api/health` informa que Supabase no está disponible (HTTP 503 o estado degradado). La API responde **503** con un mensaje comprensible y sin detalles técnicos. La autenticación distingue "servicio no disponible" (503) de "token inválido" (401), para no cerrar la sesión de todos los usuarios |
| E1, E2 (interfaz) | La pantalla muestra un aviso de servicio no disponible, nunca "No hay datos", y ofrece reintentar. Un formulario que no se pudo guardar conserva los datos y muestra un mensaje comprensible. El inicio de sesión informa "servicio no disponible", no "contraseña incorrecta" |
| E3 | La API responde en **30 segundos como máximo** (propuesta) con 503 o 504, en lugar de quedar colgada |
| E4 | Una operación interrumpida no deja datos parciales, o los deja identificados y reversibles: la importación no graba filas sueltas, el batch de migración queda "fallido" y se puede revertir, y el comprobante queda en un estado coherente con su movimiento |
| E5 | El proceso programado registra el resultado de cada corrida y no deja registros apuntando a archivos borrados |
| Recuperación | Al volver Supabase, el sistema funciona sin reiniciar el backend |

## 5. Detección (procedimiento actual)

Mientras `/api/health` no consulte Supabase (H-37), la caída se detecta por alguna de estas señales:

1. **Usuarios:** listas de Finanzas vacías de golpe, errores como `Failed to fetch`, o "Email o contraseña incorrectos" con credenciales correctas.
2. **Logs del backend:** errores `TypeError: fetch failed` o `AuthRetryableFetchError` repetidos.
3. **Página de estado de Supabase** (status.supabase.com): confirma si es una caída del proveedor o un problema propio.

**Confirmación:** quien detecta la señal revisa la página de estado y los logs. Si se confirma, avisa al responsable de guardia del equipo, que declara la contingencia.

## 6. Manejo durante la contingencia

| Acción | Responsable |
|---|---|
| Declarar la contingencia y registrar la hora de inicio | Responsable de guardia |
| Pedir a los usuarios que **no recarguen ni reintenten** guardados, importaciones ni migraciones, para evitar duplicados (H-41, H-45) | Responsable de guardia |
| No ejecutar despliegues ni migraciones de esquema hasta la recuperación | Equipo |
| Si la caída coincide con las 02:00, registrar que la limpieza de comprobantes debe revisarse (E5) | Responsable de guardia |
| Registrar qué operaciones de varios pasos estaban en curso (importaciones, migraciones, comprobantes), con usuario y hora aproximada | Responsable de guardia |

## 7. Comunicación

**A los usuarios del sistema** (canal habitual con el cliente):

- **Inicio:** "El módulo Financiero de NexaCore no está disponible por una falla del proveedor de base de datos. Tus datos no se perdieron. Mientras dure, no recargues la página ni vuelvas a cargar información: cualquier carga podría duplicarse. Te avisamos cuando se resuelva."
- **Actualización** (cada hora, si continúa): estado y próxima novedad.
- **Resolución:** "El servicio se restableció. Estamos verificando la información cargada durante la falla. Si estabas cargando algo cuando ocurrió, revisá que no esté duplicado antes de volver a cargarlo."

**Al equipo:** grupo interno, con hora de inicio, escenario (E1 a E5), señales observadas y operaciones en curso.

## 8. Recuperación

1. Confirmar en la página de estado de Supabase que el servicio volvió.
2. Comprobar que el backend responde sin reiniciarlo (se recupera solo). Si alguna petición sigue colgada, esperar a que venza o reiniciar el contenedor.
3. **Revisar inconsistencias** que el sistema no corrige solo (H-41), con consultas a la base:
   - batches de migración en estado `procesando` iniciados antes de la caída: marcarlos como fallidos y revertirlos;
   - comprobantes en estado `procesado` sin movimiento vinculado, y movimientos creados por comprobantes que no quedaron vinculados;
   - archivos del bucket de comprobantes sin fila en la base;
   - movimientos importados por Excel durante la ventana de la caída: buscar duplicados (misma fecha, descripción y monto creados en minutos cercanos);
   - suscripciones creadas sin el gasto que las acompañaba (H-45).
4. Si la caída afectó la corrida de las 02:00, verificar que el listado de comprobantes funcione; si falla, ejecutar la limpieza de nuevo.
5. Comunicar la resolución a los usuarios (sección 7).

## 9. Verificación posterior y pruebas que verifican el plan

### Verificación después de cada contingencia

| Verificación | Criterio |
|---|---|
| Salud del backend | `GET /api/health` responde 200 |
| Smoke test del pipeline | Pasa completo sobre el despliegue actual |
| Inicio de sesión | Un usuario de prueba inicia sesión |
| Lectura | El listado de movimientos devuelve datos |
| Consistencia | Las consultas de la sección 8, paso 3, no devuelven registros pendientes |

### Pruebas que verifican el comportamiento esperado (REQ-FIN-18)

Las ejecuta Valentina sobre nexacore-test o con dobles de prueba, como parte de su tarea de indisponibilidad. **Nunca sobre desarrollo ni producción.** Se espera que varias fallen hoy (sección 2): cada fallo se registra como defecto.

| ID | Escenario | Cómo se simula | Resultado esperado | Nivel |
|---|---|---|---|---|
| CP-FIN-18-01 | E1 | `SUPABASE_URL` apuntando a un host inaccesible | `GET /api/health` informa Supabase no disponible | I |
| CP-FIN-18-02 | E1 | Ídem | `GET /api/finance/movimientos` responde 503 con mensaje sin detalles técnicos | I |
| CP-FIN-18-03 | E2 | Doble de prueba: Auth responde, la base falla | La API responde 503, no 401 ni 500 | U |
| CP-FIN-18-04 | E1 (Auth) | Doble de prueba: Auth con error de red, token válido | El middleware responde 503, no 401 | U |
| CP-FIN-18-05 | E3 | Doble de prueba con demora de 60 s | La API responde en 30 s como máximo con 503 o 504 | U |
| CP-FIN-18-06 | E4 | Falla simulada en el lote 2 de una migración | El batch queda `fallido` y se puede revertir | U |
| CP-FIN-18-07 | E4 | Falla simulada en el lote 2 de una importación Excel | No queda ninguna fila grabada | U |
| CP-FIN-18-08 | E4 | Falla simulada al crear el movimiento de un comprobante | El comprobante no queda `procesado` sin movimiento | U |
| CP-FIN-18-09 | E1 (interfaz) | Cypress intercepta la API con error de red | La lista muestra un aviso de servicio no disponible y opción de reintentar, no "No hay movimientos" | S |
| CP-FIN-18-10 | E1 (interfaz) | Cypress: falla el guardado de un movimiento | El formulario conserva los datos y muestra un mensaje comprensible | S |
| CP-FIN-18-11 | E1 (interfaz) | Cypress: falla el inicio de sesión por red | Mensaje de servicio no disponible, no "contraseña incorrecta" | S |
| CP-FIN-18-12 | Recuperación | Restablecer `SUPABASE_URL` sin reiniciar el backend | La primera petición posterior responde correctamente | I |

## 10. Mejoras propuestas

Priorizadas por impacto. El grupo decide cuáles se implementan dentro del trabajo; las demás quedan documentadas como pendientes en el informe.

1. `GET /api/health` que consulte Supabase (también lo necesita la verificación del despliegue por instancia).
2. Que la autenticación distinga 503 de 401, para que una caída no cierre la sesión de todos.
3. Respuestas 503 con mensaje comprensible ante fallas de Supabase, en lugar de 500 con el error técnico.
4. Verificar el resultado de las actualizaciones de estado de los batches de migración.
5. Timeouts explícitos en el cliente de Supabase y en las llamadas del frontend.
6. En la interfaz, distinguir "error" de "sin datos" y ofrecer reintentar.
