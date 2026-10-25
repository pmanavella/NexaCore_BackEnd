# Herramienta nueva: k6 para stress y esfuerzo sostenido

**Responsable:** Valentina · **Versión:** 1.0 (borrador) · **Consigna:** "Herramienta nueva incorporada con el proceso de cinco pasos: requisitos, mercado, prueba de concepto, matriz de decisión y despliegue incremental".

**Resultado:** se incorporó k6, que obtuvo el mayor puntaje de la matriz ponderada (4,80 sobre 5) frente a Artillery (3,95), Gatling (3,50), Locust (3,05) y JMeter (2,45). Corre en un job separado del pipeline (`.github/workflows/rendimiento.yml`), contra una instancia del backend apuntada a nexacore-test, con umbrales fijados antes de ejecutar.

Antes del trabajo, el proyecto no tenía ninguna herramienta de rendimiento (verificación del 17 de octubre, documento de organización v3.2). Es la única herramienta que pasa por este proceso; SonarQube Cloud y la cobertura nativa de Node se declaran como incorporadas sin él.

---

## Paso 1 · Requisitos

Salen de la consigna, del plan de pruebas y de las restricciones reales del proyecto. Se fijaron antes de mirar herramientas.

| ID | Requisito | Origen | Tipo |
|---|---|---|---|
| RQ-1 | Pruebas de stress (carga creciente) y de esfuerzo sostenido (carga estable durante un período) | Consigna, tema Herramientas | Obligatorio |
| RQ-2 | Se ejecuta en GitHub Actions sin interfaz gráfica y deja reportes como artefactos | Consigna, entregables | Obligatorio |
| RQ-3 | Los umbrales deciden el resultado: si no se cumplen, la ejecución termina con error | Plan de pruebas, criterio de salida 7 | Obligatorio |
| RQ-4 | Scripts como código, versionados en el repo y revisables en un pull request | Consigna: "ejecutables con un comando" | Obligatorio |
| RQ-5 | Gratuita, sin licencia comercial para el uso del trabajo | Restricción del grupo | Obligatorio |
| RQ-6 | Bajo consumo de recursos: genera la carga desde un runner gratuito de GitHub | Restricción del pipeline | Deseable |
| RQ-7 | Curva de aprendizaje corta para un equipo que trabaja en JavaScript (Node y React) | Plazo del trabajo | Deseable |
| RQ-8 | Permite limitar la carga para no superar el plan gratuito de Supabase | Matriz de riesgos, R-20 | Obligatorio |

## Paso 2 · Investigación de mercado

Se relevaron cinco herramientas de código abierto de uso extendido para pruebas de carga de APIs HTTP. JMeter y Artillery eran las alternativas previstas en la organización; Locust y Gatling se sumaron para no limitar la comparación.

| Herramienta | Licencia | Scripts en | Umbrales que deciden el resultado | Ejecución en CI | Motor |
|---|---|---|---|---|---|
| **k6** (Grafana Labs) | AGPL-3.0 | JavaScript | Sí, nativos (`thresholds`), con corte anticipado | Binario único o imagen Docker | Go |
| **JMeter** (Apache) | Apache 2.0 | Planes XML (`.jmx`), armados en una interfaz gráfica | Aserciones por respuesta; percentiles con complementos o procesando el reporte | Modo sin interfaz; requiere Java | Java (JVM) |
| **Artillery** | MPL-2.0 (módulos de Azure con BSL) | YAML, con funciones en JavaScript | Sí, con el complemento `ensure` | Paquete de npm | Node.js |
| **Locust** | MIT | Python | Sin umbrales de percentiles nativos; se programan con eventos | Modo sin interfaz | Python |
| **Gatling** | Apache 2.0 (edición comunitaria) | Java, Scala o Kotlin (también JavaScript en versiones recientes) | Sí, con `assertions` | Maven, Gradle o paquete propio | JVM |

**Fuentes:** sitios y repositorios oficiales de cada herramienta: grafana.com/docs/k6, jmeter.apache.org, github.com/artilleryio/artillery, locust.io y gatling.io. Revisados el 24 de octubre de 2026.

**Descartes tempranos:** ninguna incumple un requisito obligatorio de forma absoluta, por eso las cinco pasan a la matriz. Las diferencias están en cuánto trabajo extra exige cumplir RQ-3 y RQ-4.

## Paso 3 · Prueba de concepto

**Objetivo:** confirmar que k6 cumple los requisitos obligatorios sobre NexaCore real antes de adoptarlo.

**Criterios de éxito fijados antes de la prueba:**

1. Se instala sin dependencias adicionales (RQ-5, RQ-7).
2. Un script inicia sesión en Supabase Auth y consulta las rutas de Finanzas con el token (RQ-4).
3. Si un umbral no se cumple, k6 termina con código de error (RQ-3).
4. Corre dentro de GitHub Actions contra la instancia desplegada en el runner y deja el reporte como artefacto (RQ-2).
5. La carga se puede fijar en peticiones por segundo, con un tope (RQ-8).

**Ejecución y resultado:**

| Criterio | Evidencia | Resultado |
|---|---|---|
| 1. Instalación | `brew install k6` → k6 v2.3.0, un solo binario, sin dependencias | Cumple · *[EV a asignar: captura de la terminal]* |
| 2. Script con sesión y rutas reales | `k6/lib/comun.js`: inicia sesión con dos usuarios del seed (U-02 y U-10) y consulta health, movimientos, métricas y flujo; `k6 inspect` lee los dos scripts sin errores | *[a completar con la salida de `k6 inspect`]* |
| 3. Umbrales que deciden | `k6/sostenido.js` declara `thresholds`; `k6/stress.js` aborta si los errores superan el 10 % | *[a completar con la primera corrida]* |
| 4. Ejecución en Actions | Job "Stress y esfuerzo sostenido (k6, nexacore-test)", con reporte en el *Summary* y artefacto `resultados-k6-<commit>` | *[a completar: EV-66a]* |
| 5. Carga acotada | Ejecutor `constant-arrival-rate`: tasa fija por escalón, tope de 30 peticiones por segundo | Cumple por diseño (`k6/stress.js`) |

## Paso 4 · Matriz de decisión ponderada

**Pesos.** Se fijan antes de puntuar, igual que los umbrales de rendimiento. Siguen la prioridad de los requisitos: los obligatorios pesan más que los deseables. *[Pendiente: aprobación del grupo antes de dar la matriz por cerrada.]*

**Escala:** 1 (no lo resuelve o exige mucho trabajo extra) a 5 (lo resuelve de forma nativa).

| Criterio (requisito) | Peso | k6 | JMeter | Artillery | Locust | Gatling |
|---|---|---|---|---|---|---|
| Integración con CI y reportes (RQ-2) | 25 % | 5 | 3 | 4 | 4 | 4 |
| Scripts como código revisable (RQ-4, RQ-7) | 20 % | 5 | 1 | 4 | 2 | 3 |
| Umbrales que deciden el resultado (RQ-3) | 20 % | 5 | 2 | 4 | 2 | 5 |
| Consumo de recursos en el runner (RQ-6) | 15 % | 5 | 2 | 3 | 3 | 2 |
| Curva de aprendizaje para el equipo (RQ-7) | 10 % | 4 | 3 | 5 | 3 | 2 |
| Licencia y costo (RQ-5) | 10 % | 4 | 5 | 4 | 5 | 4 |
| **Total ponderado** | **100 %** | **4,80** | **2,45** | **3,95** | **3,05** | **3,50** |

**Justificación de los puntajes:**

- **Integración con CI.** k6 es un binario o una imagen Docker y termina con código de error si falla un umbral: no hace falta procesar nada después. JMeter necesita Java y, para fallar por percentiles, procesar el reporte o sumar complementos. Las demás se integran bien, pero dependen de su entorno (Node, Python o JVM).
- **Scripts como código.** k6 usa JavaScript plano, el mismo lenguaje del equipo, y los cambios se leen en un pull request. Los planes `.jmx` de JMeter son XML generado por una interfaz gráfica, difícil de revisar en un diff. Locust exige Python, que el equipo no usa en NexaCore.
- **Umbrales.** k6 y Gatling los traen de forma nativa; k6 además permite cortar la prueba si los errores superan un límite, lo que protege a nexacore-test. Artillery los resuelve con un complemento oficial. En JMeter y Locust hay que programarlos.
- **Recursos.** k6 está escrito en Go y genera carga con poca memoria. JMeter y Gatling corren sobre la JVM, más pesada para un runner gratuito.
- **Aprendizaje.** Artillery puntúa más alto porque sus escenarios en YAML son muy simples. k6 queda cerca porque el equipo ya trabaja en JavaScript.
- **Licencia.** Todas son gratuitas para este uso. JMeter y Locust tienen licencias permisivas (Apache 2.0 y MIT). La AGPL-3.0 de k6 no impone obligaciones para usarlo como herramienta interna de pruebas, porque no se distribuye ni se modifica.

**Sensibilidad.** k6 obtiene el puntaje más alto o igual al más alto en cuatro de los seis criterios, y solo pierde en licencia (frente a JMeter y Locust) y en aprendizaje (frente a Artillery), que suman el 20 % del peso. Aunque esos dos criterios pesaran el doble, k6 seguiría primero.

**Decisión:** se adopta k6.

## Paso 5 · Despliegue incremental

La herramienta se incorporó por etapas. Cada etapa tenía un criterio para pasar a la siguiente y una forma de volver atrás sin afectar al resto del pipeline.

| Etapa | Qué se hizo | Criterio para avanzar | Cómo se vuelve atrás |
|---|---|---|---|
| 1. Local | Instalación de k6 y lectura de los scripts con `k6 inspect` | Los scripts se leen sin errores | Desinstalar; nada quedó en el repo |
| 2. Scripts en el repo | `k6/` con la configuración común, stress y esfuerzo sostenido, en un pull request revisado | Revisión aprobada; `npm test` y el pipeline de calidad siguen en verde (los scripts están fuera de `test/` y del alcance de SonarQube) | Revertir el pull request |
| 3. Job manual | Workflow `rendimiento.yml`, separado del pipeline: solo corre al agregar la etiqueta `rendimiento` o `rendimiento-demo` a un pull request | La corrida corta (`rendimiento-demo`) termina y genera el reporte | Quitar la etiqueta; el job nunca bloquea el pipeline de calidad |
| 4. Corrida completa | Etiqueta `rendimiento`: stress de 2 a 30 peticiones por segundo y 15 minutos de esfuerzo sostenido, con los umbrales aprobados | Resultados comparados con los umbrales y registrados (informe, sección 10.4) | — |
| 5. A futuro (tesis) | Ejecutar la versión corta al desplegar en `main` y la completa antes de cada versión | Fuera del alcance del trabajo | — |

## Decisiones de diseño de las pruebas

- **Solo nexacore-test.** `k6/lib/comun.js` aborta si la URL de Supabase no es la de nexacore-test (plan de pruebas, sección 4).
- **Solo lectura.** Las pruebas consultan, no escriben. Por eso no hace falta reiniciar la base después de la carga, como prevé el Anexo A.5 de la organización: el seed queda intacto, y un reinicio innecesario podría pisarse con otro pipeline que use la base al mismo tiempo.
- **Una sesión por usuario.** El inicio de sesión se hace una vez al comienzo, así la prueba mide el backend y no los límites de inicio de sesión de Supabase Auth.
- **Tope de carga.** Cada petición autenticada hace tres consultas a Supabase (validar el token, leer el perfil y leer los datos), por lo que el stress se detiene en 30 peticiones por segundo (riesgo R-20).
- **Mezcla de rutas.** Por cada 10 peticiones: 5 a `GET /api/finance/movimientos`, 2 a `/movimientos/metricas`, 2 a `/movimientos/flujo` y 1 a `/api/health`.
- **Modo demo.** Para la demostración con un despliegue nuevo, la etiqueta `rendimiento-demo` corre los mismos scripts y umbrales con escalones de 30 segundos y 3 minutos de esfuerzo sostenido (unos 6 minutos en total).

## Umbrales

Fijados antes de la primera ejecución (plan de pruebas, criterio de salida 7). Referencia: el smoke del PR #47 midió unos 290 ms en `/api/health` desde GitHub Actions (EV-64b).

| Métrica | Umbral | Dónde se evalúa |
|---|---|---|
| Percentil 95 de la latencia | < 1500 ms | En cada endpoint del módulo Financiero por separado |
| Percentil 99 de la latencia | < 3000 ms | En cada endpoint del módulo Financiero por separado |
| Respuestas fallidas | < 1 % | Todas las peticiones |
| Degradación en esfuerzo sostenido (p95 del último 20 % frente al primer 20 %) | ≤ 25 % | Peticiones del módulo Financiero |

Los percentiles se evalúan por endpoint (`/movimientos`, `/movimientos/metricas` y `/movimientos/flujo`) y no sobre el total, a propuesta de Pilar durante la aprobación: `/api/health` es mucho más rápido y, mezclado con el resto, podía tapar a un endpoint lento. Por eso `/api/health` participa de la carga pero no del criterio de latencia.

En el stress, un escalón cumple solo si los tres endpoints están bajo el umbral, no hay más de 1 % de errores y k6 no descartó iteraciones.

Aprobación del grupo: *[EV-65]*.

## Cómo se ejecuta

```bash
# Desde la raíz del repo, con las variables de nexacore-test en el entorno
npm run test:stress
npm run test:sostenido
```

En el pipeline: agregar la etiqueta `rendimiento` (o `rendimiento-demo`) al pull request. El reporte aparece en el *Summary* de la ejecución y los resultados completos quedan como artefacto.

## Limitaciones

- Los runners de GitHub no están en la misma región que nexacore-test (sa-east-1): la latencia medida incluye el tramo de red.
- Quince minutos de esfuerzo sostenido detectan degradaciones rápidas, no pérdidas de memoria que tarden horas.
- La mezcla es solo de lectura: no mide la carga de altas, importaciones ni comprobantes con OCR (este último, excluido a propósito en el plan).
- `GET /api/finance/movimientos` devuelve la tabla completa, sin paginación. Con los datos del seed es chica; con datos reales la latencia crecería con la cantidad de movimientos (hallazgo a registrar).
