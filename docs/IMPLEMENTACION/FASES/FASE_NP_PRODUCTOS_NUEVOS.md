# Fase NP — Productos nuevos (seguimiento a 30, 60 y 90 días)

> Estado: 🧪 **EN CÓDIGO Y PROBADO EN LOCAL** · 2026-10-07 · sin push, sin PR, nada aplicado a prod.
> Pantalla: `/compras/catalogo/nuevos` (pestaña **Productos nuevos** del Catálogo de Compras) +
> etiqueta "Nuevo · día N" en `/compras/catalogo`. Segunda entrega el mismo día: **recomendación de
> recompra**, **en vivo** y **detalle por sucursal** (ver al final).

## Por qué

Pedido de Compras: *"cuando se da de alta un producto nuevo hay que agregarle una etiqueta de producto
nuevo para dar seguimiento a 30, 60 y 90 días, ver su desempeño y recompra, y tener KPIs para revisar la
inversión y el retorno que tenemos al catalogar nuevos códigos"*.

Antes no existía nada: el alta ocurre en Kepler, la pestaña Solicitudes del Catálogo es un marcador
de posición, y lo único parecido era la categoría *innovation* de las recomendaciones, que usa
`products.created_at` (la fecha en que la Suite cargó el producto, no la del alta).

## Decisiones (y por qué)

| # | Decisión | Por qué |
|---|---|---|
| 1 | **La etiqueta se deriva, no se captura** (matvista `analytics.mv_new_products`). | Regla principal: cero importers. Nadie tiene que acordarse de etiquetar. |
| 2 | **El reloj arranca en la primera actividad** (primera entrada o primera venta), no en el alta. | Un código que se da de alta y llega 3 semanas después se vería como fracaso a los 30 días sin haber estado en el anaquel. |
| 3 | **`created_at` no decide qué es nuevo.** Sólo cuenta para "dado de alta, sin movimiento", y sólo si entró desde Kepler y no en una carga masiva. | Medido en la base local: la carga inicial le puso fecha de junio a 7,963 productos. La fecha de alta de Kepler vive en alguna de `kdii.c50/c56/c60/c64/c65/c75`, sin decodificar → `[NP.0]`. |
| 4 | **Carga masiva = día con ≥ 50 altas en la Suite.** | Medido en local: los días de alta a goteo tienen hasta 23; las cargas arrancan en 59. Sin el corte, 1,821 códigos muertos salían como "dados de alta sin recibir"; con él, 116. Se vuelve a medir en prod. |
| 5 | **"No medible" se mide POR FUENTE** (tienda Kepler, ruta, Wincaja, entradas): hacen falta 90 días de historia antes de la primera actividad en cada fuente donde aparece el producto. | Las fuentes no arrancan juntas (en local: tienda desde el 21-sep, ruta desde el 1-jul). Con un "desde" global se afirmaría "antes no se vendía" donde no hay historia. |
| 6 | **Recompra = segunda entrada en una plaza que ya lo había recibido.** | La primera entrada en varias plazas es surtido inicial, no recompra. La recompra del CLIENTE no se mide: el mostrador es anónimo (~1.4 % de la venta de tienda tiene cliente identificado). |
| 7 | **Decisiones en pesos y sin margen; cantidades en la unidad de Kepler.** | Entrada y venta pueden venir en peldaños distintos (caja/paquete/pieza): para decidir se usan pesos. Las cantidades se MUESTRAN como Kepler las registró (`NP.11`), cada rótulo por su lado, sin convertir ni sumar entre sí. El costo del hecho de venta es álgebra sobre el markup (ADR-051): publicarlo como retorno sería inventar. |
| 8 | **Inversión sin entrada en Kepler = NULL ("no medida"), nunca 0.** "Venta por cada $1 invertido" usa el MISMO universo arriba y abajo. | El CEDIS fue Wincaja hasta el 30-sep, y las plazas 01/02/06 antes de pasar a Kepler. Un 0 daría retorno infinito o un fracaso falso. |
| 9 | **El costo viaja sólo con `COMPRAS_COSTO_ESTANDAR_VER`** (o admin), y se quita en el SERVIDOR antes de agregar. | Mismo criterio que la pestaña Costos (`[CAT-COSTO.4]`). Ocultarlo en pantalla no lo protege. |
| 10 | **Compras confirma qué es cada código** (`catalog.new_product_reviews`): nuevo / recodificación / promoción / no mercancía. La decisión humana manda sobre la automática. | Un código nuevo no siempre es un producto nuevo. El sistema sólo propone (DESC, promoción, descontinuado, mismo código de barras que uno más viejo). |
| 11 | **Materializada, refresco nocturno** (06:20 MX, `AnalyticsRefreshService`, latido `analytics_refresh_new_products` con umbral en `CRON_JOBS`). Nace `WITH NO DATA`. | La primera actividad exige recorrer toda la historia; no cabe en el gate de 1 s. El primer poblado va de noche, no al desplegar. |

## Lo construido

| Item | Qué | Estado |
|---|---|---|
| `[NP.0]` | Decodificar la fecha de alta de Kepler (`kdii.c50…c75`) contra prod; re-medir el umbral de carga masiva; medir el refresco y el gate de 1 s con volumen real; medir qué parte de las entradas `XA2001` declara su caja (`c55/c56` con identidad que cierra). | ⬜ requiere acceso de lectura a prod |
| `[NP.1]` | Mig `20261007200000_np_mv_new_products.js` — matvista + índice único + grants. | 🧪 aplicada en local |
| `[NP.2]` | `libs/commercial/.../new-products.ts` (lógica pura) + `new-products.service.ts` + 2 endpoints en `commercial-products.controller.ts` (`GET new-products`, `PUT new-products/:id/classification`) + refresco nocturno + umbral en `db-health`. | 🧪 |
| `[NP.3]` | Candado `database/tests/test-newdb-new-products.js` sobre el escenario `database/tests/_lib/new-products-scenario.js` + demo `database/scripts/seed-local-new-products-demo.js` (`--undo`). | 🧪 |
| `[NP.4]` | Mig `20261007200100_np_new_product_reviews.js` — clasificación de Compras (RLS forzado, auditoría completa, soft-delete). | 🧪 aplicada en local |
| `[NP.5]` | Pestaña `compras-catalogo-nuevos.component.ts` + `productos-nuevos.service.ts` + etiqueta en la lista de Productos. | 🧪 |
| `[NP.6]` | Umbrales y veredicto (en `analytics.kpi_thresholds`, nacen vacíos → "sin meta") + hitos 30/60/90 **congelados** en tabla propia. | ⬜ |
| `[NP.7]` | Alta solicitada en la app (pestaña Solicitudes) con inversión y meta planeadas → plan contra real. | ⬜ decisión de proceso |
| `[NP.8]` | **En vivo**: función `analytics.fn_new_products_movimientos(tenant, skus, desde, hasta)` (venta y entradas desde el ODS; desde `NP.11` vive en la mig `20261007200000` porque la matvista la usa para su historia) + índice `ix_kdm1_compra_fecha` (mig `20261007200200`). La matvista guarda SERIES hasta el corte. | 🧪 aplicada en local |
| `[NP.9]` | **Recomendación de recompra** global y por sucursal (`recomendar` + `CRITERIO_RECOMPRA`) + `GET new-products/:id` (comportamiento por sucursal). | 🧪 |
| `[NP.10]` | **Rediseño**: respuesta arriba, filtros por recomendación, venta por semana en cada fila, panel lateral por sucursal, refresco solo cada minuto. | 🧪 |
| `[NP.11]` | **Unidades de Kepler**: lo vendido y lo recibido en la unidad que declara el renglón (cajas, paquetes, piezas, gramaje), global y por sucursal; la existencia en la unidad base de la ficha de cada sucursal con su equivalente en la unidad mayor. | 🧪 |

## Medido (base local, 2026-10-07)

- Refresco de la matvista: **8.9 s → 0.49 s** al pasar la señal de recodificación de `EXISTS` por renglón (no se podía volver semi-join en la lista de salida: 3,350 × 14,800 comparaciones) a un agregado por código de barras. `REFRESH CONCURRENTLY`: 0.28 s.
- API: `GET /commercial/products/new-products` **0.09–0.15 s**.
- Candado de base: **102 ✓ / 0 ✗**, y con la regla de recompra rota a propósito **98 ✓ / 4 ✗** (justo las 4 de recompra).
- Unitarias: lógica pura **20/20** (rota a propósito: 2 rojas), componente **12/12**, pestañas **7/7**; suite de Compras **308/308**.
- Compuertas: `check-css-tokens --todo` 731 componentes sin tokens inexistentes; `check-primeng-api` sin API retirada nueva.

## Hallazgos

- ⭐ **`v_sellout_daily` toma la venta de Kepler de cada plaza sólo desde que esa plaza pasó a Kepler**: 01 desde el 1-jul-2026, 02 desde el 1-oct-2025, 06 desde el 15-ago-2026 (antes, su verdad es Wincaja). La primera versión del escenario sembró venta de Kepler en la 01 en junio y la vista la descartó, correctamente. Por eso la historia se mide por fuente.
- ⚠️ **La sesión de VS Code exporta `NX_WORKSPACE_ROOT_PATH` apuntando al checkout principal.** Un `nx serve` lanzado desde un worktree compila **el código del checkout principal**, sin avisar. Para servir un worktree: `env -u NX_WORKSPACE_ROOT_PATH NX_NO_CLOUD=true …` (con la variable apuntando al worktree, Nx Cloud revienta resolviendo `\\?\C:\…`). Las pruebas con Vitest no se ven afectadas (resuelven la raíz por `__dirname`).

## Para llevarlo a prod

1. Aplicar las 3 migraciones **una por una** (`apply-one-migration-prod.js`), fuera de horario. La
   `20261007200000` crea la función y la matvista (`WITH NO DATA`, no recorre nada). La
   `20261007200200` crea `ix_kdm1_compra_fecha` CONCURRENTLY sobre `kdm1` (493 MB): no bloquea, pero tarda.
   La pantalla usa además `analytics.v_kepler_unit_ladder` (mig `20260915120000`, ya en prod por la Fase CE).
2. Redeploy api + view. La pestaña dirá "todavía no se calculan" hasta el primer lote nocturno (06:20).
3. Re-login no hace falta: no hay permisos nuevos.
4. Antes de publicar cifras: `[NP.0]`.

---

## Segunda entrega (2026-10-07): recomendación, en vivo y por sucursal

Pedido: *"que nos diga, en base a las ventas, si es beneficio comprarlo de nuevo; todo con datos en
vivo; el diseño más amigable; en la vista previa su comportamiento global y al darle clic, en cada
sucursal"*.

### Qué significa "en vivo" aquí, medido

| Dato | De dónde | Qué tan fresco |
|---|---|---|
| Venta de hoy en tienda | ODS (`kdm1/kdm2`, carril de ~15 s) por `fn_new_products_movimientos` | en vivo |
| Entradas de hoy | ODS, misma función (índice nuevo `ix_kdm1_compra_fecha`) | en vivo |
| Existencia | `v_erp_stock_on_hand` | en vivo |
| Historia (días anteriores) | `mv_new_products` (series hasta `corte - 1`) | cierre de anoche |
| Venta de ruta y de plazas en Wincaja | sólo en la historia | se suma al cierre (declarado en pantalla) |

⛔ **Por qué la historia NO es en vivo:** `mv_kepler_sales_daily` no tiene índice por producto (sólo
por fecha y por marca), así que recorrer la historia de cada producto en cada consulta no cabe en el
gate de 1 s. La matvista guarda la historia hasta el corte y la función trae desde el corte: **nada se
cuenta dos veces** (`fecha < corte` contra `fecha >= corte`).

⭐ **La función usa las MISMAS reglas, sin copiarlas a mano**: la venta replica
`mv_kepler_sales_daily` y lee el corte Kepler/Wincaja de cada plaza del resolvedor único
`analytics.v_branch_erp_cutover` (el que costó $1.63M de Abastos invisibles cuando era lista copiada).
El candado la compara contra `v_sellout_daily` en días cerrados: **coincide renglón por renglón**
(154 días-plaza) y contra las entradas de `erp_goods_receipt_lines` (10). Rota a propósito (sin el
ticket `U-D-10`), fallan exactamente esas dos comparaciones.

### La recomendación

Determinista y con motivos (ADR-016: el motor decide, nada de LLM). Criterio en
`CRITERIO_RECOMPRA`, visible en la pantalla ("Cómo se decide"), **propuesta para calibrar con Compras**:

| Veredicto | Cuándo |
|---|---|
| Aún es pronto | antes del día 21 |
| No recomprar | nunca se vendió, o lleva 21+ días sin venderse |
| Revisar | la venta de 4 semanas cayó a < 60% de las 4 anteriores, o se vendió < 8 de 28 días |
| Recomprar | venta sostenida **y** (agotado en una sucursal que lo vende, o sin existencia, o vendió ≥ $0.80 por $1 invertido) |
| Esperar | venta sostenida, pero todavía hay existencia y no ha recuperado |

Se aplica igual por sucursal, contando los días desde la primera actividad EN esa sucursal.
Mide rotación y recuperación de lo invertido (a precio de venta), **no margen** (ADR-051).

### Hallazgos de esta entrega

- **La gráfica mentía con la semana en curso**: traía sólo los días transcurridos y la línea "se
  desplomaba" al final. Ahora sólo se grafican semanas completas; lo de hoy va en texto.
- **Leer el valor de un recurso de Angular en error LANZA**: con el API caído la pantalla habría
  reventado en vez de decir "sin conexión". Lo detectó la prueba del componente.
- **La base local no tiene `v_branch_erp_cutover`** (va atrasada; su migración se niega a correr
  porque las sucursales locales no traen datos de corte). Para probar se creó un equivalente **sólo
  local** con las mismas 8 fechas de prod; no va al repo.

### Medido (local)

Listado completo **0.56 s** · detalle por sucursal **0.09 s** · función en vivo **29 ms** · refresco
de la matvista 1.4 s. Candado de base **94/94** (+ 2 pruebas negativas), lógica 27/27, componente
17/17, Compras 313/313, comercial 519/519. ⚠️ En prod hay que volver a medir: la función recorre los
documentos de hoy de todas las sucursales.

---

## Tercera entrega (2026-10-07): las unidades de Kepler (`NP.11`)

Pedido: *"quiero que uses las unidades de medida de Kepler: si se vendieron cajas, muestra cajas,
paquetes o piezas"*.

### De dónde sale la unidad — se lee, no se calcula

Cada renglón de `kdm2` trae su unidad base (`c11`, cantidad `c9`) y la unidad en que se compró o
vendió (`c55`, cantidad `c56`) con su factor (`c58`); `c9 = c56 × c58` se cumple en el 99.99% de la
venta (`UNIDADES_DE_MEDIDA` §8octies). La regla:

| El renglón… | Se publica |
|---|---|
| declara `c55` y su identidad `c9 = c56 × c58` cierra | `c55` / `c56` (p. ej. 1 CJA) |
| no declara `c55`, o la identidad NO cierra | su base `c11` / `c9` (p. ej. 12 PZA) |
| no declara ningún rótulo | `?` → "sin unidad" (nunca "pieza") |

Nunca se convierte ni se suman rótulos distintos: "23 cajas · 86 piezas" son dos cifras.

La existencia: Kepler la guarda en la unidad **base** de la ficha (`kdii`) de cada sucursal; el
rótulo y el peldaño mayor salen de `analytics.v_kepler_unit_ladder` (grano sucursal × SKU, no una
moda de las plazas). "Hay 24 piezas (2 cajas)" sólo si esa ficha declara la caja con su factor.
Wincaja no tiene ficha de Kepler: va como "unidades de Wincaja" con el divisor de ADR-055.

### Una sola regla para la historia y lo de hoy

La función en vivo (`fn_new_products_movimientos`) pasó a recibir **SKUs** y a devolver la unidad,
y la matvista la usa para armar su historia de Kepler (`venta_unidades`, y `entradas` con `u`). Así
la regla de unidad —y las de venta y entradas— vive en UN lugar. Por SKU y no por producto: no lee
el catálogo con RLS y entra por `ix_kdm2_sku_venta`. La venta de ruta y de plazas en Wincaja no trae
unidad de Kepler: se **declara** cuánto es ("$X van sólo en pesos"), no se reparte.

### Hallazgos

- ⛔ **En `v_erp_stock_on_hand`, `source` vale `kepler_ods`, no `kepler`.** La primera versión unía la
  ficha con `source = 'kepler'` y la existencia salía sin rótulo en todas las plazas, en silencio. La
  unidad de la cantidad la dice `unit_source` (`kepler` / `wincaja` / `wincaja_multipack`). Lo vio la
  prueba por HTTP, no las unitarias (que fingían el valor); ahora el candado verifica esa premisa.
- La base local no tenía fichas `kdii` ni la vista de escalera: el escenario siembra fichas por
  sucursal y la vista se aplicó en local.
- `erp_purchase_doc_lines` (RA-PRO.43) usa `c55/c58` en compras pero no `c56`; en las entradas
  `XA2001` la presencia de `c56` **no está medida en prod**. La regla se protege sola (si `c56` no es
  la cantidad en `c55`, la identidad no cierra y cae a la base), pero cuántas entradas salen en caja
  hay que medirlo en `[NP.0]`.

### Medido (local)

Candado de base **126/126** (+ prueba negativa: sin la condición de identidad, el renglón que dice
"caja" sin cuadrar se cuenta como 4 cajas y fallan exactamente esas 2 aserciones). Entradas de la
función contra `erp_goods_receipt_lines` folio por folio; primera entrada de la lista contra
`primera_recepcion` (otra consulta). Lógica 38/38 · componente 20/20 · Compras 316/316 · comercial
530/530. HTTP: listado **0.56 s**, detalle **0.28 s**.
