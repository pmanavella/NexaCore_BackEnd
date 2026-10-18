# Matriz de trazabilidad

Se actualiza cada vez que se diseña un caso, se automatiza un test o se registra un defecto. La versión final se congela el 23 de octubre junto con el código.

## Requisito → caso → test → defecto

| Requisito | Casos de prueba | Tests automatizados | Defectos | Estado |
|---|---|---|---|---|
| REQ-FIN-01 | | | | Sin casos |
| REQ-FIN-02 | CP-FIN-02-01 a 02-13 | | | Diseñado |
| REQ-FIN-03 | CP-FIN-03-01 a 03-15 | `test/finanzas.montos.test.js` (03-01 a 03-04, 03-11 a 03-15) | DEF-005 (#22) | Con defectos abiertos |
| REQ-FIN-04 | CP-FIN-04-01 a 04-12 | `test/finanzas.montos.test.js` (04-10 a 04-12) | DEF-006 (#23) | Con defectos abiertos |
| REQ-FIN-05 | CP-FIN-05-01 a 05-10 | | | Diseñado |
| REQ-FIN-06 | CP-FIN-06-01 a 06-09 | | | Diseñado |
| REQ-FIN-07 | | | | Sin casos |
| REQ-FIN-08 | CP-FIN-08-01 a 08-09 | | | Diseñado |
| REQ-FIN-09 | | | | Sin casos |
| REQ-FIN-10 | | | | Sin casos |
| REQ-FIN-11 | | | | Sin casos |
| REQ-FIN-12 | | | | Sin casos |
| REQ-FIN-13 | | | | Sin casos |
| REQ-FIN-14 | CP-FIN-14-01 a 14-07 | | | Diseñado |
| REQ-FIN-15 | CP-FIN-15-01, 15-02 | | | Diseñado |
| REQ-FIN-16 | CP-FIN-16-01 a 16-11 | `test/finanzas.permisos.test.js` (16-01 a 16-08) | DEF-001 (#18), DEF-002 (#19), DEF-003 (#20) | Con defectos abiertos |
| REQ-FIN-17 | CP-FIN-17-01 a 17-05 | `test/finanzas.permisos.test.js` (17-01, 17-02, 17-04, 17-05) | DEF-004 (#21) | Con defectos abiertos |

Estados posibles: Sin casos · Diseñado · Ejecutado sin defectos · Con defectos abiertos · Defectos verificados.

## Registro de identificadores de defectos

Antes de abrir un issue, tomar el siguiente número libre y anotarlo aquí.

| DEF | Issue | Título | Caso | Severidad | Detectado | Corregido | Regresión |
|---|---|---|---|---|---|---|---|
| DEF-001 | #18 | Usuarios sin permiso de Finanzas consultan y modifican datos | CP-FIN-16-04, 16-05 | Crítica | 2026-10-17 | | |
| DEF-002 | #19 | Usuario con permiso lector puede crear, editar y borrar | CP-FIN-16-08 | Alta | 2026-10-17 | | |
| DEF-003 | #20 | Usuarios con permiso reciben 403 al consultar la cotización | CP-FIN-16-06, 16-07 | Media | 2026-10-17 | | |
| DEF-004 | #21 | Dirección no puede confirmar ni revertir migraciones | CP-FIN-17-05 | Alta | 2026-10-17 | | |
| DEF-005 | #22 | La migración guarda montos incorrectos por comas y puntos | CP-FIN-03-01, 03-02, 03-11, 03-12, 03-14 | Crítica | 2026-10-17 | | |
| DEF-006 | #23 | El Excel rechaza o guarda mal montos con formato argentino | CP-FIN-04-10, 04-11, 04-12 | Crítica | 2026-10-17 | | |

Siguiente número libre: **DEF-007**.

## Ejecuciones registradas

| Fecha | Versión probada | Tests | Pasan | Fallan | Evidencia |
|---|---|---|---|---|---|
| 2026-10-17 | `develop @ 6d0c1d7` (tests en `test/casos-rojos @ 05037bf`) | 420 | 264 | 156 | EV-04a, EV-04b |
