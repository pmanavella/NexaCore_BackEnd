# Matriz de riesgos

**NexaCore · Módulo Financiero · TP Integrador de Calidad de Software**
Versión 1.3 · 25 de octubre de 2026 · Responsable: Pilar

La matriz prioriza los riesgos de producto y de proyecto según probabilidad × impacto. Las prioridades orientan dónde se concentran las pruebas y la cobertura (sección 6). Se revisa al registrar la línea base, cada vez que una prueba confirma o descarta un riesgo, y al cierre.

Cada versión agrega la evidencia nueva con su fecha, sin borrar la anterior. Las versiones completas anteriores se consultan en git: `git log -- docs/matriz-riesgos.md`.

## Control de cambios

| Versión | Fecha | Cambios |
|---|---|---|
| 1.0 | 17/10/2026 | Versión inicial |
| 1.1 | 18/10/2026 | Los tests confirman R-02 (DEF-001, DEF-002) y R-09 (DEF-005, DEF-006): ambos pasan a nivel 9. R-09 se amplía a las dos vías de importación. Nuevo riesgo de proyecto R-21. Se actualiza el orden de la sección 6 |
| 1.2 | 19/10/2026 | Los tests confirman R-01 (DEF-009 a 011, detectados el 18/10 y no incorporados en la v1.1): pasa a nivel 9. Confirman R-11 (DEF-013): pasa a nivel 6. Nueva evidencia en R-03 (DEF-012) y R-09 (DEF-014, DEF-015), sin cambio de nivel. Evidencia de la línea base en R-14 y del estado de los defectos en R-21. Nuevos riesgos R-22 (suscripciones, H-23) y R-23 (dependencias, H-48). Se actualiza la sección 6 con lo ya automatizado |
| 1.3 | 25/10/2026 | Nueva evidencia en R-02 (DEF-018) y R-11 (DEF-019), sin cambio de nivel. R-14 y R-21 bajan a probabilidad 1 (nivel 3 Media): cobertura de 88,1 % (EV-58) y defectos críticos verificados. Nuevo riesgo R-24 (latencia de los endpoints de Finanzas, H-54 y H-55). Se actualiza el mapa de calor |

## 1. Escalas

| Valor | Probabilidad | Impacto |
|---|---|---|
| 1 · Baja | Poco probable; hay controles o pruebas que lo cubren | Molestia menor; no afecta datos ni decisiones |
| 2 · Media | Puede ocurrir; no hay pruebas o hay indicios en el código | Afecta una funcionalidad o exige corrección manual |
| 3 · Alta | Ya hay evidencia en el código, en la auditoría o en una prueba ejecutada | Datos financieros incorrectos o expuestos, acceso indebido, o pone en riesgo la entrega |

**Nivel = probabilidad × impacto.** Alta: 6 a 9 · Media: 3 a 4 · Baja: 1 a 2.

## 2. Riesgos de producto

| ID | Riesgo | Evidencia | P | I | Nivel | Requisito | Respuesta |
|---|---|---|---|---|---|---|---|
| R-01 | Sueldos mal calculados en alguna combinación de tipo, estructura, moneda y cotización | Muchas combinaciones posibles y ningún test sobre salarios; se aceptan montos negativos y el backend no verifica la conversión a pesos (H-20, H-21). **Confirmado por tests el 18/10:** se aceptan montos y cantidades negativos (DEF-009), los dólares se guardan como pesos (DEF-010) y el tipo de salario se reemplaza en silencio (DEF-011) | **3** | 3 | **9 Alta** | REQ-FIN-05, 06 | Tabla de decisión completa; tests parametrizados sobre `salariosService`. Corrección según RN-03; casos de sueldos como regresión |
| R-02 | Un usuario sin permiso accede al módulo o a los sueldos | **Confirmado por tests el 17/10:** cualquier rol sin permiso consulta y modifica Finanzas, y el permiso lector permite modificar (DEF-001, DEF-002). **El 22/10** se confirma el acceso directo a Supabase con la clave pública (anon): permitía leer sueldos y asignarse permisos (DEF-018, CP-FIN-16-09); corregido con una migración, verificado en nexacore-test (EV-47a, EV-47b, EV-54a, EV-54b) y aplicado y verificado en producción el 25/10 (EV-69a a EV-69c) | **3** | 3 | **9 Alta** | REQ-FIN-16, 17 | Corrección de los middlewares según RN-02; tabla de decisión automatizada como regresión |
| R-03 | Categorías inconsistentes: rechazos de datos válidos o clasificación errónea | La lista está copiada en cuatro archivos y la de la importación no incluye Suscripción (H-01, H-02). **Confirmado por tests el 19/10:** la importación por Excel rechazaba el archivo completo con la categoría Suscripción (DEF-012) | 3 | 2 | **6 Alta** | REQ-FIN-02, 03, 04 | Clases de equivalencia sobre las siete categorías en cada vía de carga; unificar la lista (mejora antes/después, hecha el 19/10 en el backend) |
| R-04 | El libro diario no coincide con los movimientos registrados | Lógica contable dentro de un componente del frontend de más de mil líneas, mezclada con Inversiones; clasificación por subcadena (H-28, H-29) | 2 | 3 | **6 Alta** | REQ-FIN-14, 15 | Pruebas de sistema comparando movimientos sembrados con el libro y el PDF |
| R-05 | Monto de un comprobante registrado sin IVA o con totales mal conciliados | Depende de la extracción por IA; hay tests sobre extracción y conciliación | 1 | 3 | 3 Media | REQ-FIN-09, 10 | Valores límite sobre totales e IVA; ampliar los tests existentes de `documentExtraction` |
| R-06 | Comprobante duplicado no detectado, gasto registrado dos veces | Existe detección por huella y tiene tests | 1 | 3 | 3 Media | REQ-FIN-11 | Casos con el mismo archivo y con archivos casi iguales |
| R-07 | Comprobantes accesibles sin autorización | URL firmada y bucket privado; sin pruebas de acceso | 1 | 3 | 3 Media | REQ-FIN-12 | Pruebas de acceso con y sin permiso, y con URL vencida |
| R-08 | Las alertas de vencimiento no llegan al usuario | La función de próximos vencimientos no se usa en el frontend (H-04). El 19/10, el servicio pasa sus tests unitarios (CP-FIN-08-01 a 08-08) sin defectos: el riesgo queda en el frontend (CP-FIN-08-09, de sistema) | 2 | 2 | 4 Media | REQ-FIN-08 | Verificar el flujo completo; registrar defecto si se confirma |
| R-09 | Una importación (histórica o por Excel) guarda montos o datos erróneos | **Confirmado por tests el 17/10:** `1.234,56` se guarda como 1,23 y `1.234` como 1,234; montos válidos se rechazan (DEF-005, DEF-006). Además, la inserción por lotes no es transaccional (H-13). **El 19/10** se confirman errores de fechas en el Excel: rechaza el formato de la plantilla (DEF-014) y acepta fechas inexistentes (DEF-015) | **3** | **3** | **9 Alta** | REQ-FIN-03, 04 | Corrección según RN-01; casos de montos y fechas automatizados como regresión; prueba de atomicidad |
| R-22 | Una suscripción se guarda con una moneda o frecuencia distinta de la enviada | El servicio reemplaza en silencio los valores inválidos por ARS y mensual, y su propia validación de moneda y frecuencia nunca se ejecuta (H-23, 19/10) | 3 | 2 | **6 Alta** | REQ-FIN-07 | Clases de equivalencia inválidas en alta y edición (CP-FIN-07-01 a 07-04); corrección si se confirma |
| R-24 | La latencia de los endpoints de Finanzas supera el umbral de rendimiento | `GET /api/finance/movimientos` devuelve la tabla completa, sin paginación (H-54, 24/10). **Medido con k6 el 25/10:** `/movimientos/flujo` supera el p95 de 1500 ms en todas las cargas (2540 a 2643 ms en stress, 2577 ms en esfuerzo sostenido) y `/metricas` queda en 1530 ms en esfuerzo sostenido (H-55; EV-66c, EV-66d) | 3 | 2 | **6 Alta** | No funcional (rendimiento) | Umbrales de latencia por endpoint en k6 (EV-65). Para la tesis: optimizar el cálculo de `/movimientos/flujo`, paginar `/movimientos` (H-54, H-55) y medir la línea base de cada endpoint antes de fijar los umbrales |

## 3. Riesgos de dependencias externas

| ID | Riesgo | Evidencia | P | I | Nivel | Respuesta |
|---|---|---|---|---|---|---|
| R-10 | Caída o indisponibilidad de Supabase | Dependencia de base de datos y autenticación de todo el sistema | 1 | 3 | 3 Media | Plan de contingencia y pruebas de indisponibilidad (Valentina) |
| R-11 | API del dólar caída o con datos malformados | Servicio externo consultado desde el frontend (`dolarService.js`), con caché (H-24). **Confirmado por tests el 19/10:** una cotización no numérica se aceptaba como NaN en lugar de pasar a la fuente siguiente (DEF-013). **El 23/10**, en la verificación cruzada de DEF-013, se confirma lo mismo en la cotización detallada y en la del BCRA (DEF-019; EV-53a, EV-53b); queda abierto para la entrega | **3** | 2 | **6 Alta** | Tests con dobles de prueba sobre `dolarService.js`: respuesta válida, error, datos malformados y caída (Victoria). CP-FIN-13-09 como regresión de DEF-013 |
| R-12 | Servicio de OCR (Gemini) caído, con extracción errónea o costo elevado | Servicio de IA externo; el flujo de revisión manual mitiga errores | 2 | 2 | 4 Media | Dobles de prueba; verificar que una falla derive a revisión manual; sin pruebas de carga |
| R-13 | El backend falla al desplegar por la versión de Node | Dockerfile en Node 18; supabase-js requiere Node 20 o superior (H-08) | 2 | 3 | **6 Alta** | Actualizar a Node 22 y verificar con smoke test (Valentina, 18 oct.) |
| R-23 | Una vulnerabilidad en una dependencia compromete el backend | `npm audit` informa 10 vulnerabilidades (1 crítica y 7 altas), entre ellas `xlsx`, que procesa los archivos que suben los usuarios (H-48, 19/10) | 2 | 3 | **6 Alta** | Registrarlo y declararlo en el análisis crítico; actualizar o reemplazar `xlsx` queda fuera del alcance del trabajo |

## 4. Riesgos de proyecto

| ID | Riesgo | Evidencia | P | I | Nivel | Respuesta |
|---|---|---|---|---|---|---|
| R-14 | No alcanzar el 80 % de cobertura del backend del módulo | Solo 8 tests propios antes del trabajo, todos sobre comprobantes (H-07). Línea base del 19/10: 28,0 % de sentencia y 46,4 % de decisión (SonarQube). Integración local del 19/10: 90,2 % y 74,5 % (Node), no oficial. **Al 25/10:** cobertura de 88,1 % (EV-58) | **1** | 3 | 3 Media | Priorizar por esta matriz; mecanismo de compensación con tests de Pilar; declarar meta pendiente si no se alcanza. Se revisa con la cifra oficial del pipeline |
| R-15 | Retraso del pipeline, que es el camino crítico | Dos repositorios; frontend sin CI; SonarQube, Cypress y Node por incorporar | 2 | 3 | **6 Alta** | Esqueleto mínimo el 18 y mejoras incrementales; revisión diaria del avance |
| R-16 | Cifras del informe distintas de las del pipeline | Muchas fuentes de métricas y dos repositorios | 2 | 2 | 4 Media | Congelamiento del código el 23; conciliación conjunta el 24 y 25 |
| R-17 | Pruebas ejecutadas por error sobre desarrollo o producción | Hoy no existe un entorno de pruebas separado | 1 | 3 | 3 Media | Uso exclusivo de nexacore-test con secretos propios; los tests actuales usan dobles de prueba |
| R-18 | Métricas distorsionadas por código de Inversiones dentro de archivos de Finanzas | Cinco archivos mixtos (H-06) | 3 | 1 | 3 Media | Declararlo en el informe; usarlo como evidencia de mantenibilidad |
| R-19 | Una integrante no puede explicar partes ajenas en la defensa individual | Trabajo dividido por ejes | 2 | 2 | 4 Media | Revisión cruzada y ensayo de defensa |
| R-20 | Límites de los planes gratuitos durante las pruebas de carga o el análisis | Plan gratuito de Supabase y SonarQube Cloud | 1 | 2 | 2 Baja | Carga acotada a los límites del plan; análisis restringido al módulo |
| R-21 | Los defectos críticos no se corrigen y verifican antes del congelamiento | Seis defectos abiertos el 18/10, tres de severidad crítica; la corrección depende del pipeline. Al 19/10: 15 defectos registrados (4 críticos), todos corregidos en ramas sin integrar y ninguno verificado. **Al 25/10:** los defectos críticos (DEF-001, DEF-005, DEF-006, DEF-010 y DEF-018) están verificados y cerrados; de los 19 registrados solo sigue abierto DEF-019, de severidad media | **1** | 3 | 3 Media | Corregir primero los críticos (DEF-001, DEF-005, DEF-006); cada corrección con su regresión en verde antes del 23. Verificación cruzada acordada el 19/10 |

## 5. Mapa de calor

| Probabilidad \ Impacto | 1 · Bajo | 2 · Medio | 3 · Alto |
|---|---|---|---|
| **3 · Alta** | R-18 | R-03, R-11, R-22, R-24 | R-01, R-02, R-09 |
| **2 · Media** | | R-08, R-12, R-16, R-19 | R-04, R-13, R-15, R-23 |
| **1 · Baja** | | R-20 | R-05, R-06, R-07, R-10, R-14, R-17, R-21 |

## 6. Cómo orienta las pruebas y la cobertura

Orden de prioridad para la batería de tests del backend (Victoria) y los casos de caja negra (Pilar):

1. **Permisos en las rutas de Finanzas** (R-02). Automatizado el 17/10 (`test/finanzas.permisos.test.js`); queda como regresión de DEF-001 a DEF-004.
2. **Montos y fechas en las importaciones** (R-09, R-03: `migradorUtils.js`, `excelService.js`, `finance/utils/fechas.js`). Montos automatizados el 17/10 (`test/finanzas.montos.test.js`), regresión de DEF-005 y DEF-006. Categorías y fechas del Excel automatizadas el 19/10, regresión de DEF-012, DEF-014 y DEF-015. Falta la prueba de atomicidad (CP-FIN-04-06).
3. **Sueldos** (`finance/services/salariosService.js` y su controlador): R-01. Automatizado el 18/10 (`test/finanzas.sueldos.test.js`); regresión de DEF-009 a DEF-011.
4. **Categorías y alta de movimientos** (`finance/config/movimientos.js`, `movimientosService.js`): R-03. Automatizado el 18/10 (`test/finanzas.movimientos.test.js`); regresión de DEF-007 y DEF-008.
5. **Suscripciones y vencimientos** (`suscripcionesService.js`): R-08 y R-22. Vencimientos automatizados el 19/10 (CP-FIN-08-01 a 08-08); moneda y frecuencia inválidas en CP-FIN-07-01 a 07-04.
6. **Comprobantes** (`documentExtraction.js`, `comprobantesService.js`): R-05, R-06, R-07. Ya tenían tests; ampliados el 19/10 con el flujo completo.
7. **Cotización del dólar**: R-11, con dobles de prueba sobre `dolarService.js` del frontend. Automatizado el 19/10; regresión de DEF-013.

El libro diario (R-04) vive en el frontend, que no tiene umbral de cobertura: se verifica con pruebas de sistema que comparan los movimientos sembrados con el libro y con el PDF exportado.