# Fase TP — Calendario de Pagos

> **Tesis (ADR-064):** el Calendario de Pagos es un **consumidor**, no una caja de captura. Cada
> obligación nace **precargada y autorizada en su módulo de origen** (Compras / Presupuestos /
> Finanzas); el calendario solo la **asigna** a un día, dentro de una **capacidad que Presupuestos
> fija por fecha**, y prepara su ejecución (método/banco/caja) para que Caja General la corra.
> Vive en `/finanzas/calendario-pagos` — Tesorería es UNA de las responsables del proceso, no su
> dueña exclusiva; por eso el módulo no cuelga de "Tesorería" sino de Finanzas en general.
>
> Absorbe el sprint **PP.5** de [`FASE_PP_PROGRAMA_PAGOS.md`](FASE_PP_PROGRAMA_PAGOS.md) (la mitad
> *prospectiva* del mismo dominio; PP sigue siendo la bitácora *retrospectiva* del Excel).

Estado: **🧪 EN CÓDIGO Y VERIFICADO (DB-direct) — TP.0-TP.5 2026-09-14 + TP.6-TP.8+TP.10
(control interno) 2026-09-15.** Falta validación visual (`nx serve view` no se pudo levantar
esta sesión) y despliegue a Railway. TP.9 (comprobación final) declarado para la siguiente entrega.

---

## Lo medido antes de diseñar (research, sin código)

- **Presupuestos no existe.** Cero tablas, cero permisos, cero pantalla. Sí existe ya un **rol legado**
  `coordinador_presupuestos` (mapeado hoy al área `finanzas` en `role-presets.ts`, sin permisos propios
  de este dominio) — la fase le da por fin algo que gestionar.
- **Tesorería / Programación de Pagos no existe como motor de asignación.** Lo que sí existe es
  `finance.payment_program` (Fase PP): una **bitácora** de pagos ya ejecutados, importada del mismo
  Excel `PROGRAMA PAGOS 2026.xlsx`. Es retrospectiva, no autoriza ni reserva nada.
- **No existe una entidad "cuenta por pagar / saldo pendiente"** dentro de la plataforma. El aging
  vive fuera (Kepler 201 / ContPAQi 2120, ver Fase CXP §"Cuadre y deuda"). `commercial.purchase_orders`
  / `goods_receipts` (RA.15) trackean **unidades y costo pactado**, no una obligación de pago con
  vencimiento negociable y parcialidades.
- **Caja General existe** (`libs/finance/lib/caja`) pero sólo para el flujo venta-diaria→depósito+
  arqueo; no ejecuta pagos salientes.
- **No hay precedente de UI de calendario** (`p-calendar` de PrimeNG está instalado, 0 usos reales).
  Se construye el componente de navegación por fecha desde cero.

## Qué se construyó

### Orígenes de obligación (uno por responsable, mismo shape, tablas separadas)

| Schema.tabla | Responsable | Qué registra |
|---|---|---|
| `budget.expense_obligations` | Presupuestos | Gastos autorizados y requerimientos de operación (luz/renta/sueldos/comisiones/operativo/otro) |
| `finance.financial_commitments` | Finanzas | Compromisos financieros de deuda (factoraje/interés/amortización/otro) |
| `commercial.supplier_payment_obligations` | Compras | Proveedores de mercancía (opcionalmente ligada a `purchase_orders`/`goods_receipts` de RA.15) |

Columnas compartidas (no una tabla compartida — **tres tablas**, un mismo contrato): `original_amount`,
`reserved_amount`, `paid_amount` (mantenidos por el motor de asignación, nunca por captura manual),
`original_due_date`, `negotiated_date`, `status` (`pending|partial|paid|cancelled`), `authorized_by`/
`authorized_at` **NOT NULL** (una obligación sin autorización no puede existir — criterio de aceptación
#2), `notes`, auditoría completa. `is_critical`/`critical_reason` vive en `catalog.suppliers` (para
proveedores) y en cada tabla de gasto/compromiso — **flag manual con motivo, nunca inferido del
importe** (regla explícita del pedido).

### Capacidad por día (Presupuestos)

- `budget.daily_capacity` — 1 fila por fecha: `authorized_amount`. Sin fila = capacidad **no definida**
  (NULL), distinto de capacidad **cero** — un día sin capacidad definida no permite liberar pagos.
- `budget.daily_capacity_history` — cada cambio de monto queda con motivo + quién + cuándo. Si una
  reducción deja el día excedido, el lote no puede pasar a `released` hasta resolverse (ver abajo).

### El motor de asignación (Tesorería — Programación de Pagos)

- `finance.payment_calendar_lots` — 1 fila por día (`draft → scheduled → in_prep → released →
  executing → closed`). Es el "borrador del día".
- `finance.payment_allocations` — 1 fila = **1 pago que el día agenda**. Nace con solo fecha + monto
  (criterio #4: sin banco ni método). Más tarde se le completa `payment_method` / `bank_account_id` /
  `destination_account_text` / `cash_register_text` / `reference_text` (preparación operativa, §7 del
  pedido). Reprogramar = mover `lot_id` a otro día (self-FK `reprogrammed_from_id` deja el rastro).
- `finance.payment_allocation_items` — el join N:M contra las obligaciones (polimórfico por
  `obligation_source` + `obligation_id`), cada uno con su `applied_amount`. Con esta tabla:
  - **Un pago cubre varias facturas** → 1 `allocation`, N `items`.
  - **Una factura se parcializa en varias fechas** → N `allocations` (fechas distintas), mismo
    `obligation_id` en sus `items`.
  - **Nunca se reserva el mismo saldo dos veces**: disponible = `original_amount − Σ(items activos,
    TODAS las fechas) − paid_amount`.
- `finance.payment_negotiation_agreements` — acuerdos (responsable, contraparte, fecha/monto
  comprometido, permite parcialidad, evidencia), ligados a una obligación y opcionalmente a un `item`.

**Regla de capacidad:** consumo del día = `Σ amount_assigned` de allocations no-canceladas de ese lote,
**sin importar si ya se ejecutaron** (criterio #10: ejecutar no vuelve a liberar capacidad). Liberar un
lote (`draft/scheduled → released`) exige capacidad definida y `consumo ≤ authorized_amount` (criterio
#5). Un movimiento **fallido** no liquida la obligación (criterio #11): su reserva regresa al fondo
común (puede reprogramarse), la obligación sigue con el mismo saldo pendiente.

### Vista agregada de obligaciones (lo que ve el calendario)

`PaymentCalendarService.listObligations()` hace un `UNION ALL` tipado sobre las tres tablas de origen
(nunca las escribe) + resta lo ya reservado/pagado → `available_amount`. Filtra por origen,
clasificación, beneficiario, sucursal, vencimiento, prioridad, criticidad (criterio de filtros del
pedido). Los pendientes **no se pierden al cambiar de mes/año** (criterio #12): la lista de
obligaciones no está acotada por el día en pantalla, sólo por estado (`pending`/`partial`) y saldo
disponible > 0.

---

## Permisos (reuso antes que nuevo — regla del proyecto)

| Permiso | Nuevo/reusado | Para qué |
|---|---|---|
| `FINANCE_PAYMENTS_VER` / `_GESTIONAR` | **reusado** (ya usado por Programa de Pagos, Pagos a proveedor, Cuadre-proveedor) | Ver/operar el Calendario de Pagos + compromisos financieros (Finanzas) |
| `PRESUPUESTOS_VER` / `_GESTIONAR` | **nuevo** | Capacidad diaria + gastos autorizados (Presupuestos) — otorgado a `coordinador_presupuestos` |
| `COMPRAS_OBLIGACIONES_VER` / `_GESTIONAR` | **nuevo** | Obligaciones a proveedor de mercancía (Compras) — grupo `compras` existente |
| `COMPRAS_PROVEEDORES_GESTIONAR` | **reusado** | Marcar proveedor crítico (`catalog.suppliers.is_critical`) |

## Pantallas

- `/finanzas/calendario-pagos` — el calendario: navegador de fecha (día/semana/mes/año), resumen del
  día (capacidad/asignado/restante/ejecutado/pendiente), obligaciones disponibles (filtros), pagos del
  día (agregar/quitar/dividir/reprogramar/preparar), liberar lote.
- `/finanzas/presupuesto` — Presupuestos: capacidad por fecha (con historial) + gastos autorizados
  (alta + bandeja).
- `/compras/obligaciones` — Compras: obligaciones a proveedor (alta + bandeja) + marcar crítico.

## Sprints

- **TP.0** — schema (`budget.*`, `finance.financial_commitments`, `commercial.supplier_payment_obligations`,
  `catalog.suppliers.is_critical`) + motor de asignación (`payment_calendar_lots/allocations/
  allocation_items/negotiation_agreements`). Migraciones idempotentes, RLS forzado, grants `app_runtime`.
- **TP.1** — backend: capacidad + historial, obligaciones de gasto (Presupuestos), compromisos
  financieros (Finanzas), obligaciones a proveedor (Compras, `libs/commercial`), agregación UNION,
  lotes/allocations/items (crear, agregar/quitar obligación, reprogramar, preparar, ejecutar, marcar
  fallido, liberar lote con validación de capacidad), agreements.
- **TP.2** — permisos: enum + meta + `role-presets` (grupo `presupuestos` nuevo, `compras` extendido)
  + `authz-tree` (3 módulos nuevos) + migración de reparto a `coordinador_presupuestos`.
- **TP.3** — frontend: las 3 pantallas de arriba, Operations (sin Fraunces, tabla densa, tokens).
- **TP.4** — smoke test (`database/tests/test-newdb-payment-calendar.js`): **50 ✓ / 0 ✗** contra
  `platform_test` real + alta en `run-all-tests.js`. Migraciones aplicadas localmente de forma
  directa (`migrate:latest` se colgó ~17 min por un backlog de migraciones de otras sesiones en la
  DB compartida, sin relación con esta fase — se abortó, se liberó el lock huérfano de
  `knex_migrations_lock`, y se aplicaron las 3 migraciones con `exports.up(knex)` + registro manual
  en `knex_migrations`, compatible con un futuro `migrate:latest` real).
- **TP.5** — documentación: tracker, changelog, este doc, ADR-064.

MVP = TP.0-TP.5 (este corte).

## Seed de ejemplo (90 días)

`database/seeds-newdb/08_mega_dulces_payment_calendar_demo.js` (corre con `npm run seed:new`,
idempotente por `created_by = 'seed:payment-calendar-demo'`). Puebla capacidad para 90 días
(hoy-30..hoy+59, 2 días sin capacidad definida a propósito, 1 día con capacidad reducida para
que el consumo la EXCEDA, 1 ajuste posterior con historial de 2 filas), 12 gastos autorizados,
8 compromisos financieros y 16 obligaciones a proveedores **reales** del catálogo (no se inventan
proveedores) — y una mezcla de pagos en todos los estados: ejecutados (transferencia/cheque/
efectivo/cargo automático), uno fallido, uno que agrupa 2 obligaciones, uno parcializado en 2
fechas, uno reprogramado (con lineage), y varios pendientes sin preparar. Deja además obligaciones
sin asignar a propósito para ejercer el flujo de "obligaciones disponibles". Verificado contra
`platform_test`: exceso de capacidad ($23,400 > $20,000) y parcialidad ($18,120+$12,080=$30,200,
reserved=100%) confirmados por consulta directa.

## Extensión TP.6-TP.8+TP.10 (ADR-065, 2026-09-15) — control interno real

Pedido explícito del usuario sobre el módulo ya construido: capacidad más visible, catálogo de
cuentas de pago a proveedor (con adjunto de la solicitud), folio consecutivo al autorizar,
leyendas de control interno, botón de impresión para Caja General, y reprogramación de fallidos
con motivo. Investigación previa (sin código) ancló el diseño en 5 patrones ya existentes (ver
ADR-065) antes de construir.

- **TP.6 — separación de funciones**: permiso nuevo `FINANCE_PAYMENT_CALENDAR_AUTORIZAR`
  (fuera de todo `MODULE_GROUP`, repartido sólo a `gerente_finanzas`/`direccion`/`superadmin` vía
  migración `20260915130000`) exige liberar (autorizar) el lote — distinto de `FINANCE_PAYMENTS_
  GESTIONAR` (preparar). `suggestPriorityOrder` propone el orden de pago (compromiso financiero →
  crítico → resto); `setPriorityRank` lo ajusta a mano; `releaseLot` exige que todo pago pendiente
  tenga orden antes de autorizar. Un lote autorizado/cerrado ya no admite pagos nuevos.
- **TP.7 — catálogo de cuentas de pago a proveedor**: `commercial.supplier_payment_accounts`
  (banco/cuenta/CLABE/alias/adjunto JPG-PDF/favorita) + `commercial.supplier_payment_account_
  change_requests` (mismo molde que `finance.proposed_actions`: created_by≠decided_by, NUNCA se
  auto-aplica). Toda alta/cambio/baja pasa por una solicitud — no hay alta directa. Aprobar exige
  `FINANCE_PAYMENT_CALENDAR_AUTORIZAR` (el mismo permiso que libera el lote). Favorita exclusiva
  **por proveedor** (no por tenant). `prepare()` acepta `supplier_payment_account_id` del catálogo
  en vez de texto libre (evita el error de captura que pidió el usuario) — se snapshotea a
  `destination_account_text` para el documento impreso.
- **TP.8 — folio + documentos imprimibles**: folio del lote `YYMMDD-01` (el "01" es el consecutivo
  de lote del día — hoy siempre 1, `UNIQUE(tenant_id,lot_date)` no permite más de un lote/día; sin
  tabla de secuencia porque sólo podría devolver 1) generado SOLO al autorizar; folio de cada pago
  `<folio del lote>-NN` (NN = su orden de pago). `PaymentCalendarDocumentService` (Chromium propio,
  no cruza a `@megadulces/commercial` — ver ADR-065): `renderPreliminar` (documento para
  autorización, disponible aunque aún no tenga folio, con las leyendas de control interno e
  instrucción a Tesorería) y `renderCajaGeneral` (instrucción de ejecución, sólo tras autorizar).
- **TP.10 — motivo de reprogramación**: `reprogram_reason` CHECK cerrado (`cuenta_erronea |
  falla_sistema_banco | pago_devuelto | presupuesto_recortado | otro`) + `reprogram_reason_detail`
  obligatorio si `otro`. `reprogram()` ahora acepta pagos `pending` O `failed` (antes sólo
  pendiente) — cubre tanto "se decidió mover" como "falló, hay que reintentar en otra fecha".

**Migraciones**: `20260915120000_payment_calendar_accounts_and_control.js` (schema) +
`20260915130000_grant_payment_calendar_autorizar.js` (reparto del permiso). Aplicadas localmente
de forma directa (mismo procedimiento que TP.0, ver más abajo).

**Verificado**: `nx build api` + `nx build view` OK. Smoke `test-newdb-payment-calendar-controls.js`:
**28 ✓ / 0 ✗** (workflow de cuenta alta/cambio/baja/rechazo, favorita exclusiva por proveedor,
CHECKs de folio único y motivo cerrado, orden de pago propuesto con la prioridad exacta). El smoke
original (`test-newdb-payment-calendar.js`) se aisló de datos ambiente (ver hallazgo abajo) y
sigue en **50 ✓ / 0 ✗**.

**Hallazgo real al correr los tests, no en producción**: el smoke original usaba fechas
hardcodeadas (`2026-09-15`/`16`) que **colisionaron con el seed de demo de 90 días** (sección de
abajo) una vez que el reloj real alcanzó esas fechas — `budget.daily_capacity` ya tenía fila ahí.
Fix: el test borra (dentro de su propia transacción con rollback) cualquier fila ambiente de esas
fechas antes de sembrar las suyas — aísla el test de la data de ejemplo en vez de asumir fechas
libres.

**Declarado, no construido en este corte** (decisión explícita del usuario): TP.9 comprobación
final (evidencia de ejecución del pago) — próxima entrega. Integración real con un catálogo de
cajas de Caja General (`cash_register_text` sigue texto libre). Cobertura de inventario por
proveedor y programa de ingresos/forecast de ventas — fuera de alcance, la reunión semanal
Compras/Presupuestos/Tesorería los sigue manejando fuera del sistema.

**Pendiente**: aplicar migraciones a Railway + redeploy api+view + re-login de los roles con el
permiso nuevo. Validación visual (no se pudo levantar `nx serve view` esta sesión).

## Deferred / declarado (no inventado)

- **Ejecución real vs Caja General**: `cash_register_text` es texto libre hoy, no una cuenta de caja
  tipada — Caja General (`libs/finance/lib/caja`) no tiene un catálogo de "cajas" contra el cual atar
  esto. Integrar cuando exista ese catálogo.
- **Conciliación banco↔allocation** (equivalente a PP.4): diferido. Hoy `bank_account_id` se captura en
  la preparación pero no se concilia automáticamente contra `finance.bank_movements`.
- **Importación del histórico del Excel** hacia estas tablas: el Excel sigue alimentando **PP**
  (bitácora), no TP (obligaciones). Migrar el histórico a obligaciones reales requeriría reconstruir
  autorización retroactiva — no se inventa.
- **Vínculo automático `purchase_orders`/`goods_receipts` → `supplier_payment_obligations`**: hoy la
  liga es manual/opcional al capturar la obligación en Compras (el `purchase_order_id`/`goods_receipt_id`
  son nullable). Automatizarlo (crear la obligación sola al confirmar una recepción) queda para RE
  (Fase RE, Recepción de Mercancía 360) cuando esa fase cubra el cuadre 3-vías completo.
- **Motor de prioridad**: hoy el orden sugerido (compromisos financieros del día → críticos → gastos
  críticos → resto) es un `ORDER BY` en el backend, no un score persistido; los ajustes manuales del
  usuario no se re-entrenan (no hay Horus-L de por medio aquí — es un backlog operativo, no un motor
  de inteligencia).
- **`is_critical` de proveedor vive en una pantalla nueva** (`/compras/obligaciones`), no en la pantalla
  existente `/compras/proveedores` (que ya es un archivo grande y en producción — RA.15/RA-PRO). Fusionar
  ambas es un follow-up de bajo riesgo, no parte de este corte.
- **Validación visual del calendario**: no se pudo levantar `nx serve view` en esta sesión (sin
  navegador headed disponible) — el build y el smoke de API sí corrieron.

Ver también [`FASE_PP_PROGRAMA_PAGOS.md`](FASE_PP_PROGRAMA_PAGOS.md) (bitácora retrospectiva del mismo
Excel) y [`FASE_CXP_PAGOS.md`](FASE_CXP_PAGOS.md) (hallazgos/acciones sobre pagos ya hechos).
