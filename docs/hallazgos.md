# Hallazgos de auditoría

Surgen de la lectura del código (17 y 18/10/2026). **No son defectos**: cada uno se verifica con su caso de prueba y, si el caso falla, se registra como `DEF-NNN` en GitHub Issues. Los marcados como *inferido* no fueron ejecutados ni siquiera en la auditoría.

## Alcance, estructura y entorno

| ID | Hallazgo | Casos |
|---|---|---|
| H-01 | El código maneja siete categorías; la documentación previa decía cuatro | CP-FIN-02-01, 02-03 |
| H-02 | La lista de categorías está copiada en cuatro archivos; la del endpoint Excel no incluye Suscripción | CP-FIN-04-01 |
| H-03 | El endpoint de importación Excel no lo usa ninguna pantalla | — |
| H-04 | La consulta de próximos vencimientos no se usa en el frontend | CP-FIN-08-09 |
| H-05 | Código muerto: `sueldosHistoricos.js`, `Dashboard.jsx`, archivos de Tesseract | — |
| H-06 | Lógica de Inversiones mezclada en cinco archivos de Finanzas | — |
| H-07 | Solo 8 tests propios del módulo; el frontend no tiene tests y el CI no ejecuta pruebas | — |
| H-08 | El backend declara Node 18, pero supabase-js requiere Node 20 o superior | Smoke tras actualizar |
| H-09 | Sin análisis estático, linter ni cobertura; el frontend no tiene CI | — |

## Validación de movimientos

| ID | Hallazgo | Casos |
|---|---|---|
| H-10 | Un monto no numérico (`"abc"`) pasa la validación y termina en error 500 | CP-FIN-02-06 |
| H-11 | No hay monto máximo ni control de precisión: `0.001` y montos sobre 13 enteros terminan en error 500 (*inferido*) | CP-FIN-02-11, 02-13 |
| H-12 | La fecha no se valida: `2026-02-31` termina en error 500 | CP-FIN-02-08 |

## Importación

| ID | Hallazgo | Casos |
|---|---|---|
| H-13 | Endpoint Excel: un monto `0` numérico pasa la validación y aborta el lote; la inserción por lotes no es transaccional y deja importaciones parciales | CP-FIN-04-02, 04-06 |
| H-14 | Endpoint Excel: valida la fecha con un parser distinto del que guarda; rechaza `31/12/2026` (formato de la plantilla) y deja pasar `2026-02-31` | CP-FIN-04-03, 04-04 |
| H-15 | Endpoint Excel: rechaza `" Gasto"` aunque al guardar recorta; un encabezado con acento no coincide; el detalle de errores no llega al cliente | CP-FIN-04-05, 04-09 |
| H-16 | Migración: `"1.234,56"` se guarda como 1,23 y `"1,5"` como 15 | CP-FIN-03-01, 03-02 |
| H-17 | Migración: la categoría se asigna por coincidencia parcial; el concepto `"a"` queda como Tecnología | CP-FIN-03-06 |
| H-18 | Migración: confirmar y revertir exigen el rol `Admin`, que no existe; Dirección no puede hacerlo | CP-FIN-03-07 |
| H-19 | Migración: revertir no es transaccional y borra registros aunque se hayan editado después | CP-FIN-03-08 |

## Sueldos y cotización

| ID | Hallazgo | Casos |
|---|---|---|
| H-20 | Se aceptan montos y cantidades negativos en movimientos salariales | CP-FIN-05-06, 05-07 |
| H-21 | El backend no verifica la conversión a pesos: usa el `monto_ars` que envía el frontend y, si falta, guarda el monto en dólares como si fueran pesos | CP-FIN-06-07, 06-08 |
| H-22 | Un tipo de salario o moneda inválidos se reemplazan en silencio; editar sin enviarlos vuelve el empleado a mensual en pesos y borra la cotización | CP-FIN-05-09, 05-10 |
| H-34 | El campo de monto del formulario de sueldos solo admite dígitos y punto: `800.000` se guarda como 800 | CP-FIN-05-11, 05-12 |
| H-35 | Al llegar la cotización, el formulario de sueldos reemplaza sin aviso el monto que el usuario ya escribió | CP-FIN-06-10 |
| H-36 | En sueldos en dólares, si el usuario edita el monto, `monto_origen × cotización` deja de coincidir con `monto_ars`; ni el frontend ni el backend lo controlan | CP-FIN-06-07, 06-08 |
| H-24 | El backend no consulta ningún servicio de cotización: la consulta externa está en el frontend (`dolarService.js`); el POST guarda la cotización sin validar | Ver nota al final |

## Suscripciones

| ID | Hallazgo | Casos |
|---|---|---|
| H-23 | `dias=0` se trata como 7; moneda y frecuencia inválidas se reemplazan en silencio; un pago se reconoce por coincidencias de texto | CP-FIN-08-06 |

## Permisos

| ID | Hallazgo | Casos |
|---|---|---|
| H-25 | Movimientos, comprobantes, suscripciones e importación solo exigen sesión iniciada: cualquier rol, incluidos Pasante y Externo, puede leer y modificar | CP-FIN-16-03 a 16-08 |
| H-26 | En el frontend el permiso solo oculta el menú: el módulo se carga igual por la ruta; un rol que no figura en la matriz recibe acceso total; Auditor / Lector puede crear, editar y borrar | CP-FIN-16-10 a 16-12 |
| H-27 | Contable, Auditor y Director ven la pestaña Sueldos pero reciben 403; los sueldos desaparecen sin aviso de gastos, movimientos y PDF | CP-FIN-14-06, 17-03 |

## Libro diario y PDF

| ID | Hallazgo | Casos |
|---|---|---|
| H-28 | La clasificación es por subcadena: «cuota social» o «interesante» se clasifican como financieros; el bloque mira categoría o descripción, pero la cuenta solo la descripción | CP-FIN-14-02 |
| H-29 | Resumen Financiero: los egresos financieros se suman como operativos; los importes se redondean sin decimales y la suma de líneas puede no coincidir con el total | CP-FIN-14-04, 14-05 |
| H-30 | El PDF ignora los filtros de pantalla y, si falla la consulta de sueldos o movimientos, se genera incompleto sin aviso | CP-FIN-14-07, 15-02 |
| H-31 | En «Ver Movimientos» el filtro de categoría no tiene efecto y el selector no incluye Suscripción | — |
| H-32 | La fecha inicial del formulario se calcula en UTC: después de las 21 h propone el día siguiente | — |
| H-33 | El OCR sobrescribe fecha, categoría y tipo elegidos por el usuario; editar un sueldo desde Movimientos borra su cuenta contrapartida | — |

## Nota sobre la cotización del dólar (H-24)

Las pruebas con dobles de prueba de la API del dólar (tarea de Victoria) no pueden hacerse en el backend, porque ahí no hay llamada externa. Se hacen sobre `src/lib/dolarService.js` del frontend con `node:test`, que viene con Node y no requiere instalar nada, simulando `fetch` con `t.mock.method`. Si el archivo depende de algo propio de Vite, se evalúa el plan de respaldo con Vitest.
