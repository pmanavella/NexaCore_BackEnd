# Operativo: tiempos manuales, menciones y notificaciones — contratos HTTP

Versión de contrato: **2026-11-09 r2** (revisión final de backend; ver "Cambios respecto de r1").

Estado: implementado en el backend y probado con la base simulada en memoria. **Las
migraciones no se ejecutaron sobre PostgreSQL real**: hasta aplicarlas y validarlas en
`nexacore_dev`, nada de esto funciona en un entorno. Orden:

1. `database/verificaciones/2026-11-09_previas_actualizaciones_operativo.sql` (solo lectura)
2. `database/migrations/2026-11-09_tiempos_carga_manual_y_correcciones.sql`
3. `database/migrations/2026-11-09_comentarios_menciones_y_notificaciones.sql`
4. Desplegar el backend.

Requisito previo en cada entorno: las migraciones `2026-11-03_tareas_comentarios_y_tiempos`
y `2026-11-03_tiempos_integridad_y_acceso` aplicadas (las nuevas abortan si faltan).

## 0. Convenciones comunes

- Todas las rutas requieren `Authorization: Bearer <token>`. Sin token: `401 { "error": "..." }`.
- El usuario sale siempre del token. Cualquier `usuario_id`, autor, `duracion_segundos`,
  `origen`, `motivo_finalizacion`, `menciones` o destinatario enviado en el body se ignora.
- `404` también cuando el recurso existe pero es de otra tarea o de otro usuario (no se
  revela su existencia).
- Fechas de respuesta: ISO 8601 UTC (`2026-11-03T09:00:00.000Z`; la base puede devolver
  microsegundos o `+00:00`). Mostrar en la zona horaria del usuario.

### 0.1 Errores

```json
{ "error": "El registro cambió desde que lo consultaste. Volvé a cargarlo y repetí la corrección.",
  "codigo": "VERSION_DESACTUALIZADA" }
```

- `error`: mensaje para mostrar (sin cambios respecto de antes).
- `codigo`: identificador estable **para lógica del frontend**. Solo lo traen los endpoints de
  esta funcionalidad (panel Actualizaciones de una tarea, temporizadores, registros de
  tiempo, mencionables y `/api/notificaciones`). Los demás módulos siguen respondiendo
  `{ "error": ... }` sin `codigo`. Si falta (por ejemplo, un `500` inesperado o un `401` del
  middleware de autenticación), usar el status HTTP.

| codigo | HTTP | Cuándo |
|---|---|---|
| `NO_AUTENTICADO` | 401 | No se pudo identificar al usuario (el 401 del middleware no trae `codigo`) |
| `ACCESO_DENEGADO` | 403 | No ve el tablero de la tarea (o lo perdió durante el pedido) |
| `TAREA_NO_ENCONTRADA` | 404 | Tarea inexistente o eliminada |
| `TABLERO_INVALIDO` / `TABLERO_NO_ENCONTRADO` | 400 / 404 | `tablero_id` de `temporizadores-activos` |
| `FECHA_INVALIDA` | 400 | `inicio`/`fin` ausente, sin zona horaria, formato o fecha inexistente |
| `INTERVALO_INVALIDO` | 400 | `inicio >= fin` |
| `FIN_FUTURO` | 400 | `fin` posterior a la hora del servidor |
| `VERSION_REQUERIDA` | 400 | PATCH sin `version` entera ≥ 1 |
| `DATOS_INCOMPLETOS` | 400 | PATCH sin `inicio` ni `fin` |
| `REGISTRO_NO_ENCONTRADO` | 404 | Registro inexistente, id inválido o de otra tarea |
| `REGISTRO_AJENO` | 403 | Corregir un registro de otra persona o sin autor (también mando alto) |
| `REGISTRO_TIEMPO_ACTIVO` | 409 | Corregir un temporizador que sigue activo |
| `VERSION_DESACTUALIZADA` | 409 | La `version` enviada ya no es la actual |
| `REGISTRO_INMUTABLE` | 409 | La base rechazó una modificación no autorizada (no debería verse) |
| `TEMPORIZADOR_YA_ACTIVO` | 409 | Iniciar con un temporizador ya activo en la tarea |
| `SIN_TEMPORIZADOR_ACTIVO` | 409 | Detener sin temporizador activo |
| `TAREA_FINALIZADA` | 409 | Iniciar temporizador en tarea completada/cancelada |
| `CONTENIDO_INVALIDO` | 400 | Comentario vacío, no texto o > 2000 caracteres (con tokens) |
| `MENCION_INVALIDA` | 400 | Algún token apunta a alguien no mencionable (el mensaje lista los ids) |
| `COMENTARIO_NO_ENCONTRADO` | 404 | Comentario inexistente o de otra tarea |
| `COMENTARIO_AJENO` | 403 | Editar/eliminar un comentario de otra persona |
| `NOTIFICACION_NO_ENCONTRADA` | 404 | Inexistente, eliminada o de otro usuario |
| `PARAMETRO_INVALIDO` | 400 | `estado`, `limite` u `offset` inválidos en `/api/notificaciones` |

---

## 1. Registros de tiempo

### 1.1 Forma de un registro (ampliada, aditiva)

Se devuelve en `GET /api/operations/tareas/:id/actualizaciones` (elementos con
`tipo: "registro_tiempo"`, solo finalizados), `POST /:id/temporizador/detener` y en los
endpoints nuevos.

```json
{
  "tipo": "registro_tiempo",
  "id": "uuid",
  "tarea_id": "uuid",
  "usuario": { "id": "uuid", "nombre": "Nico" },
  "fecha": "2026-11-03T10:30:00.000Z",
  "inicio": "2026-11-03T09:00:00.000Z",
  "fin": "2026-11-03T10:30:00.000Z",
  "duracion_segundos": 5400,
  "motivo_finalizacion": null,
  "origen": "carga_manual",
  "version": 1,
  "corregido": false,
  "corregido_at": null,
  "permisos": { "puede_editar": true, "puede_eliminar": false }
}
```

| Campo | Nuevo | Significado |
|---|---|---|
| `origen` | sí | `temporizador` o `carga_manual`. |
| `motivo_finalizacion` | no | Solo temporizador: `manual` = lo detuvo su usuario; `automatico` = tarea finalizada o pérdida de acceso. **`null` en cargas manuales.** |
| `version` | sí | 1 al crearse; +1 por corrección. Se envía en el PATCH. |
| `corregido`, `corregido_at` | sí | Si tuvo alguna corrección y cuándo fue la última. |
| `permisos.puede_editar` | cambia | `true` solo para el autor y si el registro está finalizado (antes siempre `false`). |
| `permisos.puede_eliminar` | no | Siempre `false`. **No existe eliminación de tiempos** (DELETE → 404). |
| `fecha` | no | = `fin`; criterio de orden del panel. Una carga con fecha pasada aparece en su lugar cronológico, no al final. |

`usuario: null` = autor eliminado; nadie puede corregir ese registro.

### 1.2 Fechas de entrada

`inicio` y `fin`: strings **ISO 8601 con zona horaria explícita** (`Z` o `±hh:mm`; segundos y
hasta 3 decimales opcionales). El frontend arma el valor con fecha + hora del formulario y el
offset local, p. ej. `2026-11-08T22:30:00-03:00`.

- Rechazados (`FECHA_INVALIDA`): sin zona horaria, fechas inexistentes (`2026-02-30`,
  `24:00`), números (epoch), otros formatos.
- `inicio < fin` estricto (`INTERVALO_INVALIDO`); `fin` no futuro (`FIN_FUTURO`, hora del
  servidor de base de datos).
- Puede cruzar la medianoche: `fin` lleva su propia fecha (`2026-11-09T01:15:00-03:00`).
- Sin límite de antigüedad ni de duración.

**Tareas completadas o canceladas:** se puede registrar y corregir tiempo (si se conserva el
acceso). La tarea no cambia de etapa, estado ni fechas; no se inicia ningún temporizador
(`temporizador/iniciar` sigue respondiendo `409 TAREA_FINALIZADA`).

### 1.3 Advertencias de superposición (formato común)

Presentes en `validar`, `POST` y `PATCH`:

```json
"advertencias": {
  "superposicion": true,
  "superposiciones": [
    {
      "registro_id": "uuid",
      "misma_tarea": true,
      "tarea": { "id": "uuid", "titulo": "A" },
      "inicio": "2026-11-03T08:00:00.000Z",
      "fin": "2026-11-03T09:00:00.000Z",
      "activo": false,
      "origen": "carga_manual",
      "solapamiento_segundos": 2700
    }
  ]
}
```

- Se comparan los **registros del propio usuario** en cualquier tarea: finalizados y
  temporizadores activos (`activo: true`, `fin: null`; cuentan hasta "ahora"). Nunca los de
  otras personas.
- Superposición = `otro.inicio < nuevo.fin` y `fin_efectivo(otro) > nuevo.inicio`. **Los
  intervalos contiguos** (uno termina exactamente cuando empieza el otro) no se superponen.
- `tarea: null` = el registro está en una tarea que el usuario ya no ve; no se informa id ni
  título, solo el horario (que es tiempo propio del usuario).
- Orden: por `inicio` ascendente. `superposicion: false` ⇔ `superposiciones: []`.
- **Nunca bloquean** el guardado.

### 1.4 `POST /api/operations/tareas/:id/registros-tiempo/validar`

Validación previa: **no guarda nada**.

```json
{ "inicio": "2026-11-03T05:15:00-03:00", "fin": "2026-11-03T08:15:00-03:00" }
```
Para validar una corrección, agregar `"registro_id": "uuid"` (debe ser propio y finalizado;
se excluye de las superposiciones).

`200`:
```json
{ "valido": true, "inicio": "2026-11-03T08:15:00.000Z", "fin": "2026-11-03T11:15:00.000Z",
  "duracion_segundos": 10800, "advertencias": { "superposicion": false, "superposiciones": [] } }
```
Errores: `400` (`FECHA_INVALIDA`, `INTERVALO_INVALIDO`, `FIN_FUTURO`), `403`
(`ACCESO_DENEGADO`, `REGISTRO_AJENO`), `404` (`TAREA_NO_ENCONTRADA`,
`REGISTRO_NO_ENCONTRADO`), `409` (`REGISTRO_TIEMPO_ACTIVO`).

### 1.5 `POST /api/operations/tareas/:id/registros-tiempo`

Alta manual de tiempo **propio**.

```json
{ "inicio": "2026-11-03T06:00:00-03:00", "fin": "2026-11-03T07:30:00-03:00" }
```
`201`:
```json
{ "registro": { "…forma 1.1…": "", "origen": "carga_manual", "version": 1, "motivo_finalizacion": null },
  "advertencias": { "superposicion": false, "superposiciones": [] } }
```
Las `advertencias` se recalculan **después de guardar** (definitivas).

Errores: `400` (`FECHA_INVALIDA`, `INTERVALO_INVALIDO`, `FIN_FUTURO`), `401`, `403`
(`ACCESO_DENEGADO`), `404` (`TAREA_NO_ENCONTRADA`).

### 1.6 `PATCH /api/operations/tareas/:id/registros-tiempo/:registroId`

Corrección por el **autor** de un registro **finalizado** (manual o del temporizador). Un
temporizador activo se detiene primero (`409 REGISTRO_TIEMPO_ACTIVO`).

```json
{ "fin": "2026-11-03T09:00:00-03:00", "version": 1 }
```
`inicio` y/o `fin`; el que falta se conserva. `200` con `{ registro, advertencias }`:
`version` +1, `corregido: true`, `duracion_segundos` recalculada, `origen` y
`motivo_finalizacion` sin cambios. Si los valores son iguales a los actuales: `200` sin
nueva versión ni auditoría.

Errores: `400` (`VERSION_REQUERIDA`, `DATOS_INCOMPLETOS`, `FECHA_INVALIDA`,
`INTERVALO_INVALIDO`, `FIN_FUTURO`), `403` (`REGISTRO_AJENO`, `ACCESO_DENEGADO`), `404`
(`REGISTRO_NO_ENCONTRADO`, `TAREA_NO_ENCONTRADA`), `409` (`VERSION_DESACTUALIZADA`,
`REGISTRO_TIEMPO_ACTIVO`).

### 1.7 `GET /api/operations/tareas/:id/registros-tiempo/:registroId/correcciones`

Trazabilidad; la ve cualquier usuario con acceso a la tarea.

```json
{
  "registro": { "…forma 1.1…": "" },
  "data": [
    { "id": "uuid", "registro_id": "uuid", "accion": "carga_manual", "version": 1,
      "actor": { "id": "uuid", "nombre": "Nico" },
      "inicio_anterior": null, "fin_anterior": null, "duracion_anterior_segundos": null,
      "inicio_nuevo": "…", "fin_nuevo": "…", "duracion_nueva_segundos": 3600, "created_at": "…" },
    { "id": "uuid", "registro_id": "uuid", "accion": "correccion", "version": 2,
      "actor": { "id": "uuid", "nombre": "Nico" },
      "inicio_anterior": "…", "fin_anterior": "…", "duracion_anterior_segundos": 10800,
      "inicio_nuevo": "…", "fin_nuevo": "…", "duracion_nueva_segundos": 3600, "created_at": "…" }
  ],
  "total": 2
}
```
Del más antiguo al más reciente. Los registros del temporizador empiezan con su primera
corrección (no tienen `carga_manual`). `actor: null` = usuario eliminado.

### 1.8 Flujo sugerido

1. Formulario → `POST …/validar`. Si `superposicion`, mostrar la lista y pedir
   confirmación. No bloquear.
2. Confirmar → `POST …/registros-tiempo` o `PATCH …/:registroId` con `version`.
3. `409 VERSION_DESACTUALIZADA` → recargar `GET /:id/actualizaciones` y reabrir con la
   versión nueva. `409 REGISTRO_TIEMPO_ACTIVO` → ofrecer detener el temporizador.

---

## 2. Indicador de temporizador activo

`GET /api/operations/tareas/temporizadores-activos?tablero_id=<uuid>`

Una llamada por tablero (no por tarjeta). **Solo** los temporizadores activos del usuario
autenticado; sin `tablero_id`, los de todas las tareas que ve.

```json
{
  "data": [
    { "id": "uuid", "tarea_id": "uuid", "tablero_id": "uuid", "usuario_id": "uuid",
      "inicio": "2026-11-03T11:00:00.000Z", "activo": true,
      "servidor_ahora": "2026-11-03T11:02:00.000Z", "transcurrido_segundos": 120 }
  ],
  "total": 1,
  "servidor_ahora": "2026-11-03T11:02:00.000Z"
}
```
Errores: `400 TABLERO_INVALIDO`, `403 ACCESO_DENEGADO`, `404 TABLERO_NO_ENCONTRADO`.

Refrescar después de `temporizador/iniciar` y `temporizador/detener`, y al recargar el
tablero. Reloj en pantalla: `transcurrido_segundos` + tiempo local desde la respuesta. Los
endpoints `GET/POST /:id/temporizador…` no cambian.

---

## 3. Menciones con @

### 3.1 Serialización (contrato único)

Dentro de `contenido` (texto plano, máx. **2000 caracteres contando los tokens completos**):

```
@[Etiqueta](uuid-del-usuario)
```
Ejemplo: `@[Leo](3f0c…e1), revisá los cambios realizados en esta tarea.`

- El **uuid** identifica a la persona (resuelve nombres repetidos). Sin distinguir
  mayúsculas; se guarda en minúsculas.
- La **Etiqueta** (1..100 caracteres, sin `[`, `]` ni saltos de línea) es solo
  presentación. Al guardar, el backend la **reemplaza por el nombre actual** del usuario; el
  comentario devuelto puede diferir del enviado. El límite de 2000 se controla después de
  normalizar. Nunca se inserta el email ni otro dato.
- Otro texto (`@Leo` sin token, `@[Leo](123)`) es texto común: no menciona ni notifica.
- No hay lista aparte de ids: un campo `menciones` en el body se ignora.

Expresión para detectar tokens (la misma del backend):
```
/@\[([^[\]\r\n]{1,100})\]\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi
```

### 3.2 Reglas

- Mencionables: **miembros activos del tablero** de la tarea (asignados o no). El mando alto
  que no es miembro no es mencionable. Tarea sin tablero: nadie.
- Tokens repetidos o automención no duplican; **la automención no notifica**.
- Crear con algún token no mencionable → `400 MENCION_INVALIDA`; no se guarda nada.
- Editar (se envía el texto completo nuevo):
  - menciones **nuevas** → se validan (miembro activo) y notifican solo a quien nunca fue
    notificado por ese comentario;
  - menciones que **ya estaban** → se conservan aunque la persona haya dejado el tablero o
    esté inactiva (no se pueden volver a agregar si se quitaron y ya no es miembro);
  - tokens **quitados** → dejan de ser menciones; la notificación enviada se conserva
    (`mencion_vigente: false`);
  - token de un **usuario eliminado** que ya estaba en el texto → queda como texto, sin error.
- La base vuelve a verificar la membresía al guardar (cambio concurrente → `400 MENCION_INVALIDA`).

### 3.3 `GET /api/operations/tareas/:id/mencionables`

Para el selector que se abre al tipear `@`. Pedirlo una vez por apertura del panel y filtrar
localmente. Requiere acceso a la tarea (`403 ACCESO_DENEGADO`, `404 TAREA_NO_ENCONTRADA`).

```json
{ "data": [
    { "id": "uuid-1", "nombre": "Leo",   "email": "leo.a@empresa.com" },
    { "id": "uuid-2", "nombre": "leo",   "email": "leo.b@empresa.com" },
    { "id": "uuid-3", "nombre": "Pilar", "email": null }
  ],
  "total": 3 }
```
- Solo miembros activos del tablero; sin mando alto ajeno; sin inactivos.
- `email` **solo** cuando el nombre se repite en la lista (comparando sin mayúsculas ni
  espacios de los bordes); en el resto es `null`. Usarlo únicamente para diferenciar en el
  selector. No se devuelven otros datos personales.
- Orden: por nombre.

### 3.4 Comentarios en las respuestas (aditivo)

```json
{ "tipo": "comentario", "id": "uuid", "contenido": "@[Leo](3f0c…e1), revisá…",
  "menciones": [ { "id": "3f0c…e1", "nombre": "Leo", "activo": true } ],
  "…resto sin cambios…": "" }
```
`menciones` = menciones vigentes en orden de aparición (sin email). **Comentarios históricos**
y sin tokens: `menciones: []` y `contenido` intacto.

Render: recorrer `contenido` con la expresión de 3.1. Si el uuid está en `menciones`, mostrar
un chip con `menciones[i].nombre` (nombre actual; refleja renombres). Si no está (usuario
eliminado o mención quitada que quedó como texto), mostrar `@Etiqueta` como texto común.

---

## 4. Notificaciones (`/api/notificaciones`)

Complementan al Centro de Alertas: `GET /api/alertas` **no cambia**. La campana muestra
ambas; el contador total = alertas + `no_leidas`. Consulta periódica (sin tiempo real);
sugerencia: contador cada 60 s y lista al abrir la campana.

**Pendiente** = no leída **y** de una tarea que el usuario ve hoy. Es lo que cuentan
`no_leidas` (listado), `GET /no-leidas/cantidad` y lo que devuelve `estado=no_leidas`; los
tres coinciden. Una no leída de una tarea a la que perdió el acceso no es pendiente, pero se
conserva: aparece en `estado=todas` con `accesible: false` y vuelve a ser pendiente si
recupera el acceso.

### 4.1 `GET /api/notificaciones?estado=todas|no_leidas&limite=20&offset=0`

`estado`: `todas` (defecto; historial completo) o `no_leidas` (pendientes). `limite` 1..50
(defecto 20). Orden: más reciente primero.

```json
{
  "data": [
    {
      "id": "uuid",
      "tipo": "mencion_comentario",
      "created_at": "2026-11-03T11:00:00.000Z",
      "leida": false,
      "leida_at": null,
      "accesible": true,
      "autor": { "id": "uuid", "nombre": "Nico" },
      "tarea": { "id": "uuid", "titulo": "Revisar bomba", "tablero_id": "uuid" },
      "comentario": { "id": "uuid", "eliminado": false, "eliminado_at": null, "mencion_vigente": true },
      "destino": { "modulo": "operations", "tablero_id": "uuid", "tarea_id": "uuid", "comentario_id": "uuid" }
    }
  ],
  "no_leidas": 3,
  "limite": 20,
  "offset": 0,
  "hay_mas": false
}
```
Nunca incluye el texto del comentario. Errores: `400 PARAMETRO_INVALIDO`, `401`.

### 4.2 Estados que distingue el frontend

| Situación | Cómo se reconoce | Qué mostrar / hacer |
|---|---|---|
| Comentario disponible | `accesible: true`, `comentario.eliminado: false`, `comentario.mencion_vigente: true` | Navegar a `destino` y resaltar `destino.comentario_id` |
| Mención que dejó de estar vigente | `accesible: true`, `comentario.eliminado: false`, `comentario.mencion_vigente: false` | "Te mencionó (la mención fue quitada)"; navegar al comentario |
| Comentario eliminado | `accesible: true`, `comentario.eliminado: true` (`mencion_vigente: false`, `destino.comentario_id: null`) | "Te mencionó en un comentario que fue eliminado"; navegar a la tarea |
| Tarea sin acceso | `accesible: false`; `autor`, `tarea`, `comentario`, `destino` = `null` | Texto genérico sin enlace; se puede marcar como leída |
| Tarea eliminada | La notificación **ya no existe** (se elimina con la tarea): desaparece del listado y del contador. Si estaba en pantalla: `PATCH …/leida` → `404 NOTIFICACION_NO_ENCONTRADA`; abrir la tarea → `404 TAREA_NO_ENCONTRADA` | Quitarla de la lista; "La tarea ya no existe" |

Abrir desde `destino`: tablero `destino.tablero_id`, tarea `destino.tarea_id`, y en
`GET /api/operations/tareas/:tarea_id/actualizaciones` buscar el comentario
`destino.comentario_id`. Ese endpoint revalida el acceso: `403 ACCESO_DENEGADO` = "ya no tenés
acceso"; `404 TAREA_NO_ENCONTRADA` = "la tarea ya no existe".

### 4.3 `GET /api/notificaciones/no-leidas/cantidad`

```json
{ "no_leidas": 3 }
```
Pendientes (ver arriba).

### 4.4 `PATCH /api/notificaciones/:id/leida`

Sin body. `200` con la notificación (forma 4.1) y `leida: true`. Idempotente: si ya estaba
leída conserva su `leida_at`. Funciona aunque no se tenga acceso a la tarea. `404
NOTIFICACION_NO_ENCONTRADA` si no existe o es de otro usuario. No hay "marcar como no leída":
una vez leída, queda leída.

### 4.5 `POST /api/notificaciones/marcar-todas-leidas`

Sin body. Marca todas las no leídas del usuario, **incluidas** las de tareas sin acceso.

```json
{ "actualizadas": 3, "no_leidas": 0 }
```

### 4.6 Ciclo de vida (claves foráneas)

| Evento | Efecto | Mecanismo |
|---|---|---|
| Comentario con menciones | Una notificación por persona (salvo el autor), en la misma transacción | `tarea_comentario_crear` |
| Edición que agrega menciones | Solo para quien nunca fue notificado por ese comentario | índice único `(destinatario, tipo, comentario)` |
| Edición que quita una mención | Se conserva (`mencion_vigente: false`) | la mención sale de `tarea_comentario_menciones`; la notificación no |
| Comentario eliminado | Se conserva (`comentario.eliminado: true`) | `notificaciones.comentario_id` **sin FK** + trigger que completa `comentario_eliminado_at` |
| Tarea eliminada | Se elimina | `tarea_id` → `tareas` `ON DELETE CASCADE` |
| Destinatario eliminado | Se elimina | `destinatario_id` → `usuarios` `ON DELETE CASCADE` |
| Autor eliminado | `autor: null` | `autor_id` → `usuarios` `ON DELETE SET NULL` |
| Destinatario pierde/recupera acceso | `accesible: false` / vuelve a `true`; deja/vuelve a ser pendiente | evaluado al consultar |

---

## 5. Compatibilidad

- Rutas existentes sin cambios. Cambios en respuestas: aditivos (`origen`, `version`,
  `corregido`, `corregido_at`, `menciones`, `codigo` en errores de estas rutas), con una
  excepción intencional: `permisos.puede_editar` de los registros de tiempo puede ser `true`.
- `POST/PATCH /:id/comentarios` aceptan texto sin tokens exactamente como antes.
- `GET /api/alertas` y los errores del resto de los módulos no cambian.

## 6. Supuestos que el frontend debe validar

1. Puede enviar las fechas con offset explícito tomado de la zona horaria del navegador
   (incluido el cambio de horario, si aplica) y no depende de que el backend asuma
   `America/Argentina/Buenos_Aires`.
2. Su editor de comentarios puede insertar y mostrar tokens `@[Nombre](uuid)` (chips) y
   acepta que el texto devuelto difiera del enviado (etiquetas normalizadas).
3. Su contador de 2000 caracteres cuenta el texto con los tokens completos.
4. Puede reconciliar el comentario guardado con la respuesta (no reusar el texto local).
5. Puede agregar `no_leidas` al contador actual de alertas sin duplicar, y hacer polling sin
   sobrecargar (sugerencia 60 s; no hay tiempo real).
6. Puede resolver la navegación con `destino.tablero_id` + `tarea_id` (y resaltar
   `comentario_id`) con sus rutas actuales.
7. Usa `codigo` para la lógica y `error` solo para mostrar; contempla respuestas sin
   `codigo` (401 del middleware, 500).
8. Muestra registros con `fecha` en el pasado en su lugar cronológico del panel.
9. Usa `email` de mencionables solo como texto secundario para homónimos.

## Cambios respecto de r1

- Errores: nuevo campo `codigo` (tabla 0.1) en los endpoints de esta funcionalidad.
- `mencionables`: `email` es `null` salvo para nombres repetidos.
- Notificaciones: `no_leidas`, `/no-leidas/cantidad` y `estado=no_leidas` cuentan solo
  pendientes **con acceso vigente**; las demás se conservan en `estado=todas`.
- Documentados: estados de notificación (4.2), formato común de advertencias (1.3),
  contigüidad, tareas eliminadas, supuestos de frontend (6).
- Sin cambios en migraciones ni en rutas.
