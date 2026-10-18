# REQ-FIN-16 y REQ-FIN-17 · Acceso por jerarquía y permiso manual

**Riesgo:** R-02 (alto) · **Versión:** 1.2, 18/10/2026 · **Oráculo:** regla RN-02

**Regla.** Superadmin y Dirección (mando alto, nivel HIGH) acceden a todo el módulo. Otro usuario solo accede con permiso manual en la matriz del módulo `finance`: con nivel lector consulta; con nivel editor también carga, edita y borra. Sueldos, trazabilidad y confirmar o revertir migraciones son exclusivos de mando alto.

**Precondiciones comunes:** usuarios U-01 a U-12 (ver `docs/datos-de-prueba.md`).
**Pasos comunes:** enviar la operación con el token del usuario y verificar el código HTTP y que los datos no cambien cuando corresponde rechazo.

## Tabla de decisión (API)

L = consulta (GET) · E = carga, edición o borrado (POST, PUT, DELETE) · ✓ permitido · ✗ HTTP 403 · 401 sin sesión.
"Finanzas" incluye movimientos, comprobantes, suscripciones, importaciones y cotización.

| Usuario | Finanzas L | Finanzas E | Sueldos L/E | Trazabilidad | Migración confirmar/revertir |
|---|---|---|---|---|---|
| Sin sesión | 401 | 401 | 401 | 401 | 401 |
| Inactivo | ✗ | ✗ | ✗ | ✗ | ✗ |
| Superadmin | ✓ | ✓ | ✓ | ✓ | ✓ |
| Dirección | ✓ | ✓ | ✓ | ✓ | ✓ |
| Otro rol con permiso editor | ✓ | ✓ | ✗ | ✗ | ✗ |
| Otro rol con permiso lector | ✓ | ✗ | ✗ | ✗ | ✗ |
| Otro rol sin permiso (Contable, Auditor, Comercial, Operativo, Pasante, Externo) | ✗ | ✗ | ✗ | ✗ | ✗ |

Se automatiza como un test parametrizado que recorre todas las celdas.

| ID | Celdas que cubre | Criterio de aceptación | Prior. | Nivel |
|---|---|---|---|---|
| CP-FIN-16-01 | Sin sesión, todas las operaciones | HTTP 401 y sin datos en la respuesta | Alta | U/I |
| CP-FIN-16-02 | Usuario inactivo | HTTP 403 | Alta | U/I |
| CP-FIN-16-03 | Superadmin y Dirección, Finanzas L y E | HTTP 200 o 201 | Alta | U/I |
| CP-FIN-16-04 | Cada rol sin permiso, Finanzas L | HTTP 403 y sin datos en la respuesta | Alta | U/I |
| CP-FIN-16-05 | Cada rol sin permiso, Finanzas E | HTTP 403 y la tabla no cambia | Alta | U/I |
| CP-FIN-16-06 | Permiso editor, Finanzas L y E | HTTP 200 o 201 | Alta | U/I |
| CP-FIN-16-07 | Permiso lector, Finanzas L | HTTP 200 | Alta | U/I |
| CP-FIN-16-08 | Permiso lector, Finanzas E | HTTP 403 y la tabla no cambia | Alta | U/I |
| CP-FIN-17-01 | Permiso editor y lector, sueldos | HTTP 403 | Alta | U/I |
| CP-FIN-17-02 | Superadmin y Dirección, sueldos | HTTP 200 | Alta | U/I |
| CP-FIN-17-04 | Trazabilidad para cada usuario | Solo mando alto recibe 200 | Media | U/I |
| CP-FIN-17-05 | Migración confirmar y revertir para cada usuario | Solo mando alto recibe 200; Dirección incluida | Alta | U/I |
| CP-FIN-16-12 | Contable con permiso de Finanzas **por rol** en la matriz y sin permiso por usuario, en todas las rutas de Finanzas (consulta y carga) | HTTP 403 y la tabla no cambia | Alta | U/I |

## Interfaz

| ID | Datos de entrada | Resultado esperado | Criterio de aceptación | Prior. | Nivel |
|---|---|---|---|---|---|
| CP-FIN-16-09 | Usuario sin permiso escribe la ruta de Finanzas en el navegador | No accede al módulo | No se muestran datos financieros | Alta | S |
| CP-FIN-16-10 | Usuario con un rol que no figura en la matriz | Sin acceso a Finanzas | El menú no muestra Finanzas y la ruta no carga datos | Alta | S |
| CP-FIN-16-11 | Usuario con permiso lector dentro de Finanzas | No se ofrecen acciones de carga, edición ni borrado | Botones ausentes | Media | S |
| CP-FIN-17-03 | Usuario con permiso editor dentro de Finanzas | No ve la pestaña Sueldos | Pestaña ausente | Media | S |

**Hallazgos relacionados:** 16-04 a 16-08, 16-12 → H-25 · 16-09 a 16-11 → H-26 · 17-03 → H-27 · 17-05 → H-18.
