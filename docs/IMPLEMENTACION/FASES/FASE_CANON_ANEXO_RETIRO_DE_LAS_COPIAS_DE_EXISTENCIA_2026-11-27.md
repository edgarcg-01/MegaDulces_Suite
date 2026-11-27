# Anexo CANON.7 — Las dos copias de la existencia: quién las lee, quién las escribe, y cómo se retiran

> **Pedido de Edgar:** «toda fuente de verdad de existencia debe ser el ODS». **No abre una fase
> nueva**: es el tramo que le falta a `[CANON.7.4d]`/`[CANON.7.5]`, y su primera capa ya tiene
> nombre en otra fase — `[ICR.0.1]`.
>
> **Qué agrega este anexo** sobre el [anexo del 2026-11-18](FASE_CANON_ANEXO_EXISTENCIA_Y_LO_QUE_SALE_DEL_ODS_2026-11-18.md):
> el **censo completo** de lectores y escritores que quedan (código, vistas de la base, disparadores
> y llaves foráneas), la **divergencia valuada de las 9 sucursales** (el anexo anterior sólo tenía
> el conteo de celdas), **lo que NO se puede derivar del ODS** —que es lo que decide si una tabla se
> retira o se queda— y el **plan por capas** con su medición antes/después.
>
> **Cómo se midió.** Todo lo numérico sale de **pg-prod en sólo lectura** el **2026-11-27**
> (`system_identifier` **7688376744939610156**, host `192.168.0.222:5434`). Prod sirve el commit
> **`de9931cf1`** (`/api/health`). Lo que no se pudo medir **se declara NO MEDIDO**: no hay ceros
> de relleno en este documento.
>
> ⛔⛔ **El martes 1-dic-2026 hay un inventario físico real en Yurécuaro.** **Ninguna** acción de
> este plan se ejecuta antes de esa fecha. Lo que haya que hacer antes del conteo está en §7 y es
> **sólo medir y avisar**, no cambiar código ni datos. Ver §6.0.

---

## 1. Lo que motivó el pedido, verificado — y en qué parte está incompleto

Edgar midió Yurécuaro (`warehouse_id` `f2fe6a0b-…70fea`) el 2026-11-27. **Verificado celda por
celda, da exactamente lo mismo:**

| Lo que dijo Edgar | Re-medido hoy | ¿Coincide? |
|---|---|---|
| ODS: 3,144 celdas | 3,144 | ✅ |
| Copia `commercial.stock`: 3,595 filas | 3,595 | ✅ |
| 3,140 compartidas, **484 discrepan** | 3,140 · 484 | ✅ |
| **455 filas que sólo existen en la copia** | 455 | ✅ |
| ODS viva al segundo | carril `ods_live_hot`, **21 s** de antigüedad, 9 sucursales, 0 errores | ✅ |
| Última escritura de la copia: 2026-11-25 16:05 UTC | idéntica, y **igual para 8 de los 10 almacenes** | ✅ |

### 1.1 ⭐ Lo que CONTRADICE la lectura de «dos días congelada»

**La copia no se está pudriendo: la congelamos nosotros, a propósito, hace dos días.**

`[CANON.7.5]` sacó `import-branch-stock-live` del carril `stock` el **2026-11-25** por pedido de
Edgar («hay que matar ese importer»). Era el **único escritor** de `commercial.stock.quantity`. La
marca `2026-11-25 16:05:04.041` idéntica en ocho almacenes es **su última pasada**, no una caída.

**La prueba negativa, que es la que importa:** si el carril se hubiera caído, nada más de ese carril
avanzaría. Medido hoy:

- `analytics.replenishment_plan` (el otro paso del carril `stock`, @15 min) → recalculado **a las
  23:20 UTC, hace 15 minutos**.
- `analytics.stock_movements` (carril `live`) → `imported_at` **23:15 UTC**.

O sea: **el carril corre y la copia no recibe nada**. El corte funcionó y su imagen está desplegada.
Decir «dos días congelada» sin esto invita a arreglar el importer, que es exactamente lo contrario
de lo que hay que hacer.

### 1.2 Lo que sigue siendo cierto, y es el problema de fondo

⭐ **El inventario físico compara contra el ODS y escribe su ajuste en la copia.** Eso no cambió.
Y ahora que la copia está congelada, el ajuste cae en un libro que **ya nadie actualiza y que
nadie lee para decidir**: es escritura a un cuaderno muerto. Ver §4 y §6.1.

---

## 2. Censo de LECTORES — quién le pregunta algo a una copia

Barrido del repo entero (`libs/`, `apps/api`, `apps/view`, `apps/portal`, `apps/vendor`,
`services/`, `database/`) más la base: `pg_depend` sobre vistas y matvistas, `pg_trigger`,
`pg_constraint`. **Excluidos** los comentarios y los `.spec.ts` (que sólo son candados).

### 2.1 En la base de datos — casi nada depende de las copias

| Qué se buscó | Resultado medido | Consecuencia |
|---|---|---|
| Vistas / matvistas cuya definición nombre las 4 tablas | **1**: `analytics.mv_purchase_postmortem` (nombra `stock_movements`) | Única pieza SQL que hay que revisar antes de tocar nada |
| Llaves foráneas que **apunten** a las 4 tablas | **0** | Ninguna tabla se rompe si se vacían |
| Disparadores propios | 3: `trg_auto_populate_tenant_id` (×2) y **`trg_rebalance_stock_lots`** sobre `commercial.stock` | El FEFO ya **no** lo usa: `commercial.lotes_fefo_por_evento.encendida = true` desde el 2026-11-25 14:46 UTC (D-EX6). El disparador queda instalado pero inerte |

⭐ **El riesgo «una vista se rompe y ningún grep de TypeScript la ve» está DESCARTADO con medición**,
salvo por `mv_purchase_postmortem`. Era una sospecha razonable y resultó falsa; queda escrito para
que nadie la vuelva a investigar.

### 2.2 En el código

| # | Lector | Qué le pregunta | ¿El ODS contesta lo mismo? |
|---|---|---|---|
| L1 | `inventory-count.service.openCount()` — ramas `commercial` e `inventory` | El teórico del folio | **Sí.** La rama `erp` ya existe y es la que elige hoy para las 9 sucursales (§5.3) |
| L2 | `inventory-count.service.openCount()` — rama `erp`, `LEFT JOIN commercial.stock` | Sólo `s.aisle_id` | **No hace falta**: `aisle_id` está en **0 de 59,270 filas**. El join no aporta un solo dato |
| L3 | `inventory-count.service.reconcile()` — guard de congelación | «¿hubo movimientos desde que abrí?», sobre `commercial.stock_movements` | ⛔ **No, y hoy tampoco contesta la copia.** Ver §4.2: es el defecto más grave del censo |
| L4 | `commercial-inventory.getStockForProduct()` | Saldo de UN producto (`GET /inventory/stock/:wh/:prod`) | **Sí** (`existenciaYApartado`). 0 llamadas en los 59 días de telemetría |
| L5 | `warehouse-aisles.service` (`listAisles`, `assign`) | Qué producto está en qué pasillo | **No existe el dato en ningún lado**: 4 pasillos, 0 productos asignados. `GET /inventory/aisles` sí se llama (21 veces, la última **hoy**) y devuelve 4 pasillos vacíos. Lo reemplaza UB (`[ICR.0.5]`) |
| L6 | `db-health` sonda `stock` | Frescura de la copia | **Ya retirada** (`retiredOn: '2026-11-25'`), con relevo nombrado y auto-denuncia |
| L7 | `db-health` sonda `stock_cedis_00` | Última foto del CEDIS | **Ya retirada** (`retiredOn: '2026-09-30'`) |
| L8 | `commercial-inventory.listMovements()` (`GET /inventory/movements`) | Bitácora propia | Es dato propio, no del ODS (§5.1). **0 llamadas** y **0 llamadores en el frontend** |
| L9 | `inventory-investigation.service` | Cruza bitácora propia con el diario del ERP | Dato propio + ODS; ya es mixto a propósito |
| L10 | `stock-state.ts` → `APARTADO_VIVO_SQL` | El apartado vivo | **No** — y no debe: es dato propio. Ver §5.1 |

**Falsos positivos del grep, verificados uno por uno y descartados:** `commercial-pricing.service`
(comentario viejo de J.6.7; la consulta real lee el ODS desde `[CANON.7.3]`),
`existencia-historico.service` (la cadena `'commercial.stock'` es el **rótulo** de los snapshots
anteriores a `[EX.H0]`, no una consulta), `alerts-scanner`, `commercial-analytics`,
`replenishment-scanner`, `zone-stock`, `floor-stockouts`, `por-vencer`, `order-stock`,
`lineas-con-existencia` y los tres frontends: **todos nombran la copia sólo para decir que ya no la
leen**.

### 2.3 Lectores de `inventory.warehouse_stock`

**Uno solo:** `inventory-count.service` (apertura del folio y reconciliación en modo `inventory`).
Fuera del conteo físico, **nadie en todo el repo la nombra**.

---

## 3. Censo de ESCRITORES — y cuánto se usan

### 3.1 El estado de las cuatro tablas, medido hoy

| Tabla | Filas | Almacenes | Última escritura | Antigüedad |
|---|---:|---:|---|---|
| `commercial.stock` | **59,270** | 10 | 2026-11-25 16:05 UTC | 2 d 7 h (por decisión, §1.1) |
| `commercial.stock_movements` | **102** | 6 | 2026-11-17 20:42 UTC | 10 d |
| `inventory.warehouse_stock` | **7,742** | 2 (`02`, `03`) | **2026-06-15 19:56 UTC** | **5 meses** |
| `inventory.warehouse_stock_movements` | **0** | — | **nunca** | — |

⭐ `inventory.warehouse_stock_movements` **no tiene una sola fila en toda su historia**. Su tabla
madre lleva cinco meses sin escritor. Es la copia más fácil de retirar.

### 3.2 Los escritores que quedan vivos en el código

Uso medido en `analytics.ui_usage`. ⚠️ **La telemetría arranca el 2026-09-30: son 59 días, no 90 ni
180.** Donde abajo dice «0 llamadas» significa **0 en esos 59 días**; antes de esa fecha es
**NO MEDIDO**.

| # | Escritor | Entrada | Qué escribe | Uso medido |
|---|---|---|---|---|
| W1 | `inventory-count.service.reconcile()` | `POST /inventory/counts/:id/reconcile` | `commercial.stock` + `stock_movements`, o `inventory.warehouse_stock` + sus movimientos | **0 llamadas en 59 d**; **0 folios reconciliados en toda la historia** |
| W2 | `commercial-inventory.adjustStock()` | `POST /inventory/adjust` | `commercial.stock` + movimiento `adjust` | **0 llamadas**. El botón de la pantalla ya se retiró en `[CANON.7.4a]` |
| W3 | `commercial-inventory.recordMovementInTx()` | `POST /inventory/movements` **y** `receiving-session.close()` | `commercial.stock` + movimiento | **0 llamadas al endpoint y 0 llamadores en el frontend**. Por recepción: 21 movimientos, el último el **2026-09-18** |
| W4 | `commercial-inventory.assignLotToUndeclared()` | vía `receiving-auditor` | `commercial.stock` + movimiento | 11 movimientos `adjust/receiving_audit`, el último el **2026-09-18** |
| W5 | `commercial-purchase-orders` (recepción propia) | `POST /purchase-orders/:id/receipts` | `commercial.stock` + movimiento `in` | **2 llamadas**, la última el **2026-10-16**. ⭐ Esa fecha **es** la última escritura del CEDIS en la copia: el cruce cierra |
| W6 | `commercial-route-control` (carga de camioneta) | `POST /commercial/route-tickets` | `commercial.stock` + movimiento | **4 tickets en toda la historia**, el último el **2026-07-17**. 0 POST en 59 d |
| W7 | `warehouse-aisles.service` | `POST /inventory/aisles/assign` | `commercial.stock.aisle_id` | **0 llamadas**; **0 de 59,270 filas** tienen pasillo |
| W8 | `stock-reservation-cron` (@5 min) | cron | **sólo** `commercial.stock_movements` (`release`) | Vivo. Desde `[CANON.7.4b]` **no toca** `commercial.stock` |

### 3.3 Los escritores de fuera del API

| Pieza | Estado medido |
|---|---|
| `database/importers/kepler/import-branch-stock-live.js` | **Fuera del carril** desde `[CANON.7.5]`; el archivo abre con su aviso de retiro y hay dos mutantes en rojo que impiden re-engancharlo. Verificado hoy en `run-prod-feeds.js` y por la prueba negativa de §1.1 |
| `services/feeds-ingest/apply-handlers.js` | Dos caminos escriben la copia: `stock-delta` **y `wincaja-stock`** (el anexo anterior sólo nombró el primero). **No hay deployment de `feeds-ingest` en `ops/k3s/`**, así que los dos están muertos. ⚠️ Medido contra los manifiestos del repo, **no** contra el clúster: la lectura directa de k3s es NO MEDIDA en esta sesión |
| `database/importers/commercial_import.js` | Escribe la copia, pero **no está en ningún carril**: sólo cuelga de los scripts npm `import:commercial` y `seed:testdata`. Ejecución manual |
| `ecosystem.sync.config.js` (el PM2 que corría el importer, según su cabecera) | **El archivo no existe en el repo.** La cabecera del importer quedó rancia |
| `import-inventory-health.js`, `import-replenishment-plan.js` | Sólo **nombran** la copia en comentarios de ADR-055; derivan del ODS |

---

## 4. Lo que las copias le hacen hoy al inventario físico

### 4.1 La incoherencia de raíz

El folio **compara contra el ODS** (`stock_source = 'erp'`, la rama que eligen hoy las 9 sucursales)
y **escribe el ajuste en `commercial.stock`**. Corrige el libro equivocado — y ese libro, desde el
2026-11-25, además está congelado.

### 4.2 ⛔⛔ El hallazgo más grave: el candado de congelación mira un libro vacío

`reconcile()` tiene un guard bien escrito: si el folio pidió congelar y **hubo movimientos** de sus
productos desde que se abrió, se niega a reconciliar, porque un ajuste absoluto borraría esas
ventas. El guard consulta **`commercial.stock_movements`**.

Esa tabla tiene **102 filas en toda su historia**, de 6 almacenes, la última del **2026-11-17**.
Yurécuaro (`04`) **no tiene ni una sola fila, nunca**.

Contra eso, los documentos de inventario que Kepler registró en Yurécuaro en los últimos 10 días
(`analytics.stock_movements`, que es el diario del ERP):

| Día | Renglones | Productos distintos |
|---|---:|---:|
| 2026-11-18 | 383 | 335 |
| 2026-11-25 | 295 | 255 |
| 2026-11-24 | 69 | 63 |
| 2026-11-21 | 70 | 64 |
| mediana de los 10 días | **44** | **37** |

Un folio de Yurécuaro tiene ~2,024 artículos (§5.3). En un día normal se mueven **37 de ellos**; en
un día cargado, **335 (17 %)**. **El guard vería cero y dejaría pasar el ajuste absoluto.**

⚠️ **Universo declarado:** `analytics.stock_movements` sólo trae los tipos de documento marcados
`k_binv` de Kepler. **La venta de mostrador de Wincaja no está ahí**, así que el movimiento real del
día es **mayor** que estas cifras, no menor. Cuánto mayor: **NO MEDIDO**.

⭐ **Por qué no muerde el 1-dic:** Edgar decidió **cerrar la sucursal para contar** (decisión 4 del
[acta del trimestral](FASE_ICR_ANEXO_CONTEO_TRIMESTRAL_2026-11-27.md)). La congelación real la da el
candado de la puerta, no este `if`. Pero el guard es la red por si ese día alguien factura igual, y
hoy **la red no está puesta**: está dibujada.

---

## 5. ⛔ Lo que NO se puede derivar del ODS

Esto es lo que decide qué se retira y qué se queda. Lo que no se pueda derivar **se declara**, no se
asume reemplazable.

### 5.1 `commercial.stock_movements` — el libro propio de la Suite. **SE QUEDA.**

No es una copia de nada: es el registro de actos que ocurren **sólo en la Suite** y que Kepler no
conoce. Sus 102 filas, por tipo:

| Tipo · referencia | Filas | Última | Qué es, y por qué el ODS no lo tiene |
|---|---:|---|---|
| `in` · `receiving_audit` | 37 | 2026-10-07 | Alta por auditoría de recepción de la Suite |
| `in` · `receiving_session` | 21 | 2026-09-18 | Alta al cerrar una sesión de recepción |
| `adjust` · `receiving_audit` | 11 | 2026-09-18 | Ajuste de la misma auditoría |
| `in` · `goods_receipt` | 10 | 2026-10-16 | Recepción contra OC propia |
| `release` · `order` | 12 | 2026-11-17 | **Apartado liberado** |
| `sale` · `order` | 10 | 2026-11-11 | Salida por pedido de la Suite |
| `reserve` · `order` | 1 | 2026-07-27 | **Apartado vivo** |

Dos cosas lo amarran:

1. ⭐ **El apartado.** `[CANON.7.4b]` ya derivó `reserved_quantity` **de este libro**
   (`APARTADO_VIVO_SQL`), no de la columna. **Cruce hecho hoy: las dos puntas dan lo mismo** — un
   solo apartado vivo, **15.000 unidades**, mismo `(warehouse_id, product_id)` en los dos lados, La
   Piedad Abastos. Y `commercial.stock.reserved_quantity` tiene **1 fila distinta de cero en las
   59,270**. ⛔ **Kepler no sabe qué apartó la Suite: eso no se puede derivar, nunca.**
2. **La cadena de evidencia de la recepción.** `commercial.receiving_lot_captures.stock_movement_id`
   apunta a este libro: **48 de 58 capturas** tienen su movimiento. No hay FK que lo imponga (medido:
   0 llaves foráneas), así que **borrar filas rompería la cadena en silencio**.

👉 **Veredicto: la tabla se conserva.** Lo que sí se retira es que **mueva saldos**: hoy cada
`INSERT` aquí va acompañado de un `UPDATE` a `commercial.stock`. El libro se queda, el saldo se va.

### 5.2 `commercial.stock.aisle_id` — **se retira, sin pérdida**

0 de 59,270 filas tienen pasillo y el catálogo `commercial.warehouse_aisles` tiene 4 filas. Ya está
nombrado como deuda en `[ICR.0.5]` y lo reemplaza UB (`bin_assignments`). **No hay dato que perder.**

### 5.3 Los almacenes que el ODS NO contiene — **y la sorpresa: tampoco los tienen las copias**

`analytics.v_erp_stock_on_hand` cubre **9 almacenes**. `commercial.warehouses` tiene **28**. La
sospecha razonable era que las copias guardaran el saldo de los 19 restantes (rutas, CEDIS). **Medido,
es falsa:**

| Grupo | Almacenes | Celdas en el ODS | Filas en `commercial.stock` | Filas en `inventory.warehouse_stock` |
|---|---:|---:|---:|---:|
| Sucursales `00`–`08` | 9 | 33,944 | 49,202 | 7,742 |
| **Rutas** (`01-002`…`01-006`, `RUTA-21`…`RUTA-505`) | **18** | **0** | **0** | **0** |
| `MD-32` (almacén borrado del ERP) | 1 | 0 | **10,068** | 0 |

⭐ **El saldo del camión de ruta no está en ninguna parte** — ni en el ODS, ni en las copias. La
vista lo excluye a propósito (`v.warehouse_code !~~ 'RUTA-%'`), y el código ya lo declara: el
vendedor ve «sin dato», no un cero. **Retirar las copias no pierde nada de rutas, porque no hay
nada.** Si VR o Última Milla necesitan saldo de camión algún día, es **dato nuevo**, no un dato que
estemos a punto de tirar.

`MD-32` son 10,068 filas de un almacén que Kepler ya borró: es basura, no dato.

### 5.4 ⚠️ Lo que el ODS **sí** sabe y la vista **esconde**: los saldos negativos

`v_erp_stock_on_hand` calcula `GREATEST(c4 + c8 − c9, 0)` — **aplasta a cero todo lo negativo**. Por
eso la vista publica **0 celdas negativas en las 9 sucursales**, un cero redondo que no es verdad.
Medido contra la misma fórmula sin el `GREATEST`:

| Sucursal | Celdas negativas en Kepler | Unidades |
|---|---:|---:|
| `00` CEDIS | 342 | −116,462 |
| `01` Padre Hidalgo | 795 | −83,455 |
| `02` La Piedad Abastos | 343 | −8,415 |
| `03` 8 Esquinas | 488 | −16,956 |
| **`04` Yurécuaro** | **227** | **−2,024** |
| `05` Zamora Centro | 197 | −4,811 |
| `06` Canindo | 329 | −14,017 |
| `07` Morelia Madero | 232 | −1,946 |
| `08` Morelia Abastos | 360 | −49,238 |
| **Total** | **3,313** | **−297,324** |

(`analytics.v_kepler_negative_stock`, que usa su propio universo, da **3,367** — del mismo orden.)

👉 **Consecuencia directa para el 1-dic:** el folio se siembra con `qty_stock_units > 0`, así que
esos **227 artículos de Yurécuaro no entran al folio**. Si alguien los encuentra en el anaquel
entran como «sobrante» con teórico 0, y la deuda de −2,024 unidades que Kepler arrastra **desaparece
sin que nadie la nombre**. Esto **no** es un argumento para no usar el ODS: es un dato que el ODS
tiene y la vista no publica. Se arregla en la vista (§6.4), no volviendo a la copia.

---

## 6. Las cifras que justifican el trabajo: la divergencia de las 9 sucursales

Celda = (almacén, producto). El dinero se valúa con `analytics.v_erp_unit_cost.costo_unitario`, que
es **costo del ERP SIN IMPUESTOS** (`kdik.c16` es el costo unitario **neto** en el peldaño base,
promedio móvil por sucursal; `ERP_KEPLER.md` §152). Cantidades en **unidades base de Kepler**.

| Suc. | Compartidas | **Difieren** | Sólo en el ODS | **Sólo en la copia** | Unidades de diferencia | **$ dif. absoluta (sin IVA)** | $ neto copia − ODS | Valor del ODS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `00` CEDIS | 164 | **158** | 1,558 | 41 | 434,726 | **9,993,897** | −3,221,075 | 10,168,291 |
| `01` Padre Hidalgo | 4,809 | **1,671** | 18 | 738 | 157,372 | **2,806,318** | +248,140 | 17,864,614 |
| `02` La Piedad Ab. | 4,537 | **920** | 6 | 685 | 9,397 | **192,234** | +22,546 | 2,476,627 |
| `03` 8 Esquinas | 4,835 | **1,505** | 16 | 1,316 | 29,548 | **662,937** | −78,759 | 5,465,217 |
| **`04` Yurécuaro** | 3,140 | **484** | 4 | 455 | 2,575 | **49,697** | +37,410 | 936,371 |
| `05` Zamora Centro | 3,411 | **509** | 24 | 409 | 15,723 | **306,549** | −176,336 | 2,010,600 |
| `06` Canindo | 3,990 | **1,526** | 0 | 6,577 | 103,819 | **2,094,896** | +9,354 | 14,831,704 |
| `07` Morelia Madero | 3,480 | **1,316** | 6 | 6,678 | 35,583 | **744,623** | −363,176 | 3,878,197 |
| `08` Morelia Abastos | 3,909 | **1,978** | 37 | 28 | 197,257 | **5,266,799** | −2,275,737 | 18,737,477 |
| `MD-32` (borrado) | 0 | 0 | 0 | **10,068** | 88,940 | *sin costo* | — | — |
| **TOTAL** | **32,275** | **10,067** | **1,669** | **26,995** | **1,074,940** | **≈ $22,117,950** | **≈ −$5,797,633** | **$76,373,608** |

### Cómo se lee

- ⭐ **El 31 % de las celdas compartidas discrepa** (10,067 de 32,275), y la diferencia absoluta vale
  **≈ $22.1 M sin IVA — el 29 % del inventario de la empresa** ($76.4 M). Ésa es la cifra que
  justifica el trabajo.
- **26,995 celdas existen sólo en la copia**: productos que Kepler ya no tiene. 10,068 son `MD-32`,
  un almacén borrado; 6,678 y 6,577 son Morelia Madero y Canindo.
- **El neto es −$5.8 M**: la copia dice **menos** de lo que hay. Un reporte sobre la copia subvalúa.
- ⚠️ **El CEDIS es el caso extremo**: $9.99 M de diferencia absoluta contra $10.17 M de inventario —
  o sea que la copia del CEDIS **está mal casi en su totalidad** (205 filas contra 1,722 celdas
  reales). Lleva congelado desde el 2026-10-16.
- **Yurécuaro es la sucursal MENOS divergente** de las nueve en dinero ($49,697 = **5.3 %** de su
  inventario). Es un buen canario justamente por eso: si el método se valida ahí, en las demás el
  beneficio es mayor, no menor.
- ⚠️ **Universo de la valuación:** 473 celdas con diferencia **no tienen costo arbitrado**
  (`costo_unitario IS NULL`) y **quedan fuera del dinero**, no sumadas como cero. 2,823 de las 2,823
  celdas de `MD-32` con diferencia están sin costo, por eso su columna de dinero va vacía y no en
  cero.

---

## 7. El plan, por capas

> **El orden lo dicta el riesgo, no la comodidad.** Lo primero es lo que puede corromper un dato
> real (el conteo físico de Yurécuaro), después lo que miente en pantalla, y al final la limpieza.
>
> ⛔⛔ **Nada de esto se ejecuta antes del martes 1-dic-2026.** Las capas C0 y C1 se construyen y se
> prueban, pero **no se sueltan a prod** hasta que el trimestral de Yurécuaro cerró. Lo único que
> toca hacer antes del conteo está en §7.0.

### 7.0 Antes del 1-dic — sólo medir y avisar (ninguna línea de código)

| Acción | Por qué |
|---|---|
| Avisar a quien supervise el conteo que **el candado de «hubo movimientos» no está puesto** (§4.2): la congelación la da cerrar la sucursal, y si alguien factura ese día el sistema **no lo va a detectar** | Es la diferencia entre un riesgo conocido y una sorpresa |
| Avisar que **227 artículos de Yurécuaro con saldo negativo en Kepler no van a aparecer en el folio** (§5.4) y, si se encuentran en el anaquel, entran como sobrante | Evita que se lea como un defecto del conteo |
| Tomar la **foto antes**: celdas, unidades y valor del ODS de Yurécuaro el lunes 30-nov al cierre | Sin el «antes» no hay regla 15 el día del cierre |

### 7.1 Capa C0 — `[ICR.0.1]`: un solo teórico, y el ajuste deja de ir a la copia

El ítem `[ICR.0.1]` ya existe y dice: *el folio se siembra SÓLO desde el ODS; se retiran las ramas
`commercial` e `inventory`.* Este anexo le agrega **la otra mitad, que es la que importa**: la
reconciliación.

| Paso | Qué cambia | Medición ANTES | Medición DESPUÉS |
|---|---|---|---|
| a | Retirar las ramas `commercial` e `inventory` de `openCount()` y el fallback | Las 9 sucursales ya eligen `erp` (§5.3); 4 de los 8 folios históricos usaron `inventory` | Que un folio nuevo en cada sucursal siembre exactamente las celdas del ODS con `qty > 0` (Yurécuaro: **2,024**) |
| b | Quitar el `LEFT JOIN commercial.stock` que sólo trae `aisle_id` | 0 de 59,270 filas tienen `aisle_id` | El folio se siembra igual, con una tabla menos en la consulta |
| c | ⭐ **`reconcile()` deja de escribir saldos.** El ajuste pasa a ser un **documento** (el archivo que Kepler captura, `kepler-export` + `ack`, que ya está construido y **nunca se usó**: `inventory_kepler_exports` vacía) | 0 folios reconciliados en la historia; 0 archivos emitidos | Que reconciliar **no toque** `commercial.stock` ni `inventory.warehouse_stock` (prueba negativa: contar filas de las dos tablas antes y después) y sí deje el archivo con su acuse |
| d | ⛔ **Arreglar el guard de congelación**: que mire el diario del ERP (`analytics.stock_movements`, y la venta de Wincaja cuando se mida), no `commercial.stock_movements` | El guard ve **0** movimientos donde Kepler registró hasta **335 productos en un día** (§4.2) | Reproducir el caso: abrir un folio de prueba, mover un producto en el ERP, y que el guard **se ponga rojo**. Un gate sin prueba negativa es una intención |

⛔ **Regla 13:** (c) y (d) son caminos que ESCRIBEN. No cierran hasta que una prueba los ejerció
contra Postgres real con el payload de la pantalla, en el CI o en el entorno de pruebas — **nunca
la laptop apuntando a prod** (y menos ésta: su `.env` apunta a prod VIVA).

### 7.2 Capa C0 — retirar `inventory.warehouse_stock` y sus movimientos

Es el tramo más barato y el de menos riesgo: **un solo lector** (el conteo, que (a) acaba de
retirar), **cinco meses sin escritor**, **0 filas** en la tabla de movimientos, **0 FKs**, **0
vistas**. Después de 7.1(a) queda **sin un solo consumidor**.

- **No se borra** (regla 5). Se declara retirada, se documenta en `MODELO_CANONICO_DATOS.md` y se
  pone el candado que impida volver a escribirla, con su mutante en rojo.
- **Medición:** que ningún archivo fuera de los candados nombre `inventory.warehouse_stock`.

### 7.3 Capa C1 — los cuatro escritores que quedan de `commercial.stock`

Uno por uno, del que más cuesta al que menos. **Todos conservan su renglón en
`commercial.stock_movements`** (§5.1): lo que se retira es el `UPDATE` del saldo.

| Escritor | Qué se hace | Medición antes/después |
|---|---|---|
| W5 recepción propia (`purchase-orders/:id/receipts`) | El saldo lo mueve Kepler cuando la entrada se captura allá; la Suite deja el movimiento como evidencia | 2 llamadas en 59 d, 10 movimientos `goods_receipt`. Después: el endpoint responde igual y la copia no cambia |
| W3 cierre de recepción + W4 auditoría | Igual: movimiento sí, saldo no. ⚠️ Cuidar `receiving_lot_captures.stock_movement_id` (48 de 58) | 58 capturas / 48 ligadas. Después: mismo conteo, cadena intacta |
| W2 `adjustStock` | **Retirar el endpoint.** El ajuste de existencia es de Kepler (ADR-040) y el botón ya no está en la pantalla | 0 llamadas en 59 d. Después: 404, y el candado con su mutante |
| W6 carga de camioneta | **Declarar deuda con nombre**, no retirar a ciegas: el camión no tiene saldo en Kepler (§5.3) y el módulo tiene 4 tickets desde julio. Pertenece a VR, no a esta campaña | 4 tickets, 0 filas de ruta en la copia |
| W7 pasillos | Ya cubierto por `[ICR.0.5]` | 4 pasillos, 0 asignaciones |

### 7.4 Capa C0 — la vista que esconde los negativos (§5.4)

Publicar el saldo con su signo, o publicar una columna que diga cuánto se aplastó. **No se decide
acá**: cambiar `v_erp_stock_on_hand` toca a todos los lectores de `[CANON.7.2]` y `[CANON.7.3]`.
→ **D-EX10**.

### 7.5 Al final — congelar `commercial.stock`

Cuando 7.1 y 7.3 cierren, la tabla queda **sin un solo escritor**. Entonces, y no antes:

- Se declara congelada (**no se borra**, regla 5), igual que se hizo con el importer.
- `commercial.stock_movements` **se queda viva** (§5.1).
- Candado: que ningún `UPDATE`/`INSERT` a `commercial.stock` vuelva al código, con su mutante en rojo.
- **Medición de cierre:** `max(updated_at)` de la copia **no se mueve** durante 7 días con la
  operación normal corriendo.

---

## 8. Riesgos

| # | Riesgo | Qué tan real es, medido | Mitigación |
|---|---|---|---|
| R1 | ⛔⛔ Tocar cualquier cosa antes del 1-dic | El conteo es real y hay un solo día hábil antes | **Nada se suelta antes del 2-dic.** §7.0 es sólo medir y avisar |
| R2 | El guard de congelación deja pasar un ajuste absoluto sobre un día con ventas | **Alto si la sucursal no cierra**: hasta 335 productos movidos en un día contra un guard que ve 0 | La sucursal cierra (decisión de Edgar). 7.1(d) pone la red de verdad |
| R3 | Retirar un escritor rompe algo que no se midió | Bajo: 0 FKs, 1 matvista, 0 vistas, y cada escritor tiene su uso medido | Uno por uno, con candado y mutante. Revisar `analytics.mv_purchase_postmortem` antes del primer paso |
| R4 | Se pierde dato propio al retirar | **Acotado y nombrado**: apartado y cadena de recepción (§5.1). Rutas y `aisle_id` no tienen dato que perder (§5.2, §5.3) | `commercial.stock_movements` se conserva entera |
| R5 | Alguien «arregla» el importer creyendo que la copia se cayó | Real: pasó en la lectura que originó este anexo (§1.1) | El importer abre con su aviso y hay dos mutantes que impiden re-engancharlo |
| R6 | El ODS se cae y el conteo se queda sin teórico | Hoy: 21 s de antigüedad, 9 de 9 sucursales, 0 errores | `lecturaDeSucursales` ya declara `sin_dato` por sucursal; **no se rellena con la copia** |
| R7 | Los negativos aplastados se leen como «todo cuadra» | Real: **3,313 celdas, −297,324 unidades** invisibles | §7.4 / D-EX10 |

### Sospechas que se midieron y resultaron FALSAS

Se escriben para que nadie las vuelva a investigar:

- ❌ *«Una vista de Postgres depende de las copias y ningún grep la ve.»* **Falso**: 0 vistas, 1 sola
  matvista nombra `stock_movements`, 0 FKs entrantes.
- ❌ *«Las copias guardan el saldo de los almacenes de ruta, que el ERP no tiene.»* **Falso**: 0 filas
  de ruta en las dos copias y en el ODS. No hay nada que preservar.
- ❌ *«`reserved_quantity` es un dato propio que hay que migrar.»* **Ya migrado** en `[CANON.7.4b]`, y
  **el cruce de hoy lo confirma**: columna y derivación dan el mismo único apartado de 15 unidades.
- ❌ *«La copia lleva dos días congelada porque el feed se rompió.»* **Falso** (§1.1).

---

## 9. Decisiones que necesitan firma

- **D-EX8** (ya firmada el 2026-11-25, se ejecuta acá): el conteo físico **se repunta al ODS**,
  teórico y ajuste. Este anexo la aterriza en `[ICR.0.1]` §7.1.
- **D-EX10 (nueva — decide Claude, firma Edgar):** qué hace `v_erp_stock_on_hand` con los **3,313
  saldos negativos** que hoy aplasta a cero. Recomendación: **publicar el signo en una columna
  nueva** (`qty_raw`) y dejar `qty_stock_units` como está, para no mover a los ~21 lectores de
  `[CANON.7.2]`/`[CANON.7.3]` de un golpe. ⚠️ **NO MEDIDO:** cuántos de esos lectores asumen que la
  cantidad nunca es negativa. Se mide antes de firmar.
- **D-EX11 (nueva — Edgar):** la **carga de camioneta** (W6, 4 tickets desde julio) escribe un saldo
  que ningún libro tiene. ¿Se retira ahora con el resto, o se declara deuda de VR? Recomendación:
  **deuda con nombre**, porque retirarla sin reemplazo borra el único rastro de un proceso que algún
  día va a existir.
- **D-EX7** sigue abierta del anexo anterior: `analytics.stock_movements` como materialización
  declarada. Este anexo agrega un argumento a favor: es **lo único** que puede alimentar el guard de
  congelación de §7.1(d).

---

## 10. Lo que este anexo NO midió

- El clúster k3s en vivo (si `feeds-ingest` está desplegado): se leyó el repo, no `kubectl`.
- La venta de mostrador de Wincaja dentro del movimiento diario de una sucursal (§4.2).
- El uso de los endpoints **antes del 2026-09-30**: la telemetría no existe.
- El costo de derivar `analytics.stock_movements` por vista (D-EX7).
- Cuántos lectores del ODS asumen cantidad no negativa (D-EX10).
