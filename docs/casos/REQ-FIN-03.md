# REQ-FIN-03 · Importar gastos históricos

**Riesgo:** R-09 (medio); los casos de montos son de prioridad alta porque afectan datos financieros · **Versión:** 1.1, 17/10/2026 · **Oráculo de montos:** regla RN-01

**Precondiciones comunes:** usuario Superadmin activo (salvo 03-07); archivos en `test/fixtures/migracion/`; `fecha_global 2026-09-30`.
**Pasos comunes:** 1. `POST /api/finance/migracion/preview` y revisar el resultado. 2. `POST /api/finance/migracion/confirmar`. 3. Consultar los registros con el `migration_batch_id`.
**Archivo base:** columnas `Concepto, Total`.

| ID | Técnica | Datos de entrada | Resultado esperado | Criterio de aceptación | Prior. | Nivel |
|---|---|---|---|---|---|---|
| CP-FIN-03-01 | Equivalencia (formato argentino) | Total `1.234,56` | Se guarda 1234,56 | monto = 1234.56 | Alta | U |
| CP-FIN-03-02 | Equivalencia (formato argentino) | Total `1,5` | Se guarda 1,50 | monto = 1.50 | Alta | U |
| CP-FIN-03-03 | Equivalencia (formato con símbolo) | Total `$ 1,234.50` | Se guarda 1234,50 | monto = 1234.50 | Media | U |
| CP-FIN-03-04 | Valor límite | Total `0.004` | Fila rechazada (redondea a 0); el resto se importa | La fila figura en errores y no se graba | Media | U |
| CP-FIN-03-11 | Equivalencia (miles) | Total `1.234` | Se guarda 1234 | monto = 1234.00 | Alta | U |
| CP-FIN-03-12 | Equivalencia (miles) | Total `1.234.567` | Se guarda 1234567 | monto = 1234567.00 | Alta | U |
| CP-FIN-03-13 | Equivalencia (decimal) | Total `1.5` | Se guarda 1,50 | monto = 1.50 | Media | U |
| CP-FIN-03-14 | Equivalencia (inválida) | Total `1,2,3` | Fila rechazada | La fila figura en errores y no se graba | Media | U |
| CP-FIN-03-15 | Equivalencia | Celda numérica de Excel 1234.56 | Se guarda 1234,56 | monto = 1234.56 | Media | U |
| CP-FIN-03-05 | Equivalencia (inválida) | Fila sin Nombre, Descripción ni Concepto | Fila rechazada; el resto se importa | Solo esa fila figura en errores | Media | I |
| CP-FIN-03-06 | Equivalencia | Concepto `a` | Categoría Otros (sin coincidencia real) | categoria = Otros | Media | U |
| CP-FIN-03-07 | Tabla de decisión (rol, RN-02) | Confirmar con usuario Dirección | Se permite | HTTP 200 y batch completado | Alta | I |
| CP-FIN-03-08 | Transición de estado | Revertir un batch completado | Se borran sus registros | 0 registros con ese batch y estado revertido | Media | I |
| CP-FIN-03-09 | Transición de estado | Revertir un batch ya revertido | Se rechaza | HTTP 400 | Baja | I |
| CP-FIN-03-10 | Transición de estado | Revertir un batch en procesamiento | Se rechaza | HTTP 409 | Baja | I |

**Hallazgos relacionados:** 03-01, 03-02, 03-11 a 03-14 → H-16 · 03-06 → H-17 · 03-07 → H-18 · 03-08 → H-19.
