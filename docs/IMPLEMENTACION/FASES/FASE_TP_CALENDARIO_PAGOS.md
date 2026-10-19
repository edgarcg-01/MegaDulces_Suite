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

## TP.13 + TP.14 — Quién ve Obligaciones a proveedor (2026-10-01 → 2026-10-03)

### Historia del pedido

1. **2026-10-01.** Francisco pide que **María de la Paz Gutiérrez** (Jefe de Tesorería) tenga acceso
   a las obligaciones con proveedores «que se tienen que ajustar». Se le pregunta qué es ajustar:
   **cambiar el plazo pactado**. Alcance: **sólo a ella**, no a todo el perfil `tesoreria`.
2. **2026-10-03.** Pide una **maqueta de pirámide de accesos**: cada quien ve sólo su lugar
   (sucursal, zona o CEDIS), el CEDIS 00 lo ven quienes coordinan compras de las zonas, y Dirección
   General y Comercial ven todo.
3. Pide **revisar todos los puestos contra las personas y la necesidad real** de entrar al módulo.
4. Agrega a **Julio César Torres** (Auxiliar de finanzas): arma, a pedido de Tesorería, el expediente
   físico de lo que se va a pagar y lo entrega a **Caja General, que hace la dispersión**; y **cuando
   no está su jefa, él hace el programa de pagos** → ve toda la red.
5. Pide **dejarlo por migración y con constancia**, no a mano desde `/admin/personas`.

### Lo medido en prod antes de decidir (2026-10-03, sólo lectura)

- **Hoy Obligaciones NO filtra por lugar.** `SupplierPaymentObligationsController` y
  `SupplierCreditTermsController` no usan `ScopeService`: quien tiene `COMPRAS_OBLIGACIONES_VER` ve
  las 8 sucursales y el CEDIS. La pirámide es una propuesta, no el estado actual.
- **María de la Paz y Julio no tenían ninguna excepción** y sólo entraban por
  `FINANCE_PAYMENTS_GESTIONAR` (`anyPermissionGuard` de RE.32) → veían únicamente «Entregas».
- **Las zonas de compras ya existen**: `commercial.warehouses.purchase_zone`
  (mig `20260910120000`). **La Piedad** = 01 (hub), 02, 03, 04 · **Zamora** = 05, 06 (hub) ·
  **Morelia** = 07, 08 (hub) · **Corporativo** = 00 CEDIS (hub). ⚠️ Canindo es de Zamora, no de Morelia.
- Padrón: **143 personas activas en 41 puestos** (+13 cuentas sin puesto: kioscos, verificadores).

### TP.13 — lo que hace la migración `20261003200000_tp13_obligaciones_tesoreria.js`

| Persona | Puesto | Recibe | No recibe, a propósito |
|---|---|---|---|
| `maria_gutierrez` | Jefe de Tesorería | `COMPRAS_OBLIGACIONES_VER` + `COMPRAS_PLAZOS_AUTORIZAR` | `GESTIONAR` (capturar/cancelar: eso es de Compras) |
| `julio_torres` | Auxiliar de finanzas | `COMPRAS_OBLIGACIONES_VER` | `PLAZOS` (pregunta abierta) y `GESTIONAR` |

- **Por persona, no por rol:** `finanzas_operativo` lo comparten 6 personas y sólo Julio suple a
  Tesorería; el plazo es negociación (RE.30) y no se le da al puesto de Tesorería para siempre.
- **Constancia:** cada excepción lleva su motivo en `nota` y se asienta `permissions_changed` en
  `identity.user_events` → aparece en la pestaña **Historia** de cada persona.
- **4 candados:** las claves existen · la persona existe, está activa y no es de plataforma · el
  **efecto** (rol + adicionales + excepción) es exactamente el pedido, incluidos los tres «no» ·
  los roles `tesoreria`/`finanzas_operativo` no ganaron nada.
- Separación de funciones intacta: quien arma el programa **no lo autoriza**
  (`FINANCE_PAYMENT_CALENDAR_AUTORIZAR` sigue en Gerencia Adm. y Financiera / Dirección), y
  Tesorería **no registra** la deuda.

### TP.14 — La pirámide propuesta (⬜ sin construir)

| Nivel | Ve | Puestos (personas) |
|---|---|---|
| N1 | **Toda la red** | Dirección General (2) · Coordinación de Compras (2) · Comprador (1) · Jefe de Tesorería (1) · Gerencia Adm. y Financiera (2) · Presupuestos y Compras Corporativas (1, lectura) · Coordinación de Auditoría y Prevención (1, lectura) · **Julio Torres** (excepción, lectura) |
| N2 | **Su zona + CEDIS 00** | Analista de Abastecimiento Comercial (1) |
| N3 | **Su zona** | Analistas de Órdenes de Entrada = staff de compras de zona (4) · Gerencia de Zona (3, lectura) · Coordinador de Operaciones de Zona (1) |
| N3 | **Sólo CEDIS 00** | Jefatura de CEDIS (1) · Auxiliar Administrativo de Logística (2) |
| N4 | **Su sucursal** | Encargado(a) de Sucursal (6) · Auxiliar de Encargado (5) |
| N5 | **Su sucursal** | Almacenista, que hoy hace la recepción (5) |
| — | **Sólo pestaña Entregas** | Los otros 3 auxiliares de Finanzas |
| — | **Sin acceso (101)** | Facturación · Contabilidad · Crédito y Cobranza · Caja General (dispersa con el expediente físico y la instrucción autorizada, no necesita la lista) · Supervisor de inventarios · Auxiliares de Prevención · mostrador · ventas · telemarketing · mercadotecnia · RH · Sistemas · cuentas de equipo |

Reglas: **sin lugar asignado no se ve nada** (fail-closed, ADR-050); **ver ≠ ajustar** (el lugar
decide qué renglones, el permiso qué acción); las excepciones van **por persona y con motivo**.
Mecanismo: `ScopeService` + `identity.role_scopes`/`user_scopes` ya existen (`encargado_tienda`,
`auxiliar_tienda` y `almacenista` ya traen `warehouse:own`); lo nuevo es la regla «zona + 00»,
que se resuelve con `purchase_zone`/`is_purchase_hub`.

### Hallazgos del padrón que hay que corregir ANTES de activar TP.14

1. **Los 3 Gerentes de Zona tienen rol principal `superadmin`** (`aaron_alejo`, `ivette_cruz`,
   `ramon_rodriguez`): `ScopeService` los resuelve `all` en todo y ningún filtro los alcanza.
2. **7 personas de sucursal ven hoy toda la red**: los 6 encargados (`encargado_tienda` ya trae
   `COMPRAS_OBLIGACIONES_VER`) y `monica_mejia` (auxiliar con rol de encargado).
3. **`estefania_mendez` (Facturación, mayoreo) tiene rol `auxiliar_compras`** → ve y captura
   obligaciones sin necesitarlo.
4. **`superadmin` como rol adicional** en `luis_hernandez` (almacenista), `claudia_mata`
   (supervisora de inventarios) y `jesus_carrillo` (35 roles adicionales). Confirmar si es intencional.
5. **13 personas que necesitan acceso no tienen lugar**: 4 de Compras sin zona (`gerardo_ramirez`,
   `rafael_quirino`, `mario_ventura`, `juan_elizarraras`), 6 que parecen de CEDIS sin el 00
   (`alberto_moreno`, `don_antonio`, `leonardo_cazares`, `brian_zavala`, `luis_navarro`,
   `luis_hernandez`), `yadira_campero` sin sucursal, y 2 gerentes de zona con zona de ventas pero no
   de compras.
6. **Puestos pedidos que no existen**: «Dirección Comercial» (la cubre `guillermo_lopez` desde
   Dirección General) y «Recepción de mercancía» (la hacen los almacenistas).

### Preguntas abiertas

- ¿Julio también cambia **plazos** cuando suple a Tesorería? Si sí, una línea más en TP.13.
- Coordinación de Compras: ¿toda la red (propuesta) o una zona cada una + CEDIS?
- Analistas de Órdenes de Entrada: ¿una zona cada uno (propuesta) o todas?
- Almacenistas «de oficinas»: ¿son de CEDIS? Si sí, se les asigna el 00.

Maqueta navegable (simulador por puesto y lugar + matriz):
[`prototipos/piramide-accesos-obligaciones.html`](prototipos/piramide-accesos-obligaciones.html).

## TP.15 — De la entrega aceptada al Calendario (2026-10-16)

**Cómo se cargan las facturas para pago, hoy:** Compras arma la entrega en `/compras/obligaciones`
→ «Entregar»; Finanzas la confirma en «Entregas». Cada renglón **aceptado** aparece solo en
«Obligaciones disponibles» del Calendario, con el **saldo pendiente en Kepler** de esa entrada (no
el importe de la entrega) y el vencimiento de Kepler. Lo que Kepler ya no debe no aparece, y el
aviso al confirmar lo cuenta. Al asignarla a un día **y al ejecutar el pago** se vuelve a medir el
saldo de Kepler.

- Mig `20261016002604_tp15_obligacion_desde_entrega_aceptada.js`: `purchase_delivery_line_id` (FK +
  único parcial) y la llave del documento `kepler_sucursal/doc_tipo/doc_sub/folio`; backfill de lo
  ya aceptado (medido: 17 facturas · $1,587,690.31).
- `PurchaseDeliveriesService.toCalendar()` (en un savepoint: si Kepler falla, la entrega queda
  confirmada y el fallo se declara) y `PaymentCalendarService.assertKeplerBalance()`.
- `authorized_by` = quien aceptó el renglón: aceptar el papel es la autorización para programarlo.
- **Deuda declarada (revisión independiente):** el tope no sabe qué pagos del Calendario ya
  registró Kepler (pago ejecutado aquí + NC posterior → tope mayor que la deuda; restar también lo
  pagado bloquearía toda parcialidad); «sin saldo» mezcla pagada y «no casó»; `reprogram` no
  re-mide (lo cubre `execute`); heredado: la misma obligación dos veces en un pago.
- **Falta:** aplicar la mig en prod, prueba de escritura contra base real, reintento para
  aceptaciones cuya lectura de Kepler falló, y la opción B (elegir desde la deuda de Kepler lo que
  no pasa por Entregas: servicios, fletes).

## TP.16 — La semana y «Ordenar y pagar» (2026-10-16)

**Pedido (Francisco, con maqueta en Excel):** ver la semana completa en vez de un día; por día,
presupuesto / comprometido / disponible y sus documentos; y un botón **«Ordenar y pagar»** que
lleve al día con lo que pide el layout de pago: cuenta de origen, cuenta destino, CLABE.
**Dos firmas** (decisión suya): Tesorería ordena y prepara → Gerencia/Dirección autoriza → Caja
General dispersa.

**Lo medido antes:** 8 pagos asignados en prod, **0 preparados**. 20 cuentas en
`finance.bank_accounts` (19 elegibles como origen, sin la caja), pero la pantalla no dejaba elegir el
origen. `commercial.supplier_payment_accounts` = **0 filas**, y Kepler **no guarda la CLABE** de los
proveedores (ninguna columna de `kdxd` trae 18 dígitos; las de 10 son teléfonos): la CLABE es dato
propio y se captura una vez.

**Cómo quedó:**
- `GET /finance/payment-calendar/weeks/:date` → la semana lunes→domingo que contiene la fecha;
  compone `daySummary` + `listDayAllocations` + `getLot` por día (en serie: no 21 transacciones a la
  vez). `GET origin-accounts`. Contrato en `libs/contracts/src/http/payment-calendar.contract.ts`.
- `prepare()`: transferencia / cargo automático / cheque exigen **origen** (activa, no caja);
  transferencia exige además **destino**. Antes bastaba uno de los dos, así que una transferencia
  podía quedar «preparada» sin saber a dónde iba. Una CLABE tecleada se valida con el dígito de
  control de Banxico (`clabeValida`).
- `releaseLot()` se niega si hay pagos pendientes sin preparar: Caja no recibe una instrucción sin
  cuentas.
- Pantalla: rango de semana arriba; obligaciones a la izquierda; 7 tarjetas de día; el panel del día
  con los pasos (orden → preparado → autorizado → Caja dispersa) y la tabla con método, origen y
  destino. Agregar o agrupar elige el día de la semana visible.
- PDF: columna «Cuenta origen»; el total vuelve dentro de la tabla.

**Siguiente etapa: layouts de dispersión.** Se construye aparte, con un archivo real de cada banco
(BBVA, Banorte, Santander, BanBajío). Propuesta en el PR de TP.16.

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

---

# TP.17 – TP.20 — Unificación del ciclo de pagos (plan, 2026-10-16)

```
OBJETIVO: que las cuatro pantallas de Pagos sean un solo ciclo — la deuda que se ve es la que se
          puede programar, el descuento que vence se puede accionar, y el pago se lee de la factura
          al comprobante sin reconstruirlo a mano.
MÉTRICA:  % de la deuda de proveedor que el Calendario puede programar
          HOY: 2.0 % ($2,738,088 de $136,322,731 · 37 de 2,960 docs · medido 2026-10-16)
          META: ≥ 95 % para <fecha a comprometer por el dueño>
CAPA TOPE: C3
ÁREA:      Finanzas
DUEÑO:     <a asignar — sin dueño y fecha no pasa a 🔨>
ESTADO:    ⬜ (plan listo; abrir requiere cupo de §3 y que Fase 0 lo permita)
```

⛔ **Esto NO es una fase nueva.** Es la continuación de TP, que ya tiene fila en el roadmap — a
propósito, porque §7 del método cierra la apertura de fases nuevas hasta terminar la campaña de
aterrizaje, y porque un doc de fase sin fila es justamente lo que 0.3 viene a limpiar.

⭐ **La pieza C0 no se inventa acá: TP.15 ya la dejó escrita como pendiente** — *«la opción B
(elegir desde la deuda de Kepler lo que no pasa por Entregas: servicios, fletes)»*. Este plan le
pone tamaño, árbitro y orden.

---

## 1. Qué problema resuelve — lo medido el 2026-10-16 (prod, sólo lectura)

| Hecho | Valor |
|---|---:|
| Deuda real de proveedor (`analytics.v_supplier_payables`) | 2,960 docs · **$136,322,731** · 377 proveedores |
| Lo que el Calendario puede programar hoy | 37 obligaciones · **$2,738,088** (todas creadas el 16-oct por TP.15) |
| **Cobertura** | **2.0 %** |
| Beneficio de pronto pago **todavía dentro de ventana** | 552 docs · $40.7 M → **$2,420,559** |
| Acciones disponibles en la pantalla de Pronto pago | **ninguna** (no tiene un solo botón) |
| Descuento efectivamente ganado (12 m, `kdm1.c84`) | **$17,696,765** en 2,433 de 5,653 pagos |
| Hallazgos de descuento no capturado, sin triar | 98 · $5,363,294 (detector parado desde 2026-08-29) |
| Días del calendario autorizados en toda la historia | **0** (5 lotes, todos `draft`) |
| Pagos ejecutados ligados a su folio de Kepler | **0** — la columna no existe |
| Gastos autorizados que el calendario puede consumir | **0** (312 en `propuesta`) · compromisos financieros: **0 filas** |
| Libro de Tesorería (`finance.payment_program`) | 2,716 filas · cubre 2026-01…**2026-08** · último write **2026-08-08** |

**El costo de que no estén unidas:** la deuda tiene dos respuestas que difieren 50×; el descuento
que vence se mira pero no se puede accionar; y un pago ejecutado desaparece del calendario y
reaparece en Kepler como un evento sin origen.

---

## 2. Qué NO incluye

- **No escribe en Kepler.** El pago se sigue capturando en el ERP (ADR-040: integrar, no construir).
  Este plan planea y audita; no asienta.
- **No genera la autorización.** Si nadie libera un día, nada cambia: los 312 gastos en `propuesta`
  y los 0 compromisos son un bloqueo **de proceso**, con dueño en §5, no de software.
- **No reconstruye autorización retroactiva** del histórico del Excel — el `Deferred` de TP lo
  rechazó y sigue rechazado. Acá se deriva **deuda viva con saldo > 0**, que es otra cosa: no
  requiere inventar quién autorizó un pago ya hecho.
- **No incluye los layouts de dispersión bancaria** (BBVA / Banorte / Santander / BanBajío):
  TP.16 ya los declaró como etapa aparte, con archivo real de cada banco. Se consume su salida, no
  se construye acá.
- **No revive el detector `descuento_no_capturado`** ni triará sus 98 hallazgos: se declara como
  bloqueo con dueño (§5).
- **No toca nómina ni gasto operativo.** `payment_program` y `analytics.expense_entries` son
  universos distintos y cruzarlos ya produjo un reporte falso una vez.

---

## 3. Los objetivos, y qué sprint los cumple

| # | Objetivo | Número que lo mide (HOY → META) | Sprints |
|---|---|---|---|
| **O1** | La deuda que se ve es la que se puede programar | cobertura **2.0 % → ≥95 %** | TP.17 · TP.18 |
| **O2** | El descuento que vence se puede accionar | acciones en Pronto pago **0 → 1 (programar)**; cola accionable **$2,420,559** | TP.18.3 · TP.20.1 |
| **O3** | Un pago se lee de punta a punta | pagos ejecutados ligados a Kepler **0 % → 100 %** | TP.19.3 · TP.20.2 |
| **O4** | El libro de Tesorería deja de teclearse | meses del libro derivados del calendario **0 → el mes en curso** | TP.19.4 · TP.20.4 |
| **O5** | Una sola puerta a Pagos | renglones de menú **4 → 1 entrada con 4 pestañas**; pantallas en `FINANZAS_TABS` **2/4 → 4/4** | TP.20.3 |

---

## 4. Las capas

### C0 · Dato — TP.17

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| TP.17.1 | Vista `derive-no-copy` de la **deuda pagable completa** sobre `analytics.v_supplier_payables` (que ya deriva de `kepler_ods`), con las cuatro llaves que `assertKeplerBalance` ya usa: `sucursal · folio · doc_tipo · doc_sub` + `proveedor` | ⬜ | Estado de cuenta de acreedores (`/finanzas/estado-cuenta-acreedores`, ECA.2) y la cuenta **201** de Kepler, al mismo grano y mismo corte |
| TP.17.2 | **Dedupe** contra `commercial.supplier_payment_obligations`: una factura que ya entró por Entregas (TP.15) no puede aparecer dos veces. Llave: las mismas cuatro columnas `kepler_*` que la mig `20261016002604` ya dejó en la tabla | ⬜ | Conteo: derivadas + capturadas − solapadas = docs con `pendiente > 0` |
| TP.17.3 | Declarar lo que **no se puede programar y por qué**: sin fecha, sin proveedor resoluble, o proveedor no dado de alta. Nunca se dibuja en cero (ADR-056) | ⬜ | Los 1,969 docs / $74.3 M hoy sin ventana medible deben quedar **nombrados**, no desaparecidos |
| TP.17.4 | **Medir el costo de la lista**: hoy devuelve 37 filas, pasaría a ~2,960. Regla dura: <500 ms | ⬜ | `EXPLAIN ANALYZE` de la consulta REAL del servicio, no de una parecida |

⛔ Sin importer. Unidad probada de ambos lados (el `pendiente` de Kepler es el mismo peso que el
`original_amount` de la obligación). Lo que no se verifique **se declara**.

### C1 · Dominio — TP.18

| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| TP.18.1 | Cuarto `obligation_source: 'kepler_payable'` en el motor polimórfico. **La reserva no cambia de lugar**: sigue en `payment_allocation_items`. Para el origen derivado, disponible = `pendiente`(Kepler) − reservado(items) — exactamente la cuenta que `assertKeplerBalance` ya hace | ⬜ | Spec: dos pagos sobre la misma factura derivada no pueden exceder el pendiente; una factura derivada y la misma capturada **no se reservan dos veces** |
| TP.18.2 | `recalcObligation` **saltea el write** para el origen derivado (no hay tabla propia que actualizar) sin romper los tres orígenes existentes | ⬜ | Spec de regresión de los 3 orígenes actuales |
| TP.18.3 | La **fecha límite de pronto pago** viaja como atributo de la obligación derivada, leída de `analytics.mv_supplier_prompt_discount` (no se recalcula ni se redefine) | ⬜ | Cruce contra lo que publica hoy la pantalla de Pronto pago: mismo doc → misma fecha |
| TP.18.4 | `paymentGroupKey` para el nuevo origen: beneficiario = proveedor, sucursal = la de la factura (`kepler_sucursal`) — la regla de TP.16.3 no se reescribe, se extiende | ⬜ | Spec: no se agrupan dos sucursales ni dos proveedores |

⛔ **La decisión fina (→ ADR, §5):** TP.15 resolvió que *«aceptar el papel es la autorización para
programarlo»* y puso `authorized_by` = quien aceptó. Una factura derivada **no tiene ese acto**.
Hay que decidir y escribir quién autoriza ahí — sin eso, el origen derivado contradice ADR-064.

### C2 · API — TP.19

| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| TP.19.1 | `GET /finance/payment-calendar/obligations` incluye el origen derivado, con filtros y paginación (la lista pasa de 37 a ~2,960) | ⬜ | no | medición de latencia con el payload de la pantalla |
| TP.19.2 | **Programar desde Pronto pago reusa `POST /allocations`** — no hay endpoint nuevo: el front manda `obligation_source: 'kepler_payable'` + la fecha sugerida. Menos superficie que inventar una ruta | ⬜ | **sí** (vía el endpoint existente) | ⛔ obligatoria, payload exacto de la pantalla de Pronto pago |
| TP.19.3 | Columna `kepler_payment_*` (sucursal · doc_prefix · folio) en `payment_allocations`, poblada **al ejecutar**. Migración **aditiva e idempotente** (`hasColumn`), aplicada una por una | ⬜ | **sí** | ⛔ obligatoria. Además: recorrer **todos** los caminos que insertan en `payment_allocations` (regla de la columna NOT NULL — acá es nullable, pero el barrido se hace igual) |
| TP.19.4 | **El libro derivado**: endpoint que arma, desde el calendario ejecutado, lo que hoy se teclea en el Excel (fecha, banco, método, folios cubiertos, beneficiario) | ⬜ | no | cuadre contra `finance.payment_program` en un mes cargado (ej. 2026-07) antes de proponer el reemplazo |

⚠️ TP.19.3 también cierra tres de las deudas que **TP.15 declaró**: el tope que no sabe qué pagos
ya registró Kepler, el «sin saldo» que mezcla *pagada* con *no casó*, y el pago ejecutado que no se
puede reencontrar.

### C3 · UI — TP.20

| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| TP.20.1 | **Pronto pago gana «Programar pago»** con la fecha sugerida que conserva el descuento. Deja de ser un informe | ⬜ | N → N, sin fallas nuevas |
| TP.20.2 | **Pagos a proveedor muestra el origen** del pago: día autorizado + folio de lote, cuando exista | ⬜ | N → N |
| TP.20.3 | **Una entrada «Pagos» con 4 pestañas**, molde `GX.80` ya en prod: shell + `pagos-tabs.ts` + entry guard que lleva a la primera pestaña visible. Las URLs **no cambian**. Hoy sólo 2 de las 4 están en `FINANZAS_TABS` | ⬜ | N → N |
| TP.20.4 | **Programa de pagos** contrasta el Excel contra lo derivado del calendario y **dice de dónde viene cada mes** | ⬜ | N → N |

⛔ Skill `diseno` cargada **antes** de tocar el primer archivo. `npm run check:pantalla -- finanzas`
antes y después. Carga <500 ms. El spec `finanzas-tabs.spec.ts` ya vigila la paridad
sidebar↔pestañas: hay que extenderlo a las cuatro, **y romperlo a propósito una vez**.

---

## 5. Decisiones (→ ADR)

| # | Decisión | ADR | Fecha |
|---|---|---|---|
| D1 | **Quién autoriza una obligación derivada de Kepler.** TP.15 ancló la autorización en el acto de aceptar la entrega; la deuda derivada no tiene ese acto. Opciones: (a) la autorización es el **acto de liberar el día** (el calendario ya la exige y la registra); (b) un paso de aceptación propio para lo que no pasa por Entregas. ⛔ Sin esto escrito, el origen derivado contradice ADR-064 | nuevo | ⬜ |
| D2 | **La obligación capturada no se retira.** Convive con la derivada: aporta fecha negociada, crítico y acuerdos, que la vista no tiene. El dedupe decide cuál manda (TP.17.2) | nuevo o anexo a ADR-064 | ⬜ |
| D3 | **El Excel de Tesorería pasa de captura a contraste**, y sólo se propone retirarlo cuando el libro derivado cuadre contra un mes ya cargado (TP.19.4) | anexo a Fase PP | ⬜ |

---

## 6. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| **Ningún día autorizado jamás** (5 lotes `draft`, 0 folios emitidos) | Gerencia de Finanzas / Dirección | nadie con `FINANCE_PAYMENT_CALENDAR_AUTORIZAR` ha liberado un día | liberar **un** día real, aunque sea de un pago. Hasta que eso pase, el ciclo no se probó de punta a punta |
| **312 gastos en `propuesta`, 0 autorizados**; 0 compromisos financieros | Finanzas (Presupuestos) | proceso: nadie firma la propuesta | autorizar el primer lote de gastos; es prerequisito de O1 para el 7 % no-mercancía |
| **Libro de Tesorería congelado** desde 2026-08-08 (faltan sep y oct) | Tesorería | `import-payment-program.js` corre a mano, sin agenda ni latido (**PP.8**, abierto) | PP.8: subida web del libro o carril agendado con `cron-heartbeat` |
| **Detector `descuento_no_capturado` parado** desde 2026-08-29; 98 hallazgos sin triar | Finanzas / Plataforma | el scanner no tiene latido: su silencio es invisible | latido en `cron_runs` + triage de los 98 |
| **La lista de obligaciones ×80** (37 → ~2,960 filas) | dev de la fase | el calendario nunca cargó ese volumen | TP.17.4 **antes** de C3: medir la consulta real, paginar |
| `analytics.*` **no tiene RLS** | dev de la fase | el alcance lo da el JOIN con `tenant_id` | mismo patrón que `ProntoPagoService` ya usa: filtro explícito, nunca confiar en la vista |
| **Migración en prod** | quien la aplique | hay **dos** `knex_migrations` | `apply-one-migration-prod.js`, una por una. Nunca `migrate:latest` |

⛔ Un bloqueo sin dueño no es un bloqueo, es un item olvidado: los dos primeros necesitan nombre
antes de que la fase pase a 🔨.

---

## 7. Orden de ejecución (y por qué este y no otro)

```
TP.17 (C0) ──► TP.18 (C1) ──► TP.19 (C2) ──► TP.20 (C3)
  deuda          motor           API            pantallas
  completa       acepta          + liga a        + acciones
                 lo derivado     Kepler          + una puerta
```

- **C0 primero, sin excepción.** Es la regla de la capa: si la deuda derivada no está arbitrada
  contra el ECA y la 201, no se escribe pantalla. Los 330 items 🧪 del tracker son exactamente lo
  que pasa cuando se invierte este orden.
- **TP.20.3 (las pestañas) va al final a propósito.** Es lo más visible y lo más barato, y hacerlo
  primero daría sensación de integración sin mover un peso: seguirían siendo cuatro pantallas que
  no se hablan, sólo que más juntas.
- **O2 depende de O1.** El botón «Programar» de Pronto pago no tiene a dónde mandar la factura
  mientras el calendario no la conozca.

---

## 8. Definición de Terminado

- [ ] 1. Cobertura **remedida** con la misma consulta; antes/después publicado (2.0 % → ?)
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA**; los docs sin ventana medible, nombrados
- [ ] 3. `POST /allocations` con el payload real de Pronto pago y el `ejecutar` con la liga a
      Kepler, **ejercidos contra base real** — no doubles de Knex, no smoke por regex
- [ ] 4. El spec de paridad sidebar↔pestañas **roto a propósito**, rojo verificado
- [ ] 5. Si el dedupe o la frescura resultan genéricos, viven en `libs/` **o** quedan como deuda
      con nombre
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` + fila TP del roadmap al día; D1–D3 con su ADR
- [ ] 7. En prod, o escrito **por qué no** y qué falta

---

## 9. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-16 | Plan escrito sobre medición de prod (sólo lectura). Sin dueño ni fecha: no pasa a 🔨 | Claude |

---

## 10. TP.17.1 — Resultado del arbitraje C0 (2026-10-16, prod sólo lectura)

**Qué se arbitró:** `analytics.v_supplier_payables` (el origen que alimentaría el calendario, y que
hoy ya alimenta Pronto pago y el tope de `assertKeplerBalance`) contra **la regla del Estado de
Cuenta de Acreedores** (`[ECA.7]`), que es el testigo independiente del mismo ERP y el mismo grano:
excluye el documento cancelado (`kdm1.c43='C'`) **y** la aplicación cuyo abono está cancelado.

| Medición | docs | pendiente |
|---|---:|---:|
| Recálculo con la regla del ECA | 2,992 | **$136,683,665** |
| `v_supplier_payables` (lo que se publica hoy) | 2,969 | **$136,511,778** |
| **Desviación** | **30 docs · 15 proveedores** | **$172,180 — 0.13 %** |

✅ **La vista queda arbitrada**: sirve como origen C0 con una desviación conocida, acotada y
nombrada. ⛔ Esos 30 documentos **se declaran**, no se redondean: la vista **subestima** la deuda
ahí, porque resta aplicaciones cuyo abono Kepler canceló.

### Hipótesis refutada (se registra para que nadie la reconstruya)

⛔ **«La vista publica deuda cancelada como viva» — FALSO, y por dos órdenes de magnitud.** Medido:
**3 documentos · $293 · 1 proveedor**. El riesgo real va en el **sentido contrario**: hay 467
aplicaciones por **$13,944,150** que provienen de un abono cancelado, pero casi todas caen sobre
documentos ya saldados, así que sólo $172,180 tocan deuda viva.

### El universo, descompuesto (lo que exige declarar el denominador antes que el número)

| Tipo de acreedor | docs | pendiente | ¿va al Calendario? |
|---|---:|---:|---|
| **Mercancía** (`C*`) | 1,695 | $90,529,615 | sí — origen `supplier_payable` |
| **Financieros** (`AB*`, `AE*`, `AR*`, `TC*`, factoraje) | 41 | **$38,012,268** | sí — pero son **compromisos financieros**, no facturas |
| **Servicios** (`G*`) | 1,175 | $6,814,734 | sí — hoy no entran por Entregas |
| **Internos** (`TI*` = sucursales) | 58 | $1,155,161 | ⛔ **no**: traspaso entre sucursales, no es deuda |
| **Universo pagable** (sin internos) | 2,911 | **$135,356,617** | denominador de la métrica O1 |

⭐ **Hallazgo que modifica el plan:** los $38 M financieros son créditos BBVA / BanBajío, préstamos
de personas físicas y tarjetas — es decir, **el tercer origen del calendario
(`finance.financial_commitments`, hoy con 0 filas) también es derivable de Kepler**, con la misma
mecánica que las facturas. Se había dado por hecho que ese origen dependía de captura manual.

### Qué queda de TP.17 después de esto

| # | Item | Estado |
|---|---|---|
| TP.17.1 | Arbitraje contra testigo independiente | ✅ **hecho** — 0.13 % de desviación, declarada |
| TP.17.1b | **Nuevo:** derivar también los compromisos financieros (`AB*/AE*/AR*/TC*`) | ⬜ |
| TP.17.2 | Dedupe contra lo capturado por Entregas | ⬜ |
| TP.17.3 | Declarar lo no programable (incluye **excluir `TI*`**: no es deuda) | 🔨 parcial — el universo ya está descompuesto arriba |
| TP.17.4 | Costo de la lista con ~2,900 filas | ⬜ — las consultas base corren en 315–719 ms, pero **falta medir la consulta REAL del servicio**, no una parecida |

⛔ **No se escribió una sola línea de código**: C0 se arbitra antes de construir, y D1 (quién
autoriza una obligación derivada) sigue abierta — bloquea C1 en adelante, no a esta medición.

### Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-16 | TP.17.1 arbitrado contra la regla del ECA: desviación 0.13 % ($172,180 / 30 docs), declarada. Hipótesis de deuda cancelada refutada ($293). Universo descompuesto: $135,356,617 pagables sin internos. Hallazgo: los compromisos financieros también son derivables | Claude |

---

## 11. D1 RESUELTA + cierre de C0 (2026-10-16)

### D1 — decidida por Edgar: **liberar el día ES la autorización** → **ADR-094**

Programar un pago pasa a ser una **propuesta**; el compromiso nace cuando Gerencia/Dirección
libera el lote con `FINANCE_PAYMENT_CALENDAR_AUTORIZAR` — las dos firmas que ADR-065 ya construyó.
`[TP.15]` **no se deroga**: lo que entra por Entregas conserva su `authorized_by`, que pasa a ser
información adicional y no un requisito del que carezca lo derivado.

⚠️ **Lo que se pierde, dicho:** cualquiera con `FINANCE_PAYMENTS_GESTIONAR` podrá **proponer** el
pago de cualquier factura de Kepler. Es el mismo alcance que ya tiene sobre las capturadas, y el
candado sigue siendo que **otra persona libere el día** — un candado que **nunca se ha ejercido**
(5 lotes `draft`, 0 días autorizados en toda la historia).

⇒ **C1 queda desbloqueado.** Razonamiento completo y lo rechazado, en ADR-094.

### TP.17.2 — dedupe: medido, y sin migración nueva

| | |
|---|---:|
| Obligaciones capturadas | 37 |
| …con la llave `kepler_*` completa | **37 (100 %)** — la dejó la mig `20261016002604` de TP.15 |
| …que casan con deuda viva de Kepler | **37 (100 %)** · $2,738,088 |

⇒ **Sin dedupe serían 37 duplicados exactos.** El `NOT EXISTS` por las cuatro llaves
(`kepler_sucursal · kepler_doc_tipo · kepler_doc_sub · kepler_folio`, excluyendo `cancelled`)
alcanza: **no hace falta migración**, la llave ya está en la tabla. ✅

### TP.17.4 — el costo de la lista, medido con la consulta armada

| | |
|---|---:|
| Filas que entrega el origen derivado (sin `TI*`, sin duplicados) | **2,890** · $133,045,503 · 364 proveedores |
| `ORDER BY vencimiento + LIMIT 200` — lo que pide la pantalla | **325 · 345 · 377 ms** (3 corridas) |
| La misma consulta **sin límite** | 613 ms |

⇒ Entra bajo los 500 ms **sólo si la pantalla pagina**. Traer la lista completa no entra. ✅ con
condición.

⚠️ **Lo que esta medición NO es, declarado:** se midió **la pata derivada sola**, con la estructura
que usa `listObligations` pero **no el `UNION ALL` completo** con los tres orígenes existentes (que
hoy aportan 37 + 312 + 0 filas, o sea poco), y **fuera de RLS** — con la cuenta de lectura directa,
no por `TenantKnexService`. La medición definitiva es la del servicio real, y queda pendiente.

### Hallazgo de diseño que salió de medir (y que no estaba en el plan)

⛔ **`payment_allocation_items.obligation_id` es `uuid`**, y la llave natural de la deuda derivada
es compuesta (`sucursal · doc_tipo · doc_sub · folio`). La primera corrida de la medición falló con
`operator does not exist: uuid = text` — o sea que el origen derivado **no cabía** en el motor tal
como está. Resuelto con un **uuid determinístico**: `md5('kepler_payable|'||…)::uuid`, estable,
reproducible y sin extensión. ⛔ Se rechaza cambiar el tipo de la columna: tocaría los tres
orígenes vivos para resolver lo que una función determinística resuelve sin migrar datos. (→ ADR-094 §4)

### Estado de TP.17 (C0) al cierre

| # | Item | Estado |
|---|---|---|
| TP.17.1 | Arbitraje contra testigo independiente | ✅ desviación 0.13 %, declarada |
| TP.17.1b | Los financieros ($38 M) también se derivan | ⬜ — confirmado que existen; falta construir |
| TP.17.2 | Dedupe por las 4 llaves | ✅ medido: 37/37 casan, sin migración |
| TP.17.3 | Declarar lo no programable + excluir `TI*` | ✅ universo descompuesto y nombrado |
| TP.17.4 | Costo de la lista | ✅ con condición (paginar) · ⚠️ falta medir el servicio real bajo RLS |

⇒ **C0 cerrada.** Lo que sigue es C1 (TP.18), que ya no está bloqueado por D1 pero **sí** por el
cupo de §3 del método y por un dueño con fecha.

### Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-16 | D1 decidida (liberar el día = autorización) → ADR-094. C0 cerrada: dedupe 37/37 sin migración, lista 325–377 ms paginada, y el hallazgo del `uuid` resuelto con llave determinística. Cero código de producción escrito | Edgar (decisión) · Claude (medición) |

---

## 12. TP.18 (C1) — el motor acepta la deuda derivada (2026-10-16)

**Qué se construyó** — cuarto `obligation_source: 'kepler_payable'` en el motor polimórfico, según
ADR-094. ⛔ **Sin migración y sin tabla nueva**: el origen es la vista que ya existía.

| Pieza | Dónde | Qué hace |
|---|---|---|
| `keplerPayableId()` + `KEPLER_PAYABLE_ID` | `payment-calendar.service.ts` | la llave determinística, en TS y en SQL — **la misma cuenta en los dos lados** |
| `loadObligationRow()` | ídem | una obligación venga de donde venga: tabla para los tres de siempre, vista + items para el derivado |
| 4.ª pata del `UNION ALL` | `listObligations()` | la deuda viva con sus tres recortes: sin `TI*`, sin duplicados, reserva desde los items |
| `TABLE_BY_SOURCE` → `string \| null` | ídem | **el tipo obliga** a preguntar si hay tabla antes de tocarla |
| `recalcObligation()` | ídem | no escribe para el derivado: no hay dónde, y no hay nada que desincronizar |
| `assertKeplerBalance()` · `paymentGroupKey()` · orden sugerido · etiquetas del día · ejecutar | ídem | los dos orígenes de factura se tratan igual |
| espejo del agrupador | `calendario-pagos-grupos.ts` | el front agrupa igual que el backend — el archivo mismo pide que si cambia una, cambie la otra |

### Lo que se probó, y con qué

- `payment-calendar-kepler-payable.spec.ts` — **16 casos**, 7 de ellos negativos (cambiar sucursal,
  folio, tipo, subtipo; y que `01|31|1` no colisione con `01|3|11`). Verde junto con los specs que
  ya existían: **35 pasan** en `payment-calendar`, **17** en el agrupador del front.
- ⭐ **Cruce de las dos implementaciones de la llave** (TS vs SQL de Postgres) contra prod:
  **5 de 5 documentos reales coinciden**, más el vector fijo que quedó anclado en el spec. Si
  alguien cambia el formato de un lado, el test se pone rojo.
- ⭐ **El SQL se ejerció contra prod** (sólo lectura): la pata devuelve **2,892 filas ·
  $133,209,074**. No es una prueba de escritura — es la comprobación de que el builder de knex
  produce SQL válido, que es donde un `joinRaw`/`whereNotExists` falla sin que ningún test puro lo note.
- ⛔ **Un bug real que atrapó el test, y vale escribirlo:** el comentario SQL que agregué al orden
  sugerido llevaba **acentos graves** dentro de un *template literal* de JS — el backtick cierra el
  string. No es un error de SQL ni de tipos: el archivo entero dejaba de parsear. Lo cazó `vitest`
  en la primera corrida. (Mismo patrón que `[feedback_no_backticks_in_css_comments]`.)

### ⚠️ Deuda con nombre — TP.18.5: la lista NO cumple los 500 ms de forma confiable

Medido con 6 corridas sobre prod, `ORDER BY vencimiento + LIMIT 200`:

| | |
|---|---:|
| corridas (ms) | 441 · 445 · 454 · 456 · 522 · 558 |
| **mediana** | **456 ms** |
| **p90** | **558 ms** |

⛔ **No se declara verde.** Roza el límite y lo pasa en el p90. ⭐ Y el `EXPLAIN` dice dónde está
el costo, que **no es la pata nueva**: adentro de `analytics.v_supplier_payables` hay un
**Seq Scan de `kdxe` (24,523 filas)** y un **sort de `kdxf` (34,769)** que se rehacen en cada
consulta. O sea que el costo ya lo paga hoy **Pronto pago**, y lo paga `assertKeplerBalance` en
cada asignación y cada ejecución.

Salidas posibles, **ninguna hecha**: materializar la vista (legítimo por costo — `GOTCHAS §32`
permite materializar lo caro, lo que prohíbe es materializar un valor inventado) con su refresco, o
índices sobre `kdxe`/`kdxf`. ⚠️ Un `CREATE MATERIALIZED VIEW` va **fuera de horario hábil**: uno ya
sostuvo el candado de migraciones 22 minutos.

### Lo que sigue SIN probar, dicho sin maquillaje

⛔ **Ninguna escritura se ejerció.** `createAllocation`, `addItem` y `ejecutar` con el origen
derivado **no corrieron contra una base real** — el DoD punto 3 no está cumplido. Lo que falta es
extender `database/tests/test-newdb-payment-calendar.js` (hoy 50 casos) con el cuarto origen y
correrlo contra una base de pruebas. No se hizo acá porque ejercer escrituras contra **producción**
está prohibido y levantar el backend local también.

⛔ **No se compiló**: lo compila el CI (`Build & typecheck`), que es además quien sella `ci-green`.
El `boundary-gate` sí corrió: verde.

### Estado

| # | Item | Estado |
|---|---|---|
| TP.18.1 | Cuarto origen en el motor | 🔨 escrito, specs verdes, **sin prueba de escritura** |
| TP.18.2 | `recalcObligation` saltea el derivado sin romper los otros 3 | 🔨 ídem |
| TP.18.3 | Fecha límite de pronto pago como atributo | ⬜ no empezado |
| TP.18.4 | `paymentGroupKey` extendido + espejo en el front | ✅ con specs a ambos lados |
| TP.18.5 | **Latencia: mediana 456 ms / p90 558 ms** | ⚠️ **deuda declarada** |

### Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-16 | TP.18 escrito: 4.º origen derivado, llave determinística cruzada TS↔SQL (5/5), SQL ejercido en lectura contra prod (2,892 filas / $133.2 M), 16 specs nuevos con 7 negativos. Declarado: cero pruebas de escritura y latencia p90 558 ms sobre el límite | Claude |

---

## 13. TP.18 — la prueba de escritura, y lo que encontró (2026-10-16)

**20 de 20 verde** en `payment-calendar.it.spec.ts`: el **código real** del service contra un
Postgres de verdad, todo dentro de una transacción que se revierte. Ocho casos nuevos para el
origen derivado, incluido el **camino completo de escritura**: programar → agrupar con una
capturada → ordenar → preparar → **autorizar** → **ejecutar**.

⭐ **Lo que la prueba encontró y ningún test puro podía ver:**

| # | Defecto | Qué habría pasado en prod |
|---|---|---|
| 1 | **`ReferenceError: tenantId is not defined`** en `listObligations` | ⛔ **La lista entera del Calendario reventaba**, no sólo la pata nueva. `vitest` usa esbuild y **no tipa**, así que los specs puros pasaban en verde |
| 2 | **`violates check constraint payment_allocation_items_obligation_source_check`** | La pantalla habría listado 2,892 facturas **imposibles de programar**: el botón daría 500 y la lista se vería perfecta. **Es el defecto del arqueo de caja otra vez** (columna nueva + un camino que nadie recorrió) |
| 3 | `available_amount` **NULL** en las ~2,890 facturas sin reservar | Lo introduje yo al optimizar: con `LEFT JOIN`, sin fila en `r`, `pendiente − NULL` es NULL. El disponible desaparecía justo donde más se usa |

⛔ El defecto 2 **exigió una migración**: `20261016171340_tp18_allocation_items_origen_kepler_payable.js`
(generada con `scripts/nueva-migracion.js`, idempotente, `down` que se **niega** si ya hay renglones
del origen nuevo). La prueba la aplica sola donde falte, así que también corre en CI.

### TP.18.5 — la latencia, medida otra vez

| | antes | ahora |
|---|---:|---:|
| mediana | 476 ms | **432 ms** |
| p90 | 558 ms | **555 ms** |

El cambio: el agregado de reservas se calcula **una vez** y se une por id, en vez de un `LATERAL`
evaluado 2,892 veces. ⛔ **No se declara resuelto.** La mediana entra bajo los 500 ms; **el p90 no**.

⭐ **Y el techo no está en esta consulta.** Medido: `analytics.v_supplier_payables` **sola** cuesta
**321 ms** (Seq Scan de `kdxe`, 24,523 filas + `GroupAggregate` sobre un sort de `kdxf`, 34,773).
Ese piso ya lo paga hoy **Pronto pago** y cada validación de saldo del Calendario.

**Lo que falta para bajarlo de verdad, y por qué no se hizo:** un índice sobre
`kepler_ods.kdxf (sucursal, c7, c8, btrim(c9))` convertiría ese sort en un scan ordenado —
**estimado** (del plan, no medido) un ahorro de ~150–200 ms. Es **DDL sobre producción**: va con
autorización explícita y **fuera de horario hábil**, por la misma regla que el
`CREATE MATERIALIZED VIEW` que sostuvo el candado de migraciones 22 minutos.

### ⚠️ La base local quedó parchada — declarado para que nadie la confunda con una sana

Levantar una base de pruebas costó tres rondas y **no llegó entera**: Docker Desktop está caído
(API 500) y el Postgres local de Windows **no tiene pgvector**. Quedó registrado en
`public._dev_bootstrap_log` de esa base:

- `20260527120000_enable_pgvector…` **marcada aplicada sin ejecutarse** (la extensión no existe).
- `catalog.products.embedding` creada como **`text`** en lugar de `vector(N)` — sustituto para
  desbloquear las migraciones que la leen.
- El bootstrap se detuvo en `20261007182945_rd_route_count_permiso_piso.js` por **roles que son
  datos de prod** (`encargado_tienda`, `prevencion`, …). Llegó a **1,037 de ~1,084**, suficiente
  para esta prueba.

⛔ **Esa base NO sirve para nada vectorial ni para medir datos del ERP.** Lo correcto a futuro es
el job `pruebas-db` del CI, que levanta Postgres de servicio con la imagen adecuada.

### Estado de TP.18

| # | Item | Estado |
|---|---|---|
| TP.18.1 | Cuarto origen en el motor | ✅ **ejercido contra base real** (DoD 3 cumplido) |
| TP.18.2 | `recalcObligation` saltea el derivado | ✅ con los otros 3 orígenes verdes |
| TP.18.3 | Fecha límite de pronto pago como atributo | ⬜ no empezado |
| TP.18.4 | `paymentGroupKey` + espejo en el front | ✅ |
| TP.18.5 | Latencia | ⚠️ mediana **432 ms** (entra) · p90 **555 ms** (no entra) — **abierto** |
| TP.18.6 | Migración del CHECK **aplicada a prod** | ⬜ **pendiente de autorización** |

### Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-16 | Prueba de escritura 20/20 contra Postgres real. Encontró 3 defectos: `tenantId` sin definir (rompía toda la lista), el CHECK que rechazaba el origen nuevo (→ migración) y un NULL que introduje al optimizar. Latencia 476→432 ms de mediana; p90 555 sigue sobre el límite | Claude |

---

## 14. TP.18.6 — la migración en prod (2026-10-16), y lo que enseña el árbol compartido

**Verificado contra prod (sólo lectura, 2026-10-16 ~18:10):**

| | |
|---|---|
| Migración | `20261016171340_tp18_allocation_items_origen_kepler_payable.js` |
| Ledger | **`public.knex_migrations`** — el activo (1,272 filas). `identity.knex_migrations` sigue en **0**: es el señuelo por el que `migrate:latest` reaplicaría 800 migraciones |
| Batch · hora | **950** · `2026-10-16 17:51:10-06` |
| CHECK en prod | `ARRAY['budget_expense','financial_commitment','supplier_payable','kepler_payable']` — idéntico al que produce el `up()` |

⭐ **Nadie de esta sesión la aplicó, y no podía:** la cuenta de prod de la máquina de trabajo es
`edgar`, **sin superusuario, sin ser dueña de la tabla y con `transaction_read_only = on`**
(SEG.4 — un guion equivocado **falla** en vez de mutar producción). La aplicó otra sesión, **28
minutos después** de commitearla.

⚠️ **Y eso es la lección, no un detalle de calendario.** En un checkout compartido sobre `main`,
un commit deja de ser tuyo en cuanto existe: el `pull --rebase` + `push` de otra sesión se llevó
los tres commits de código **y** la migración, y alguien corrió las pendientes. El orden que el
protocolo pide —*la migración aditiva ANTES que el código que la lee*— **se cumplió por suerte**:
entre que el código llegó a `main` y que el CHECK se amplió hubo una ventana en la que programar
una factura derivada habría devuelto 500. Lo único que la tapó es que
[`ops/prod/auto-deploy.sh`](../../../ops/prod/auto-deploy.sh) tiene su renglón del `crontab`
comentado y nada se despliega solo.

⛔ **Corolario para la próxima:** cuando el cambio necesita migración, **aplicarla antes de
commitear el código**, no después — porque entre el commit y la autorización puede no haber
tiempo: el árbol es de todos.

### Estado

| # | Item | Estado |
|---|---|---|
| TP.18.6 | Migración del CHECK aplicada a prod | ✅ batch 950, ledger `public`, verificada |

### Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-16 | Migración verificada en prod (batch 950, ledger correcto, CHECK idéntico). La aplicó otra sesión al empujar `main`; esta sesión no tiene permisos de escritura en prod y lo confirmó midiendo | Claude (verificación) |

---

## 15. TP.17.1b — un crédito bancario no es mercancía (2026-10-16)

**El defecto que tenía lo construido en TP.18:** la pata derivada traía TODA la deuda del ERP y la
marcaba entera como `proveedor_mercancia`. Medido, ahí adentro hay **39 documentos por
$38,503,392** que son créditos BBVA y BanBajío, préstamos de personas físicas, tarjetas y
factoraje. Con esa clasificación un crédito se podía **agrupar en el mismo pago que una factura de
dulces** y **perdía su lugar en el orden** — los compromisos financieros se pagan primero.

### Cómo se resolvió, y qué NO se hizo

⛔ **El criterio no se reescribió.** Es `clasificarAcreedor()` del Estado de Cuenta de Acreedores,
que ya está en producción. Lo que se agregó es una función que **genera el SQL desde sus propias
constantes** (`PREFIJOS_FINANCIEROS`, `GRUPOS_FINANCIEROS`): si mañana se suma un prefijo al
engine, esta consulta cambia sola. Una copia a mano habría sido la **sexta** familia de constantes
duplicadas del repo (ADR-056, el primitivo que no se comparte).

⚠️ **La clasificación deja de salir del `obligation_source`.** Para los tres orígenes con tabla la
fija el origen; para el derivado **la trae la fila**, porque un mismo origen entrega facturas y
créditos. Eso obligó a mover la validación de `addItem` **después** de cargar la obligación: antes
se decidía mirando sólo el origen, y ahí ya no hay información suficiente.

**Decisión declarada:** `servicios` y `sin_clasificar` van a `proveedor_mercancia`. No es que sean
mercancía — **se pagan por el mismo circuito** (una factura del ERP a un tercero), mientras que
`gasto` queda reservado a lo que autorizó Presupuestos por su propio camino.

### Medido sobre prod (sólo lectura, 2026-10-16)

| clasificación | docs | monto | acreedores |
|---|---:|---:|---:|
| `proveedor_mercancia` | 2,893 | $97,368,083 | 355 |
| **`compromiso_financiero`** | **39** | **$38,503,392** | **12** |

⭐ **La regla atrapó un caso que la prueba no cubría:** `GS012` (STM Financial) **empieza con `G`**
—o sea, parece servicios— pero su grupo es **140**, y por eso entra como financiero. Las dos
mitades del criterio hacen falta.

⚠️ **Y la que no atrapa, dicha:** el grupo **120 se llama «Instituciones financieras» y NO cuenta**
como financiero (sólo el 140). Los 12 acreedores reales se detectan **todos por prefijo de clave**
(`A`, `TC`, `B.B.`), así que hoy no se pierde ninguno — pero **un banco dado de alta con clave
`G*` y grupo 120 se leería como proveedor**. Queda anotado acá y no se cambia el engine: esa regla
es del ECA y está en producción.

### Probado

- `payment-calendar.it.spec.ts`: **23/23** contra Postgres real. Tres casos nuevos — el acreedor
  financiero se deriva como `compromiso_financiero` con subtipo `financiero`; ⛔ **no** se puede
  sumar a un pago de proveedor (prueba negativa); y la factura de mercancía del mismo origen sigue
  siendo `proveedor_mercancia`.
- `creditor-statements`: **58/58** — el engine que se reusó no se tocó.
- `boundary-gate` verde.

### Estado de O1

| | |
|---|---|
| Mecanismo | ✅ completo: deriva toda la deuda, deduplica, excluye internos y **clasifica por naturaleza** |
| Verificación | ✅ 23/23 contra base real · migración del CHECK en prod (batch 950) |
| **Métrica** | ⛔ **sigue en 2.0 %**: el código **no está desplegado**. Al desplegarse pasa a ~100 % (2,894 docs · $133,131,122 de $135,869,210) |

### Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-16 | TP.17.1b: la deuda derivada se clasifica con la regla del ECA generada desde sus constantes. 39 docs / $38.5 M salen de «mercancía» y entran como compromiso financiero. 23/23 verde | Claude |

---

## 16. TP.17.2 — el techo que casi vuelve a esconder la deuda · O1 cerrado en local (2026-10-16)

**El defecto, encontrado al revisar el endpoint antes de declarar O1 terminado.** `listObligations`
terminaba en un `.limit(1000)` fijo y el front pedía todo de una. Con 37 obligaciones era invisible.
Medido con la deuda derivada:

| | docs | monto |
|---|---:|---:|
| Deuda derivada | 2,895 | $133,133,387 |
| Lo que el endpoint devolvía | 1,000 | $27,449,662 |
| **Lo que callaba** | **1,895** | **$105,683,725 (79 %)** |

⭐ **Y el recorte no era neutro:** el orden es por vencimiento ascendente, así que el corte caía en
**2026-06-04** y lo oculto era **lo más reciente y lo más caro**. La pantalla se habría visto
impecable mostrando mil facturas viejas — exactamente lo contrario de lo que O1 promete.

⭐⭐ **La lección que deja, y que no es sobre este `limit`:** ese techo era **correcto** cuando se
escribió. No lo rompió tocarlo: lo rompió **multiplicar por 80 el volumen que entra por esa
consulta**. ⇒ Al abrirle una compuerta a un volumen nuevo, hay que **revisar los techos que ya
existían río abajo** — `limit`, `timeout`, tamaños de página, lotes.

**Cómo quedó:** el endpoint devuelve `{ rows, total, limit, offset }` y la pantalla dice **«N de M»**
más un `p-message` que explica cómo llegar al resto. El armado del día pide `limit=5000` a propósito:
proponer qué pagar mirando las 1,000 más viejas es peor que no proponer. ⚠️ Esto es un **techo
honesto, no paginación** — la paginación real queda declarada como deuda.

⛔ **Un valor inválido cae al default, no al mínimo.** `Math.max(limit, 1)` hacía que `limit=-5`
devolviera **una sola fila**: una lista casi vacía se lee como «no hay deuda». Lo cazó una prueba
negativa, no una revisión.

### Frontend (skill `diseno` cargada antes de tocar el primer archivo)

| | |
|---|---|
| `check:pantalla -- calendario-pagos` | **1 falla antes → 1 falla después** (§9 frescura, preexistente). **Cero nuevas** |
| Tipado | `✔ tipa (0 errores semánticos)` — cubre el cambio de contrato en la pantalla |
| Piezas | `p-message` del sistema (el mismo patrón con que Programa de pagos declara sus meses faltantes), no un `<span>` propio |
| `check:templates` · `check:tokens` · `check:tables` · `check:estilos` · `check:sql-backticks` | verdes |
| Spec del agrupador | 17/17 |

---

## 17. O1 — estado final (2026-10-16)

| DoD | |
|---|---|
| 1. Métrica remedida | ⛔ **sigue 2.0 %** — no desplegado. Al desplegarse: ~100 % (2,894 docs · $133,131,122) |
| 2. Capas verificadas o declaradas | ✅ C0 arbitrada (0.13 %) · C1 y C2 probadas · C3 sin fallas nuevas |
| 3. Endpoints que escriben, ejercidos | ✅ **25/25** contra Postgres real, con el camino completo hasta ejecutar |
| 4. Compuerta nueva rota a propósito | ✅ cuatro pruebas negativas (techo, límite inválido, clasificación mixta, sucursales distintas) |
| 5. Primitivo en `libs/` o deuda con nombre | ⚠️ **`[TP.18.7]`** — `keplerPayableId()` sigue dentro del service |
| 6. Tracker + log + roadmap | 🟡 log ✅ · **tracker y roadmap NO**: tienen cambios sin commitear de otra sesión |
| 7. En prod | ⛔ **no** — y escrito por qué: `auto-deploy.sh` tiene su renglón del `crontab` comentado |

⇒ **O1 está terminado hasta donde esta sesión puede llevarlo: construido, medido y verificado en
local.** Los dos puntos rojos no son trabajo pendiente de código — son un despliegue y dos archivos
que otra sesión tiene tomados.

### Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-16 | TP.17.2: el techo de 1,000 se declara (`{rows,total}` + «N de M» + aviso). 25/25 verde, `check:pantalla` sin fallas nuevas. O1 cerrado en local con sus tres deudas nombradas | Claude |

---

## 18. O2 — el descuento que vence ya se puede accionar (2026-10-16)

**Lo que faltaba:** Pronto pago veía vencer **$2,420,559** de descuento todavía dentro de ventana y
**no tenía un solo botón**. El Calendario sí podía programar, pero no sabía de esas facturas.

### C1/C2 — el puente: la pantalla ahora sabe CON QUÉ programar

Cada fila de `/finance/pronto-pago` viaja con cinco campos nuevos:

| campo | qué resuelve |
|---|---|
| `obligation_source` | si Compras ya la capturó como entrega manda **esa** obligación (trae fecha negociada y acuerdos); si no, va por la **deuda derivada** |
| `obligation_id` | la llave con que el Calendario la va a guardar |
| `reservado` · `pagado` | lo ya comprometido |
| `programable` | `pendiente − reservado − pagado`: lo que queda por mandar |

⛔ **La llave no se reimplementó.** `sqlKeplerPayableId()` pasó de constante a función para que
Pronto pago la use con su propio alias. Si las dos formas se separaran, el botón mandaría a una
factura que el Calendario no reconoce — y el síntoma no sería un error, sería un pago que no baja
ningún saldo.

### C3 — el botón (skill `diseno` cargada antes de tocar el archivo)

- **«Programar»** por fila, sólo con `FINANCE_PAYMENTS_GESTIONAR`: ver el pronto pago no es
  prepararlo. Autorizar el día sigue siendo otro permiso, en el Calendario.
- Lo que ya tiene fecha **se dice** («ya programada» / «pagada»), no se deja un hueco.
- El diálogo propone **la fecha que conserva el descuento** (si ya pasó, mañana — nunca hoy: un
  pago se prepara antes de ejecutarse) y el monto programable como tope.
- Dice en voz alta que **nace como propuesta**: el compromiso lo crea Gerencia al autorizar el día.
- El error del servidor se muestra tal cual: es quien hace cumplir el saldo y la agrupación, y su
  mensaje explica **por qué** no se pudo.

### Probado

| | |
|---|---|
| `payment-calendar.it.spec.ts` | **28/28** contra Postgres real · 3 casos nuevos: la llave coincide con la del Calendario, la factura capturada va por su obligación, y `programable` **baja tras programar con el service real** |
| `check:pantalla -- pronto-pago` | **3 fallas antes → 3 después** (§2, §9, D.4c, preexistentes). **Cero nuevas**, y tipa sin errores |
| `check:templates` · `check:estilos` | verdes |

⭐ **Tres defectos que sólo aparecieron al ejercerlo**, ninguno visible en revisión:
1. **Faltaba una coma** antes del `CASE` nuevo → `syntax error at or near "CASE"`.
2. El mapeo de `rows` **no incluía los campos nuevos**: el SQL los calculaba y se perdían antes de
   llegar al front.
3. ⛔ La matview `mv_supplier_prompt_discount` se crea **`WITH NO DATA`**, y en Postgres una matview
   sin poblar **no se puede consultar**: en una base recién levantada **toda** consulta de Pronto
   pago falla con `55000`, y el error no menciona a Pronto pago. En prod no se nota porque ya se
   refrescó. ⚠️ **Esto le pega también al job `pruebas-db` del CI**, que levanta la base desde cero.

⚠️ **Y una del dato de prueba que vale como regla:** Pronto pago mira **sólo** proveedores `C%`
(mercancía), porque el pronto pago es un descuento de compra. Un dato de prueba con otra clave
sencillamente no existe para esa pantalla.

### Lo que NO quedó

- ⛔ **La métrica de O2 se mueve al desplegar**, igual que O1: el botón existe en el código, no en
  producción.
- ⚠️ El `boundary-gate` quedó **rojo por deuda ajena** (5 `any` nuevos en
  `libs/finance/src/lib/caja/cash-ledger.service.ts`, de otra sesión y sin commitear). Ninguno de
  los archivos de O2 aparece en el reporte.

### Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-16 | O2: Pronto pago publica con qué programar cada factura y gana el botón «Programar». 28/28 verde, `check:pantalla` sin fallas nuevas. Tres defectos cazados al ejercer, uno de ellos afecta al CI | Claude |

---

## 19. TP.19.3 — el pago ejecutado dice cuál es en Kepler (O3, backend) · 2026-10-16

**El hueco:** al marcar un pago como ejecutado, el rastro se cortaba. El pago reaparecía en el ERP
—y en «Pagos a proveedor»— como un evento **sin origen**, y nadie podía contestar sin reconstruirlo
a mano *«¿de qué día del calendario salió esta transferencia?»*.

**Migración `20261016185746`** (aditiva, idempotente): `kepler_payment_sucursal · _doc_prefix ·
_folio` + `_linked_at` / `_linked_by`, y un **índice único parcial**: un mismo documento de Kepler
no puede estar ligado a dos pagos — sería contar dos veces la misma salida de dinero.

⚠️ **Nullable a propósito:** el dinero sale **antes** de que el ERP capture el documento. Exigir la
terna al ejecutar obligaría a **inventar un folio** para poder cerrar el pago. Lo que falta se
declara con NULL (ADR-056) y se liga después — por eso es un endpoint aparte
(`POST /allocations/:id/kepler`) y no un campo de `ejecutar`.

⛔ **Sin FK al espejo del ERP**: `analytics.erp_supplier_payments` es una **vista** que se repuebla;
una FK haría que repoblarla pudiera fallar por filas nuestras. La integridad la da el cruce.

**Las tres guardas, con prueba negativa cada una:**

| Guarda | Por qué |
|---|---|
| El documento **existe** en el espejo del ERP | ligar a un folio tecleado mal publicaría una trazabilidad falsa, que es peor que no tener ninguna |
| Sólo se liga un pago **ya ejecutado** | antes de que salga el dinero no hay documento que ligar |
| Un documento, **un solo** pago | índice único parcial |

⭐ **Cierra tres deudas que `[TP.15]` había declarado**, y las tres eran la misma falta de liga: el
tope de saldo no sabía qué pagos del Calendario ya había registrado Kepler; «sin saldo» mezclaba
*pagada* con *no casó*; y un pago ejecutado no se podía reencontrar.

**Probado:** `payment-calendar.it.spec.ts` **31/31** contra Postgres real. ⚠️ Sembrar el pago
obligó a recordar que **el espejo es una vista**: se siembra `kepler_ods.kdm1` con la forma que
ella espera (`c4=26` → `XD2601`), no se le inserta a la vista.

### Lo que falta de O3

- **La pantalla**: «Pagos a proveedor» todavía no muestra el origen (día autorizado + folio de
  lote). Sin eso, la liga existe en la base pero nadie la ve.
- **El cruce automático**: hoy la terna se teclea. El espejo tiene `pago_date`, `monto` y
  `proveedor_code`, que es con lo que se podría **proponer** el documento — y `_linked_by` ya
  permite medir si el sistema acierta.
- ⛔ **La migración no está aplicada a prod.** A diferencia del CHECK de TP.18, acá el riesgo es
  acotado: el endpoint es nuevo y nadie lo llama todavía, así que el código sin la migración no
  rompe nada existente.

### Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-16 | TP.19.3: migración + `linkKeplerPayment()` con sus tres guardas y pruebas negativas. 31/31 verde. Falta la pantalla y el cruce automático | Claude |

---

## 20. TP.19.3 (pantalla) — «Pagos a proveedor» dice de dónde salió el pago · 2026-10-16

Cada pago del ERP que nació en el Calendario muestra ahora su **folio de pago** y enlaza al
Calendario. Si no nació ahí **no se pinta nada**: la ausencia es lo normal hoy, y un «—» por renglón
sería ruido en una tabla que ya tiene ocho columnas.

### ⛔ El riesgo que obligó a hacerlo condicional

Esta pantalla **está en uso** (1,350 comprobantes). Las columnas de la liga llegan con una migración
que **puede no estar aplicada**, y leerlas sin preguntar la tumbaría entera por una función que es
un extra. Se resuelve con el patrón que ya usa `purchase-deliveries.service.ts`: preguntar a
`pg_attribute` y **cachear sólo el `true`** — guardar el `false` dejaría la liga invisible hasta
reiniciar la API aunque la migración ya estuviera aplicada.

**Las dos ramas, probadas contra bases reales (2026-10-16):**

| base | guard | efecto |
|---|---|---|
| **prod** (sin la migración) | `false` | omite el JOIN — **la pantalla no se cae** |
| **local** (con la migración) | `true` | hace el JOIN y muestra el origen |

### ⛔⛔ El defecto que encontró reaplicar la migración

**`hasColumn('finance.payment_allocations', …)` MIENTE: devuelve `false` aunque la columna exista.**
Knex trata el argumento como *nombre de tabla*, no como `esquema.tabla`, así que busca una tabla
llamada literalmente «finance.payment_allocations» en el `search_path`.

| forma | con la columna ya creada |
|---|---|
| `hasColumn('finance.payment_allocations', 'x')` | **false** ⛔ |
| `withSchema('finance').hasColumn('payment_allocations', 'x')` | **true** ✓ |

⇒ Escrita de la primera forma, la migración **no era idempotente**: a la segunda corrida moría con
`column … already exists` — y el proyecto exige que lo sean. Lo cazó el spec de integración al
reaplicarla, no una revisión. Verificado después corriendo el `up()` **dos veces seguidas**.

⚠️ **Vale para cualquier migración del repo que use `hasColumn` con nombre calificado.**

### Estado de O3

| | |
|---|---|
| Migración + `linkKeplerPayment()` con 3 guardas y pruebas negativas | ✅ |
| La pantalla muestra el origen | ✅ (condicional, con las dos ramas probadas) |
| **Métrica: pagos ligados** | ⛔ **0 %** — ni la migración está en prod ni hay pagos ejecutados que ligar (0 días autorizados) |
| Cruce automático (proponer el documento en vez de teclearlo) | ⬜ el espejo tiene fecha, monto y proveedor; `_linked_by` ya permite medir si acierta |

### Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-16 | O3 completo en código: la liga, la pantalla condicional y sus dos ramas probadas. El `hasColumn` calificado resultó mentir y la migración no era idempotente; corregido y verificado | Claude |

---

## 21. TP.19.4 — el documento de Kepler se propone, no se teclea (O3 completo) · 2026-10-16

Teclear la terna `(sucursal, doc_prefix, folio)` era el trabajo que la liga venía a evitar. El
espejo del ERP ya tiene con qué reconocerla: **monto, día y proveedor**.

`GET /allocations/:id/kepler/sugerencias` devuelve los candidatos y dice si hay **uno solo**.

| Criterio | Tolerancia, y por qué |
|---|---|
| Monto | **± $0.01** — redondeo, no «parecido»: un monto distinto es otro pago |
| Día | **± 3 días** del día del lote — el ERP se captura después de que sale el dinero |
| Proveedor | exacto, por código |
| Ya ligado a otro pago | **se excluye** — el índice único lo rechazaría igual, y ofrecer algo que va a fallar es la peor forma de decir que no |

⛔ **Con dos candidatos no elige: los devuelve.** Es el mismo criterio con el que `[PC.6]`
auto-valida un comprobante — sólo cuando el cruce no deja lugar a duda. Elegir entre dos pagos del
mismo proveedor y monto es justo donde una trazabilidad inventada se vuelve indistinguible de una
real.

**Probado:** `payment-calendar.it.spec.ts` **35/35**, con 4 casos nuevos y 3 de ellos negativos:
antes de ejecutar no hay nada que buscar · dos candidatos no eligen · un documento a $2 de
distancia **no** es candidato · lo ya ligado no se vuelve a proponer.

⚠️ **Dos cosas que el escenario de prueba obligó a aprender, y valen como regla:**
1. La vista de pagos del ERP **sólo trae proveedores de compra (`C%`)**. Un dato de prueba con otra
   clave no existe para ella — lo mismo que ya había pasado con Pronto pago.
2. Este bloque **arma su propio escenario de punta a punta** en vez de apoyarse en los pagos de los
   tests de arriba: depender del estado que dejó otro test ya hizo fallar esta prueba por un pago
   que resultó no estar ejecutado.

### O3 — estado final

| | |
|---|---|
| Liga + 3 guardas con pruebas negativas | ✅ |
| La pantalla muestra el origen (condicional, 2 ramas probadas) | ✅ |
| El documento se **propone** | ✅ |
| **Métrica: pagos ligados** | ⛔ **0 %** — la migración no está en prod y **no hay pagos ejecutados que ligar**: nunca se ha autorizado un día |

⇒ O3 está **completo en código**. Lo que falta para que la métrica se mueva no es código: es
desplegar y que alguien autorice un día.

### Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-16 | TP.19.4: el cruce automático propone el documento y no elige cuando hay duda. 35/35 verde. O3 cerrado en código | Claude |

---

## 22. TP.20.3 — una sola puerta a Pagos (O5) · 2026-10-16

En el menú eran **cuatro renglones sueltos** con nombres que se parecen —*Pagos a proveedor*,
*Pronto pago*, *Calendario de pagos*, *Programa de pagos*— y que hacen cosas distintas: dos miran
lo ya pagado, una el plazo que vence y una lo que se va a pagar. Ahora son **una entrada «Pagos»**
y una barra de pestañas, en el orden del ciclo del dinero: **se debe → se programa → se paga → se
audita**. Pronto pago va primero porque es el único con reloj.

### ⛔ Por qué NO hay shell de ruta, a diferencia de «Gastos»

El área Gastos ya ocupa el único padre con `path: ''` que `/finanzas` puede tener **al final** — el
que matchea cualquier URL restante. Meter un segundo padre vacío arriesga que `/finanzas/mis-gastos`
deje de resolver, y **eso no se puede comprobar sin levantar la app**, que acá está prohibido.

⇒ La barra se embebe en cada una de las cuatro pantallas: **una línea por pantalla contra el riesgo
de romper cuatro que están en uso.** Es una decisión por riesgo, no por gusto, y queda escrita para
que el día que exista un shell de área de Finanzas esto se simplifique.

### El candado, con su prueba negativa

Sin shell, una pantalla puede nacer **sin barra** y nadie se entera: se entra, pero no se sale a sus
hermanas. El spec nuevo comprueba tres cosas: que el sidebar tenga **una** entrada con
`tabs: PAGOS_TABS` y ya **no** las liste sueltas; que las cuatro rutas estén en la lista y **en el
orden del ciclo**; y que las cuatro pantallas **embeban la barra**.

⭐ **Roto a propósito** (DoD 4): quitarle `<app-pagos-tabs />` a *Programa de pagos* pone el candado
en **rojo** con el mensaje exacto; restaurarla, en verde.

⭐ Y el candado que **ya existía** (`[IG.2]`, «ninguna pestaña se queda fuera del sidebar») hizo su
trabajo solo: al quitar los renglones del menú se puso rojo señalando dos pantallas que quedaban
**vivas y sin puerta**. Se resolvió como Gastos — contando las rutas que el sidebar lleva por
`tabs:` — no aflojando la prueba.

### Medido

| | antes → después |
|---|---|
| Renglones en el menú | **4 → 1** |
| Pantallas de Pagos en un registro de pestañas | **2 de 4 → 4 de 4** |
| `check:pantalla` de las cuatro | 3·1·1·2 → **3·1·1·2 (cero fallas nuevas)**, y las cuatro tipan |
| Specs de `modules/finanzas` | **997/997** |

### Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-16 | O5: una entrada «Pagos» con las cuatro pestañas, sin tocar rutas. Candado nuevo roto a propósito; el candado viejo detectó solo las dos pantallas que quedaban sin puerta | Claude |

---

## 23. ¿Fusionar Pronto pago con el Calendario? — inventario feature×feature (2026-10-19)

La regla del proyecto es explícita: **no se unifican dos vistas perdiendo columnas, chips o
subtotales; el inventario va ANTES de tocar código.** Éste es ese inventario — y el resultado
**contradice la propuesta** que lo originó («la fusión barata»).

### Lo que cada una tiene

| Pronto pago (340 líneas) | ¿Existe en la lista del Calendario? |
|---|---|
| Veredicto *answer-first* («hoy hay $X que se pueden ganar; $Y vence en 5 días») | ⛔ no |
| Procedencia: la ventana es **observada, no pactada** | ⛔ no |
| Hallazgos de descuento **ya perdido** | ⛔ no |
| Filtro por **estado de ventana** (capturable · por vencer · fuera · sin medir) | ⛔ no |
| Columna **Tasa observada** | ⛔ no |
| Columna **Se gana** (beneficio) | ⛔ no |
| Columna **Límite estimado** (la fecha que decide) | ⛔ no |
| El **«por qué»** por fila | ⛔ no |
| Orden por **urgencia del descuento** → dinero | ⛔ no |
| Buscador · KPIs · ayuda contextual | ✅ equivalente |

La lista de obligaciones del Calendario tiene hoy **tres columnas** (Proveedor/factura · Vence ·
Disponible) y está pensada para **elegir qué pagar hoy**: filtra por tipo y críticos, y **agrupa por
beneficiario** para armar un pago.

### ⛔ El conflicto que mata la fusión

No es que falten columnas: es que las dos listas **ordenan y agrupan al revés**.

- El Calendario **agrupa por beneficiario** — un pago es una transferencia a una cuenta.
- Pronto pago **no puede agrupar**: cada factura tiene **su propia fecha límite**, y juntarlas por
  proveedor esconde la que vence mañana detrás de la que vence en tres semanas. Es la razón por la
  que esa pantalla ordena por urgencia, y está escrita en su propio encabezado: *«el orden ES la
  mitad del valor»*.

⇒ Fusionarlas obliga a elegir un orden, y cualquiera de los dos **rompe la pantalla que pierde**.
Más 9 features sin lugar y una pantalla que pasaría de 1,187 a ~1,500 líneas.

### Recomendación revisada

**No fusionar.** En su lugar, llevar al Calendario **sólo las tres columnas que deciden** —*límite
estimado*, *se gana* y *estado de ventana*— como información de la fila, más un filtro **«con
descuento por vencer»**. Eso da lo que la fusión perseguía —ver la urgencia del descuento mientras
se arma el día— **sin tocar el orden, sin perder features y sin una pantalla gigante**.

El dato ya está disponible: ambas derivan de `analytics.v_supplier_payables` (**1,741 docs ·
$92,981,074**) y desde `[TP.18.3]` comparten `obligation_id`, así que es un `LEFT JOIN` a
`mv_supplier_prompt_discount`, no una integración nueva.

⚠️ **Y la otra fusión (Pagos a proveedor + Programa de pagos) sigue bloqueada por falta de llave:**
el libro no guarda el folio del pago de Kepler — sólo `invoice_folios` (de *factura*), `kepler_flag`
(24.8 %) y `kepler_matched` (NULL). Casarlos por monto+mes es lo que produjo los $273 M
indefendibles de `[PP.4]`.

---

## 24. TP.20.4 — la urgencia del descuento, dentro del Calendario (2026-10-19)

Lo que el inventario de §23 recomendó en lugar de fusionar: que al armar el día se vea **qué
factura pierde descuento**, sin mover a Pronto pago de su sitio.

### La regla no se copió: se compartió

`libs/finance/src/lib/shared/pronto-pago-ventana.ts` — las constantes (`MIN_OBS = 3`,
`DIAS_AVISO = 5`) y el SQL que decide los tres campos. **Pronto pago pasó a tomarlas de ahí**, así
que las dos pantallas no pueden divergir: si mañana se ajusta el mínimo de observaciones, cambia en
las dos a la vez. Copiarla habría sido la sexta familia de constantes duplicadas del repo, y ésta
decide dinero.

### ⚠️ Lo que cambió respecto de lo propuesto, y por qué

Se propusieron **tres columnas nuevas**. Al abrir la tabla: es un **panel estrecho de cuatro
columnas** (Proveedor/factura · Vence · Disponible · Agregar) con ancho fijo y texto cortado con
«…». Tres columnas más la rompen.

⇒ La señal va **dentro de la celda de la factura**, como un renglón corto —
*«⚡ ahorra $1,234 · antes del 24/10»*— y **sólo cuando hay algo que ganar**: en `fuera_de_ventana`
o `sin_medir` no se pinta nada, porque un «—» por fila es ruido en una lista que se recorre rápido.
Más un filtro **«Descuento por vencer»** junto a «Críticos».

### Probado

- **44/44** contra Postgres real. Seis casos nuevos ejercen **la regla**, no el cableado: evalúan
  el SQL que genera el helper sobre filas construidas y verifican los cuatro estados, el **borde**
  del aviso (límite a 5 días → *por vencer*; a 6 → *capturable*), el beneficio calculado, y que
  `sin_medir` deje la fecha en **NULL** y no en «hoy».
- La lista del Calendario trae los tres campos y el filtro los usa.
- `check:pantalla -- calendario-pagos`: **1 falla antes → 1 después**, ninguna nueva · templates,
  estilos y specs del agrupador (17/17) verdes.

### Declarado

⚠️ La ventana sólo viaja hoy en el origen **derivado** (`kepler_payable`), que tiene la factura del
ERP a mano. Las 37 obligaciones **capturadas** por Entregas salen `sin_medir`: para calcularles la
ventana hace falta unirlas a `v_supplier_payables` por sus llaves `kepler_*`, que es un join más en
una consulta que ya está en el límite de latencia (`[TP.18.5]`). Queda como deuda con nombre.

⛔ **Sin validación visual** (`nx serve` prohibido): el chip de ahorro es lo primero que habría que
mirar — es el único elemento nuevo dentro de una celda que ya corta texto con «…».
