# Plan de pruebas

**NexaCore · Módulo Financiero · TP Integrador de Calidad de Software**
Responsable: Pilar · Participan: Victoria y Valentina

## Control de versiones

| Versión | Fecha | Tag de git | Cambios |
|---|---|---|---|
| 1.0 | 17/10/2026 | `plan-pruebas-v1.0` | Versión inicial: alcance, estrategia, criterios, entornos y verificación del despliegue |
| 1.1 | 25/10/2026 | `plan-pruebas-v1.1` | Estado final de los criterios de salida (8.1) y matriz ISO/IEC 25010 con las 8 características y el top 3 (sección 15) |

Cada versión se publica con un tag de git. La v1.1 incorpora la matriz ISO/IEC 25010 (sección 15) y el estado final de los criterios de salida (sección 8.1).

## 1. Objetivo

Verificar que el módulo Financiero de NexaCore cumple sus requisitos funcionales, protege la información financiera y funciona de forma confiable con sus dependencias externas, mediante un proceso de pruebas continuo, automatizado y trazable que acompañe el desarrollo hasta la entrega del 26 de octubre de 2026.

## 2. Alcance

### En alcance

Los 17 requisitos del catálogo (`docs/convencion-identificadores.md`, sección 5): registro de ingresos y gastos, importación histórica y por endpoint, sueldos, suscripciones y alertas, comprobantes con OCR, cotización del dólar, libro diario y exportación a PDF, y control de acceso por roles.

| Repositorio | Qué se prueba | Medición |
|---|---|---|
| Backend (`finance/`) | Lógica de negocio, validaciones, API, integración con Supabase | Cobertura con umbral del 80 % y SonarQube |
| Frontend (archivos de Finanzas) | Pantallas, libro diario, PDF, permisos en la interfaz | SonarQube sin umbral de cobertura; pruebas de sistema y E2E |
| Base de datos (nexacore-test) | Persistencia, permisos, indisponibilidad | Pruebas de integración |

El detalle de rutas incluidas y excluidas está en el Anexo B del documento de organización.

### Fuera de alcance

Inversiones, Deudas, Nexi, Panel General, backups automáticos, integración con calendarios y los tipos de importación histórica que no son de gastos (compras internacionales, cuentas por cobrar y totales financieros). Tampoco se hacen pruebas de carga sobre el servicio de OCR.

## 3. Estrategia

### 3.1. Enfoque basado en riesgos

La intensidad de las pruebas se decide con la matriz de riesgos (`docs/matriz-riesgos.md`). Los riesgos de nivel alto reciben casos de todas las técnicas aplicables, automatización y prioridad de ejecución; los de nivel medio, casos de las técnicas principales; los de nivel bajo, verificación puntual. El orden de cobertura del backend sigue la sección 6 de esa matriz.

### 3.2. Niveles de prueba

| Nivel | Qué verifica | Herramienta | Responsable | Automatizado |
|---|---|---|---|---|
| Unitaria | Cálculos, validaciones y reglas de negocio aisladas, con dobles de prueba para servicios externos | node:test | Victoria y Pilar | Sí, en el pipeline |
| Integración | Endpoints de la API con Supabase real (nexacore-test), permisos por ruta, indisponibilidad | node:test con Supertest o node:http | Valentina | Sí, en el pipeline |
| Sistema | Flujos completos desde la interfaz: libro diario, PDF, permisos visibles, alertas | Ejecución manual documentada y Cypress | Pilar y Valentina | Parcial: el flujo E2E y el smoke sí |
| Aceptación | Que los objetivos de calidad del usuario se cumplan (por ejemplo, coincidencia entre movimientos y libro diario) | Casos de aceptación sobre el despliegue | Pilar | No, con evidencia |
| No funcional | Stress y esfuerzo sostenido | k6 | Valentina | Job separado del pipeline |

### 3.3. Técnicas

- **Caja negra** (Pilar): clases de equivalencia, valores límite y tablas de decisión sobre las reglas reales del código.
- **Caja blanca** (Victoria): cobertura de sentencia y de decisión (ramas) medida con la cobertura nativa de Node.
- **Análisis estático** (Victoria): SonarQube Cloud sobre los archivos del módulo en ambos repositorios.
- **Dobles de prueba**: para la API del dólar y el servicio de OCR, simulando respuestas válidas, errores, datos malformados y caídas.

### 3.4. Regresión

Cada defecto corregido tiene al menos una prueba de regresión con nombre `REG DEF-NNN`, que se suma a la batería y se ejecuta en cada corrida del pipeline.

### 3.5. Independencia

Quien corrige un defecto no lo verifica: la prueba de regresión la confirma otra integrante antes de pasar el defecto a `estado: verificado`. Los casos de caja negra (Pilar) se diseñan sin mirar la implementación de los tests unitarios (Victoria), para no repetir los mismos supuestos.

## 4. Entornos y datos

| Elemento | Definición |
|---|---|
| Base de datos | Exclusivamente nexacore-test, con esquema por migraciones y datos ficticios (Anexo A del documento de organización) |
| Datos | Seed reproducible derivado de los casos de prueba; reinicio antes de cada suite que escribe datos |
| Node | Versión 22 en ambos repositorios y en el pipeline |
| Credenciales | Secretos de GitHub propios de nexacore-test |
| Prohibido | Ejecutar cualquier prueba, carga o seed sobre desarrollo o producción |

## 5. Herramientas

| Uso | Herramienta | Situación |
|---|---|---|
| Pruebas unitarias e integración | node:test | Existente |
| Cobertura | Cobertura nativa de Node (lcov) | Incorporada durante el trabajo |
| Pruebas de API | Supertest o node:http | A definir por Valentina |
| E2E y smoke | Cypress | Incorporada durante el trabajo |
| Análisis estático | SonarQube Cloud | Incorporada durante el trabajo |
| Stress y esfuerzo sostenido | k6 | Herramienta nueva (proceso de cinco pasos) |
| Pipeline | GitHub Actions | Existente en el backend; nueva en el frontend |
| Registro de defectos | GitHub Issues (formulario Defecto) | Configurado el 17/10 |

## 6. Responsables

| Actividad | Pilar | Victoria | Valentina |
|---|---|---|---|
| Plan, riesgos, plantillas y trazabilidad | Responsable | Revisa | Revisa |
| Casos de caja negra y su ejecución | Responsable | | |
| Tests unitarios y cobertura | Tests parametrizados | Responsable | |
| Análisis estático y métricas | | Responsable | |
| Pruebas de API, integración, smoke y E2E | | | Responsable |
| Stress y esfuerzo sostenido | | | Responsable |
| Pipeline y quality gate | | Umbrales | Responsable |
| Registro de defectos | Configuración | Registra | Registra y vincula con el pipeline |
| Verificación de correcciones | Las tres, con independencia (3.5) | | |

## 7. Criterios de entrada

La ejecución de pruebas de un requisito comienza cuando se cumple todo lo siguiente:

1. El requisito está validado contra el sistema real y sus diferencias están registradas como hallazgos.
2. Sus casos están diseñados con la plantilla y tienen **criterio de aceptación fijado antes de ejecutar**.
3. nexacore-test está disponible, con el esquema actualizado y los datos del seed cargados.
4. El código a probar compila y la versión está identificada (commit o tag).
5. Para pruebas automatizadas: el pipeline base está funcionando.

## 8. Criterios de salida

Las pruebas se consideran terminadas, a más tardar el 23 de octubre (congelamiento del código), cuando:

1. Se ejecutaron todos los casos de prioridad alta y al menos el 80 % de los de prioridad media.
2. No quedan defectos de severidad crítica abiertos.
3. Los defectos de severidad alta abiertos están documentados con su justificación y su impacto en las metas.
4. Cada defecto corregido tiene su prueba de regresión en verde.
5. La cobertura del backend del módulo alcanza el 80 %, o el informe declara la meta como no cumplida con la cifra real.
6. El quality gate pasa en ambos repositorios.
7. Las pruebas de stress y esfuerzo sostenido se ejecutaron y sus resultados se compararon con los umbrales definidos antes.
8. La matriz de trazabilidad está completa: cada requisito tiene casos, y cada defecto, su caso y su estado.
9. Hay al menos una ejecución del pipeline en verde y una fallida por un defecto real.

### 8.1. Estado final (25/10/2026)

| Criterio | Estado | Evidencia |
|---|---|---|
| 1. Casos de prioridad alta ejecutados y al menos el 80 % de los de prioridad media | No cumplido | Tienen ejecución registrada 61 de 76 de prioridad alta (80 %) y 34 de 49 de media (69 %). Faltan 12 casos de alta de nivel sistema (interfaz), que dependían de Cypress, y 3 de integración (CP-FIN-03-07, 04-02 y 04-06) |
| 2. Sin defectos críticos abiertos | Cumplido | Los 5 críticos (DEF-001, 005, 006, 010 y 018) están corregidos, integrados en develop y verificados; la migración de DEF-018 se aplicó en Developer y en producción (EV-62, EV-69a a EV-69c) |
| 3. Defectos altos abiertos documentados | Cumplido | No hay defectos altos abiertos; el único abierto, DEF-019, es de severidad media y está justificado (issue #44, `docs/trazabilidad.md`) |
| 4. Regresión en verde para cada defecto corregido | Cumplido | 997 pruebas sin fallos en develop (EV-67a); la regresión de DEF-013 corre en local (EV-52c), porque el frontend no tiene pipeline |
| 5. Cobertura del backend del módulo ≥ 80 % | Cumplido | 88,1 % en develop (sentencia 91,5 %, decisión 76,6 %; EV-58) |
| 6. Quality gate en ambos repositorios | Parcial | Backend Passed en develop (EV-58); el frontend no tiene análisis posterior a la línea base |
| 7. Stress y esfuerzo sostenido comparados con los umbrales | Cumplido | Ejecutados el 25/10 con umbrales fijados antes (EV-65, EV-66c, EV-66d); los umbrales de latencia no se cumplen en `/movimientos/flujo` ni en `/movimientos/metricas` |
| 8. Trazabilidad completa | Cumplido con atraso | Cerrada el 25/10 (pull request #51), dos días después del congelamiento previsto |
| 9. Pipeline en verde y ejecución fallida por un defecto real | Cumplido | Fallida en el #41 (EV-46a, EV-60a) y verde en el #43 (EV-48a) y en develop (EV-67a); también rojo y verde de DEF-018 en el #40 (EV-42a, EV-45a) |

## 9. Suspensión y reanudación

| Se suspende cuando… | Se reanuda cuando… |
|---|---|
| Alguna prueba apunta a desarrollo o a producción | Se corrigen las credenciales y se verifica que solo se use nexacore-test. Se suspende de inmediato |
| nexacore-test no está disponible o su esquema no coincide con las migraciones | La base vuelve a estar disponible, se aplican las migraciones y se reinicia el seed |
| Un defecto crítico impide ejecutar el resto de los casos de un requisito | Se corrige el defecto o se acuerda un camino alternativo, y se ejecuta su regresión |
| El pipeline está roto y no puede ejecutar pruebas | El pipeline vuelve a pasar la compilación y las pruebas existentes |
| Las pruebas de carga se acercan a los límites del plan de Supabase | Se ajusta la carga a los límites del plan |

## 10. Verificación del despliegue por instancia

**Por qué.** En el caso Knight Capital (2012), una actualización se aplicó en siete de ocho servidores; el que quedó con la versión anterior reactivó código obsoleto y produjo pérdidas millonarias en minutos. Un despliegue no está verificado porque el proceso terminó sin errores, sino cuando cada instancia demuestra que ejecuta la versión esperada.

**Criterio.** Un despliegue de NexaCore está verificado solo si las tres instancias informan la misma versión que generó el pipeline y el smoke test pasa sobre todas ellas.

| Instancia | Cómo informa su versión | Qué se verifica después de desplegar |
|---|---|---|
| Backend (imagen Docker) | Un endpoint que devuelve el commit con el que se construyó la imagen | El commit coincide con el del pipeline y el endpoint de salud responde |
| Frontend (Cloudflare Pages) | Un archivo o variable de build con el commit del despliegue | El commit coincide con el del pipeline y la pantalla de Finanzas carga |
| Base de datos (Supabase) | La última migración aplicada | Coincide con la última migración del repositorio |

Si alguna instancia no coincide, el despliegue se marca como fallido aunque las otras funcionen. La forma concreta de exponer la versión en cada instancia la define Valentina al armar el smoke test; si hace falta agregar el endpoint de versión al backend, se registra como mejora del proceso.

## 11. Gestión de defectos

Según `docs/convencion-identificadores.md`: formulario Defecto en GitHub Issues, severidad en cuatro niveles y ciclo nuevo → confirmado → en corrección → corregido → verificado. Un hallazgo de auditoría (`H-NN`) se convierte en defecto solo cuando una prueba lo confirma.

## 12. Seguimiento

Se revisan al menos cada dos días, durante el desarrollo principal:

| Indicador | Fuente |
|---|---|
| Casos diseñados, ejecutados, pasados y fallidos por requisito | `docs/trazabilidad.md` |
| Defectos abiertos por severidad y estado | GitHub Issues |
| Cobertura de sentencia y de decisión del backend | Reporte del pipeline |
| Estado del quality gate | SonarQube Cloud |
| Avance real contra el cronograma | Documento de organización, sección 8 |

Estos datos alimentan la métrica de proceso (tiempo entre detección y corrección) y la de proyecto (desvío del cronograma).

## 13. Cronograma

| Fechas | Etapa | Hitos de prueba |
|---|---|---|
| 14–17 oct. | Planificación | Plan v1.0, matriz de riesgos, plantillas, registro de defectos, casos prioritarios |
| 18 oct. | Preparación | Node 22, nexacore-test, pipeline base, línea base y tag `linea-base` |
| 18–20 oct. | Desarrollo principal | Casos diseñados y automatizados, tests unitarios y de API, primeras cargas |
| 21–23 oct. | Integración y correcciones | Quality gate, smoke y E2E, regresión, mejora antes/después. Congelamiento el 23 |
| 24–25 oct. | Cierre | Conciliación de cifras, informe, revisión cruzada |
| 26 oct. | Presentación | Demostración con un despliegue nuevo |

## 14. Entregables de prueba

| Entregable | Ubicación |
|---|---|
| Plan de pruebas versionado | `docs/plan-de-pruebas.md` y tags `plan-pruebas-v*` |
| Matriz de riesgos | `docs/matriz-riesgos.md` |
| Casos de prueba | `docs/casos/` |
| Matriz de trazabilidad | `docs/trazabilidad.md` |
| Matriz ISO/IEC 25010 | Sección 15 de este plan (desde la v1.1) |
| Código de pruebas | `test/` de cada repositorio |
| Reportes de cobertura, análisis estático y carga | Artefactos del pipeline |
| Registro de defectos | GitHub Issues del backend |
| Evidencias (capturas) | Carpeta del grupo en Drive y anexos del informe |

## 15. Matriz ISO/IEC 25010

### 15.1. Características

| Característica | Evidencia | Fuente |
|---|---|---|
| Adecuación funcional | Defectos de montos, sueldos, importaciones y validaciones: DEF-005, 006 y 010 (críticos), DEF-007, 009, 011, 012, 014, 015 y 016. Reglas RN-01 y RN-03 como oráculo | Issues; `docs/casos/` |
| Eficiencia de desempeño | Sin saturación hasta 30 pet/s (46 usuarios virtuales): 0 % de errores y latencia estable. Sin degradación en 15 min de esfuerzo sostenido (−0,5 %). `/movimientos/flujo` supera el p95 de 1,5 s en todas las cargas (≈ 2,6 s), por su costo propio y no por la carga (H-55) | Workflow Rendimiento #2; `docs/herramienta-k6.md`; EV-66c, EV-66d |
| Compatibilidad | Integración con Supabase probada contra una base real (nexacore-test): 13 pruebas de integración, que detectaron DEF-018 | `test/integracion/`; EV-41, EV-45a |
| Usabilidad | Mensajes de error y avisos: un monto 0 devolvía "Faltan campos obligatorios" (DEF-008); errores que se muestran como "No hay datos" (H-42) o como contraseña incorrecta (H-43) | `docs/hallazgos.md`; #25 |
| Fiabilidad | Plan de contingencia ante la caída de Supabase (H-37 a H-45, CP-FIN-18). Fuente alternativa de la cotización del dólar ante datos no numéricos (DEF-013, DEF-019) | `docs/plan-contingencia.md`; #31, #44 |
| Seguridad | Acceso indebido a Finanzas (DEF-001 a 004) y lectura de sueldos y asignación de permisos con la clave pública de Supabase, sin iniciar sesión (DEF-018, crítico). Regla RN-02 verificada con 433 pruebas | Issues; `test/finanzas.permisos.test.js`; EV-54a, EV-54b |
| Mantenibilidad | Complejidad ciclomática del backend del módulo: 616 en la línea base y 686 al cierre; frontend, 1.122. El archivo más complejo del backend es `salariosService.js` (118); en el frontend, `Movimientos.jsx` (284) e `ImportarExcel.jsx` (238). Duplicación del backend: 2,3 % → 0,0 % (mejora H-02); frontend, 0,7 %. Issues de mantenibilidad: 14 → 10 en el backend y 6 en el frontend | SonarQube Cloud; EV-16, EV-18a, EV-58; H-02, H-06 |
| Portabilidad | Backend en Docker con Node 22 (H-08). El pipeline construye la imagen en cada pull request, la despliega en el runner y el smoke verifica que arranca, se conecta a Supabase y responde con la versión desplegada | `Dockerfile`; `.github/workflows/ci.yml`; EV-64b, EV-67b |

### 15.2. Características prioritarias

| Prioridad | Característica | Justificación |
|---|---|---|
| 1 | Seguridad | Es la característica con más defectos críticos y la de mayor impacto: el módulo guarda sueldos y datos contables. Cualquier usuario autenticado podía consultar y modificar Finanzas (DEF-001) y, con la clave pública del frontend, se podían leer sueldos y asignarse permisos directamente en Supabase sin iniciar sesión (DEF-018). Ninguno de los dos se veía usando la aplicación: aparecieron con tablas de decisión por rol y con pruebas de integración |
| 2 | Adecuación funcional | Un dato financiero incorrecto se propaga al libro diario y a las decisiones de la dirección. Tres defectos críticos eran de este tipo: montos con formato argentino guardados mal en la migración y en el Excel (DEF-005, DEF-006) y sueldos en dólares guardados como pesos (DEF-010). Por eso se definieron RN-01 y RN-03 antes de corregir |
| 3 | Fiabilidad | El módulo depende por completo de Supabase y de servicios externos de cotización. El diagnóstico del plan de contingencia mostró que una caída no se detecta, se informa como error de contraseña y puede dejar importaciones a medias (H-37 a H-45). Y la cotización del dólar aceptaba valores no numéricos (DEF-013, DEF-019) |

**Por qué no las otras:** la mantenibilidad explica un defecto (H-02 → DEF-012), pero sus problemas son de costo de cambio, no de datos incorrectos o expuestos. La eficiencia es menos crítica para una empresa chica con pocos usuarios simultáneos, y se cubre con las pruebas de carga.
