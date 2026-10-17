# REQ-FIN-14 y REQ-FIN-15 · Libro diario y exportación a PDF

**Riesgo:** R-04 (alto) · **Versión:** 1.0, 17/10/2026

**Precondiciones comunes:** movimientos M-01 a M-11 y sueldos SA-01 y SA-02 del seed, todos en septiembre de 2026 (ver `docs/datos-de-prueba.md`).
**Pasos comunes:** 1. Ingresar a Finanzas → Ver Movimientos. 2. Generar el Libro Diario Contable y el Resumen Financiero de septiembre de 2026. 3. Comparar con los totales esperados.

**Totales esperados** con el seed: ingresos operativos 800.000; egresos operativos 1.210.001,50 (incluye 1.000.000 de sueldos); egresos financieros 10.500.

| ID | Técnica | Datos de entrada | Resultado esperado | Criterio de aceptación | Prior. | Nivel |
|---|---|---|---|---|---|---|
| CP-FIN-14-01 | Sistema | Usuario Dirección, septiembre 2026 | Cada movimiento aparece en un único asiento y Debe = Haber = total de movimientos | Total del período 2.020.501,50 | Alta | S |
| CP-FIN-14-02 | Equivalencia | M-05 «Cuota social del club», Servicios | Egreso operativo, cuenta «Gastos en servicios» | Bloque y cuenta correctos | Alta | S |
| CP-FIN-14-03 | Equivalencia | M-06 «Interés por pago fuera de término» | Egreso financiero, cuenta «Gastos por intereses» | Bloque y cuenta correctos | Media | S |
| CP-FIN-14-04 | Valor límite | M-09 a M-11, tres gastos de 0,50 | Los importes impresos suman igual que el total | Suma de líneas = total del asiento | Media | S |
| CP-FIN-14-05 | Equivalencia | Resumen Financiero del mes | Egresos financieros informados por separado de los operativos | 10.500 en egresos financieros | Media | S |
| CP-FIN-14-06 | Tabla de decisión (rol) | Usuario con permiso editor (U-10) genera el libro | Avisa que el libro no incluye sueldos | Aviso visible antes de generar | Alta | S |
| CP-FIN-14-07 | Falla de dependencia | La consulta de sueldos falla (simulada) | El sistema avisa que el libro está incompleto | Mensaje visible antes de generar | Media | S |
| CP-FIN-15-01 | Sistema | PDF del Libro Diario de septiembre | Coincide con el libro en pantalla | Mismos asientos y Total Período | Alta | S |
| CP-FIN-15-02 | Sistema | Pantalla filtrada por categoría Insumos, luego exportar | El PDF indica el período y alcance que exporta | El usuario puede saber qué contiene el PDF | Baja | S |

**Hallazgos relacionados:** 14-02 → H-28 · 14-04, 14-05 → H-29 · 14-06, 14-07 → H-27, H-30 · 15-02 → H-30.
