# REQ-FIN-13 · Consultar la cotización del dólar en un servicio externo

**Componente:** frontend (`src/lib/dolarService.js`). El backend no consulta ninguna API externa (hallazgo H-24). · **Versión:** 1.0, 19/10/2026 · **Autora:** Victoria

**Precondiciones comunes:** las APIs externas (BCRA estadísticas v4.0, DolarAPI oficial y DolarAPI blue) se simulan reemplazando `fetch`; no se hace ninguna llamada real. Cada caso empieza con la caché vacía.
**Orden de fuentes según el servicio:** cotización simple BCRA → DolarAPI oficial → DolarAPI blue; cotización con compra y venta DolarAPI oficial → DolarAPI blue → BCRA. Caché de 5 minutos. Timeout de 7 segundos por consulta.
**Test automatizado:** `test/dolarService.test.js` del frontend (un test por caso, en el mismo orden).

| ID | Técnica | Datos de entrada | Resultado esperado | Criterio de aceptación | Prior. | Nivel |
|---|---|---|---|---|---|---|
| CP-FIN-13-01 | Equivalencia (válida) | BCRA responde con la variable de tipo de cambio, valor 1050,25 | Se usa el valor del BCRA | valor = 1050.25, fuente BCRA | Alta | U |
| CP-FIN-13-02 | Equivalencia (válida) | DolarAPI oficial responde compra 1000, venta 1040 y fecha | Se devuelven compra, venta y fecha | compra 1000, venta 1040, fecha 2026-10-19 | Alta | U |
| CP-FIN-13-03 | Equivalencia (error HTTP) | BCRA responde HTTP 500 | Se usa DolarAPI oficial | valor = venta oficial, fuente DolarAPI Oficial | Alta | U |
| CP-FIN-13-04 | Equivalencia (error HTTP) | BCRA HTTP 503 y DolarAPI oficial HTTP 429 | Se usa DolarAPI blue | fuente DolarAPI Blue | Media | U |
| CP-FIN-13-05 | Equivalencia (sin red) | Las tres fuentes fallan por falta de conexión | Error con mensaje para el usuario | Se rechaza con "No se pudo obtener la cotización…" tras 3 consultas | Alta | U |
| CP-FIN-13-06 | Valor límite (timeout) | BCRA no responde | La consulta se corta a los 7 s y se usa DolarAPI oficial | fuente DolarAPI Oficial | Alta | U |
| CP-FIN-13-07 | Equivalencia (datos malformados) | BCRA responde sin la variable del dólar | Se usa DolarAPI oficial | fuente DolarAPI Oficial | Media | U |
| CP-FIN-13-08 | Equivalencia (datos malformados) | BCRA responde con un formato inesperado (sin `results`) | Se usa DolarAPI oficial | fuente DolarAPI Oficial | Media | U |
| CP-FIN-13-09 | Equivalencia (datos malformados) | DolarAPI oficial responde compra y venta `"sin datos"` (BCRA caído) | Una cotización no numérica no se acepta; se usa DolarAPI blue | valor numérico y positivo, fuente DolarAPI Blue | Alta | U |
| CP-FIN-13-10 | Equivalencia (datos malformados) | DolarAPI oficial responde sin compra ni venta (detalle) | Se usa DolarAPI blue | fuente DolarAPI Blue, venta 1200 | Media | U |
| CP-FIN-13-11 | Valor límite (caché) | Segunda consulta a los 5 min − 1 ms y tercera a los 5 min exactos | Se reutiliza la cotización antes del límite y se consulta de nuevo al cumplirse | 1 consulta antes del límite, 2 en total | Media | U |
| CP-FIN-13-12 | Equivalencia (válida) | Convertir USD 100 con cotización 1250,5 | ARS 125.050 | resultado = 125050 | Media | U |

**Nota de proceso:** los casos se documentaron junto con el test automatizado el mismo 19/10, después de escribirlo; no se fijaron antes como los de REQ-FIN-02 a 06.
**Defectos:** CP-FIN-13-09 → DEF-013.
