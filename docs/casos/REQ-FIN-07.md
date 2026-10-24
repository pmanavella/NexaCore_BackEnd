# REQ-FIN-07 · Gestionar suscripciones con su día de vencimiento

**Riesgo:** R-NN · **Versión:** 1.0, 19/10/2026 · **Oráculo:** las validaciones del propio servicio (`_validar` en `finance/services/suscripcionesService.js`), que ya define las monedas (ARS, USD) y frecuencias (mensual, trimestral, semestral, anual) admitidas

**Precondiciones comunes:** Supabase simulado; se prueba `suscripcionesService` (nivel unitario).
**Datos base:** suscripción válida `{ nombre: 'Slack', monto: 1500, moneda: 'USD', dia_vencimiento: 10, frecuencia: 'mensual', estado: 'activa' }`.
**Supuesto:** moneda y frecuencia son opcionales; si no se envían, se usan ARS y mensual. Un valor enviado que no está en la lista se rechaza: no se reemplaza.

| ID | Técnica | Datos de entrada | Resultado esperado | Criterio de aceptación | Prior. | Nivel |
|---|---|---|---|---|---|---|
| CP-FIN-07-01 | Equivalencia (inválida) | Alta con moneda `EUR` | Se rechaza con error de validación | HTTP 400 "Moneda inválida" y no se guarda | Alta | U |
| CP-FIN-07-02 | Equivalencia (inválida) | Alta con frecuencia `semanal` | Se rechaza con error de validación | HTTP 400 "Frecuencia inválida" y no se guarda | Media | U |
| CP-FIN-07-03 | Equivalencia (inválida) | Edición con moneda `EUR` | Se rechaza con error de validación | HTTP 400 "Moneda inválida" y no se guarda | Alta | U |
| CP-FIN-07-04 | Equivalencia (inválida) | Edición con frecuencia `semanal` | Se rechaza con error de validación | HTTP 400 "Frecuencia inválida" y no se guarda | Media | U |
| CP-FIN-07-05 | Equivalencia (válida) | Alta sin moneda ni frecuencia | Se guarda con ARS y mensual | moneda = ARS, frecuencia = mensual | Media | U |

CP-FIN-07-05 lo cubre el test «alta de suscripción válida» de `test/finanzas.suscripciones.test.js` (rama `test/cobertura-finanzas`).

**Hallazgos relacionados:** 07-01 a 07-04 → H-23.