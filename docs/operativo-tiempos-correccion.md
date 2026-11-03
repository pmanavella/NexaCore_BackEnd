# Corrección de integridad de temporizadores

Migración: `database/migrations/2026-11-03_tiempos_integridad_y_acceso.sql`.
No aplicada durante el desarrollo de esta corrección. La original se conserva.

## Decisión y alcance

El cierre se hace en PostgreSQL, en la misma transacción que cambia la fuente
de acceso o finalización. No se agregan llamadas desde servicios JS: una llamada
posterior al cambio permitiría fallos parciales y no cubriría todas las escrituras.
Se reutiliza `tarea_es_final`; revisión abierta y cerrada siguen sin ser finales.

Se conservan el trigger original sobre tareas, las RPC/contratos existentes,
el índice único parcial y la columna generada de duración. La RPC de inicio
vuelve a verificar perfil activo y acceso después de adquirir el bloqueo.
El único cambio de servicio es traducir `NX_SIN_ACCESO_TAREA` a HTTP 403.

| Cambio | Efecto sobre activos |
| --- | --- |
| Etapa de una tarea o tipo_base de la etapa pasa a final | Cierre automático |
| Quitar membresía por DELETE, reemplazo de lista o cambio de IDs | Cierre donde pierde acceso; HIGH conserva acceso |
| Usuario deja de estar Activo | Cierre de todos sus activos, también HIGH |
| Eliminar perfil public.usuarios | FK mantiene registros con autor NULL; se cierran sus activos |
| Reasignar rol o cambiar nivel HIGH a otro | Cierre solo en tableros sin membresía |
| Quitar es_admin | No cierra: administración y acceso son diferentes |
| Cambiar permisos de módulo o roles.activo | No cierra: no intervienen en el acceso actual de estas rutas |
| Tarea sin tablero | Solo perfil activo HIGH tiene acceso, igual que el backend |

No se modifica RBAC. Se requiere la migración de jerarquía con
`roles.nivel_jerarquico NOT NULL`; así SQL usa la fuente de verdad del backend,
sin duplicar el fallback JS por nombres legacy. Si cambia la política de acceso,
actualizar esta función SQL y los tests de paridad en la misma entrega.

## Concurrencia y límites

Un advisory lock transaccional común `(20261103, 1)` serializa inicios con
UPDATE de las columnas relevantes y DELETE sobre tareas, etapas, membresías,
usuarios y roles. Triggers BEFORE STATEMENT lo adquieren antes de bloquear filas;
AFTER STATEMENT reconcilia activos con el estado nuevo y las cascadas FK visibles.
La RPC adquiere el mismo lock antes de leer. Si gana inicio, el cambio posterior
cierra su registro; si gana el cambio, inicio vuelve a comprobar y rechaza.
El índice parcial sigue resolviendo duplicados por usuario/tarea.

La reconciliación consulta los activos, no reescribe tiempos ya cerrados, usa
`greatest(clock_timestamp(), inicio)` y `automatico`. Ante rollback del cambio,
también se revierten sus cierres. Un cierre manual concurrente conserva el motivo
de quien cerró primero; la condición `fin IS NULL` evita sobrescribirlo.

Compromiso explícito: serializa también inicios de tareas distintas y examina
los activos globalmente al cambiar estas fuentes. Medir contención/latencia con
volumen real antes de ampliar el uso. El bloqueo termina al terminar la transacción;
no depende de una conexión persistente y es compatible con pooling transaccional.
Transacciones largas demoran los inicios. Escrituras externas que toman locks
en otro orden pueden provocar deadlocks; PostgreSQL aborta una transacción,
sin dejar cierres parciales. No se agregaron reintentos automáticos.

Se admite READ COMMITTED (y READ UNCOMMITTED, equivalente en PostgreSQL).
REPEATABLE READ/SERIALIZABLE se rechazan explícitamente con 40001 para evitar
lecturas antiguas después de esperar el advisory lock. Confirmar el aislamiento
del rol service_role antes de aplicar; no cambiarlo globalmente como parte de
esta migración. Este requisito también alcanza cambios de las fuentes indicadas.

Las garantías cubren escrituras normales con triggers habilitados y comienzos
por la RPC. DML directo privilegiado sobre registros, TRUNCATE, triggers
deshabilitados o cambios arbitrarios de esquema quedan fuera del contrato.

La eliminación/bloqueo exclusivamente en Supabase Auth, sin modificar
`public.usuarios`, no tiene un punto de integración en este módulo. No se agregan
triggers a `auth.users`: alternativa mínima, hacer pasar la baja administrativa
por la desactivación de public.usuarios antes de la baja Auth. Expirar/revocar una
sesión tampoco equivale a perder acceso al tablero; no cierra tiempos.

## Aplicación manual en Developer

1. Confirmar organización y referencia exacta del proyecto Developer por una
   fuente administrativa. No confiar solamente en nombre o DB_LABEL. Comparar
   esa referencia con la URL configurada para desarrollo, sin publicar secretos.
2. Respaldar según el procedimiento del proyecto y elegir una ventana sin
   escrituras del backend. El script toma locks de tablas durante el despliegue.
3. Confirmar que se aplicaron la migración original y la de jerarquía. Revisar
   en solo lectura los casos que bloquearían la aplicación:

   ```sql
   SHOW transaction_isolation;
   SELECT id, tarea_id, inicio, fin
   FROM public.tarea_registros_tiempo
   WHERE fin IS NOT NULL AND motivo_finalizacion IS NULL;
   SELECT count(*) AS roles_sin_nivel FROM public.roles WHERE nivel_jerarquico IS NULL;
   ```

   Si hay cierres sin motivo, investigar su origen y definir una reparación
   explícita por separado. La migración aborta sin inventar manual/automatico y
   sin alterar esos registros. No deshabilitar el trigger protector a ciegas.
4. Abrir el SQL Editor del proyecto confirmado y ejecutar **el archivo completo**
   `database/migrations/2026-11-03_tiempos_integridad_y_acceso.sql`, una vez.
   No volver a ejecutar la migración original: reemplazaría la RPC corregida.
   El script incluye BEGIN/COMMIT; ante un error, hacer ROLLBACK si la sesión
   conserva una transacción abortada y revisar la causa antes de reintentar.
5. La reconciliación inicial cierra activos actualmente inválidos a la hora de
   aplicación. Conserva inicio y calcula duración hasta ese momento; no conoce
   cuándo se perdió acceso en el pasado. Revisar esos tiempos con el responsable.
6. Confirmar que `activos_invalidos` devuelve 0 y revisar los objetos instalados:

   ```sql
   SELECT tgrelid::regclass AS tabla, tgname, tgenabled, pg_get_triggerdef(oid)
   FROM pg_trigger
   WHERE tgname IN ('trigger_tiempos_bloquear_cambio',
                   'trigger_tiempos_reconciliar_cambio',
                   'trigger_tareas_finalizar_tiempos');
   SELECT pg_get_constraintdef(oid)
   FROM pg_constraint
   WHERE conrelid = 'public.tarea_registros_tiempo'::regclass
     AND conname = 'tarea_registros_tiempo_motivo_check';
   SELECT pg_get_functiondef('public.tarea_tiempo_iniciar(uuid,uuid)'::regprocedure);
   ```

   Deben existir los diez triggers nuevos (dos por fuente) más el original;
   comprobar que no estén deshabilitados. Verificar también permisos efectivos
   service_role y denegación anon/authenticated de las funciones nuevas.
7. Desplegar el cambio JS que traduce el nuevo error a 403 y completar la
   integración autorizada antes de habilitar el frontend. Reaplicar la correctiva
   es idempotente: conserva cerrados y reconstruye sus funciones/triggers.

## Validación local y pendiente

`test/tareaActualizaciones.test.js` prueba servicios/HTTP con Supabase en memoria,
incluyendo edición de etapa, revisión, bajas, cambio de rol y la carrera entre
la comprobación JS y la RPC. No prueba PostgreSQL. `test/tareaTiemposMigracion.test.js`
verifica contratos estructurales del SQL; no valida su ejecución ni MVCC.

No ejecutar `npm test` indiscriminadamente: puede descubrir integración remota
si existe .env.test. Usar los archivos locales seleccionados.

Integración pendiente, **solo con autorización y proyecto Developer confirmado**:

- Crear tablero/usuarios/tareas exclusivos `TEST_OPERATIVO_<run_id>`; registrar
  IDs y limpiar solo esos fixtures al terminar, nunca usar reset general.
- Etapa en_curso -> completada/cancelada: todos sus activos cierran con duración
  generada y motivo automatico; otras etapas y cerrados previos se conservan.
  Repetir con ambas revisiones: ningún cierre; reabrir permite nuevos tiempos.
- Quitar miembro por RPC individual y por reemplazo de lista; desactivar perfil,
  eliminarlo y verificar FK SET NULL; cambiar rol individual y nivel del rol.
  HIGH sin membresía conserva acceso, y perder HIGH con membresía lo conserva.
- Intentar insertar fin no nulo/motivo NULL con service_role en fixture: 23514;
  verificar combinaciones válido/inválido de fin y motivo, y rechazo de escritura
  a duración generada. Verificar privilegios anon/authenticated y retorno RPC real.
- Dos sesiones READ COMMITTED, con pausas controladas entre operaciones y COMMIT:
  A inicia y retiene transacción; B cambia etapa o quita miembro, debe esperar.
  COMMIT A permite cierre por B. Invertir el orden: B cambia y retiene, A inicia
  y espera; COMMIT B debe producir NX_TAREA_FINALIZADA/NX_SIN_ACCESO_TAREA en A.
  Repetir para desactivación, eliminación y downgrade de rol. Comprobar que jamás
  se confirman activos finales/sin acceso.
- Inicio/inicio del mismo usuario y tarea: un éxito y un conflicto. Distintos
  usuarios/tareas: ambos permitidos aunque serialicen. Stop/stop y stop/cierre
  automático: un solo cierre, motivo no sobrescrito y duración consistente.
- Hacer ROLLBACK de cambio de etapa/baja y verificar que el temporizador sigue
  activo; provocar rechazo por último administrador y comprobar rollback de cierre.
- Reejecutar correctiva en fixtures y verificar idempotencia. Preparar un cierre
  sin motivo en esquema previo aislado: la correctiva debe abortar sin cambios.
- Medir contención con volumen representativo; verificar aislamiento configurado
  del rol real y respuesta del backend ante 40001/40P01 (actualmente error genérico).

Fundamento: [triggers por sentencia](https://www.postgresql.org/docs/current/sql-createtrigger.html)
y [visibilidad de cambios en triggers](https://www.postgresql.org/docs/current/trigger-datachanges.html).
