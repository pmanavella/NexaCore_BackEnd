# Convención de identificadores y catálogo de requisitos

**NexaCore · Módulo Financiero · TP Integrador de Calidad de Software**
Versión 1.2 · 18 de octubre de 2026 · Responsable: Pilar

Este documento define cómo se nombra cada elemento del proceso de calidad para que todo quede trazable: requisito → caso de prueba → test automatizado → defecto → corrección → prueba de regresión.

## 1. Identificadores

| Elemento | Formato | Ejemplo | Quién lo asigna |
|---|---|---|---|
| Requisito | `REQ-FIN-NN` | `REQ-FIN-02` | Pilar (catálogo de la sección 2) |
| Caso de prueba | `CP-FIN-NN-MM` | `CP-FIN-02-03` = caso 3 del requisito 02 | Quien diseña el caso |
| Defecto | `DEF-NNN` | `DEF-007` | Quien lo registra, tomando el siguiente número libre de `docs/trazabilidad.md` |
| Hallazgo de auditoría | `H-NN` | `H-02` | Ya asignados en el Anexo B del plan |
| Riesgo | `R-NN` | `R-04` | Pilar (matriz de riesgos) |

El caso de prueba incluye el número de su requisito, así la trazabilidad se lee en el propio identificador. Un hallazgo (`H-NN`) no es un defecto: se convierte en `DEF-NNN` solo cuando una prueba lo confirma.

## 2. Uso en el código y en GitHub

- **Tests automatizados**: el nombre del test empieza con el identificador del caso.
  `test('CP-FIN-02-03 rechaza una categoría que no existe', ...)`
- **Tests de regresión**: empiezan con `REG` y el defecto que cubren.
  `test('REG DEF-007 la importación acepta la categoría Suscripción', ...)`
- **Issues**: el título empieza con el identificador del defecto: `[DEF-007] La importación rechaza la categoría Suscripción`.
- **Pull requests que corrigen un defecto**: la descripción incluye `Corrige DEF-007` y `Closes #<número del issue>`, para que GitHub vincule la corrección con el defecto.
- **Versiones del plan de pruebas**: tags `plan-pruebas-v1.0`, `plan-pruebas-v1.1`, etc.

## 3. Severidad de los defectos

| Severidad | Criterio | Ejemplo en el módulo |
|---|---|---|
| Crítica | Datos financieros incorrectos, perdidos o expuestos; acceso indebido; caída del módulo | Un monto se registra sin IVA; un rol sin permiso ve sueldos |
| Alta | Una funcionalidad principal falla y no hay forma alternativa de hacerla | No se puede importar ningún archivo válido |
| Media | La funcionalidad falla en parte o hay una alternativa | Una categoría válida se rechaza solo en la importación |
| Baja | Problema visual o de texto que no afecta el resultado | Un mensaje de error mal redactado |

Esta severidad es la del registro de defectos. No es la misma que la de SonarQube: el quality gate se bloquea por los bugs que SonarQube clasifica como críticos.

## 4. Estados de un defecto

| Estado (etiqueta) | Significado |
|---|---|
| `estado: nuevo` | Registrado, sin revisar |
| `estado: confirmado` | Reproducido por otra integrante |
| `estado: en corrección` | Hay alguien trabajando en la corrección |
| `estado: corregido` | El PR de corrección está integrado; falta la prueba de regresión |
| `estado: verificado` | La prueba de regresión pasa en el pipeline. Se cierra el issue |

Si el problema no es un defecto, se cierra como *not planned* con un comentario que lo explique.

## 5. Catálogo de requisitos

Construido a partir del análisis funcional y contrastado con la auditoría de los repositorios. Cada requisito se valida contra el sistema real antes de diseñar sus casos; cualquier diferencia se registra como hallazgo.

| ID | Requisito | Repositorio | Hallazgos |
|---|---|---|---|
| REQ-FIN-01 | Registrar ingresos individuales con fecha, descripción, monto y cliente | Backend y frontend | |
| REQ-FIN-02 | Registrar gastos individuales con una categoría válida del sistema | Backend y frontend | H-01, H-02 |
| REQ-FIN-03 | Importar gastos históricos desde Excel o CSV, interpretando los montos según la regla RN-01 | Backend y frontend | H-16, H-17 |
| REQ-FIN-04 | Importar movimientos mediante el endpoint de Excel o CSV, interpretando los montos según la regla RN-01 | Backend | H-02, H-03 |
| REQ-FIN-05 | Liquidar sueldos según tipo de personal (planta o temporal) y estructura de pago (mensual, por hora o por turno) | Backend y frontend | |
| REQ-FIN-06 | Liquidar sueldos en dólares con cotización de compra o de venta | Backend y frontend | |
| REQ-FIN-07 | Gestionar suscripciones con su día de vencimiento | Backend y frontend | |
| REQ-FIN-08 | Alertar sobre pagos próximos a vencer | Backend | H-04 |
| REQ-FIN-09 | Procesar comprobantes con OCR en flujo binario: procesado o revisión manual | Backend y frontend | |
| REQ-FIN-10 | Registrar el monto del comprobante siempre con IVA incluido | Backend | |
| REQ-FIN-11 | Detectar comprobantes duplicados y vincularlos al original | Backend y frontend | |
| REQ-FIN-12 | Guardar los comprobantes de forma privada, accesibles solo para usuarios autorizados | Backend | |
| REQ-FIN-13 | Consultar la cotización del dólar en un servicio externo | Backend y frontend | |
| REQ-FIN-14 | Generar el libro diario a partir de los movimientos registrados | Frontend | |
| REQ-FIN-15 | Exportar el libro diario a PDF | Frontend | |
| REQ-FIN-16 | Solo los roles de mando alto (nivel HIGH: Superadmin y Dirección) acceden al módulo Financiero; otro usuario accede solo con permiso manual en la matriz, con nivel lector (consulta) o editor (consulta y carga) | Backend y frontend | H-25, H-26 |
| REQ-FIN-17 | Sueldos, trazabilidad y confirmación o reversión de migraciones son exclusivos de los roles de mando alto | Backend y frontend | H-18, H-27 |
| REQ-FIN-18 | Ante la indisponibilidad de Supabase, el módulo informa el problema de forma comprensible, no pierde ni duplica datos y se recupera sin intervención (ver `docs/plan-contingencia.md`) | Backend y frontend | H-37 a H-45 |

## 6. Reglas de negocio definidas por el equipo

### RN-01 · Interpretación de montos escritos como texto en importaciones

Aplica a la importación histórica (REQ-FIN-03) y al endpoint de Excel o CSV (REQ-FIN-04). Las celdas que Excel guarda como número se toman tal cual. Para montos escritos como texto, se quitan el símbolo `$`, la sigla `ARS` y los espacios, y luego:

| Situación | Interpretación | Ejemplo | Resultado |
|---|---|---|---|
| Tiene coma y punto | El último separador es el decimal; el otro, de miles | `1.234,56` · `1,234.50` | 1234,56 · 1234,50 |
| Solo una coma | Es decimal | `1,5` | 1,50 |
| Más de una coma y ningún punto | Inválido | `1,2,3` | Fila rechazada |
| Solo puntos, todos seguidos de exactamente 3 dígitos y parte entera distinta de 0 | Son de miles | `1.234` · `1.234.567` | 1234 · 1234567 |
| Solo un punto en otro caso | Es decimal | `1.5` · `0.004` | 1,50 · 0,004 |

El resultado se redondea a 2 decimales. Si queda en 0 o menos, la fila se rechaza.

### RN-02 · Acceso al módulo Financiero

| Usuario | Finanzas: consulta | Finanzas: carga, edición y borrado | Sueldos, trazabilidad, confirmar o revertir migraciones |
|---|---|---|---|
| Mando alto (Superadmin, Dirección) | Sí | Sí | Sí |
| Otro rol con permiso manual nivel editor | Sí | Sí | No |
| Otro rol con permiso manual nivel lector | Sí | No | No |
| Otro rol sin permiso manual | No | No | No |

"Finanzas" incluye movimientos, comprobantes, suscripciones, importaciones y cotización del dólar. El permiso manual es el que se asigna en la matriz de permisos del módulo `finance`.
