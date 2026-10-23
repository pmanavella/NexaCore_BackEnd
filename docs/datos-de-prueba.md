# Datos de prueba para nexacore-test

**Para:** Valentina (seed y reinicio) · **Diseño:** Pilar · **Versión:** 1.2, 23/10/2026

Todos los datos son ficticios. Las descripciones empiezan con `TEST` para reconocerlas. Las fechas marcadas como *relativas* se calculan en el seed a partir de la fecha de ejecución (`CURRENT_DATE`), para que los casos de vencimientos funcionen cualquier día.

## 1. Usuarios

Un usuario activo por rol sin permisos manuales, uno inactivo y dos con permiso manual en la matriz del módulo `finance` (regla RN-02). Correo `test.<rol>@nexacore.test`; contraseñas solo en los secretos de GitHub.

| ID | Rol | Estado | Usado en |
|---|---|---|---|
| U-01 | Superadmin | Activo | 03, 16, 17 |
| U-02 | Dirección | Activo | 03-07, 05, 06, 14, 16, 17 |
| U-03 | Contable | Activo, sin permiso manual | 16, 17 |
| U-04 | Auditor / Lector | Activo | 16, 17 |
| U-05 | Comercial | Activo | 16 |
| U-06 | Operativo | Activo | 16 |
| U-07 | Pasante | Activo | 16 |
| U-08 | Externo | Activo | 16 |
| U-09 | Contable | **Inactivo** | 16-02 |
| U-10 | Contable | Activo, **permiso manual nivel editor** | 16-06, 17-01, 02, 04 |
| U-11 | Auditor / Lector | Activo, **permiso manual nivel lector** | 16-07, 16-08, 17-01 |
| U-12 | Mando Medio (rol legacy: existe en la base pero no en la matriz del frontend); correo `test.rol-legacy@nexacore.test` | Activo, sin permiso | 16-10 |

## 2. Empleados (tabla de decisión de sueldos)

Planta y temporal se alternan porque no intervienen en el cálculo.

| ID | Permanencia | Estructura | Moneda | Cotización | monto_base |
|---|---|---|---|---|---|
| E-01 | Planta | Mensual | ARS | — | 800.000 |
| E-02 | Temporal | Por hora | ARS | — | 5.000 |
| E-03 | Planta | Por turno | ARS | — | 40.000 |
| E-04 | Temporal | Mensual | USD | Compra | 1.000 |
| E-05 | Planta | Por hora | USD | Compra | 10 |
| E-06 | Temporal | Por turno | USD | Compra | 80 |
| E-07 | Planta | Mensual | USD | Venta | 1.000 |
| E-08 | Temporal | Por hora | USD | Venta | 10 |
| E-09 | Planta | Por turno | USD | Venta | 80 |

Los empleados en dólares necesitan `cotizacion_tipo`, `cotizacion_valor`, `cotizacion_fecha` y `cotizacion_fuente`. Usar compra 1000 y venta 1050, fuente `TEST`.

**Cotización del día:** una fila en `cotizaciones_dolar` con fecha *relativa* (hoy, en UTC), compra 1000 y venta 1050. Para probar la ausencia de cotización, el caso la borra y el reinicio la restaura.

## 3. Movimientos de septiembre de 2026 (libro diario)

| ID | Fecha | Tipo | Categoría | Descripción | Monto |
|---|---|---|---|---|---|
| M-01 | 2026-09-02 | Ingreso | Servicios | TEST Abono soporte cliente A | 500.000 |
| M-02 | 2026-09-05 | Ingreso | Tecnología | TEST Licencia de software | 300.000 |
| M-03 | 2026-09-08 | Gasto | RRHH | TEST Capacitación del equipo | 120.000 |
| M-04 | 2026-09-10 | Gasto | Insumos | TEST Resmas de papel | 45.000 |
| M-05 | 2026-09-12 | Gasto | Servicios | TEST Cuota social del club | 15.000 |
| M-06 | 2026-09-15 | Gasto | Otros | TEST Interés por pago fuera de término | 8.000 |
| M-07 | 2026-09-15 | Gasto | Otros | TEST Comisión bancaria por transferencia | 2.500 |
| M-08 | 2026-09-20 | Gasto | Suscripción | TEST Hosting mensual | 30.000 |
| M-09 | 2026-09-25 | Gasto | Insumos | TEST Café 1 | 0,50 |
| M-10 | 2026-09-25 | Gasto | Insumos | TEST Café 2 | 0,50 |
| M-11 | 2026-09-25 | Gasto | Insumos | TEST Café 3 | 0,50 |

**Sueldos de septiembre:** SA-01 para E-01 por 800.000 y SA-02 para E-03 con 5 turnos (200.000), ambos con fecha 2026-09-30. Total 1.000.000.

**Totales esperados del mes:** ingresos operativos 800.000 · egresos operativos 1.210.001,50 · egresos financieros 10.500 · total 2.020.501,50.

**Movimientos de octubre de 2026** (para las pruebas de listado): una fila por categoría, tipo Gasto, desde 2026-10-01 (una por día, en el orden RRHH, Insumos, Servicios, Otros, Suscripción, Tecnología, Inversión: hasta 2026-10-07), monto 1000, descripción `TEST Octubre <categoría>` y notas `listado-octubre`. Además, el gasto vinculado a S-05 se crea con la fecha del día del reinicio, así que octubre tiene 8 movimientos solo si el reinicio se corre en octubre.

**Nota:** los casos de listado de octubre deben filtrar por `notas = 'listado-octubre'`, porque los casos de REQ-FIN-02 crean movimientos con fecha 2026-10-15.

## 4. Suscripciones (fechas relativas)

| ID | Estado | Frecuencia | Día de vencimiento | Particularidad |
|---|---|---|---|---|
| S-01 | Activa | Mensual | Hoy | — |
| S-02 | Activa | Mensual | Hoy + 7 días | Límite superior de la ventana |
| S-03 | Activa | Mensual | Hoy + 8 días | Fuera de la ventana |
| S-04 | Activa | Mensual | Ayer | Ya venció en el mes |
| S-05 | Activa | Mensual | Hoy + 3 días | Con un gasto vinculado por `suscripcion_id` en el período |
| S-06 | Pausada | Mensual | Hoy + 2 días | — |
| S-07 | Activa | Mensual | 31 | Para el cálculo en meses cortos |
| S-08 | Activa | Trimestral | Hoy + 5 días | — |

Si "hoy + N" cae en el mes siguiente, el seed ajusta el día igual que el sistema. Valentina valida esta lógica al escribir el seed.

## 5. Comprobantes y migraciones

| ID | Contenido | Usado en |
|---|---|---|
| C-01 | Comprobante `procesado` con huella fiscal | Duplicados |
| C-02 | Comprobante en `requiere_revision` | OCR |
| B-01 | Batch de migración `completado` con 3 gastos | CP-FIN-03-08 |
| B-02 | Batch `revertido` | CP-FIN-03-09 |
| B-03 | Batch `procesando` | CP-FIN-03-10 |

C-01 está vinculado al movimiento de octubre de la categoría Insumos.

La variable `COMPANY_CUIT` del entorno de pruebas tiene que tener 11 dígitos, o todos los comprobantes quedan en revisión.

## 6. Archivos de prueba (en el repositorio, no en la base)

Van en `test/fixtures/`.

| Carpeta | Archivo | Contenido |
|---|---|---|
| excel/ | `base-7-categorias.xlsx` | 7 filas válidas, una por categoría, incluida Suscripción |
| excel/ | `monto-cero.xlsx` | Una fila con monto 0 numérico |
| excel/ | `fecha-dd-mm.xlsx` | Fecha 31/12/2026 |
| excel/ | `fecha-inexistente.xlsx` | Fecha 2026-02-31 |
| excel/ | `tipo-con-espacio.xlsx` | Tipo " Gasto" |
| excel/ | `150-filas-error-120.xlsx` | 150 filas; la 120 con monto 0 numérico |
| excel/ | `5mb-exacto.csv` y `5mb-mas-1.csv` | Límites de tamaño |
| excel/ | `tres-filas-invalidas.xlsx` | Tres filas con errores distintos |
| excel/ | `montos-texto.xlsx` | Montos como texto: `1.234,56`, `1.234`, `1,5` |
| migracion/ | `montos-formatos.xlsx` | Totales como texto: `1.234,56`, `1,5`, `$ 1,234.50`, `0.004`, `1.234`, `1.234.567`, `1.5`, `1,2,3`, y una celda numérica 1234.56 |
| migracion/ | `sin-concepto.xlsx` | Una fila sin nombre, descripción ni concepto |
| migracion/ | `concepto-a.xlsx` | Concepto `a` |
| comprobantes/ | `factura.pdf`, `ticket.jpg`, `ticket.png` | Formatos válidos |
| comprobantes/ | `firma-falsa.pdf` | Texto con extensión .pdf |
| comprobantes/ | `10mb-mas-1.pdf` | Límite de tamaño |

## Control de cambios

| Versión | Fecha | Cambios |
|---|---|---|
| 1.0–1.1 | 17/10/2026 | Versiones anteriores, sin historial registrado |
| 1.2 | 23/10/2026 | Alineado con el seed de nexacore-test: U-12 usa el rol legacy Mando Medio; S-06 pasa de Inactiva a Pausada (Inactiva no es un estado válido del esquema); se detallan los movimientos de octubre y el vínculo de C-01 |
