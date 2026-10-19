# Matriz de trazabilidad

Se actualiza cada vez que se diseña un caso, se automatiza un test o se registra un defecto. La versión final se congela el 23 de octubre junto con el código.

## Requisito → caso → test → defecto

| Requisito | Casos de prueba | Tests automatizados | Defectos | Estado |
|---|---|---|---|---|
| REQ-FIN-01 | | | | Sin casos |
| REQ-FIN-02 | CP-FIN-02-01 a 02-15 | `test/finanzas.movimientos.test.js` (02-01 a 02-15) | DEF-007 (#24), DEF-008 (#25) | Corregido, pendiente de merge y verificación |
| REQ-FIN-03 | CP-FIN-03-01 a 03-15 | `test/finanzas.montos.test.js` (03-01 a 03-04, 03-11 a 03-15) | DEF-005 (#22) | Corregido, pendiente de merge y verificación |
| REQ-FIN-04 | CP-FIN-04-01 a 04-12 | `test/finanzas.montos.test.js` (04-10 a 04-12), `test/finanzas.importacion.test.js` (04-01) | DEF-006 (#23), DEF-012 (#30) | Con defectos abiertos |
| REQ-FIN-05 | CP-FIN-05-01 a 05-16 | `test/finanzas.sueldos.test.js` (05-01 a 05-10, 05-13 a 05-16) | DEF-009 (#26), DEF-011 (#28) | Corregido, pendiente de merge y verificación |
| REQ-FIN-06 | CP-FIN-06-01 a 06-17 | `test/finanzas.sueldos.test.js` (06-07 a 06-09, 06-11 a 06-17) | DEF-010 (#27) | Corregido, pendiente de merge y verificación |
| REQ-FIN-07 | | | | Sin casos |
| REQ-FIN-08 | CP-FIN-08-01 a 08-09 | | | Diseñado |
| REQ-FIN-09 | CP-FIN-09-01 | `test/finanzas.comprobantes.test.js` | — | Ejecutado sin defectos |
| REQ-FIN-10 | | | | Sin casos |
| REQ-FIN-11 | | | | Sin casos |
| REQ-FIN-12 | | | | Sin casos |
| REQ-FIN-13 | | | | Sin casos |
| REQ-FIN-14 | CP-FIN-14-01 a 14-07 | | | Diseñado |
| REQ-FIN-15 | CP-FIN-15-01, 15-02 | | | Diseñado |
| REQ-FIN-16 | CP-FIN-16-01 a 16-12 | `test/finanzas.permisos.test.js` (16-01 a 16-08, 16-12) | DEF-001 (#18), DEF-002 (#19), DEF-003 (#20) | Corregido, pendiente de merge y verificación |
| REQ-FIN-17 | CP-FIN-17-01 a 17-05 | `test/finanzas.permisos.test.js` (17-01, 17-02, 17-04, 17-05) | DEF-004 (#21) | Corregido, pendiente de merge y verificación |
| REQ-FIN-18 | CP-FIN-18-01 a 18-12 (en `plan-contingencia.md`) | | | Diseñado |

Estados posibles: Sin casos · Diseñado · Ejecutado sin defectos · Con defectos abiertos · Corregido, pendiente de merge y verificación · Defectos verificados.

## Registro de identificadores de defectos

Antes de abrir un issue, tomar el siguiente número libre y anotarlo aquí.

| DEF | Issue | Título | Caso | Severidad | Detectado | Corregido | Regresión |
|---|---|---|---|---|---|---|---|
| DEF-001 | #18 | Usuarios sin permiso de Finanzas consultan y modifican datos | CP-FIN-16-04, 16-05 | Crítica | 2026-10-17 | 2026-10-18 · `fix/DEF-001-004-permisos` | CP-FIN-16-04, 16-05, 16-12 |
| DEF-002 | #19 | Usuario con permiso lector puede crear, editar y borrar | CP-FIN-16-08 | Alta | 2026-10-17 | 2026-10-18 · `fix/DEF-001-004-permisos` | CP-FIN-16-08 |
| DEF-003 | #20 | Usuarios con permiso reciben 403 al consultar la cotización | CP-FIN-16-06, 16-07 | Media | 2026-10-17 | 2026-10-18 · `fix/DEF-001-004-permisos` | CP-FIN-16-06, 16-07 |
| DEF-004 | #21 | Dirección no puede confirmar ni revertir migraciones | CP-FIN-17-05 | Alta | 2026-10-17 | 2026-10-18 · `fix/DEF-001-004-permisos` | CP-FIN-17-05 |
| DEF-005 | #22 | La migración guarda montos incorrectos por comas y puntos | CP-FIN-03-01, 03-02, 03-11, 03-12, 03-14 | Crítica | 2026-10-17 | 2026-10-18 · `fix/DEF-005-006-montos` | CP-FIN-03-01, 02, 11, 12, 14 |
| DEF-006 | #23 | El Excel rechaza o guarda mal montos con formato argentino | CP-FIN-04-10, 04-11, 04-12 | Crítica | 2026-10-17 | 2026-10-18 · `fix/DEF-005-006-montos` | CP-FIN-04-10, 11, 12 |
| DEF-007 | #24 | El alta de movimientos no valida monto no numérico, fecha inexistente ni rango | CP-FIN-02-06, 02-08, 02-11, 02-13 | Media | 2026-10-18 | 2026-10-18 · `fix/DEF-007-008-movimientos` | CP-FIN-02-06, 08, 11, 13, 14, 15; 09-01 |
| DEF-008 | #25 | Mensaje engañoso con monto 0 en el alta de movimientos | CP-FIN-02-04 | Baja | 2026-10-18 | 2026-10-18 · `fix/DEF-007-008-movimientos` | CP-FIN-02-04 |
| DEF-009 | #26 | Los movimientos salariales aceptan montos y cantidades negativos | CP-FIN-05-06, 05-07 | Media | 2026-10-18 | 2026-10-18 · `fix/DEF-009-011-sueldos-validaciones` | CP-FIN-05-06, 07, 13 |
| DEF-010 | #27 | Sueldos en dólares guardados como pesos, sin verificar la conversión | CP-FIN-06-07, 06-08 | Crítica | 2026-10-18 | 2026-10-18 · `fix/DEF-010-sueldos-usd` | CP-FIN-06-07, 08, 11 a 17 |
| DEF-011 | #28 | Tipo de salario reemplazado en silencio; la edición cambia la estructura de pago | CP-FIN-05-09, 05-10 | Alta | 2026-10-18 | 2026-10-18 · `fix/DEF-009-011-sueldos-validaciones` | CP-FIN-05-09, 10, 14, 15, 16 |
| DEF-012 | #30 | La importación por Excel rechaza el archivo completo si incluye la categoría Suscripción | CP-FIN-04-01 | Media | 2026-10-19 | — | CP-FIN-04-01 |

Siguiente número libre: **DEF-013**.

## Ejecuciones registradas

| Fecha | Versión probada | Tests | Pasan | Fallan | Evidencia |
|---|---|---|---|---|---|
| 2026-10-17 | `develop @ 6d0c1d7` (tests en `test/casos-rojos @ 05037bf`) | 420 | 264 | 156 | EV-04a, EV-04b |
| 2026-10-18 | `develop @ 6d0c1d7` (tests en `test/casos-rojos @ 186d9e7`, archivos de movimientos y sueldos) | 39 | 28 | 11 | EV-06 |

| 2026-10-18 | `fix/DEF-005-006-montos` | 12 | 12 | 0 | EV-08 (montos) |
| 2026-10-18 | `fix/tests-documentExtraction` | 8 | 8 | 0 | EV-09a (antes: 4 fallos), EV-09b |
| 2026-10-18 | `fix/DEF-001-004-permisos` | 433 | 433 | 0 | EV-10a (rojo de CP-FIN-16-12), EV-10b |
| 2026-10-18 | `fix/DEF-010-sueldos-usd` (casos CP-FIN-06) | todos | todos | 0 | EV-11a, EV-11b |
| 2026-10-18 | `fix/DEF-009-011-sueldos-validaciones` (DEF-009) | 3 | 3 | 0 | EV-12a, EV-12b |
| 2026-10-18 | `fix/DEF-009-011-sueldos-validaciones` (DEF-011) | 6 | 6 | 0 | EV-13a, EV-13b |
| 2026-10-18 | `fix/DEF-007-008-movimientos` | casos 02 y 09-01 | todos | 0 | EV-14a, EV-14b |

Ninguna corrección produjo regresiones en la suite completa: cada una se comparó contra la rama de la que sale.

## Ramas de corrección e integración

| Rama | Sale de | Defectos | Estado |
|---|---|---|---|
| `fix/tests-documentExtraction` | `develop` | Hallazgo H-46 | Pull request #29, a revisar por Victoria |
| `fix/DEF-005-006-montos` | `test/casos-rojos` | DEF-005, 006 | Subida, sin merge |
| `fix/DEF-001-004-permisos` | `test/casos-rojos` | DEF-001 a 004 | Subida, sin merge |
| `fix/DEF-010-sueldos-usd` | `test/casos-rojos` | DEF-010 | Subida, sin merge |
| `fix/DEF-009-011-sueldos-validaciones` | `fix/DEF-010-sueldos-usd` | DEF-009, 011 | Subida, sin merge (va después de DEF-010) |
| `fix/DEF-007-008-movimientos` | `test/casos-rojos` | DEF-007, 008 | Subida, sin merge |

**Integración propuesta**, cuando estén la línea base de Victoria y el pipeline de Valentina:
1. Mergear el pull request #29 a `develop` (con la aprobación de Victoria).
2. Abrir un pull request de `test/casos-rojos` a `develop` para registrar la **ejecución fallida en el pipeline**. No se mergea.
3. Crear una rama de integración que una todas las ramas `fix/…` (respetando DEF-010 antes que DEF-009-011), y abrir el pull request a `develop`: el pipeline debería quedar en verde.
4. Otra integrante verifica cada corrección; recién entonces los issues pasan a `estado: verificado` y se cierran.

## Casos bloqueados o corregidos

| Caso | Estado | Detalle |
|---|---|---|
| CP-FIN-05-16 | Rojo verificado sin captura | El rojo se comprobó ejecutándolo sobre el código anterior (`b776d88`) |
| CP-FIN-05-01 | Diseño corregido el 18/10 | Asumía que el backend calcula el sueldo mensual; ver `casos/REQ-FIN-05-06.md`, "Correcciones de diseño" |
