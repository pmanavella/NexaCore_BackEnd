# Hallazgos de auditoría

H-01 a H-47 surgen de la lectura del código (17 y 18/10/2026); los posteriores indican en la descripción cuándo y cómo se detectaron. **No son defectos**: cada uno se verifica con su caso de prueba y, si el caso falla, se registra como `DEF-NNN` en GitHub Issues. Los marcados como *inferido* no fueron ejecutados ni siquiera en la auditoría.

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
| H-48 | `npm audit` informa 10 vulnerabilidades en dependencias del backend (1 crítica y 7 altas), entre ellas `xlsx`, que usa la importación por Excel. Riesgo de dependencias, no defecto del módulo. Detectado por Victoria (19/10) | — (se verifica con `npm audit`) |
| H-52 | SonarQube Cloud, en el plan gratuito, no analiza pull requests: el análisis y el quality gate corren solo en el push a develop. Un cambio puede pasar todos los checks del pull request y recién fallar el quality gate cuando ya está en develop. Detectado por Valentina al configurar el pipeline; mitigación: el job de SonarQube corre en cada push a develop y su resultado se revisa después de cada merge | — |

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
| H-14 | Endpoint Excel: valida la fecha con un parser distinto del que guarda; rechaza `31/12/2026` (formato de la plantilla) y deja pasar `2026-02-31`. Confirmado como DEF-014 (#32) y DEF-015 (#33); DEF-015 corregido en 32668b8 | CP-FIN-04-03, 04-04, 04-13 a 04-15 |
| H-15 | Endpoint Excel: rechaza `" Gasto"` aunque al guardar recorta; un encabezado con acento no coincide; el detalle de errores no llega al cliente | CP-FIN-04-05, 04-09 |
| H-16 | Migración: `"1.234,56"` se guarda como 1,23 y `"1,5"` como 15 | CP-FIN-03-01, 03-02 |
| H-17 | Migración: la categoría se asigna por coincidencia parcial; el concepto `"a"` queda como Tecnología | CP-FIN-03-06 |
| H-18 | Migración: confirmar y revertir exigen el rol `Admin`, que no existe; Dirección no puede hacerlo | CP-FIN-03-07 |
| H-19 | Migración: revertir no es transaccional y borra registros aunque se hayan editado después | CP-FIN-03-08 |
| H-49 | `parsearFecha`: el último recurso (`new Date`) acepta formatos que la plantilla no anuncia y convierte en silencio una fecha inexistente en otra válida (`2026/02/31` → 2026-03-03). Detectado al corregir DEF-015 (19/10); fuera de su alcance | — |

## Sueldos y cotización

| ID | Hallazgo | Casos |
|---|---|---|
| H-20 | Se aceptan montos y cantidades negativos en movimientos salariales | CP-FIN-05-06, 05-07 |
| H-21 | El backend no verifica la conversión a pesos: usa el `monto_ars` que envía el frontend y, si falta, guarda el monto en dólares como si fueran pesos | CP-FIN-06-07, 06-08 |
| H-22 | Un tipo de salario o moneda inválidos se reemplazan en silencio; editar sin enviarlos vuelve el empleado a mensual en pesos y borra la cotización | CP-FIN-05-09, 05-10 |
| H-34 | El campo de monto del formulario de sueldos solo admite dígitos y punto: `800.000` se guarda como 800 | CP-FIN-05-11, 05-12 |
| H-35 | Al llegar la cotización, el formulario de sueldos reemplaza sin aviso el monto que el usuario ya escribió | CP-FIN-06-10 |
| H-36 | En sueldos en dólares, si el usuario edita el monto, `monto_origen × cotización` deja de coincidir con `monto_ars`; ni el frontend ni el backend lo controlan | CP-FIN-06-07, 06-08 |
| H-47 | Con la regla RN-03, un sueldo en dólares solo puede ajustarse en dólares, pero el formulario de edición del frontend solo envía el monto en pesos: el monto de un sueldo en dólares no puede modificarse desde la pantalla (sí la descripción y la fecha). Además, al editar un movimiento en dólares la cantidad de horas o turnos se ignora | Mejora del frontend pendiente |
| H-24 | El backend no consulta ningún servicio de cotización: la consulta externa está en el frontend (`dolarService.js`); el POST guarda la cotización sin validar | Ver nota al final |

## Suscripciones

| ID | Hallazgo | Casos |
|---|---|---|
| H-23 | `dias=0` se trata como 7; moneda y frecuencia inválidas se reemplazan en silencio; un pago se reconoce por coincidencias de texto. Moneda y frecuencia inválidas confirmadas como DEF-016 (#34) por CP-FIN-07-01 a 07-04; corregido en 5e1d73d.| CP-FIN-08-06, CP-FIN-07-01 a 07-04 |
| H-50 | H-50: número no asignado. La numeración pasa de H-49 a H-51; no se renumera para no cambiar las referencias existentes | — |
| H-51 | `datos-de-prueba.md` v1.1 definía S-06 con estado "Inactiva", que no pertenece al dominio del esquema (`activa`, `pausada`, `cancelada`). Hallazgo de documentación (verificación estática), no defecto del módulo. Detectado por Valentina al implementar el seed de nexacore-test (22/10, commit b20a93b); confirmado y corregido en la v1.2 (23/10) | CP-FIN-08-08 |

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

## Indisponibilidad de Supabase (relevado el 18/10 para el plan de contingencia)

| ID | Hallazgo | Casos |
|---|---|---|
| H-37 | `GET /api/health` siempre responde 200 sin consultar Supabase | CP-FIN-18-01 |
| H-38 | Las fallas de Supabase llegan al cliente como HTTP 500 con el mensaje técnico o el HTML de la página de error; nunca 503. Con la base caída, un batch se informa como "no encontrado" (404) | CP-FIN-18-02, 18-03 |
| H-39 | Si cae Supabase Auth, la autenticación responde 401 "Token inválido o expirado", igual que con un token inválido | CP-FIN-18-04 |
| H-40 | Sin timeouts en el cliente de Supabase, en Express ni en el frontend: las peticiones pueden quedar colgadas varios minutos | CP-FIN-18-05 |
| H-41 | Operaciones de varios pasos sin transacciones: archivos huérfanos, comprobantes procesados sin movimiento, batches trabados en "procesando" que no se pueden revertir, importaciones parciales; la limpieza nocturna puede dejar filas apuntando a archivos borrados | CP-FIN-18-06 a 18-08 |
| H-42 | Ante un error, las pantallas de Finanzas muestran "No hay … registradas", sin aviso ni reintento; los mensajes de error son técnicos | CP-FIN-18-09, 18-10 |
| H-43 | Una caída se informa en el inicio de sesión como "Email o contraseña incorrectos"; pueden quedar sesiones a medias | CP-FIN-18-11 |
| H-44 | Logs solo en consola, sin ruta, usuario ni hora; los procesos programados no registran su resultado ni reintentan; no hay `HEALTHCHECK` | — |
| H-45 | Al crear un gasto con una suscripción nueva, si falla el segundo paso la suscripción queda creada y reintentar la duplica | — |

## Rendimiento

| ID | Hallazgo | Casos |
|---|---|---|
| H-54 | `GET /api/finance/movimientos` devuelve la tabla completa, sin paginación ni límite. Con los datos del seed es chica, pero con datos reales la latencia y el tamaño de la respuesta crecerían con la cantidad de movimientos. Detectado por Valentina al diseñar las pruebas de carga (24/10) | — |
| H-55 | `GET /api/finance/movimientos/flujo` supera el umbral de rendimiento (p95 < 1500 ms) en todas las cargas: 2540 a 2643 ms en el stress de 2 a 30 pet/s y 2577 ms en el esfuerzo sostenido de 15 min. Su latencia no crece con la carga y no hay errores, así que no es saturación sino el costo propio del endpoint (calcula el flujo sobre todos los movimientos, sin paginación: H-54). `/metricas` queda apenas por encima en el esfuerzo sostenido (1530 ms). La latencia de base de las rutas de Finanzas medida desde GitHub Actions ronda 1,5 s: tres llamadas en serie a Supabase, en otra región. Detectado por Valentina con k6 (25/10, Rendimiento #2; EV-66c, EV-66d) | — |

## Tests del equipo

| ID | Hallazgo | Casos |
|---|---|---|
| H-46 | 4 de los 8 tests de `documentExtraction.test.js` fallaban en `develop` desde el commit `1f04ba4` (14/09), sin que nadie lo notara durante un mes porque los tests no se ejecutaban en ningún pipeline. No era un defecto del código: los tests quedaron desactualizados por dos cambios de regla intencionales (renglones netos contra subtotal; categoría inválida como advertencia). Se actualizaron con el pull request #29 (commit 85f7590), mergeado a develop el 18/10 (d443536), antes de la línea base (8 de 8 en verde). El merge se hizo sin la revisión de otra integrante que exige el plan de pruebas; la revisión queda pendiente | — |
| H-53 | El helper `pedir()` de 8 archivos de test levanta Express con `listen(0)`, que escucha en todas las direcciones, y después se conecta a `127.0.0.1`. En macOS, si otro proceso ya escucha en `127.0.0.1` en el puerto asignado (en el caso detectado, procesos de VS Code y de la extensión de SonarQube), la petición le llega a ese proceso y el test falla con `HTTPParserError`, porque recibe HTTP/2. Falla intermitente solo en máquinas locales (`npm test` del 25/10: 992 de 997, falla CP-FIN-02-01); en el pipeline no ocurre porque el runner no tiene otros procesos escuchando. No es un defecto del módulo. Corrección propuesta: `listen(0, '127.0.0.1')`. Detectado por Valentina (25/10) | CP-FIN-02-01 |

## Nota sobre la cotización del dólar (H-24)

Las pruebas con dobles de prueba de la API del dólar (tarea de Victoria) no pueden hacerse en el backend, porque ahí no hay llamada externa. Se hacen sobre `src/lib/dolarService.js` del frontend con `node:test`, que viene con Node y no requiere instalar nada, simulando `fetch` con `t.mock.method`. Si el archivo depende de algo propio de Vite, se evalúa el plan de respaldo con Vitest.
