# Anexo CANON.5 — Retiro de los importers vivos (inventario del 2026-11-05)

> **Estado: ⏸️ — no se abre como fase.** El tablero tiene 9 fases 🔨 contra un cupo de 4
> (`node .claude/skills/pm/tablero.js`, 2026-11-05). Este anexo deja el trabajo **clasificado y
> priorizado**; sólo la oleada 0 (abajo) se hizo, porque no toca el esquema. Lo demás espera cupo o
> una excepción firmada (D1).
>
> Hermano de [`FASE_CANON_INGESTA.md`](FASE_CANON_INGESTA.md), que planteó la meta el 2026-08-20.
> Esto **no la reemplaza**: la pone al día contra el código y prod de hoy, y corrige lo que ya cambió
> (§5).

---

## 0. El pedido, literal

1. «analiza cuántos importers tenemos actualmente»
2. «eliminemos todo lo que es basura y dejemos sólo los que están activos» → se borraron 50 scripts
   sin quién los dispare (`chore([OPS])`, 2026-11-05) y 13 `_diag-*` sueltos sin versionar.
3. «dime cuáles son esos 54 imports» → contados uno por uno eran **51** (la cifra de 54 era una
   estimación y estaba mal).
4. «arma la clasificación como plan» y «limpiemos todo el mierdero entonces».

**El universo no es el trabajo.** De los 51, **24 se quedan como tabla con razón** (son cálculos,
documentos propios o catálogo con RLS), y 3 se retiraron hoy. **El trabajo de la regla 1 son 24**:
13 que pueden ser vista y 11 que siguen siendo tabla pero deben leer `kepler_ods` en vez de las
réplicas por sucursal o el `mart`.

## 1. Cómo se midió

- **Qué corre:** los pasos activos de `database/importers/kepler/run-prod-feeds.js` (sin comentar),
  `ops/vl/crontab.feeds` y `ops/k3s/*.yaml`.
- **Qué late:** `analytics.v_feed_step_health` y `analytics.cron_runs` en `pg-prod`, de sólo lectura,
  verificado por `system_identifier`. El costo es `corridas × seg_p50` en la ventana de 30 días.
- **Qué hace cada uno:** lo leyeron tres agentes en el código (cabecera **y** SQL), con la misma
  rúbrica: de dónde lee, qué escribe, naturaleza, bajas, lectores y qué decisión de dinero alimenta.
  ⚠️ **Lo que viene sólo de esa lectura es una lectura de código, no una medición.** Lo verificado
  en prod se dice explícitamente.
- **Un escéptico funcionó una vez.** El agente dijo «`sales_monthly` sin lectores», y prod mostró
  2.9 M lecturas por índice. Desglosadas por índice, **todas caen en la PK** (son los upserts del
  propio importer); el índice por mes tiene 0 lecturas, y ninguna vista ni función la nombra. Se
  retiró con esa evidencia, no con la del agente.

## 2. Oleada 0 — hecha el 2026-11-05 (sólo el carril, ninguna tabla)

| Paso | Qué se hizo | Evidencia |
|---|---|---|
| `import-sales-monthly` | fuera del `nightly`; script borrado | sin lector en código, vistas ni funciones; lecturas sólo por PK |
| `wincaja/import-sales-by-vendor-monthly` | fuera del `nightly`; script borrado | la réplica de Wincaja ya no se mueve (WR.7); ~9 min por noche para `n_tup_upd = 0`. La tabla queda como foto fija y Thot la sigue leyendo |
| `wincaja/import-wincaja-caja-factor` | fuera del `nightly`; script borrado | su tabla no tiene lector (la reemplazó `v_warehouse_box_factor`) |
| `import-label-data` en `nightly` | quitado del `nightly` (sigue en `prices`, cada 30 min) | mismos argumentos; en el `nightly` escribía 0 cambios |
| `repoint-catalog-prices --solo-promo` en `nightly` | quitado del `nightly` (sigue en `prices`) | mismos argumentos y salida idéntica |

- **Se quedan a propósito:** `route-push-monthly` y `route-push-lines` también se repiten en el
  `nightly`. Pero `canindo-routes-monthly` sobrescribe la misma llave y el reconciliador de procedencia
  va detrás de los dos. Mover ese orden para ahorrar 23 s no vale el riesgo.
- **Ahorro esperado:** unos 9 min por noche, casi todo de `sales-by-vendor-monthly`.
- ⚠️ **No llega a prod hasta reconstruir y desplegar la imagen `ingesta`** (skill `entrega`). La
  medición de después es la duración de `feed_nightly` y la ausencia de esos 5 pasos en
  `v_feed_step_health` tras la primera noche desplegada.
- **Las tablas no se tocaron.** Borrar `analytics.sales_monthly` y `analytics.wincaja_product_box_factor`
  es la decisión D2.

## 2b. Oleada 1 — hecha el 2026-11-05 (prioridad 1, esfuerzo S; Edgar: «sigamos purgando los que afectan»)

En todos los casos el método fue el mismo: comparar en seco contra prod (conexión de sólo
lectura), con un control negativo que debe salir en rojo, y cambiar la fuente sólo si cuadraba.
Ninguna tabla se tocó. **Nada llega a prod hasta desplegar `ingesta`.**

| Item | Qué | Comparación (antes) | Lo que cambia |
|---|---|---|---|
| **CANON.5.1** `import-margin` | ODS en vez del POS de la `03` | 9,009/9,057 iguales. De los 48 distintos, 35 eran un **bug** (el mapa SKU→id elegía la fila borrada de un SKU repetido) y 13 no se explicaron al centavo (la réplica lógica coincide con el ODS) | esos 48 markups: ~0.2 % de la venta de 90 días |
| **CANON.5.2** `import-purchase-adjustments` | ODS (`sucursal='00'`) en vez del POS del CEDIS | 1,690/1,690 iguales, total al centavo; control en rojo | nada |
| **CANON.5.3** `import-auto-received` | ODS en vez de 9 POS; además un SAVEPOINT por sucursal | 12,860/12,860 folio×sku iguales en las 9; control en rojo | nada. El savepoint arregla un COMMIT que, si fallaba una sucursal, era un ROLLBACK silencioso |
| **CANON.5.4** `import-pos-ticket-sales` | ODS en una consulta (~2 s) en vez de 9 POS | 4,728/4,743 iguales; los 15 distintos son de hoy y con el ODS más alto (frescura); control en rojo | el día en curso llega más fresco |
| **CANON.5.5** `repoint-catalog-prices` | el modo seguro (sólo `is_promo`) pasa a ser el default; escribir precio exige `--escribir-precio` | — | nada en los carriles (H3 cerrado) |
| **CANON.5.6** `import-logistics-dims` | respeta lo borrado en la app (D3) | causa medida: «ZAMORA CANINDO», borrada el 12-oct | vuelve a correr; costo de las 3 semanas: 0 altas perdidas (H1 cerrado) |

**No ejercido, declarado:** el `--source=branch` de los cuatro (el `pg_hba` de los POS sólo
acepta `md`) y el camino de escritura de `margin` y `auto-received` (corre en la primera noche
desplegada). **El después:** tras esa noche, el dry-run de `import-margin` debe dar 0 cambios y
`import-logistics-dims` debe salir `ok` en `v_feed_step_health`.

`import-pos-ticket-sales` sigue siendo tabla: volverla vista pide borrarla (D2).

## 2c. Oleada 2 — respaldos que repetían al hop-2 (CANON.5.7, 2026-11-05)

El hop-2 de `services/feeds-ingest/apply-handlers.js` llama a las mismas funciones de
`ods-derived.js` cada vez que cambia `kdii`, `kdik` o `kdpv_prod_util`. El nocturno las volvía a
pasar sobre todos los SKUs. Medido en `analytics.cron_run_log` (30 días):

| Paso nocturno | Noches que escribieron | Decisión |
|---|---|---|
| `import-box-factor` | 1 de 33 (2 filas, 5-oct). El hop-2 escribió 516 filas en el mes | **retirado** |
| `import-reorder-policy` | 0 de 34 | **retirado** (misma ruta de código que box-factor) |
| `repoint-catalog-cost` | 2 de 33 (el 30-oct atrapó un costo que el hop-2 no vio) | se queda como red |
| `import-box-price` | la mayoría (depende de `factor_sale` de la app, que no dispara el hop-2) | se queda |
| `repoint-catalog-presence` | 1 de 29 | se queda |

De paso, `test-newdb-master-data-history.js` estaba rojo desde PURGA.P1 por un archivo borrado
(`import-kepler-prices`): la lista se corrigió.

## 2d. Oleada 3 — la velocidad de compra entra al plan (CANON.5.8, 2026-11-05)

`import-purchase-velocity` llenaba `analytics.purchase_velocity` una vez por noche, y su único
lector era `import-replenishment-plan`. El plan ahora deriva la velocidad en línea de
`analytics.stock_movements`, con el mismo cálculo y el mismo redondeo (~275 ms). El importer se
retiró; la tabla queda sin escritor (borrarla es D2).

Antes y después, comparando el plan COMPLETO de las dos versiones en prod (sólo lectura, 44,175
filas almacén×producto): 41,429 idénticas. Todas las diferencias se explican:
- **Frescura (181 productos):** compras registradas después de las 03:00. El plan del carril
  `stock` (cada 15 min) ahora las ve; antes usaba la foto de la noche.
- **Desempate (H13):** 189 productos empatan en la cantidad máxima comprada entre almacenes, y
  `primary_wh` (el almacén de compra) lo decidía el orden físico de las filas. Ahora a igual
  cantidad gana donde se compró más reciente.
- **`stock_pz` (84 filas):** existencia que se movió entre las dos corridas, no el cambio.

Control: la misma comparación sin clasificar los empates da 885 fuera de explicación, así que la
prueba sí distingue.

## 2e. Oleada 4 — la mensual por producto se vuelve rollup en línea (CANON.5.9, 2026-11-05)

`import-product-sales-monthly` era el rollup de `analytics.product_sales_daily` (Σ por
producto×almacén×mes, sólo productos del catálogo). Lectores medidos: `thot-build-features.js`
(nocturno) y `deactivate-legacy-skus.js` (manual); ninguna vista ni función de la base, y las
lecturas por índice eran los upserts del propio importer.

- **Thot** suma la diaria por mes en su consulta: 36,502 de 36,502 filas de `zone_demand`
  idénticas a la versión anterior; control con ventana de 11 meses en rojo (5,655 distintas).
- **`deactivate-legacy-skus`** ya exigía «sin venta diaria», y 0 productos de la mensual faltan
  en la diaria: la condición sobre la mensual era redundante y salió.
- **`test-newdb-product-sales-parity`** guardaba «mensual = rollup(diaria)», que sin escritor se
  pondría rojo al cerrar el mes. Ahora guarda lo que importa: **nadie lee la tabla congelada**
  (con prueba negativa). En su primera corrida atrapó dos textos que todavía nombraban la
  mensual. Su etiqueta en `run-all-tests.js` quedó vieja: ese archivo tiene cambios de otra sesión.

## 2f. Oleada 5 — repuntes y errores (2026-11-06; Edgar: «termina con todos los innecesarios o erróneos»)

Mismo método que la oleada 1: comparación en seco contra la tabla de prod (sólo lectura,
`system_identifier` verificado), cada diferencia clasificada y un control negativo en rojo. Lo que no
cuadró **no se repuntó**. Todos aceptan `--source=` para volver a la fuente vieja.

| Item | Qué | Comparación | Lo que cambia |
|---|---|---|---|
| **CANON.5.11** consolidado | `mart.refresh_si_cambio` por servidores `dblink_fdw` con keepalives y `statement_timeout` remoto; sin contraseña en el código | prueba de corte de red: 9 s contra colgado indefinido; prueba negativa 2 s | aplicado en md el 2026-11-06 |
| **CANON.5.12** `import-ap-findings` | POS → ODS + **H4**: se descarta el renglón ajeno sólo si existe idéntico en su base dueña | 1,135/1,154 proveedores iguales; las 19 son frescura (captura posterior al nocturno, por `kdm1.c68`) | 9 proveedores de la `03` bajan (H4 cerrado) |
| **CANON.5.13** `import-ledger-chain` | POS → ODS; la cadena se arma en orden estable | balanza 2,467/2,562 (95 frescura, 0 sin explicar); cadena 14,749/14,806, 44 desempates igual de válidos | la cadena deja de depender del orden físico |
| **CANON.5.14** `import-expenses-polizas` | POS → ODS; líneas numeradas por el renglón de Kepler (`c7`); un folio sin líneas en el ODS ya no borra las de la tabla | 19,459/19,459 presentes + 73 frescura; 4 filas toman un departamento que el ODS no borró | la numeración deja de cambiar cada noche |
| **CANON.5.15** `import-top-sellers-from-consolidado` | `mart` → `sales_daily` | top-100 idéntico; el `mart` contaba doble las rutas de Padre Hidalgo (base 01 + push) | `units_sold` en unidad canónica |
| **CANON.5.16** `import-route-push-monthly` | `mart` → Σ `route_push_lines`; en el carril las líneas van antes | las 77 ruta×mes ya existen y ninguna cambia | — |
| **CANON.5.18** `import-sales-by-route-monthly` | POS → ODS | 224/248; las 24 son noviembre con el ODS más alto | no toca H7 (escribe `UD…`, no `WIN-`) |
| **CANON.5.19** `import-product-sales-daily` | POS → ODS | 726,835/726,835 en 180 días | — |
| **CANON.5.21** `import-transfers-monthly` | POS → ODS | 1,070 filas iguales | ver D6 |
| **CANON.5.23** H12/H6 | una sola función de identidad (retail primero) para el hop-2 y `repoint-catalog-names` | 0 diferencias contra el barrido en 9,554 SKUs; la regla vieja del hop-2 da 6 en rojo | al desplegar: 1 nombre y 4 códigos de barras (gana el de las tiendas) |
| **CANON.5.24** H11 | el hop-2 firma `app.actor = 'hop2:<normalizador>'` y lo restaura | prueba nueva en `test-newdb-master-data-history.js`; dos mutantes en rojo | `master_data_history` deja de tener escrituras anónimas |
| **CANON.5.26** H9 + H9 bis | `import-sales-fact`: mapa SKU→id determinista, gana la fila viva; migración `20261106130742_sales_daily_reasigna_productos_borrados` | el mapa sin orden escribía la misma venta a nombre de las dos filas del SKU: ~0.02 % de la venta del periodo contada doble | la migración borra las copias y reasigna el resto; **va DESPUÉS de desplegar la imagen** |

⚠️ **Corrección a CANON.5.26 (aplicada el 2026-11-06 13:47):** el «antes» medía **10** filas vivas
con valor distinto; la migración corrigió **873**. La medición comparó sólo el importe y las
unidades, pero el paso 1 compara 9 columnas (costo, tickets y el modelo de unidades además) y copia
las 9. Las 863 de más tenían el mismo importe —el total se movió sólo por las 10— pero recibieron el
costo y el modelo de unidades calculados con el producto BORRADO (`import-sales-fact` toma el markup
y el modelo del producto al que asigna la venta). Que «la más reciente gana» no vale para esas
columnas: el producto correcto es el vivo. **Se corrige solo:** el nocturno recalcula 13 meses desde
la fuente con el mapa nuevo, y las copias empiezan el 2025-10-10, dentro de la ventana. Lección:
medir la condición EXACTA que ejecuta el SQL, no una parecida.

**No se repuntaron, con la causa medida:**
- `import-rotation-from-consolidado`: su `u90` está en pieza suelta (`units × factor_sale`); `sales_daily`
  no, y 3,085 SKUs difieren de 10× a 94×. Pide pasarle su modelo de unidades.
- `import-kardex`: 3 mermas reales de la `06` cuya cabecera llegó al ODS y su renglón `kdij` no
  (el hueco de OBS.15.9, que estaba registrado sólo para la `00`). Repuntar perdería mermas.
- `import-pos-cashiers`: el ODS tiene `kdpv_kdku` pero no recoge las ediciones de nombre (6 de 1,359).
- `import-supplier-params` (H5): ver D5.

**Lo que sigue sin esto (declarado):** las VISTAS que exigen borrar la tabla (`cash-sessions`,
`box-price`, `pos-ticket-sales`) esperan D2; `branch-stock-live` (~40 lectores) y `sales-fact` /
`customer-sales` (D4) son trabajo de fase. Los huecos viejos del `kdm2`/`kdij` del ODS (bases 00, 01,
06 y 08, antes del 26-oct) no tienen relleno y pegan a otros lectores además de éstos.

**NO MEDIDO:** el camino `--apply` de los repuntados (corre en la primera noche desplegada) y el
`--source=branch` (los POS sólo aceptan a md). La migración de CANON.5.26 sólo se ejerció en una base
desechable.

## 3. Los 51, clasificados

**Leyenda.** **Lee:** `ods` = `kepler_ods` · `réplicas` = bases `md_*` por sucursal · `mart` = el
consolidado (`mart.ventas*`) · `prod` = tablas de prod de segundo nivel. **Veredicto:** VISTA ·
MATVIEW (por costo, refrescada por evento) · REPUNTAR (sigue tabla, pero lee `kepler_ods`) ·
SE QUEDA · RETIRADO.

### 3.1 Retirados hoy (3)
`import-sales-monthly` · `import-sales-by-vendor-monthly` · `import-wincaja-caja-factor` (ver §2).

### 3.2 Se quedan como tabla, con razón (24)

| Importer | Lee | Por qué es tabla legítima |
|---|---|---|
| `import-sales-stats` | prod | cálculo (ABC por Pareto) sobre `sales_daily` |
| `import-demand-clean` | prod | modelo de demanda; numerador del sugerido |
| `import-sales-by-channel` | réplicas | **árbitro independiente** de `income_entries_src` (VERDAD_ABSOLUTA): repuntarlo al ODS lo vuelve espejo |
| `import-sales-boxes-monthly` | prod | cálculo de cajas con el resolvedor de factor de la app |
| `import-canindo-routes-monthly` | wincaja + mart | une dos eras; el push de camionetas no está en el ODS |
| `import-route-push-lines` | mart | única entrada del push a prod (comisiones) |
| `import-label-data` | ods | catálogo con RLS, filas `manual` y aviso TDA.8 |
| `import-product-barcodes` | ods + wincaja | catálogo con RLS y soft-delete (la rama Wincaja se puede congelar) |
| `import-brands-lineas` | ods | altas sobre un catálogo curado a mano |
| `import-kepler-suppliers` | ods | catálogo con RLS que normaliza y fusiona |
| `repoint-catalog-cost` | ods | regla de negocio (mediana retail con tope) sobre catálogo con RLS |
| `repoint-catalog-names` | ods | catálogo con RLS (ver hallazgo H6) |
| `repoint-catalog-presence` | ods | da de alta productos nuevos (operativa) |
| `repoint-catalog-prices --solo-promo` | ods | único escritor de `is_promo` (ver hallazgo H3) |
| `import-replenishment-plan` | prod + ods | cálculo del pedido |
| `import-stock-movements` | ods | ya lee el ODS; comparte la tabla con el escritor Wincaja (`W%`) |
| `import-reorder-policy` | ods | catálogo con RLS compartido con `computed` y `manual` |
| `import-computed-reorder` | prod | stock de seguridad por nivel de servicio |
| `import-network-reorder` | prod | DRP multi-escalón |
| `import-replenishment-cadence` | prod | cálculo de cadencia (con una topología fija en el código) |
| `import-demand-acceleration` | prod | Welch-Z |
| `import-inventory-health` | prod + vista ods | cálculo de σ/CV y cobertura |
| `import-supplier-params` | prod | cálculo sobre catálogo con RLS (ver hallazgo H5) |
| `import-logistics-dims` | ods | operativa: la app y el GPS escriben las mismas tablas (**roto**, H1) |

> Dos de estos son **costo, no regla 1**, y van aparte (regla 15: optimizar no se mezcla con cambiar
> alcance): `import-stock-movements` gastó **~45 h de base en 30 días** (21.5 min por corrida, cada
> hora) e `import-replenishment-plan` **~23 h**. Son los más caros del carril, con diferencia.

### 3.3 La deuda de la regla 1 (24), por prioridad

> **Al 2026-11-06** la tabla de abajo es el inventario del 11-05. Ya repuntados en la oleada 5 (§2f):
> `ap-findings`, `ledger-chain`, `expenses-polizas`, `top-sellers`, `route-push-monthly`,
> `sales-by-route-monthly`, `product-sales-daily`, `transfers-monthly`. No repuntados con causa medida:
> `rotation`, `kardex`, `pos-cashiers`.

Prioridad = dinero en juego × esfuerzo ([criterios del PM](../../../.claude/skills/pm/references/criterios.md) §1).
⚠️ **El monto en pesos NO SE MIDIÓ en ningún renglón.** «Alto» sale de la clase («una cifra con la que
se decide dinero: margen, pagos, precios»), no de un monto.

| Pri | Importer | Lee hoy | Veredicto | Dinero | Esf. | Por qué |
|---|---|---|---|---|---|---|
| ✅ | `import-margin` | ~~réplica de una sola sucursal~~ ods | REPUNTAR | Alto | S | **CANON.5.1** — el costo de `sales_daily` sale de este markup → margen |
| ✅ | `import-purchase-adjustments` | ~~réplica CEDIS~~ ods | REPUNTAR | Alto | S | **CANON.5.2** — notas de crédito y devoluciones a proveedor (ver H10) |
| ✅ | `import-auto-received` | ~~réplicas~~ ods | REPUNTAR | Alto | S | **CANON.5.3** — cierra las OC abiertas → obligaciones de pago |
| 🟡 | `import-pos-ticket-sales` | ~~réplicas~~ ods | VISTA | Alto | S | **CANON.5.4** repuntado; la vista espera D2 |
| **1** | `import-ap-findings` | réplicas | REPUNTAR | Alto | M | saldo y DPO por proveedor (y H4) |
| **1** | `import-ledger-chain` | réplicas | REPUNTAR | Alto | M | balanza para impuestos provisionales y P&L |
| **1** | `import-expenses-polizas` | réplicas + ods | REPUNTAR | Alto | M | P&L de egresos, rentabilidad de ruta |
| 2 | `import-branch-stock-live` | réplicas | VISTA (ADR-055) | Alto | L | la copia cuadra 91 % contra el POS; `v_erp_stock_on_hand` ya cuadra 100 %. ~40 lectores |
| 2 | `import-sales-fact` | mart + réplicas | REPUNTAR (CANON.2.1) | Alto | L | base del costo, la demanda y el sell-out; el push no está en el ODS |
| 2 | `import-kardex` | réplicas | VISTA | Medio | S | mermas en la conciliación; 2 lectores |
| 2 | `import-purchase-velocity` | prod | VISTA o CTE dentro del plan | Medio | S | su único lector es `import-replenishment-plan` |
| 3 | `import-cash-sessions` | ods | VISTA | Bajo | S | sólo tablero (cajas abiertas), pero arregla H2 |
| 3 | `import-pos-cashiers` | réplicas | VISTA (si `kdpv_kdku` está en el ODS: NO DETERMINADO) | Bajo | S | nombre del cajero en el faltante |
| 3 | `import-transfers-monthly` | réplicas | VISTA | Bajo | S | `/logistica/traspasos`; 1 lector |
| 3 | `import-product-sales-monthly` | prod | VISTA sobre la diaria | Bajo | S | sólo la lee Thot |
| 3 | `import-top-sellers-from-consolidado` | mart | REPUNTAR a `sales_daily` | Bajo | S | orden del portal por popularidad |
| 3 | `import-route-push-monthly` | mart | REPUNTAR a `route_push_lines` | Bajo | S | es la suma de una tabla que ya está en prod |
| 3 | `import-box-factor` | ods | VISTA | Medio | M | la vista `v_product_box_factor` ya lee el ODS: la tabla sobra |
| 3 | `import-box-price` | ods + catálogo | VISTA | Medio | M | hay que recrear las vistas que dependen de ella |
| 3 | `import-expense-requests` | ods | VISTA | Medio | M | comparte tabla con `ap-findings` (UNION por tipo) |
| 3 | `import-sales-by-route-monthly` | réplicas | REPUNTAR | Medio | M | 3 escritores en la misma tabla (H7) |
| 3 | `import-rotation-from-consolidado` | mart | REPUNTAR | Medio | M | escribe `catalog.products` (RLS) por UPDATE |
| 4 | `import-product-sales-daily` | réplicas | MATVIEW (o retirar a favor de `sales_daily`) | Bajo | M | reporte semanal |
| 4 | `import-customer-sales` | mart | MATVIEW (depende de CANON.2.1) | Bajo | M | RFM / customer-360 |

**Cómo se parte la L de dinero Alto:** el pedazo S de `branch-stock-live` es retirar el importer de
**un** lector crítico a la vez, empezando por el que decide pedidos (`order-stock.service.ts`).
`sales-fact` no tiene pedazo S hasta decidir qué hacer con el push (D4).

## 4. Hallazgos (lectura de código; lo que dice «medido» está medido)

- **H1 — `import-logistics-dims` está roto desde el 12-oct** (medido: 23 fallas en 29 noches; el
  último resumen dice `duplicate key … logistics_routes_tenant_name_unique`). Causa probable en el
  código: los índices únicos (`tenant_id, name` y `tenant_id, plate`) incluyen las filas borradas,
  pero el importer sólo busca las vivas. Una ruta borrada en la app que Kepler sigue trayendo se
  vuelve a insertar, choca y hace ROLLBACK de vehículos, choferes y rutas a la vez. **No se vio**
  porque el `nightly` sólo marca error si fallan todos sus pasos. Arreglarlo es S, pero pide D3.
- ✅ **H2 — `import-cash-sessions` tenía fijos los códigos `01`–`05`** (cerrado en CANON.5.10).
  Medido el 2026-11-05: Canindo, Morelia Madero y Morelia Abastos tenían 11 cajas abiertas en el
  ODS que `/tienda/cajas` no mostraba; la `00` no tiene cajas. Ahora lee todas las sucursales del
  mapa único (dry-run: 113 sesiones y 23 abiertas, igual que el ODS).
- **H3 — `repoint-catalog-prices` sin bandera vuelve a sincronizar el precio.** En los carriles corre
  con `--solo-promo`, pero quien lo lance a mano sin ella escribe `commercial.product_prices` y
  deshace los rechazos de `ods-derived`. Es una mina: el modo por defecto debería ser el seguro. S.
- **H4 — `import-ap-findings` cuenta doble, poco** (medido el 2026-11-05 en el ODS, 12 meses,
  cuenta 201): sólo la base de la `03` trae movimientos con `c14` de otra sucursal, 41 por unos
  $0.68 M, alrededor del 0.1 % de las compras del año, aunque infla ~2.6 % el auxiliar de la `03`.
  **29 de esos 41 también están en su base dueña** (duplicado real); los otros 12 sólo existen ahí.
  Un filtro `c14 = propia` como el de `ledger-chain` perdería esos 12: el arreglo es deduplicar
  contra la base dueña, y se hace al repuntarlo al ODS (item M de prioridad 1).
- **H9 bis — el arreglo de H9 no es chico:** si `sales-fact` empieza a escribir a nombre de la fila
  viva, las filas viejas a nombre de la borrada siguen en `sales_daily` y la venta se cuenta doble.
  Requiere una migración que reasigne esas filas en el mismo cambio.
- **H5 — `import-supplier-params` sólo llena columnas en NULL**, así que lo que deriva una vez no
  vuelve a refrescarse nunca.
- **H6 — Reglas opuestas sobre el mismo producto.** El hop-2 (`normalizeProductsFromOds`, en
  `services/feeds-ingest/apply-handlers.js`) da de alta y renombra con CEDIS primero y el `c7` crudo;
  `repoint-catalog-names` y `presence` usan retail primero. El código de barras lo escriben tres
  caminos, contra la regla de CANON.1.3b («un solo escritor: `import-label-data`»).
- **H7 — `analytics.sales_by_route_monthly` tiene 3 escritores**, y dos de ellos (`route-push-monthly`
  cada hora con GREATEST, `canindo-routes-monthly` de noche con sobrescritura) escriben la misma
  llave (`06`, `WIN-50N`, mes).
- **H9 — `import-sales-fact` arma el mismo mapa SKU→id que tenía `import-margin`** (incluye las
  filas borradas de los 887 SKUs repetidos). Medido: en 90 días, 31 productos borrados reciben
  venta en `sales_daily`, alrededor del 0.07 % del total. Chico, pero esa venta no aparece en la
  ficha del producto vivo.
- **H10 — `analytics.erp_purchase_adjustments` sólo lee el CEDIS.** Las bases de las sucursales
  01–08 tienen **487 ajustes X-D-40/55 propios en 2026** que la tabla nunca leyó. Su monto **NO
  está validado**: en las sucursales `c16` no parece significar lo mismo (147 ajustes de la 01
  suman casi lo mismo que los 1,690 del CEDIS). Ampliar el universo es cambio de alcance.
- **H11 — El hop-2 escribe datos maestros sin declarar actor.** `services/feeds-ingest/` no llama
  a `declararActor`: lo que escribe en `catalog.products`, `commercial.reorder_policy` y demás
  queda en `analytics.master_data_history` como anónimo.
- **H12 — H6 está activo, pero es UN producto** (diagnosticado el 2026-11-05 con
  `analytics.master_data_history`). Cada noche `repoint-catalog-names` (retail primero) pone
  «AGUA DOÑA VITA 500M/ 1 ZORRO» a las ~03:28, y entre 03:32 y 03:47 el hop-2 (sin actor, CEDIS
  primero) lo regresa a «\*\*\*DESC DOÑA VITA 500 ML / 1 ZORRO», el nombre que el CEDIS le dio al
  descontinuarlo. Mismo producto las 4 noches medidas. Se arregla aplicando CANON.1.3 (retail
  primero) **en el hop-2**, que se despliega con los carriles del ODS.
  ⚠️ **Corrección:** este hallazgo decía que `import-product-barcodes` escribía en 953 de 1,417
  corridas. Era cierto **hasta el 29-oct** (4–5 cambios en cada media hora desde el 6-oct); desde
  el 30-oct está en 0 salvo algún cambio aislado. El promedio de 30 días escondía que ya se había
  resuelto.
- **H13 — El almacén de compra del plan era una moneda al aire para 189 productos** (ver §2d).
  Cerrado en CANON.5.8 con un desempate determinista.
- **H8 — Duplicados de significado**: `product_sales_daily` contra `sales_daily` (otro linaje),
  `stock_ledger` contra `stock_movements`, y `transfers_monthly` contra los traspasos de
  `stock_movements`.

## 5. Lo que `FASE_CANON_INGESTA.md` decía y ya no es cierto

| Decía | Hoy (código del 2026-11-05) |
|---|---|
| CANON.3.2 y 3.3: falta repuntar `stock-movements`, `reorder-policy`, `logistics-dims`, `box-factor`, `box-price`, `brands-lineas`, `kepler-suppliers` | **los 7 ya leen `kepler_ods`**. De ese lote, sólo `import-margin` sigue leyendo una réplica |
| CANON.3.1: repuntar `sales-by-channel` | **no se repunta**: es el árbitro independiente de `income_entries_src`, y repuntarlo lo vuelve espejo |
| CANON.2.1: `mart.ventas_enriched` → vista sobre el ODS | **no completo**: `mart.ventas` trae el push de las camionetas, que el ODS no replica. Son 7 los lectores del mart, no 6 |
| CANON.4: `label-prices` como vista | **no puede ser vista**: tiene RLS, filas `manual` y aviso. `box-factor` y `box-price` sí pueden serlo, aunque las dos borran filas |
| CANON.3.2: `product-sales-monthly` lee las sucursales | desde AUD-DAT.10 es un rollup de la diaria |
| Límite 1 (el ODS no propaga borrados) frena las vistas | no frena a `kardex`, `purchase-adjustments`, `transfers-monthly` ni `auto-received`: ninguno borra hoy |

## 6. Decisiones (firma Edgar)

- ✅ **D1 — resuelta (Edgar, 2026-11-05: «sigamos purgando los importers que afectan»).** Se
  hicieron los S; las M de prioridad 1 siguen esperando cupo. Texto original:
  **¿Excepción al cupo para los 4 items S de prioridad 1?** (`margin`, `purchase-adjustments`,
  `auto-received`, `pos-ticket-sales`) más H1 y H3. **Recomendación: sí, como «parar el sangrado»,
  sin abrir la fase.** Cada uno es ≤ 1 día, repunta un SRC con comparación en seco antes y después
  (método CANON), y toca números con los que se decide dinero. Las M de prioridad 1 esperan cupo.
- **D2 — ¿Se borran `analytics.sales_monthly` y `analytics.wincaja_product_box_factor`?**
  **Recomendación: sí, pero dentro de 30 días**, y sólo si sus índices de lectura siguen en 0.
  `sales_by_vendor_monthly` se queda como foto fija, porque Thot la lee.
- ✅ **D3 — resuelta por el PM técnico con la recomendación** (es reversible y conservadora: no
  revive nada). Edgar puede revertirla. Pregunta original: **Una ruta o un vehículo que se borró
  en la app pero Kepler sigue trayendo: ¿se queda borrado o se revive?** **Recomendación: se queda borrado.** Lo decidió una persona en la app; el importer lo
  salta y lo declara en su resumen. Es lo que desbloquea H1.
- **D4 — El push de las camionetas: ¿se replica al ODS o sigue como única fuente en el `mart`?**
  Decide si `sales-fact` y `customer-sales` pueden terminar de repuntarse. **Recomendación: que siga
  en el `mart` hasta que el proyecto de camionetas (`route-push`) se estabilice.**

- **D5 — Parámetros de proveedor (H5): ¿se marca qué valor es manual?** Medido el 2026-11-06: de 290
  proveedores derivables, 260 tienen hoy al menos un valor distinto del que se derivaría (cadencia,
  colchón, mínimos). El importer sólo llena NULL porque la app los edita sin `updated_by` y no hay
  historia: no se sabe qué capturó una persona. **Recomendación:** una columna de procedencia
  (`derivado`/`manual`) por migración, que la app marque `manual` al editar, y que el importer refresque
  sólo lo derivado.
- **D6 — `analytics.transfers_monthly` (CEDIS, salida) está inflada ~10 % en el primer semestre.** El
  catálogo de destinos `kdud` se renombró y el upsert GREATEST nunca retira el renglón con el nombre
  viejo: el mismo documento queda bajo dos destinos. **Recomendación:** volverla vista sobre el ODS
  (junto con D2); mientras, una corrida con `--reset`.

## 7. Qué NO incluye este anexo

- Las fuentes que no son Kepler: ContPAQi (5), CAOS, Caja General en SISTEMAS y relojes checadores.
  Cada una es la única replicación de su sistema.
- La optimización de costo de `import-stock-movements` e `import-replenishment-plan` (va aparte).
- Los 2 backfills de `warehouse_id`. Siguen trabajando: medido el 2026-11-05, hay 2,949 renglones de
  `gl_poliza_lines`, 23 de `gl_polizas` y 34 de `blind_counts` sin almacén.
- `import-route-stock` e `import-route-collections`: sin agenda, pendientes de Edgar desde RD.32/RC.4.
