# REQ-FIN-09 · Procesar comprobantes con OCR

**Riesgo:** R-05 (medio) · **Versión:** 1.0, 18/10/2026

**Precondiciones comunes:** servicio de OCR (Gemini) y base simulados con dobles de prueba; `COMPANY_CUIT` configurado.
**Pasos comunes:** subir el comprobante con `subirArchivo` y verificar el estado del comprobante y el movimiento creado.

| ID | Técnica | Datos de entrada | Resultado esperado | Criterio de aceptación | Prior. | Nivel |
|---|---|---|---|---|---|---|
| CP-FIN-09-01 | Valor límite | Comprobante válido cuyo total extraído es 1234.567 | Se crea el movimiento con el total redondeado a centavos | Movimiento con monto = 1234.57 y comprobante en estado `procesado`, vinculado al movimiento | Alta | U |

CP-FIN-09-01 surgió durante la corrección de DEF-007: la nueva validación de 2 decimales habría dejado en revisión comprobantes válidos. Sin el redondeo del total, el caso falla.

Los casos de IVA, conciliación y duplicados (REQ-FIN-09 a 11) se diseñan en una versión posterior.
