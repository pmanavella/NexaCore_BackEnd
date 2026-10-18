# Casos de prueba del módulo Financiero

Un archivo por requisito o grupo de requisitos que comparten una tabla de decisión. Cada caso tiene los campos de la plantilla (`docs/plantillas/caso-de-prueba.md`) en formato compacto: los datos comunes (precondiciones y pasos) van al inicio de cada archivo y los particulares en la tabla.

## Criterios generales de resultado esperado

El resultado esperado se deriva del requisito, no de lo que hace hoy el código. Si el código se comporta distinto, el caso falla y se registra un defecto.

1. **Entrada inválida del usuario**: el sistema la rechaza con un error de validación (HTTP 400) y un mensaje que indica el problema, sin crear ni modificar registros. **Un error 500 ante una entrada del usuario es un defecto.**
2. **Acceso no autorizado**: sin sesión, HTTP 401; con sesión pero sin permiso, HTTP 403. En ambos casos no se devuelve ni se modifica información.
3. **Montos**: se guardan exactamente con el valor ingresado, con dos decimales.
4. **Permisos esperados por rol**: el oráculo es la regla RN-02 (`docs/convencion-identificadores.md`, sección 6).
5. **Montos escritos como texto en importaciones**: el oráculo es la regla RN-01.

## Supuestos a confirmar antes de ejecutar

Los criterios de aceptación se fijan antes de ejecutar. Estos casos dependen de una regla que el código no define con claridad; el grupo la confirma y se deja asentado aquí.

| Supuesto | Casos | Confirmado |
|---|---|---|
| Acceso por jerarquía y permiso manual (RN-02) | REQ-FIN-16-17 | ☑ 17/10 |
| Interpretación de montos (RN-01) | CP-FIN-03-01 a 03-04, 03-11 a 03-15, 04-10 a 04-12 | ☑ 17/10 |
| Las categorías distinguen mayúsculas: `rrhh` no es válida | CP-FIN-02-02 | ☐ |
| En la importación, un tipo con espacios (`" Gasto"`) se acepta recortado, igual que al guardar | CP-FIN-04-05 | ☐ |
| `dias=0` en próximos vencimientos significa "solo hoy" | CP-FIN-08-06 | ☐ |

## Correcciones de diseño

Cuando un caso está mal diseñado (por ejemplo, prueba una regla que el sistema no tiene), se corrige con justificación escrita en el archivo del caso, nunca para que una prueba pase. El resultado esperado solo cambia si cambia el requisito.

| Fecha | Caso | Archivo |
|---|---|---|
| 18/10/2026 | CP-FIN-05-01 | `REQ-FIN-05-06.md` |

## Niveles

**U** unitaria · **I** integración o API contra nexacore-test · **S** sistema, desde la interfaz.

## Índice

| Archivo | Requisitos | Riesgo principal |
|---|---|---|
| `REQ-FIN-02.md` | Alta de movimientos | R-03 |
| `REQ-FIN-03.md` | Importación histórica | R-09 |
| `REQ-FIN-04.md` | Importación por endpoint | R-03 |
| `REQ-FIN-05-06.md` | Sueldos en pesos y en dólares | R-01 |
| `REQ-FIN-08.md` | Alertas de vencimiento | R-08 |
| `REQ-FIN-14-15.md` | Libro diario y PDF | R-04 |
| `REQ-FIN-16-17.md` | Permisos por rol | R-02 |
