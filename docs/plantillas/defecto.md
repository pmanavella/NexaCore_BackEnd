# Plantilla de defecto

Los defectos se registran como issues en el repositorio del backend con el formulario **Defecto**, que pide estos mismos campos. Esta plantilla es la referencia para el informe y para quien no use el formulario.

| Campo | Contenido |
|---|---|
| **ID** | DEF-NNN (siguiente número libre en `docs/trazabilidad.md`) |
| **Título** | Qué falla, en una frase |
| **Caso de prueba** | CP-FIN-NN-MM que lo detectó |
| **Requisito** | REQ-FIN-NN |
| **Severidad** | Crítica / Alta / Media / Baja (ver convención) |
| **Componente** | Backend / Frontend / Base de datos (nexacore-test) |
| **Versión** | Commit, rama o tag donde se detectó |
| **Precondiciones y datos** | Rol, datos sembrados, archivos usados |
| **Pasos para reproducir** | 1. … 2. … 3. … |
| **Resultado esperado** | Qué debería pasar |
| **Resultado obtenido** | Qué pasó realmente |
| **Evidencia** | Captura, log o enlace a la ejecución del pipeline |
| **Detectado por / fecha** | Integrante y fecha |
| **Corrección** | PR que lo corrige y fecha de integración |
| **Prueba de regresión** | Nombre del test `REG DEF-NNN …` y archivo |
| **Verificación** | Fecha en que la regresión pasó en el pipeline |

Las fechas de detección y de corrección son obligatorias: con ellas se calcula la métrica de proceso (tiempo promedio entre detección y corrección).
