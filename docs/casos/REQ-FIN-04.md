# REQ-FIN-04 · Importar movimientos por el endpoint de Excel o CSV

**Riesgo:** R-03 (alto) · **Versión:** 1.1, 17/10/2026 · **Oráculo de montos:** regla RN-01

**Precondiciones comunes:** usuario Contable con permiso manual nivel editor (U-10); nexacore-test reiniciado; archivos de prueba en `test/fixtures/excel/`.
**Pasos comunes:** 1. Enviar el archivo a `POST /api/finance/excel/importar`. 2. Contar los registros nuevos en `movimientos`.
**Archivo base:** 7 filas válidas con columnas `fecha, descripcion, categoria, tipo, monto`, fechas en formato `AAAA-MM-DD`.

| ID | Técnica | Datos de entrada | Resultado esperado | Criterio de aceptación | Prior. | Nivel |
|---|---|---|---|---|---|---|
| CP-FIN-04-01 | Equivalencia (válida) | Archivo base con una fila por cada una de las 7 categorías, incluida Suscripción | Se importan las 7 filas | HTTP 200 y 7 registros nuevos | Alta | I |
| CP-FIN-04-02 | Equivalencia (inválida) | Una fila con monto `0` numérico | Se rechaza el archivo con error de validación | HTTP 400 y 0 registros nuevos | Alta | I |
| CP-FIN-04-03 | Equivalencia (válida) | Fecha `31/12/2026`, formato que anuncia la plantilla | Se importa con fecha 2026-12-31 | HTTP 200 y fecha guardada correcta | Alta | I |
| CP-FIN-04-04 | Equivalencia (inválida) | Fecha `2026-02-31` | Se rechaza con error de validación | HTTP 400 y 0 registros nuevos | Alta | I |
| CP-FIN-04-05 | Equivalencia | Tipo `" Gasto"` con espacio inicial | Se importa con tipo Gasto | HTTP 200 y tipo guardado `Gasto` | Baja | I |
| CP-FIN-04-06 | Atomicidad | 150 filas; la fila 120 tiene un error que solo detecta la base | No queda ninguna fila grabada | 0 registros nuevos | Alta | I |
| CP-FIN-04-07 | Valor límite | Archivo de exactamente 5 MB | Se acepta | No hay error por tamaño | Media | I |
| CP-FIN-04-08 | Valor límite | Archivo de 5 MB + 1 byte | Se rechaza por tamaño | HTTP 400 con mensaje de tamaño | Media | I |
| CP-FIN-04-09 | Equivalencia (inválida) | Archivo con 3 filas inválidas | El rechazo informa qué filas fallan | La respuesta incluye el detalle de las 3 filas | Media | I |

| CP-FIN-04-10 | Equivalencia (RN-01) | Monto como texto `1.234,56` | Se importa por 1234,56 | monto = 1234.56 | Alta | U |
| CP-FIN-04-11 | Equivalencia (RN-01) | Monto como texto `1.234` | Se importa por 1234 | monto = 1234.00 | Alta | U |
| CP-FIN-04-12 | Equivalencia (RN-01) | Monto como texto `1,5` | Se importa por 1,50 | monto = 1.50 | Alta | U |
| CP-FIN-04-13 | Equivalencia (inválida) | Fecha `31/02/2026` (formato DD/MM/AAAA) | Se rechaza como fecha inválida | parsearFecha devuelve null | Alta | U |
| CP-FIN-04-14 | Valor límite | Fecha `2028-02-29` (año bisiesto) | Se acepta | parsearFecha devuelve 2028-02-29 | Alta | U |
| CP-FIN-04-15 | Valor límite | Fecha `2026-02-29` (año no bisiesto) | Se rechaza como fecha inválida | parsearFecha devuelve null | Alta | U |

**Hallazgos relacionados:** 04-01 → H-02 · 04-02, 04-06 → H-13 · 04-03, 04-04, 04-13 a 04-15 → H-14 · 04-05, 04-09 → H-15.
