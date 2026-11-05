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

Prioridad = dinero en juego × esfuerzo ([criterios del PM](../../../.claude/skills/pm/references/criterios.md) §1).
⚠️ **El monto en pesos NO SE MIDIÓ en ningún renglón.** «Alto» sale de la clase («una cifra con la que
se decide dinero: margen, pagos, precios»), no de un monto.

| Pri | Importer | Lee hoy | Veredicto | Dinero | Esf. | Por qué |
|---|---|---|---|---|---|---|
| **1** | `import-margin` | réplica de una sola sucursal | REPUNTAR | Alto | S | el costo de `sales_daily` sale de este markup → margen |
| **1** | `import-purchase-adjustments` | réplica CEDIS | REPUNTAR | Alto | S | notas de crédito y devoluciones a proveedor → pagos y margen |
| **1** | `import-auto-received` | réplicas | REPUNTAR | Alto | S | cierra las OC abiertas → obligaciones de pago |
| **1** | `import-pos-ticket-sales` | réplicas | VISTA | Alto | S | cuadre del corte de caja contra tickets |
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
- **H2 — `import-cash-sessions` tiene fijos los códigos `01`–`05`**: deja fuera las cajas de las
  sucursales `00`, `06`, `07` y `08`. NO MEDIDO en prod.
- **H3 — `repoint-catalog-prices` sin bandera vuelve a sincronizar el precio.** En los carriles corre
  con `--solo-promo`, pero quien lo lance a mano sin ella escribe `commercial.product_prices` y
  deshace los rechazos de `ods-derived`. Es una mina: el modo por defecto debería ser el seguro. S.
- **H4 — `import-ap-findings` podría contar doble**: no filtra `c14 = sucursal propia`, y
  `import-ledger-chain` sí lo hace. NO MEDIDO.
- **H5 — `import-supplier-params` sólo llena columnas en NULL**, así que lo que deriva una vez no
  vuelve a refrescarse nunca.
- **H6 — Reglas opuestas sobre el mismo producto.** El hop-2 (`normalizeProductsFromOds`, en
  `services/feeds-ingest/apply-handlers.js`) da de alta y renombra con CEDIS primero y el `c7` crudo;
  `repoint-catalog-names` y `presence` usan retail primero. El código de barras lo escriben tres
  caminos, contra la regla de CANON.1.3b («un solo escritor: `import-label-data`»).
- **H7 — `analytics.sales_by_route_monthly` tiene 3 escritores**, y dos de ellos (`route-push-monthly`
  cada hora con GREATEST, `canindo-routes-monthly` de noche con sobrescritura) escriben la misma
  llave (`06`, `WIN-50N`, mes).
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

- **D1 — ¿Excepción al cupo para los 4 items S de prioridad 1?** (`margin`, `purchase-adjustments`,
  `auto-received`, `pos-ticket-sales`) más H1 y H3. **Recomendación: sí, como «parar el sangrado»,
  sin abrir la fase.** Cada uno es ≤ 1 día, repunta un SRC con comparación en seco antes y después
  (método CANON), y toca números con los que se decide dinero. Las M de prioridad 1 esperan cupo.
- **D2 — ¿Se borran `analytics.sales_monthly` y `analytics.wincaja_product_box_factor`?**
  **Recomendación: sí, pero dentro de 30 días**, y sólo si sus índices de lectura siguen en 0.
  `sales_by_vendor_monthly` se queda como foto fija, porque Thot la lee.
- **D3 — Una ruta o un vehículo que se borró en la app pero Kepler sigue trayendo: ¿se queda borrado
  o se revive?** **Recomendación: se queda borrado.** Lo decidió una persona en la app; el importer lo
  salta y lo declara en su resumen. Es lo que desbloquea H1.
- **D4 — El push de las camionetas: ¿se replica al ODS o sigue como única fuente en el `mart`?**
  Decide si `sales-fact` y `customer-sales` pueden terminar de repuntarse. **Recomendación: que siga
  en el `mart` hasta que el proyecto de camionetas (`route-push`) se estabilice.**

## 7. Qué NO incluye este anexo

- Las fuentes que no son Kepler: ContPAQi (5), CAOS, Caja General en SISTEMAS y relojes checadores.
  Cada una es la única replicación de su sistema.
- La optimización de costo de `import-stock-movements` e `import-replenishment-plan` (va aparte).
- Los 2 backfills de `warehouse_id`. Siguen trabajando: medido el 2026-11-05, hay 2,949 renglones de
  `gl_poliza_lines`, 23 de `gl_polizas` y 34 de `blind_counts` sin almacén.
- `import-route-stock` e `import-route-collections`: sin agenda, pendientes de Edgar desde RD.32/RC.4.
