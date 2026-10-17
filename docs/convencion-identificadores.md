# Convención de identificadores y catálogo de requisitos

**NexaCore · Módulo Financiero · TP Integrador de Calidad de Software**
Versión 1.0 · 17 de octubre de 2026 · Responsable: Pilar

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
| REQ-FIN-03 | Importar gastos históricos desde Excel o CSV | Backend y frontend | |
| REQ-FIN-04 | Importar movimientos mediante el endpoint de Excel o CSV | Backend | H-02, H-03 |
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
| REQ-FIN-16 | Restringir el acceso al módulo Financiero según el rol | Backend y frontend | |
| REQ-FIN-17 | Restringir la consulta y gestión de sueldos a los roles autorizados | Backend y frontend | |
