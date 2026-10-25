# REQ-FIN-08 · Alertar sobre pagos próximos a vencer

**Riesgo:** R-08 (medio) · **Versión:** 1.0, 17/10/2026

**Precondiciones comunes:** suscripciones del seed (S-01 a S-08), creadas con fechas relativas al día de ejecución.
**Pasos comunes:** `GET /api/finance/suscripciones/proximas-vencer` (con `dias` por defecto, salvo indicación) y verificar qué suscripciones devuelve.

| ID | Técnica | Datos de entrada | Resultado esperado | Criterio de aceptación | Prior. | Nivel |
|---|---|---|---|---|---|---|
| CP-FIN-08-01 | Valor límite | S-01 vence hoy | Aparece | S-01 está en la respuesta | Media | I |
| CP-FIN-08-02 | Valor límite | S-02 vence en 7 días | Aparece | S-02 está en la respuesta | Media | I |
| CP-FIN-08-03 | Valor límite | S-03 vence en 8 días | No aparece | S-03 no está en la respuesta | Media | I |
| CP-FIN-08-04 | Valor límite | S-04 venció ayer (mensual) | No aparece; su próximo vencimiento es el mes siguiente | S-04 no está en la respuesta | Baja | U |
| CP-FIN-08-05 | Valor límite | Día de vencimiento 31, evaluado en febrero | Vence el último día de febrero | Fecha calculada 28 o 29 de febrero | Media | U |
| CP-FIN-08-06 | Valor límite | `dias=0` | Solo las que vencen hoy | Respuesta solo con S-01 | Baja | I |
| CP-FIN-08-07 | Equivalencia | S-05 vence en 3 días y tiene un gasto vinculado del período | No aparece (ya pagada) | S-05 no está en la respuesta | Media | I |
| CP-FIN-08-08 | Equivalencia | S-06 pausada, vence en 2 días | No aparece | S-06 no está en la respuesta | Media | I |
| CP-FIN-08-09 | Sistema | S-02 vence en 7 días | El usuario ve la alerta en la interfaz | La alerta es visible al ingresar a Finanzas | Media | S |

**Hallazgos relacionados:** 08-06 → H-23 · 08-09 → H-04.
