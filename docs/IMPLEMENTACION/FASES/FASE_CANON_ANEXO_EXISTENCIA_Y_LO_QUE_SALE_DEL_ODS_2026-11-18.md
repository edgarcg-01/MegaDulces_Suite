# Anexo CANON.7 — La existencia y todo lo que puede salir del ODS (medido el 2026-11-18)

> **Pedido, literal (Edgar, 2026-11-18):** «los imports no deben de existir» · «revisa qué puede salir del ODS que hoy
> no está saliendo» · «resolvamos existencia y todo lo que pueda salir del ODS».
>
> **Estado:** C0 medido (este documento). `[CANON.7.1]` ✅ **en prod desde el 2026-11-19** (las 9 sucursales en 29–57 ms
> leídas con RLS, antes 10.5–14 s); 7.2–7.5 sin construir. Se cuelga de la excepción de cupo que Edgar firmó para CANON (anexo
> `FASE_CANON_ANEXO_RETIRO_IMPORTERS_2026-11-05.md` §8); items `[CANON.7.N]`.
>
> ⭐ **Corrección del 2026-11-19 (§2.1 y §3):** la vista no era lenta por RLS sino por un **estimado**. Se arregla con una
> estadística y sin tabla nueva: el diseño de «existencia mantenida por cambio en la cola de CANON.6.21» queda descartado.
>
> **Cómo se midió:** horario vivo del pod `feeds-cron` (igual al del repo) y el loop `feeds-livefast`; código con `git grep`;
> prod en sólo lectura (`system_identifier` 7688376744939610156), una parte como `postgres` y la que importa como un rol
> **sin** superusuario ni `BYPASSRLS` (el que pinta lo que vive la app); el consolidado por el túnel del 5433 (`system_identifier`
> 7644631598664073265, con venta de hoy).

---

## 1. Lo que hoy NO sale del ODS y podría

46 pasos activos en la ingesta (8 carriles + 9 sueltos). Los que leen OTRA fuente aunque el dato ya está en el ODS:

| Frente | Hoy sale de | Lo medido | Destino |
|---|---|---|---|
| **Venta** — `import-sales-fact` (loop de 60 s + nocturno) → `analytics.sales_daily`, raíz de Pedido | `mart.ventas_enriched` | 30 días: **92.8 %** del importe es venta de las 8 sucursales de Kepler y **7.2 %** el push de las camionetas (`ruta_*`). Control 7 días contra `analytics.v_kepler_sales_lines`: 8 Esquinas, Canindo y Morelia Abastos **idénticas al centavo** (21/21 sucursal-días, mismos renglones); Padre Hidalgo difiere exactamente por sus almacenes de ruta `01-001`…`01-006` (17-nov: $123,254 vs $123,255), que **sí están en `kepler_ods.kdm1`** (202 documentos ese día) pero la vista los excluye (`btrim(h.c1) = btrim(h.sucursal)`) | vista/tabla por evento que una por `warehouses.kepler_code` (las rutas `RUTA-NN` ya tienen `01-00N`) — es `[PQ.61]` (venta diaria de Kepler por evento, migración sin versionar) más el push (D4) |
| Mismos datos del mart: `rotation-from-consolidado`, `top-sellers-from-consolidado`, `customer-sales` | `mart.ventas` | = la venta de arriba | se derivan de la misma venta |
| **ContPAQi** — `contpaqi-polizas`, `-bank-movements`, `-ledger`, `-suppliers`, `-cfdis` (×2 agendas), `derivar-reglas` | SQL Server directo | `contpaqi_ods` vivo desde `[CANON.6.21]`/D15 (202 tablas, 5 GB, escrito hoy) con `ct_polizas`, `ct_movimientospoliza`, `ct_saldoscuentas`, `ct_proveedores`, `ct_bancos`, `add_comprobante`… | repuntar a `contpaqi_ods` (de la sesión de CANON) |
| **Existencia** — `import-branch-stock-live` (cada 15 min) → `commercial.stock` | réplica directa `md.kdil` | §2 | §3 |
| Mixtos: `product-sales-daily`, `expenses-polizas`, `ledger-chain`, `reconcile-route-provenance` | ODS **y** réplica directa `md.*` | — | quitar la mitad `md.*` |

**No está en el ODS:** sólo el push de las camionetas (`route-push-lines`, `route-push-monthly`, `canindo-routes-monthly`,
`reconcile-route-provenance`) → D4 (Edgar, 2026-11-17: «sí, hagamos lo del ODS»).

---

## 2. Existencia: el dato sale entero del ODS (C0)

`commercial.stock` vs `analytics.v_erp_stock_on_hand` (vista sobre `kepler_ods.kdil`), celda por (almacén, producto):

| Caso | Celdas | Con existencia |
|---|---:|---:|
| Igual | 31,714 | 22,070 |
| Sólo en la copia | 27,100 | **3,347** |
| Sólo en el ODS | 1,458 | 241 |
| Distinto | 302 | 302 |

La vista: 0 duplicados, 0 negativos, una sola fuente (`kepler_ods`, 9 sucursales).

**Las 3,347 que sólo tiene la copia, una por una:**
- **2,823** — «Almacén Morelia Madero (32)» (`MD-32`), almacén **borrado**, congelado desde el 2026-09-10: fantasma.
- **424** — productos activos que Kepler NO tiene en `kdil` de esa sucursal, congelados desde la migración de cada una
  (Morelia Madero 2026-09-18, Canindo 2026-08-18, CEDIS ago–oct): fantasma que la copia (delta) nunca borró.
- **64** — productos borrados en el catálogo: la vista los excluye a propósito.
- **32** — CEDIS sin movimiento desde su corte a Kepler: la vista los excluye a propósito
  (`20261001190000_cedis_arbitrado_por_corte`).
- 3 en cero en Kepler.

**Dato propio de la Suite en la copia:** 59,116 filas, **1** con `reserved_quantity > 0`, **0** con `aisle_id`. Los lotes viven
en `commercial.stock_lots`. Movimientos que la app escribió en 30 días: **19** (12 liberaciones, 7 ventas, de pedidos);
recepciones, conteos y devoluciones de ruta: **0**.

⭐ Pasar los lectores al ODS **corrige ~3,800 celdas** y no pierde ninguna real.

### 2.1 Pero la vista NO aguanta como fuente de lectura de la app

Medido con un rol sin superusuario ni `BYPASSRLS` (como corre la app; tres corridas):

| Consulta | `postgres` | Con RLS |
|---|---:|---:|
| Toda la red | 357 ms | 1.2–2.0 s |
| **Una sucursal (`warehouse_code = '08'`)** | 44 ms | **10.5–11 s** |
| `reorder_policy` ⟕ existencia, toda la red | — | ~500 ms (con la copia: 5 ms) |

⛔ Cambiar los lectores a la vista **tal como está** vuelve lentas pantallas que hoy son instantáneas (Existencia crítica,
catálogo del portal, detalle de pedido). Con `postgres` no se ve.

### 2.2 La causa, medida el 2026-11-19: un estimado, no RLS

`EXPLAIN ANALYZE` de una sucursal con el rol de la app: el filtro `k.sucursal = k.c1` (el almacén propio de cada
sucursal) compara dos columnas, Postgres no tiene estadística para eso y usa el 0.5 % por defecto: estima **204** filas de
`kdil` donde hay **37,133** (91 % de 40,800). Con 204 elige un Merge Join sólo por almacén y deja el SKU como filtro:
**40 millones de pares descartados**, 13.8 s de 13.8 s. RLS sólo cambia la forma del plan lo suficiente para exponerlo.

| Intento | Resultado |
|---|---|
| Unir `kdil` al almacén por `sucursal` Y `c1` | ✖ la clase de equivalencia re-deriva `sucursal = c1`: mismo plan, 12.9 s |
| `CREATE STATISTICS (mcv) ON sucursal, c1` | ✖ el MCV no sirve para «columna = columna» (Postgres 18, probado) |
| Estadística de la expresión `((sucursal = c1))` con el filtro escrito igual | ✖ sigue en 204 |
| La misma estadística con el filtro escrito `(k.sucursal = k.c1) IS TRUE` | ✔ **37,123** (Postgres 18 desechable, datos de la misma forma) |

Con el estimado bien (simulado en prod quitando el filtro) quedan ~330 ms por sucursal, casi todo de calcular entero
`v_product_box_factor` (10 mil productos) en cada lectura. `[CANON.6.21]` ya guarda esa regla por llave en
`analytics.resolved_product_box_factor`. Con las dos cosas: **una sucursal 36–66 ms · toda la red 87–113 ms · 3 SKUs
5–6 ms** (rol `edgar`, sin BYPASSRLS, tres corridas cada una).

---

## 3. El diseño: la vista misma, con la estadística que le faltaba

~~Existencia mantenida por cambio: `kdil` como fuente 14 de la cola de `[CANON.6.21]` y una tabla nueva.~~ Descartado el
2026-11-19 por §2.2: no hace falta copiar nada. (Además habría sumado los ~290 mil cambios de `kdil` a una cola cuyo
drenado cuesta ~40 ms por SKU porque recalcula también precio y costo.)

1. **`[CANON.7.1]` C0** — migración `20261119083212_canon71_existencia_ods_estimado_y_factor_por_evento`:
   `kepler_ods.st_kdil_almacen_propio` (estadística de la expresión `(sucursal = c1)`) + `ANALYZE`, y la vista con
   `WHERE (k.sucursal = k.c1) IS TRUE` y el factor de caja desde `analytics.resolved_product_box_factor`. Prueba
   `database/tests/test-newdb-canon71-existencia-ods.js`: la estadística y el `IS TRUE` juntos, el estimado leído del
   EXPLAIN contra el conteo real, la cantidad idéntica al renglón contra el texto anterior, el factor sólo difiere donde la
   tabla por evento difiere de su vista, una sucursal bajo 500 ms con un rol como la app. Ensayada entera en un Postgres 18
   desechable con los tipos de prod: el texto anterior deparsea idéntico al de prod, `up` dos veces, `down` exacto, y tres
   negativas en rojo (sin migración, factor roto, sin la tabla por evento). ✅ **Aplicada en prod el 2026-11-19 a las
   11:24** (0.3 s; sin lectores de la vista ni transacciones largas; 0 errores en la API en los 20 min alrededor) y medida
   con RLS como `edgar`: estima 37,114 filas propias de `kdil` y son 37,145 (escrito sin `IS TRUE`, sigue en 204: es el
   control), las 9 sucursales en 29–57 ms, toda la red ~90 ms, prueba 11/11. ⚠️ Se había prometido «fuera de horario» y
   se aplicó en horario hábil: Git Bash dio la hora en UTC creyendo dar la de México. ⛔ La prueba traía un error de
   instrumento que salió en prod: comparaba el estimado del nodo de UNA sucursal (4,108) contra las filas propias de toda
   la red (37,145) y salía roja con la estadística funcionando. En el ensayo pasaba porque el plan recorría `kdil` entera.
   Ahora compara estimado contra real del mismo nodo (`EXPLAIN ANALYZE`) y corre el filtro sin `IS TRUE` como control
   negativo. `display_box_factor` difería la mañana del 19 en 3 SKUs (retraso de < 24 h de la tabla por evento ante el
   refresco nocturno de `mv_kepler_bought_rung`: un `REFRESH` no dispara la cola, hueco de `[CANON.6.21]` con nombre); al
   aplicarla eran 0.
2. **`[CANON.7.2]` C2** — los lectores clase A leen la vista. 🧪 **11 de 13 en código (2026-11-19)**, con una sola
   definición, `EXISTENCIA_ODS_SQL` / `existenciaOds()` en `stock-state.ts` (la vista con la forma de la copia; apartados
   en 0, como `leerExistencia`): Stock muerto, Bajo stock (Command Center), Sell-out, Salidas, Thot `reorder_policy`, ficha
   de producto, Rentabilidad overview y breakdown, Existencia crítica, su resumen y el excedente de red. Candado
   `existencia-ods-lectores.spec.ts` (rojo en los 7 archivos de antes). **A6 (conteo de Monitoreo) y A13 (scanner de
   reorden) pasan a 7.4:** leen dentro de un endpoint que escribe y su prueba contra base real siembra la copia (regla 13).
   Antes/después medido en prod con RLS (`edgar`), réplica de cada consulta: las 8 sucursales dan lo mismo al renglón;
   cambia el CEDIS (la copia lo tenía congelado desde el 16-oct: un producto, 2,318 contra 72,576 en Kepler) y sale
   `MD-32`. Bajo stock del Command Center: 34,218 → 18,650 celdas; inventario valuado de Rentabilidad: $65.98 M → $69.02 M;
   capital parado: $429 mil → $432 mil. Tiempos con el ODS, todos bajo 500 ms (el más lento 353 ms; Stock muerto 558 ms
   ya costaba 550 con la copia, lo pesa `v_erp_unit_cost`). Sell-out pierde la excepción «sin SKU pero con existencia»:
   0 filas en la copia y en el ODS.
3. **`[CANON.7.3]` C2** — los clase B (deciden «hay / no hay»). 🧪 **10 de 11 en código (2026-11-19)**, con la misma
   `existenciaOds` de 7.2: catálogo y facetas del portal, lista de precios y más vendidos, bot de WhatsApp, Command
   Center (agotados del top), Reparto › Faltantes y sus sugerencias, Thot del portal y del vendedor. **Cambian de fuente,
   no de regla:** «sin fila» se sigue leyendo como 0, igual que con la copia. Decir «sin dato» en vez de «agotado» (la
   regla de `estadoDeExistencia`, que el catálogo ya usa con `stock_state=1`) es otra decisión, por pantalla. **B6
   (detalle de pedido) pasa a 7.4:** su tope tiene que cuadrar con `reserve()`, que valida contra la copia con candado.
   Medido en prod con RLS (Padre Hidalgo, réplica de cada consulta): casi idéntico (catálogo «sólo con existencia» 3,339 →
   3,337; Faltantes 637 → 655 renglones; precios con registro 5,355 → 4,751, las celdas en cero que la copia arrastraba);
   todo bajo 125 ms (catálogo 47–64 ms, con la copia 14–25).
4. **`[CANON.7.4]` C1** — escritores (clase C, 18 sitios, más A6, A13 y B6, que leen la existencia dentro de algo que
   escribe). **Medido el 2026-11-19** (prod, sólo lectura; `stock_movements` 90 días y `ui_usage` 60 días), ordenado por uso:

   | Pieza | Uso medido | Qué cambia |
   |---|---|---|
   | **7.4a Inicio de Almacén** (`/almacen`, `listStock`, C3) | **704 llamadas en 28 días**, ocho roles de tienda y almacén. Es la PORTADA de Almacén, no una consola: muestra el CEDIS congelado | la lectura pasa al ODS con los mismos campos. Su botón «Ajustar» (`POST /inventory/adjust`) tuvo **0 llamadas** y escribe en la copia: se retira (ajustar es en Kepler, ADR-040) → **D-EX3** |
   | **7.4b Pedidos** (`reserve`/`consume`/`release`, cron de apartados, B6) | 7 ventas y 12 liberaciones en 30 días; **0 apartados en 90 días** (1,104 pedidos confirmados sin apartar); 1 apartado vivo (15 piezas) | validar contra el ODS; `consume` deja de restar `quantity` (la venta la descuenta Kepler); el apartado sigue siendo dato propio. Prueba contra base real sembrando `kdil` |
   | **7.4c Lotes** (`stock_lots`, caducidades C1/C2) | `POST expiry-reviews/entries`: 123 en 60 días; 144 lotes declarados (15,720 piezas) | ⭐ el disparador `trg_rebalance_stock_lots` mantiene el lote **NA** como `quantity` de la copia − lotes declarados: **es una TERCERA copia** (64,440 filas). Pasa a derivarse del ODS sin guardarse. ⛔ En el CEDIS quedaron **5,175 lotes NA huérfanos desde el 28-jul** sin fila en la copia, que suman 104 M de piezas (el SKU `00001` solo, 97 M) |
   | **7.4d Lo que nadie usa** | 0 en 60–90 días: ajustes, movimientos, conteos (abrir/contar/conciliar), conteo de Monitoreo (A6), pasillos, recepción (última el 16-oct, D21), carga de camioneta (C18), `stock-reservation` | se retira o se repunta, uno por uno, con su dueño |
   | **7.4e Scanner de reorden** (A13) | cron de medianoche + `scan-now` | lee el ODS como la pantalla de Existencia crítica (hoy difieren en el CEDIS) |

   Cada pieza que escribe lleva su prueba contra base real con el payload de la pantalla (regla 13).

   🧪 **7.4a en código (2026-11-19).** La portada lee `EXISTENCIA_ODS_CON_APARTADO_SQL` (la cantidad del ODS y el apartado
   de la app, que es dato propio); D-EX3 firmada («hagámoslo»): fuera «Ajustar» y la pantalla pasa a llamarse «Existencia y
   apartados» (pestaña, menú, permiso, ayuda y la nota de Existencia). Medido en prod con RLS: el CEDIS pasa de 205
   renglones congelados a 1,618; una página por sucursal 270–325 ms; la cuenta de la red 708 → 117 ms (sin los cuatro
   joins 1:1, mismo total con y sin ellos). `POST /inventory/adjust` sigue vivo sin pantalla: se retira en 7.4d.

   **Probado en local antes de empujar (Edgar, 2026-11-19: «primero tenemos que cumplir todos los procesos en local y
   probarlos»).** La prueba encontró dos defectos que ya estaban en prod con la copia y uno que traía el propio cambio:
   - **Las tarjetas mentían.** Se sumaban en el navegador sobre `listStock(pageSize: 9999)`, que el servidor topa a 500:
     en la red decían 500 líneas, $475,940 y «1 almacén» contra **33,530 líneas, $70.4 M y 9 almacenes** (medido en prod
     con RLS). Ahora las agrega el servidor (`GET /commercial/inventory/stock/summary`, mismo universo y mismo costo
     arbitrado que el listado; la línea con saldo y sin costo se cuenta, 34 en la red, y no se suma como cero). Visto en
     local: tarjetas y encabezado dicen lo mismo (33,534 en la red; 1,624 en el CEDIS) y sano + crítico + sin stock suman
     el total. ⚠️ El resumen de la red tarda 0.83 s en prod (por sucursal ~0.4 s): arriba de 500 ms, deuda con nombre —
     reemplaza una llamada de 0.76 s que además era falsa.
   - **Dos formatos de cantidad**: la existencia del ODS llega «1» y el apartado «0.000»; ahora las tres columnas con
     `number:'1.0-3'`.
   - **En el teléfono** (un tercio del uso, almacenista y surtidor): sin la columna «Ajustar» la regla global dejaba fija
     a la derecha «Valor disp.» y «Disponible» quedaba debajo. La tabla pasa a `dt-stack` (cada renglón se apila con sus
     campos); va con `class` porque en PrimeNG 22 `styleClass` en `p-table` es un atributo muerto (también en
     `admin-personas` y las demás que lo usan así: hallazgo aparte).
   Candado ampliado a 27 casos, siete mutantes en rojo. La pantalla sale de la deuda por columnas de `check-dense-tables`
   (trinquete: quitarle `dt-stack` la vuelve a poner en rojo), con un hueco declarado: esa compuerta busca la PALABRA
   `dt-stack` en todo el archivo y un comentario la satisface; por eso el candado exige la clase real en `p-table`.
   Visto en local a 390 px y en escritorio, contra los datos de prod.

   🧪 **7.4b en código (2026-11-20).** Medido antes (prod, sólo lectura): el libro `commercial.stock_movements` tiene
   102 filas en toda su historia; hubo **un** apartado (`PD-2026-00011`, La Piedad Abastos, «confirmado» desde el
   27-jul con las 15 piezas que la copia decía tener; Kepler tiene 150); 3 entregas en 90 días, las tres de preventa; y
   las 8 trazas por lote que dejaron las entregas dicen `NA` (el lote sin lote). ⛔ Y la copia exige
   `quantity >= reserved_quantity`: apartar contra el ODS con la copia rezagada rompe esa regla o obliga a mantenerla.
   - **El apartado se deriva del libro, no de la columna de la copia** (`APARTADO_VIVO_SQL` en `stock-state.ts`): por
     referencia, lo apartado menos lo liberado sin bajar de cero; cuentan los pedidos no entregados ni cancelados y las
     reservas del bot sin `released_at`. Da lo mismo que la columna (15 = 15) en 0.3 ms para toda la red.
   - `OrderStockService` ya no toca la copia: **apartar** valida existencia del ODS − apartado y escribe el
     movimiento; **entregar** valida contra el ODS y ya no resta (la venta la descuenta Kepler; la traza por lote decía
     siempre `NA`, no se pierde nada); **liberar** topa en lo que ESA referencia apartó (antes, en lo apartado de todo
     el almacén: un pedido podía liberar el de otro). El `FOR UPDATE` sobre la copia pasa a `pg_advisory_xact_lock`
     por (almacén, producto). El cron que vence las reservas del bot, igual.
   - Leen el mismo apartado la portada de Almacén (7.4a) y el detalle de pedido (B6, acotado con constantes a los
     almacenes y productos del pedido: la vista agrupa y Postgres no empuja una condición de JOIN hasta `kdil`).
   - Medido con RLS (`app_runtime`): apartar o entregar un producto 7–30 ms; el detalle de un pedido de 55 renglones
     16–18 ms (con la copia, 84); el resumen de la red da lo mismo que con 7.4a y no empeora (0.73–0.89 s contra
     1.06–1.54; sigue siendo la deuda de 7.4a).
   - **Probado contra Postgres real**: una base desechable local con todas las migraciones
     (`dev-bootstrap-empty-db.js`; la máquina no tiene pgvector y su migración se registró como molde, declarado en
     `_dev_bootstrap_log`). `order-stock.it.spec.ts` corre el servicio REAL como `app_runtime` con `kdil` sembrado y
     SIN renglón en la copia: 12 casos, y quince mutantes en rojo (sin tope por referencia, sin candado en cada una de
     las tres operaciones, un cancelado que sigue apartando, la portada, B6 o el cron de vuelta a la copia…). La
     consulta del detalle de pedido salió de `findById` a `lineas-con-existencia.ts` para que la prueba ejerza ESA
     consulta y no una copia de su SQL: la API local no estaba corriendo y levantarla está prohibido (regla 3), así que
     la pantalla del detalle queda **sin validación visual**. En el CI corre en el job de integración (`TP_IT_DB`).
   - ⚠️ **Sin tocar, con nombre:** el apartado fantasma de `PD-2026-00011` (es de Comercial: o se entrega o se
     cancela); el tope del detalle de pedido suma de vuelta la cantidad del renglón también en preventa, que no apartó
     (regla anterior, sin cambio); el aviso «se vendió vencido» sigue leyendo `stock_lots`, cuyo lote `NA` mantiene la
     copia (7.4c). En la base desechable la vista de existencia es la de antes de 7.1 (su migración depende de 6.21, que
     no corre sin los datos de prod): misma cantidad, otro origen del factor de caja, que esta prueba no lee.

   🧪 **7.4e en código (2026-11-20).** El scanner de reorden (A13, `replenishment-scanner.service.ts`, la bandeja
   `commercial.replenishment_findings`) leía la copia en sus dos consultas (bajo reorden y cadencia lenta); ahora lee
   `existenciaOds`, la MISMA fuente que la pantalla de Existencia crítica desde 7.2 (sin apartados, igual que ella: 15
   piezas en toda la red). Medido en prod con RLS: «bajo reorden» pasa de 24,251 a 24,261 (Canindo +74, CEDIS −64, el
   resto ±3); la consulta, 0.79 s (corre de noche). Prueba contra Postgres real `replenishment-scanner.it.spec.ts`: el
   servicio REAL como `app_runtime` con una copia que miente a propósito (100 contra 3 de Kepler, y 0 contra 40): marca
   el bajo y no el sano; devuelto a la copia, rojo (2 de 2) y también el candado estático.

   **7.4c (lotes), medido el 2026-11-20 — sin código todavía.** De 151 caducidades capturadas en 60 días, 139 se
   volvieron lote fechado (`EXP-…`); 12 no, porque el lote `NA` no alcanzaba (2 sin renglón en la copia). En el CEDIS no
   se capturan caducidades y su `NA` es basura: 5,385 renglones, 104.7 M de piezas, 5,178 sin renglón en la copia. Hay
   ~130 lotes fechados vivos y **ninguno tiene su entrada en `stock_lot_movements`**. Ubicaciones usa un solo renglón
   de lote (60 piezas). ⚠️ Lo que decide el diseño: cuando la existencia de Kepler baja de lo declarado en lotes, el
   disparador de la copia consume los lotes fechados en orden FEFO, y ese consumo es irreversible (si después entra
   mercancía, va a `NA`, no regresa al lote). Sin la copia, eso tiene que ocurrir por EVENTO del ODS (el cambio de
   `kdil` del producto), sólo para los ~130 productos con lote fechado — no derivarse al leer, que lo volvería
   reversible.

   **Plan de 7.4c (2026-11-20, sin código; D-EX4 la decide Claude y la firma Edgar, D-EX5 es de Edgar):**
   1. **C0 — el consumo FEFO pasa al evento del ODS.** Un disparador POR SENTENCIA sobre `kepler_ods.kdil` (tablas de
      transición, el patrón de `[CANON.6.21]`, `tg_kdii_ficha_history` y ADR-104: la ingesta escribe por lote, así que
      corre una vez por lote y sólo ve lo que cambió). Sólo actúa sobre los productos que tienen lote fechado vivo
      (~130): si la existencia de Kepler quedó por debajo de lo declarado en lotes, consume la diferencia en orden FEFO
      (lo bueno primero, como el disparador de hoy) y lo deja escrito en `stock_lot_movements`. Nace APAGADO con su
      interruptor, atrapa su propio error y nunca frena la ingesta. Fuera de horario: `CREATE TRIGGER` sobre la tabla
      más escrita del ODS. ⛔ Mientras exista la copia, los dos disparadores coexisten: se prende éste y se apaga el de
      la copia en el mismo paso, no antes.
   2. **C1 — el lote `NA` deja de guardarse y se deriva**: `NA = max(existencia del ODS − Σ lotes fechados, 0)`, una
      definición en `stock-state.ts` (como `APARTADO_VIVO_SQL`). La leen la lista de lotes de inventario, «por ubicar»
      de Ubicaciones y el aviso «se vendió vencido» de entregar.
   3. **C1 — capturar una caducidad** (`feedLine`) ya no necesita renglón en la copia ni mueve cantidad del `NA`: declara
      hasta lo que la existencia de Kepler deja libre (existencia − Σ fechados). Corregirla (`unfeedLine`) sólo baja el
      lote fechado. Prueba contra Postgres real con `kdil` sembrado, incluido el caso que hoy falla (sin renglón en la
      copia).
   4. **D-EX5 (Edgar):** los ~64 mil renglones `NA` guardados (en el CEDIS, 104.7 M de piezas que no existen) quedan sin
      lector después del paso 2. Recomendado: borrarlos en 7.5, con el conteo antes y después, cuando ya nadie los lea.

   🧪 **Paso 1 (C0) en código (2026-11-20), D-EX4 firmada («sí, sigue»).** Migración
   `20261120150025_canon74c_lotes_fefo_por_evento_del_ods` (sin aplicar: fuera de horario). La llave de la copia se
   INSERTA en la definición que la base tiene (`pg_get_functiondef`) y `down` la quita exacta: copiar el cuerpo a mano daba
   otra función (lo cazó la prueba). El disparador parte de las celdas declaradas (índice parcial
   `ix_stock_lots_declarados`) y no del lote de la ingesta: medido en prod con un lote simulado de ~1,400 renglones,
   60–110 ms al revés contra 13–30 ms así, sin el índice. La existencia de una celda, ~100 ms, sólo cuando el lote toca
   un producto declarado. Al prenderlo hoy, 5 celdas tienen declarado por encima de Kepler (5,035 piezas; 2 sin
   renglón en `kdil`, que no se consumen hasta que Kepler las escriba). Prueba contra Postgres real
   `lotes-fefo-por-evento.it.spec.ts` 9/9 y siete mutantes en rojo (sin interruptor, FEFO sin preferir lo bueno, sin
   bitácora, el error que frena la ingesta, la copia que sigue consumiendo, `down` sin quitar la llave, consumir sin
   comparar).

   🧪 **Pasos 2–3 (C1) en código (2026-11-20).** Medido el uso (30 días): de lo que lee el `NA` guardado, sólo la captura
   de caducidades está viva (las promotoras capturan y corrigen a diario); la lista de lotes de inventario, «por ubicar»
   y «asignar lote» tuvieron 0 llamadas → 7.4d. `lotes-declarados.ts` (una definición): lo libre para declarar =
   existencia del ODS − lo declarado (`lot_code <> 'NA'`), con el MISMO candado que el disparador de `kdil`.
   `feedLine`/`unfeedLine` lo usan: ya no exigen renglón en la copia ni mueven el `NA`. Entregar (`consume`) calcula el
   aviso «se vendió vencido» con lo sin lote derivado. Medido en prod, 155 capturas en 60 días: 143 alimentaron, 12 no;
   con la regla nueva, 2 de esas 12 tendrían hoy lugar; el `NA` guardado coincide con el derivado en todas las celdas
   capturadas menos una. Pruebas contra Postgres real: `lotes-declarados.it.spec.ts` 5/5 (con un `NA` guardado que
   miente: 500), el caso de «vendido vencido» en `order-stock.it.spec.ts`, y las 4 suites de caducidades con servicio
   real 31/31 (`createEntry` incluido; en serie: en paralelo chocan entre ellas por la base compartida, ajeno a este
   cambio). Seis mutantes en rojo. ⛔ El interruptor sigue apagado: hasta aplicar la migración y prenderlo, los lotes
   los sigue consumiendo el disparador de la copia (que ahora ya no ve el `NA` que la captura dejó de mover; se cuadra
   solo en la siguiente pasada del importer).
5. **`[CANON.7.5]`** — `import-branch-stock-live` sale del carril `stock`; `commercial.stock.quantity` queda congelada (la tabla
   NO se borra, regla 5); el sensor `stock` de db-health se retira o se repunta (clase D).

**Clasificación completa de los 47 sitios** (archivo:línea, llamador, columnas, riesgo): hecha el 2026-11-18 por lectura de
código; los más calientes son el catálogo del portal y el detalle de pedido. ⚠️ `findById` del pedido no se mueve sin decidir
`reserve()` (valida contra la copia con candado). Los Thot del portal y del vendedor usan la sucursal por defecto `'MD-10'`
(código Wincaja viejo de Padre Hidalgo): no verificado que case con `warehouses.code = '01'`.

**Pruebas que copian la consulta en su propio SQL** (no se rompen, pero describen la forma vieja):
`test-newdb-replenishment.js`, `test-newdb-critical-stock-count.js`.

---

## 4. Decisiones

- ~~**D-EX1 (Edgar):** quién construye `[CANON.7.1]`~~ — **resuelta el 2026-11-19** («sí, quítaselo»): esta sesión. La
  sesión que construyó `[CANON.6.21]` ya no está viva; 7.1 terminó sin tocar su cola (sólo lee su tabla de factor).
- **D-EX2 (Edgar):** `[PQ.61]` (venta diaria por evento): aplicar su migración fuera de horario. Es la base del frente Venta.
- **D-EX3 (decide Claude, firma Edgar):** retirar el botón «Ajustar» de la portada de Almacén. Recomendado: sí — 0 llamadas
  en 60 días, escribe en una copia que se va a congelar, y el ajuste de existencia es de Kepler (ADR-040). Sin él, la portada
  sólo lee y puede pasar al ODS entera.
