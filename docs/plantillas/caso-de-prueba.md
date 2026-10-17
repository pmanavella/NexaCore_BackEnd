# Plantilla de caso de prueba

Copiar una tabla por caso en `docs/casos/REQ-FIN-NN.md` (un archivo por requisito).

| Campo | Contenido |
|---|---|
| **ID** | CP-FIN-NN-MM |
| **Requisito** | REQ-FIN-NN |
| **Título** | Qué verifica, en una frase |
| **Técnica** | Clases de equivalencia / Valores límite / Tabla de decisión |
| **Nivel** | Unitaria / Integración / Sistema / Aceptación |
| **Prioridad** | Alta / Media / Baja (según la matriz de riesgos, indicando el R-NN) |
| **Precondiciones** | Estado necesario antes de ejecutar (rol del usuario, datos sembrados en nexacore-test) |
| **Datos de entrada** | Valores concretos que se usan |
| **Pasos** | 1. … 2. … 3. … |
| **Resultado esperado** | Qué debe pasar, de forma verificable |
| **Criterio de aceptación** | Condición exacta para considerar que pasó. Se fija antes de ejecutar |
| **Automatizado** | No / Sí: ruta del archivo de test |

## Registro de ejecución

| Fecha | Versión (commit o tag) | Ejecutó | Resultado obtenido | Estado | Evidencia | Defecto |
|---|---|---|---|---|---|---|
| | | | | Pasó / Falló / Bloqueado | Captura o enlace | DEF-NNN o — |

---

## Ejemplo

| Campo | Contenido |
|---|---|
| **ID** | CP-FIN-02-03 |
| **Requisito** | REQ-FIN-02 |
| **Título** | Rechaza un gasto con una categoría que no existe |
| **Técnica** | Clases de equivalencia (clase inválida) |
| **Nivel** | Unitaria |
| **Prioridad** | Alta (R-NN) |
| **Precondiciones** | Usuario con rol que puede registrar gastos |
| **Datos de entrada** | Categoría `Viáticos`, monto `1500`, fecha actual |
| **Pasos** | 1. Enviar el alta del gasto con los datos indicados. |
| **Resultado esperado** | El sistema rechaza el alta con un error de validación y no crea el movimiento |
| **Criterio de aceptación** | Respuesta de error de validación y ningún registro nuevo en `movimientos` |
| **Automatizado** | Sí: `test/movimientos.categorias.test.js` |
