# REQ-FIN-05 y REQ-FIN-06 · Liquidación de sueldos en pesos y en dólares

**Riesgo:** R-01 (alto) · **Versión:** 1.0, 17/10/2026

**Precondiciones comunes:** usuario Dirección activo; empleados del seed (E-01 a E-09, ver `docs/datos-de-prueba.md`); cotización fija de prueba: compra 1000, venta 1050.
**Pasos comunes:** registrar un movimiento salarial para el empleado indicado y consultar el monto guardado en pesos.

## Tabla de decisión

Planta o temporal no interviene en el cálculo; se alterna entre empleados para verificar que no lo altere.

| Regla | Estructura | Moneda | Cotización | Cantidad | Monto esperado en pesos |
|---|---|---|---|---|---|
| R1 | Mensual | ARS | — | — | monto_base |
| R2 | Por hora | ARS | — | 10 | monto_base × 10 |
| R3 | Por turno | ARS | — | 3 | monto_base × 3 |
| R4 | Mensual | USD | Compra | — | monto_base × 1000 |
| R5 | Por hora | USD | Compra | 10 | monto_base × 10 × 1000 |
| R6 | Por turno | USD | Compra | 3 | monto_base × 3 × 1000 |
| R7 | Mensual | USD | Venta | — | monto_base × 1050 |
| R8 | Por hora | USD | Venta | 10 | monto_base × 10 × 1050 |
| R9 | Por turno | USD | Venta | 3 | monto_base × 3 × 1050 |

| ID | Regla | Empleado | Resultado esperado | Criterio de aceptación | Prior. | Nivel |
|---|---|---|---|---|---|---|
| CP-FIN-05-01 | R1 | E-01 (planta, 800.000) | 800.000 | monto = 800000.00 | Alta | U |
| CP-FIN-05-02 | R2 | E-02 (temporal, 5.000/h) | 50.000 | monto = 50000.00 | Alta | U |
| CP-FIN-05-03 | R3 | E-03 (planta, 40.000/turno) | 120.000 | monto = 120000.00 | Alta | U |
| CP-FIN-06-01 | R4 | E-04 (temporal, USD 1.000) | 1.000.000 | monto = 1000000.00 | Alta | S |
| CP-FIN-06-02 | R5 | E-05 (planta, USD 10/h) | 100.000 | monto = 100000.00 | Alta | S |
| CP-FIN-06-03 | R6 | E-06 (temporal, USD 80/turno) | 240.000 | monto = 240000.00 | Alta | S |
| CP-FIN-06-04 | R7 | E-07 (planta, USD 1.000) | 1.050.000 | monto = 1050000.00 | Alta | S |
| CP-FIN-06-05 | R8 | E-08 (temporal, USD 10/h) | 105.000 | monto = 105000.00 | Alta | S |
| CP-FIN-06-06 | R9 | E-09 (planta, USD 80/turno) | 252.000 | monto = 252000.00 | Alta | S |

Los casos en dólares son de sistema porque la conversión la hace el frontend con la cotización externa. En Cypress, la cotización se fija interceptando la consulta externa con los valores de prueba.

## Integridad en la API (dólares)

| ID | Técnica | Datos de entrada | Resultado esperado | Criterio de aceptación | Prior. | Nivel |
|---|---|---|---|---|---|---|
| CP-FIN-06-07 | Equivalencia (inválida) | Empleado E-05 en USD, cantidad 10, sin `monto_ars` | Se rechaza o se convierte a pesos | Nunca se guarda 100 (dólares) como pesos | Alta | I |
| CP-FIN-06-08 | Equivalencia (inválida) | E-04, `monto_ars` 1 con cotización 1000 | Se rechaza o se recalcula | El monto guardado es 1000000.00 o HTTP 400 | Alta | I |
| CP-FIN-06-09 | Equivalencia (inválida) | Alta de empleado en USD sin `cotizacion_tipo` | Se rechaza | HTTP 400 y ningún empleado nuevo | Media | U |

## Valores límite y validaciones

| ID | Técnica | Datos de entrada | Resultado esperado | Criterio de aceptación | Prior. | Nivel |
|---|---|---|---|---|---|---|
| CP-FIN-05-04 | Valor límite | E-02, cantidad 0 | Se rechaza | HTTP 400 | Alta | U |
| CP-FIN-05-05 | Valor límite | E-02, cantidad 1 | Se crea por 5.000 | monto = 5000.00 | Media | U |
| CP-FIN-05-06 | Equivalencia (inválida) | E-02, cantidad −5 | Se rechaza | HTTP 400 y ningún movimiento nuevo | Alta | U |
| CP-FIN-05-07 | Equivalencia (inválida) | Monto −1000 | Se rechaza | HTTP 400 y ningún movimiento nuevo | Alta | U |
| CP-FIN-05-08 | Equivalencia (inválida) | Cantidad `abc` | Se rechaza | HTTP 400 | Media | U |
| CP-FIN-05-09 | Equivalencia (inválida) | Alta de empleado con tipo_salario `semanal` | Se rechaza | HTTP 400 y ningún empleado nuevo | Media | U |
| CP-FIN-05-10 | Transición | Editar E-02 (por hora) cambiando solo el apellido | Conserva la estructura por hora | tipo_salario sigue en `hora` | Media | I |

**Hallazgos relacionados:** 06-07, 06-08 → H-21 · 05-06, 05-07 → H-20 · 05-09, 05-10 → H-22.
