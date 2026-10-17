# REQ-FIN-02 · Registrar gastos e ingresos con datos válidos

**Riesgo:** R-03 (alto) · **Responsable del diseño:** Pilar · **Versión:** 1.0, 17/10/2026

**Precondiciones comunes:** usuario Contable con permiso manual nivel editor (U-10), nexacore-test con el seed cargado.
**Pasos comunes:** 1. Enviar `POST /api/finance/movimientos` con los datos del caso. 2. Consultar la tabla `movimientos`.
**Datos base** (se modifica solo el campo del caso): `fecha 2026-10-15`, `descripcion "TEST alta"`, `categoria Servicios`, `tipo Gasto`, `monto 1000`.

## Clases de equivalencia

| Campo | Clases válidas | Clases inválidas |
|---|---|---|
| categoria | Tecnología, RRHH, Insumos, Servicios, Inversión, Otros, Suscripción | Inexistente · distinta capitalización · vacía |
| tipo | Ingreso, Gasto | Otro texto · vacío |
| monto | Número mayor a 0 | 0 · negativo · no numérico · vacío |
| fecha | Fecha calendario válida | Fecha inexistente · texto |
| descripcion | Texto no vacío | Vacía o solo espacios |

| ID | Datos de entrada | Resultado esperado | Criterio de aceptación | Prior. | Nivel |
|---|---|---|---|---|---|
| CP-FIN-02-01 | Cada una de las 7 categorías, con tipo Gasto e Ingreso (14 combinaciones) | Se crea el movimiento | HTTP 201 y el registro existe con la categoría enviada | Alta | U/I |
| CP-FIN-02-02 | categoria `rrhh` | Se rechaza | HTTP 400 y ningún registro nuevo | Media | U |
| CP-FIN-02-03 | categoria `Viáticos` | Se rechaza indicando las categorías válidas | HTTP 400, mensaje con la lista, ningún registro nuevo | Alta | U |
| CP-FIN-02-04 | monto `0` (número) | Se rechaza por monto | HTTP 400 con mensaje sobre el monto, ningún registro nuevo | Alta | U |
| CP-FIN-02-05 | monto `-100` | Se rechaza | HTTP 400, ningún registro nuevo | Alta | U |
| CP-FIN-02-06 | monto `"abc"` | Se rechaza por monto | HTTP 400, ningún registro nuevo | Alta | U/I |
| CP-FIN-02-07 | tipo `Egreso` | Se rechaza | HTTP 400, ningún registro nuevo | Media | U |
| CP-FIN-02-08 | fecha `2026-02-31` | Se rechaza por fecha | HTTP 400, ningún registro nuevo | Alta | I |
| CP-FIN-02-09 | descripcion `"   "` | Se rechaza | HTTP 400, ningún registro nuevo | Media | U |

## Valores límite del monto

El código no define un máximo; el límite es el de la columna `numeric(15,2)`: 9.999.999.999.999,99.

| ID | Datos de entrada | Resultado esperado | Criterio de aceptación | Prior. | Nivel |
|---|---|---|---|---|---|
| CP-FIN-02-10 | monto `0.01` | Se crea | HTTP 201 y monto guardado `0.01` | Alta | I |
| CP-FIN-02-11 | monto `0.001` | Se rechaza (menor al mínimo representable) | HTTP 400, ningún registro nuevo | Media | I |
| CP-FIN-02-12 | monto `9999999999999.99` | Se crea | HTTP 201 y monto guardado igual | Media | I |
| CP-FIN-02-13 | monto `10000000000000` | Se rechaza por exceder el máximo | HTTP 400, ningún registro nuevo | Media | I |

**Hallazgos relacionados:** 02-03 → H-01, H-02 · 02-06 → H-10 · 02-08 → H-12 · 02-11, 02-13 → H-11.
