# Matriz de riesgos

**NexaCore · Módulo Financiero · TP Integrador de Calidad de Software**
Versión 1.1 · 18 de octubre de 2026 · Responsable: Pilar

La matriz prioriza los riesgos de producto y de proyecto según probabilidad × impacto. Las prioridades orientan dónde se concentran las pruebas y la cobertura (sección 6). Se revisa al registrar la línea base, cada vez que una prueba confirma o descarta un riesgo, y al cierre.

## Control de cambios

| Versión | Fecha | Cambios |
|---|---|---|
| 1.0 | 17/10/2026 | Versión inicial |
| 1.1 | 18/10/2026 | Los tests confirman R-02 (DEF-001, DEF-002) y R-09 (DEF-005, DEF-006): ambos pasan a nivel 9. R-09 se amplía a las dos vías de importación. Nuevo riesgo de proyecto R-21. Se actualiza el orden de la sección 6 |

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
| R-01 | Sueldos mal calculados en alguna combinación de tipo, estructura, moneda y cotización | Muchas combinaciones posibles y ningún test sobre salarios; se aceptan montos negativos y el backend no verifica la conversión a pesos (H-20, H-21) | 2 | 3 | **6 Alta** | REQ-FIN-05, 06 | Tabla de decisión completa; tests parametrizados sobre `salariosService` |
| R-02 | Un usuario sin permiso accede al módulo o a los sueldos | **Confirmado por tests el 17/10:** cualquier rol sin permiso consulta y modifica Finanzas, y el permiso lector permite modificar (DEF-001, DEF-002) | **3** | 3 | **9 Alta** | REQ-FIN-16, 17 | Corrección de los middlewares según RN-02; tabla de decisión automatizada como regresión |
| R-03 | Categorías inconsistentes: rechazos de datos válidos o clasificación errónea | La lista está copiada en cuatro archivos y la de la importación no incluye Suscripción (H-01, H-02) | 3 | 2 | **6 Alta** | REQ-FIN-02, 03, 04 | Clases de equivalencia sobre las siete categorías en cada vía de carga; unificar la lista (mejora antes/después) |
| R-04 | El libro diario no coincide con los movimientos registrados | Lógica contable dentro de un componente del frontend de más de mil líneas, mezclada con Inversiones; clasificación por subcadena (H-28, H-29) | 2 | 3 | **6 Alta** | REQ-FIN-14, 15 | Pruebas de sistema comparando movimientos sembrados con el libro y el PDF |
| R-05 | Monto de un comprobante registrado sin IVA o con totales mal conciliados | Depende de la extracción por IA; hay tests sobre extracción y conciliación | 1 | 3 | 3 Media | REQ-FIN-09, 10 | Valores límite sobre totales e IVA; ampliar los tests existentes de `documentExtraction` |
| R-06 | Comprobante duplicado no detectado, gasto registrado dos veces | Existe detección por huella y tiene tests | 1 | 3 | 3 Media | REQ-FIN-11 | Casos con el mismo archivo y con archivos casi iguales |
| R-07 | Comprobantes accesibles sin autorización | URL firmada y bucket privado; sin pruebas de acceso | 1 | 3 | 3 Media | REQ-FIN-12 | Pruebas de acceso con y sin permiso, y con URL vencida |
| R-08 | Las alertas de vencimiento no llegan al usuario | La función de próximos vencimientos no se usa en el frontend (H-04) | 2 | 2 | 4 Media | REQ-FIN-08 | Verificar el flujo completo; registrar defecto si se confirma |
| R-09 | Una importación (histórica o por Excel) guarda montos o datos erróneos | **Confirmado por tests el 17/10:** `1.234,56` se guarda como 1,23 y `1.234` como 1,234; montos válidos se rechazan (DEF-005, DEF-006). Además, la inserción por lotes no es transaccional (H-13) | **3** | **3** | **9 Alta** | REQ-FIN-03, 04 | Corrección según RN-01; casos de montos automatizados como regresión; prueba de atomicidad |

## 3. Riesgos de dependencias externas

| ID | Riesgo | Evidencia | P | I | Nivel | Respuesta |
|---|---|---|---|---|---|---|
| R-10 | Caída o indisponibilidad de Supabase | Dependencia de base de datos y autenticación de todo el sistema | 1 | 3 | 3 Media | Plan de contingencia y pruebas de indisponibilidad (Valentina) |
| R-11 | API del dólar caída o con datos malformados | Servicio externo consultado desde el frontend (`dolarService.js`), con caché (H-24) | 2 | 2 | 4 Media | Tests con dobles de prueba sobre `dolarService.js`: respuesta válida, error, datos malformados y caída (Victoria) |
| R-12 | Servicio de OCR (Gemini) caído, con extracción errónea o costo elevado | Servicio de IA externo; el flujo de revisión manual mitiga errores | 2 | 2 | 4 Media | Dobles de prueba; verificar que una falla derive a revisión manual; sin pruebas de carga |
| R-13 | El backend falla al desplegar por la versión de Node | Dockerfile en Node 18; supabase-js requiere Node 20 o superior (H-08) | 2 | 3 | **6 Alta** | Actualizar a Node 22 y verificar con smoke test (Valentina, 18 oct.) |

## 4. Riesgos de proyecto

| ID | Riesgo | Evidencia | P | I | Nivel | Respuesta |
|---|---|---|---|---|---|---|
| R-14 | No alcanzar el 80 % de cobertura del backend del módulo | Solo 8 tests propios antes del trabajo, todos sobre comprobantes (H-07) | 3 | 3 | **9 Alta** | Priorizar por esta matriz; mecanismo de compensación con tests de Pilar; declarar meta pendiente si no se alcanza |
| R-15 | Retraso del pipeline, que es el camino crítico | Dos repositorios; frontend sin CI; SonarQube, Cypress y Node por incorporar | 2 | 3 | **6 Alta** | Esqueleto mínimo el 18 y mejoras incrementales; revisión diaria del avance |
| R-16 | Cifras del informe distintas de las del pipeline | Muchas fuentes de métricas y dos repositorios | 2 | 2 | 4 Media | Congelamiento del código el 23; conciliación conjunta el 24 y 25 |
| R-17 | Pruebas ejecutadas por error sobre desarrollo o producción | Hoy no existe un entorno de pruebas separado | 1 | 3 | 3 Media | Uso exclusivo de nexacore-test con secretos propios; los tests actuales usan dobles de prueba |
| R-18 | Métricas distorsionadas por código de Inversiones dentro de archivos de Finanzas | Cinco archivos mixtos (H-06) | 3 | 1 | 3 Media | Declararlo en el informe; usarlo como evidencia de mantenibilidad |
| R-19 | Una integrante no puede explicar partes ajenas en la defensa individual | Trabajo dividido por ejes | 2 | 2 | 4 Media | Revisión cruzada y ensayo de defensa |
| R-20 | Límites de los planes gratuitos durante las pruebas de carga o el análisis | Plan gratuito de Supabase y SonarQube Cloud | 1 | 2 | 2 Baja | Carga acotada a los límites del plan; análisis restringido al módulo |
| R-21 | Los defectos críticos no se corrigen y verifican antes del congelamiento | Seis defectos abiertos el 18/10, tres de severidad crítica; la corrección depende del pipeline | 2 | 3 | **6 Alta** | Corregir primero los críticos (DEF-001, DEF-005, DEF-006); cada corrección con su regresión en verde antes del 23 |

## 5. Mapa de calor

| Probabilidad \ Impacto | 1 · Bajo | 2 · Medio | 3 · Alto |
|---|---|---|---|
| **3 · Alta** | R-18 | R-03 | R-02, R-09, R-14 |
| **2 · Media** | | R-08, R-11, R-12, R-16, R-19 | R-01, R-04, R-13, R-15, R-21 |
| **1 · Baja** | | R-20 | R-05, R-06, R-07, R-10, R-17 |

## 6. Cómo orienta las pruebas y la cobertura

Orden de prioridad para la batería de tests del backend (Victoria) y los casos de caja negra (Pilar):

1. **Permisos en las rutas de Finanzas** (R-02). Automatizado el 17/10 (`test/finanzas.permisos.test.js`); queda como regresión de DEF-001 a DEF-004.
2. **Montos en las importaciones** (R-09: `migradorUtils.js`, `excelService.js`). Automatizado el 17/10 (`test/finanzas.montos.test.js`); queda como regresión de DEF-005 y DEF-006. Falta la prueba de atomicidad (CP-FIN-04-06).
3. **Sueldos** (`finance/services/salariosService.js` y su controlador): R-01. Siguiente a automatizar.
4. **Categorías y alta de movimientos** (`finance/config/movimientos.js`, `movimientosService.js`): R-03. Siguiente a automatizar.
5. **Suscripciones y vencimientos** (`suscripcionesService.js`): R-08.
6. **Comprobantes** (`documentExtraction.js`, `comprobantesService.js`): R-05, R-06, R-07. Ya tienen tests; se amplían los casos límite.
7. **Cotización del dólar**: R-11, con dobles de prueba sobre `dolarService.js` del frontend.

El libro diario (R-04) vive en el frontend, que no tiene umbral de cobertura: se verifica con pruebas de sistema que comparan los movimientos sembrados con el libro y con el PDF exportado.
