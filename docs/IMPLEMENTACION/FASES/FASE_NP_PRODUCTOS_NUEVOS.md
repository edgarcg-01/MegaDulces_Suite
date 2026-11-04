# Fase NP — Productos nuevos (seguimiento a 30, 60 y 90 días)

> **Estado al 2026-11-03:** 🧪 · **EN PROD desde el 2026-10-08** (NP.1–NP.5, NP.8–NP.17: la pantalla la
> usan los jefes de Compras; NP.17 nació de sus quejas en producción). **Sin prod:** la décima entrega
> (`[NP.6]` hitos congelados + semáforo, `[NP.18]` venta y compra sin impuestos, `[NP.19]` el universo
> dicho) y la undécima (`[NP.20]` un solo motor de compra, `[NP.21]` agotado no se juzga) — en código y
> probadas en la base local, **CERO migraciones** (decisión de David del 2026-11-04: las dos de la décima entrega se
> retiraron; ver [§ Duodécima entrega](#duodécima-entrega-2026-11-04-cero-migraciones-np6-derivado-y-np18-en-el-servidor)).
> Tarjeta **#33** del Tablero PM, dueño David, vence el **2026-11-10**.
>
> ⚠️ Lo que decía esta línea hasta hoy («sin push, sin PR, nada aplicado a prod», 2026-10-07) quedó rancio
> al día siguiente y nadie lo corrigió en 26 días (observación `NP.UI.9`).
>
> Pantalla: desde el 2026-11-04 (`[NP.22]`) **ya no es pantalla propia**: vive en Compras › Catálogo › Productos como
> «Mostrar › Productos nuevos» (`/compras/catalogo?mostrar=nuevos`; la ruta vieja `/compras/catalogo/nuevos` redirige ahí) +
> sección «Lanzamiento» en la ficha del producto. Ver [§ Decimotercera entrega](#decimotercera-entrega-2026-11-04-productos-nuevos-dentro-de-productos-np22).

```
OBJETIVO:  Compras sabe, a los 30, 60 y 90 días de cada código nuevo, si devolvió lo invertido
           (comparando lo mismo con lo mismo) y si el lanzamiento funcionó (NP.20).
MÉTRICA:   (2026-11-04, sin tabla) cortes 90 cumplidos que se pueden calcular desde la historia ÷ cortes 90
           cumplidos de productos en pantalla — HOY (local): 66 de 66 (100 %), 0 sin historia, 0 productos
           de más de 180 días. Prod NO MEDIDO → `medir-np-productos-nuevos.js` §D3.
           META: 100 % (un corte cumplido nunca sale «sin dato» mientras el producto está en pantalla).
           (La métrica anterior —fotos congeladas ÷ hitos cumplidos— se retiró con la tabla.)
MÉTRICA 2: «venta por $1 invertido» con los dos lados sin impuestos — HOY (local): 12 productos con
           cociente, 0 cambian de recomendación al corregir; el cociente baja hasta 10 % (17085:
           $0.69 → $0.62). Prod NO MEDIDO → §E del mismo script.
CAPA TOPE: C3
ÁREA:      Comercial (Compras)
DUEÑO:     David
```

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
| `[NP.0]` | Decodificar la fecha de alta de Kepler (`kdii.c50…c75`) contra prod; re-medir el umbral de carga masiva; medir el refresco y el gate de 1 s con volumen real; medir qué parte de las entradas `XA2001` declara su caja (`c55/c56` con identidad que cierra). | 🔨 2026-11-03: en local las 6 columnas valen `1800-01-01` (vacío) en el **100 %** de 9,678 fichas; el script de sólo lectura `database/scripts/medir-np-productos-nuevos.js` (§A–§C) queda listo para prod |
| `[NP.1]` | Mig `20261007360000_np_mv_new_products.js` — matvista + índice único + grants. | 🧪 aplicada en local |
| `[NP.2]` | `libs/commercial/.../new-products.ts` (lógica pura) + `new-products.service.ts` + 2 endpoints en `commercial-products.controller.ts` (`GET new-products`, `PUT new-products/:id/classification`) + refresco nocturno + umbral en `db-health`. | 🧪 |
| `[NP.3]` | Candado `database/tests/test-newdb-new-products.js` sobre el escenario `database/tests/_lib/new-products-scenario.js` + demo `database/scripts/seed-local-new-products-demo.js` (`--undo`). | 🧪 |
| `[NP.4]` | Mig `20261007360100_np_new_product_reviews.js` — clasificación de Compras (RLS forzado, auditoría completa, soft-delete). | 🧪 aplicada en local |
| `[NP.5]` | Pestaña `compras-catalogo-nuevos.component.ts` + `productos-nuevos.service.ts` + etiqueta en la lista de Productos. | 🧪 |
| `[NP.6]` | Umbrales y veredicto (en `analytics.kpi_thresholds`, nacen vacíos → "sin meta") + hitos 30/60/90 **congelados** en tabla propia. | 🧪 2026-11-03 (mig `20261103172233` sin aplicar) |
| `[NP.7]` | Alta solicitada en la app (pestaña Solicitudes) con inversión y meta planeadas → plan contra real. **Plan detallado (2026-10-28): alta desde fotos + ficha para Kepler → [`FASE_NP7_ALTA_DESDE_FOTOS.md`](FASE_NP7_ALTA_DESDE_FOTOS.md).** | 🔨 2026-11-03: primer corte (levantamiento + bandeja «Por revisar») **en prod** (PR #481; la primera captura de prueba dejó 4 fichas sin foto: ver la bitácora del plan); estado por item en el plan NP.7 |
| `[NP.18]` | `NP.UI.1`: «venta por $1 invertido» con venta SIN impuestos contra compra SIN impuestos (mig `20261103172230`: la compra con tasa negativa trae el impuesto adentro). | 🧪 2026-11-03 |
| `[NP.19]` | `NP.UI.2/4/5/6` lo barato: el universo de las cifras dicho con «Preliminar», la nota de ruta, las dos fechas de arranque. | 🧪 2026-11-03 |
| `[NP.8]` | **En vivo**: función `analytics.fn_new_products_movimientos(tenant, skus, desde, hasta)` (venta y entradas desde el ODS; desde `NP.11` vive en la mig `20261007360000` porque la matvista la usa para su historia) + índice `ix_kdm1_compra_fecha` (mig `20261007360200`). La matvista guarda SERIES hasta el corte. | 🧪 aplicada en local |
| `[NP.9]` | **Recomendación de recompra** global y por sucursal (`recomendar` + `CRITERIO_RECOMPRA`) + `GET new-products/:id` (comportamiento por sucursal). | 🧪 |
| `[NP.10]` | **Rediseño**: respuesta arriba, filtros por recomendación, venta por semana en cada fila, panel lateral por sucursal, refresco solo cada minuto. | 🧪 |
| `[NP.12]` | **Sin clasificación manual en pantalla** (pedido del usuario): se quitó el formulario "¿Qué es este código?" del panel, el filtro "Por confirmar" y la frase "N esperan que Compras confirme". Las exclusiones automáticas (promoción, código DESC, descontinuado) siguen. El endpoint `PUT …/classification` y `catalog.new_product_reviews` quedan **sin consumidor en la pantalla**. | 🧪 |
| `[NP.13]` | **Sólo Kepler y en vivo las 24 h** (pedido del usuario): mig `20261008091317` rehace la matvista sobre Kepler (sin Wincaja ni ruta por push), con la primera venta de `mv_kepler_sales_daily`, el corte en lo que esa matvista ya tiene cerrado, lanzamientos detectados en vivo y la historia medida POR SUCURSAL; se refresca cada 30 min y sin JIT. | 🧪 |
| `[NP.14]` | **El primer cálculo en producción no terminaba**: mig `20261008111426` arma las series buscando cada día en un mapa (sin unir tablas) y pasa `fn_new_products_movimientos` a `plpgsql` planeada con sus valores reales (misma consulta, leída de `pg_proc`); el refresco lleva tope de 3 min y una matvista vacía no espera su cadencia. | 🧪 |
| `[NP.15]` | **Los tres márgenes y dónde se mueve mejor** (pedido del jefe de Compras): mig `20261008131320` — la función trae venta neta de IVA/IEPS, costo del renglón, peldaño y unidad base; la matvista guarda por plaza `margen_plaza` y la compra por unidad base `compra_base`. Márgenes de lista (meta de la ficha por peldaño vendido), real (`c62`) y sobre lo pagado, cada uno con su cobertura; ranking de sucursales por venta neta por día. Revisa la decisión #7: el margen ya se mide con el costo del renglón, no con el álgebra del markup. | 🧪 |
| `[NP.16]` | **Cuándo llegó, unidades por corte y reparto** (pedido de Compras): mig `20261009085241` — la función trae también traspasos recibidos (`U-A-50`) y salidas a sucursal o ruta (`U-D-41`, en la misma pasada que la venta); la matvista agrega `llegada` (barrido del kardex `kdij`), `venta_unidades_hito` y `reparto`. Pantalla: «Llegó a la empresa», unidades vendidas en 30·60·90, vendido y existencia en «¿Dónde se mueve mejor?», y el reparto arriba de «Por sucursal». | 🧪 |
| `[NP.17]` | **Sin pantallazo y más rápida** (queja de los jefes): el detalle conserva lo último mientras recarga cada minuto; la existencia se lee directo de `kdil` con las reglas de la rama Kepler de `v_erp_stock_on_hand`, sin su factor de caja (lista 1.7–2.3 s → 134–163 ms; detalle 1.1–1.35 s → 6–8 ms). Sin migración. | 🧪 |
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
   `20261007360000` crea la función y la matvista (`WITH NO DATA`, no recorre nada). La
   `20261007360200` crea `ix_kdm1_compra_fecha` CONCURRENTLY sobre `kdm1` (493 MB): no bloquea, pero tarda.
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

---

## Cuarta entrega (2026-10-07): sin clasificación manual (`NP.12`)

Pedido: quitar del panel el bloque "¿Qué es este código?" (selector + nota + Guardar).

Se quitó el formulario y, con él, lo que sólo tenía sentido si alguien podía confirmar: el filtro
"Por confirmar" y la frase "N esperan que Compras confirme qué son" (se quedarían pidiendo algo que
ya nadie puede hacer).

**Qué cambia en el resultado:**
- Las exclusiones **automáticas** siguen igual (promoción, código `DESC`, descontinuado).
- Una **recodificación** o algo que **no es mercancía** ya no se puede sacar a mano: cuenta como
  lanzamiento en las cohortes y en la inversión/retorno. La etiqueta "Posible recodificación" sigue
  apareciendo como aviso, pero no hay dónde resolverla.
- Las clasificaciones que ya existan en `catalog.new_product_reviews` se siguen respetando (el
  servidor las une al leer).

**Lo que quedó sin consumidor** (no se borró, a propósito): el endpoint
`PUT /commercial/products/new-products/:id/classification`, `NewProductsService.classify` y la tabla
`catalog.new_product_reviews` (mig `20261007360100`). Si la clasificación no va a volver, se quitan
en otra entrega; si va a volver por otro lado (p. ej. desde Solicitudes de alta), se reusan.

---

## Quinta entrega (2026-10-08): sólo Kepler y en vivo las 24 h (`NP.13`)

Pedidos: *"quiero los datos activos 24/7, o sea en vivo"* y *"no los quiero de Wincaja, solo de
Kepler"*. Disparador: el día del despliegue la pantalla dijo *"Las cifras todavía no se calculan…
vuelve mañana"* — las migraciones entraron a las 8:19, después del lote nocturno de las 6:20.

### Lo medido en producción antes de cambiar (sólo lectura)

| Pieza | Tiempo |
|---|---|
| La matvista de `NP.1`–`NP.12` completa | **> 150 s** (se cortó ahí; en local 1.4 s) |
| Su parte cara: agrupar `v_sellout_daily` por producto y día | **> 60 s**, aun acotada a 7 meses |
| Primera venta por producto desde un resumen ya materializado | ~1 s |
| Lo de hoy, por la función en vivo | **21 ms** |
| Unidades de 180 días de ~736 productos nuevos | 11 s |

⚠️ Esas consultas pesadas se corrieron en horario de trabajo, contra la regla del proyecto. Justo
después **el Postgres de producción se reinició** (09:07:32 MX); no se pudo establecer desde aquí si
fue por ellas. No se volvió a medir contra producción en horario.

### Qué cambió

1. **Sólo Kepler.** Venta en tienda de `kepler_ods` (todas las de la tienda, también las de
   vendedores de ruta, con el corte Kepler/Wincaja de cada sucursal) y entradas `XA2001`. Sin
   Wincaja (tampoco su existencia) y sin la ruta que llega por push.
2. **La primera venta sale de `mv_kepler_sales_daily`**, no de recorrer `v_sellout_daily`. Las
   series y las unidades salen de `fn_new_products_movimientos`: historia y hoy con una sola regla.
3. **El corte es lo que `mv_kepler_sales_daily` ya tiene cerrado** (su última fecha no futura), no
   "hoy": si esa matvista va un día atrás, lo que falta lo trae la función en vivo, sin hueco.
4. **Lanzamientos en vivo.** Un producto sin ninguna actividad Kepler antes del corte que se mueve
   desde el corte entra al universo en el siguiente refresco, como día 0 — aunque se haya dado de
   alta hace mucho (antes sólo entraban los dados de alta en los últimos 90 días).
5. **La historia se mide por sucursal.** Con sólo Kepler, una sucursal que pasó a Kepler hace poco
   no puede afirmar que algo "no se vendía antes". La historia de un producto empieza en el corte
   (`v_branch_erp_cutover`) de la sucursal con más historia entre las que lo movieron. Si se movió en
   la 03/04/05 (Kepler siempre) se mide; si sólo en la 08 (Kepler desde 2026-09-18), es **no medible**
   hasta que esa sucursal junte 90 días. El CEDIS `00` no está en el resolvedor y no aporta historia.
6. **Refresco cada 30 min** (además del lote nocturno, justo después de `mv_kepler_sales_daily`). La
   pantalla se llena sola minutos después de desplegar; el aviso ya no manda a nadie a "volver mañana".
7. **Sin JIT.** La causa de que el refresco local tardara 5 s no estaba en ningún nodo del plan: era
   el JIT de Postgres compilando una consulta que se ejecuta en milisegundos (las estimaciones de las
   funciones en `LATERAL` la hacen parecer cara). **4.8 s con JIT, 70 ms sin él.** El servicio de
   refresco apaga el JIT sólo para esta matvista (`SET LOCAL jit = off` en una transacción).

### Medido (local)

Candado **134/134**, con dos pruebas negativas: con la historia por sucursal rota (`max` en vez de
`min`) falla 1; sin la detección en vivo fallan 5. Refresco 70–131 ms. Comercial 621/621 (incluye la
prueba nueva del refresco sin JIT, que falla 2 de 3 al quitar la matvista de la lista), Compras 315/315.

### Pendiente antes de dar por buena la cadencia

- **Medir el refresco nuevo en producción, fuera de horario** (sólo lectura, con `jit = off`). La
  cadencia de 30 min está estimada sumando las piezas medidas (~13 s); si el log
  `Refreshed analytics.mv_new_products (Nms)` pasa de ~20 s, subirla a 60.
- La migración se aplica como siempre, una por una. Nace vacía y el ciclo la llena en ≤ 30 min.

---

## Sexta entrega (2026-10-08): el primer cálculo en producción no terminaba (`NP.14`)

La migración de `NP.13` entró a prod a las 10:22. El ciclo de 15 min arrancó el primer poblado a
las 11:00 y a las 11:09 seguía corriendo, con la matvista tomada en exclusiva. La pantalla seguía
en *"se están calculando"*. Como el ciclo no arranca una pasada mientras la anterior sigue viva,
ninguna otra matvista de 15 min se refrescó en ese tiempo. A las 11:10:14 Postgres de producción
se reinició (el segundo reinicio del día; el primero fue a las 09:07) y eso cortó el cálculo. Desde
el acceso de sólo lectura no se pudo ver qué lo reinició.

### Lo medido (prod, sólo `EXPLAIN`, sin ejecutar)

- **La serie por sucursal se armaba con un ciclo anidado.** Se cruzaba "un renglón por día ×
  sucursal" contra "la venta por sucursal y día". Postgres estimaba **1 fila** de cada lado y eligió
  un Nested Loop que recorre todo el lado de adentro por cada renglón de afuera. En realidad son
  decenas de miles de cada lado: el costo crece con el producto de los dos.
- **La estimación de 1 fila venía de la función.** `fn_new_products_movimientos` era SQL, así que
  Postgres la mete en el plan, y sus fechas y su lista de SKUs llegan como valores desconocidos. Con
  una lista no constante, además, `= ANY(p_skus)` se recorre **elemento por elemento en cada renglón**
  en vez de buscarse por hash.
- En local nada de esto se ve: con pocos datos cualquier plan tarda milisegundos. La estimación de
  ~13 s de `NP.13` sumaba piezas medidas por separado, con la lista de SKUs como constante. **No
  medía el plan que de verdad iba a correr.**

### Qué cambió

1. **La serie se arma sin unir tablas.** La venta de cada producto y de cada sucursal se junta en un
   mapa `fecha → pesos`. La serie recorre los días del lanzamiento a la víspera del corte y busca
   cada uno en el mapa. Cuesta lo mismo que los días a llenar, y ningún plan lo vuelve cuadrático.
2. **La función se planea con sus valores reales.** Pasa a `plpgsql` con
   `plan_cache_mode = force_custom_plan`: cada llamada se planea con las fechas y la lista ya puestas
   como constantes, así que la lista se busca por hash. La consulta de adentro es **la misma**: la
   migración la lee de la función instalada (`pg_proc.prosrc`) y la envuelve tal cual. `ROWS 10000`
   le da a quien la llama una estimación con la que no elige ciclos anidados.
3. **Tope de 3 min al refresco de esta matvista** (`statement_timeout`, sólo para su REFRESH). Si
   vuelve a tardar de más, se cancela sola, el error queda en el log y el ciclo sigue con las demás.
   Un redeploy no alcanzaba: Postgres sigue con la consulta aunque el proceso que la pidió ya no exista.
4. **Una matvista vacía no espera su cadencia.** Con `everyMin: 30` la pantalla podía quedar vacía
   media hora después de aplicar la migración. Ahora se puebla en el primer tick.

### Medido

- **Mismo resultado:** la consulta de `NP.13` y la de `NP.14`, sobre el mismo escenario, dan **147
  filas y 0 diferencias** campo por campo. Prueba negativa: con la serie un día más corta, el
  comparador marca 6 filas distintas.
- **Plan en prod** (`EXPLAIN` de la consulta nueva, aun con la función vieja): todas las uniones de
  la parte de series son por hash. Los únicos ciclos anidados que quedan son contra la fila única
  de parámetros.
- Candado `test-newdb-new-products.js` **134/134** con la función ya en `plpgsql`. La migración
  va y vuelve (`down` → `up` → `up`) y deja la función como estaba.
- Prueba del servicio **5/5**. Prueba negativa: sin el poblado inmediato, falla la prueba de la
  matvista vacía.

### Para llevarlo a producción

1. **Primero la migración `20261008111426`**, sola, como siempre. Si la matvista está tomada por un
   REFRESH viejo, el `DROP` espera 5 s y la migración falla entera: hay que cancelar ese REFRESH antes.
2. El código del servicio toca `mv_new_products`, así que la compuerta lo frena hasta que la
   migración esté aplicada.
3. ⚠️ **Sigue sin medirse el refresco completo en prod.** Leer el log `Refreshed
   analytics.mv_new_products (Nms)` de la primera corrida; si pasa de ~20 s, subir la cadencia a 60.

---

## Séptima entrega (2026-10-08): los tres márgenes y dónde se mueve mejor (`NP.15`)

Pedido del jefe de Compras: ver márgenes de los productos nuevos, y en qué sucursal se mueve mejor
cada uno. Se publican **tres márgenes**, porque contestan preguntas distintas, y cada uno con lo que
alcanza a cubrir:

| Margen | Pregunta | Fuente |
|---|---|---|
| De lista | ¿Con qué margen lo pusimos a la venta? | La meta de la ficha (`v_kepler_margin_target`, ya convertida de markup a margen sobre venta), ponderada por la venta de cada peldaño VENDIDO |
| Real | ¿Cuánto dejó? | Venta sin impuesto menos `kdm2.c62 × coalesce(c56, c9)`: el costo que Kepler escribió en el renglón (mismas fórmulas que `mv_erp_margin_daily`, `[MR.8.2]`) |
| Sobre lo pagado | ¿La ficha tiene el costo correcto? | Lo vendido en la misma unidad base que sus compras `XA2001`, contra lo que costó esa unidad |

Y **dónde se mueve mejor**: venta sin impuesto por día desde que el producto llegó a cada sucursal.
Una sucursal con menos de 7 días no compite (una sola venta la pondría arriba). Al lado, qué parte de
lo que pasó por la sucursal ya se vendió (vendido contra vendido + existencia de hoy, en la unidad de
la ficha).

### Por qué cambia la decisión #7

La decisión #7 decía "sin margen" porque el costo del hecho de venta (`sales_daily.cost`) es álgebra
sobre el markup (ADR-051). El costo del renglón `kdm2.c62` no lo es: tiene su propio árbitro
(`c62 = u1_cost × c58` en el 98.39% de los renglones, VERDAD §4.2) y ADR-051 enmendado lo declara el
costo canónico. La recomendación de recompra sigue sin usar margen; los márgenes se muestran aparte.

### Lo medido antes (prod, sólo lectura)

- **El importe de COMPRA viene sin impuesto; el de VENTA, con impuesto.** Una semana de `XA2001`:
  renglones + IVA + IEPS del encabezado = total en 256 de 259 documentos. Por eso la compra no se
  divide y la venta sí.
- **El costo del renglón falta en mucha venta de mayoreo (`U-D-8`).** En un producto, sólo el 6% de
  la venta de una sucursal traía costo. El margen real se calcula sobre la venta que sí lo trae y dice
  su cobertura; la venta sin costo no entra como margen cero.
- **La meta de la ficha tiene peldaños repetidos** con el mismo factor (base y Unidad Dos de factor 1):
  sin quitarlos la cobertura daba hasta 200%. Se toma un margen por (sucursal, SKU, factor); si hay dos
  distintos para el mismo factor (27 casos en ~1,200 productos) queda fuera. Leer la meta cuesta ~0.7 s.
- **Contra `mv_erp_margin_daily`** (segunda implementación, 3 productos): venta neta y costo al
  centavo en 01/02/03/07. En 06/08 aquélla cuenta días anteriores a que la sucursal pasara a Kepler,
  que esta pantalla excluye a propósito. **En la 05 quedan $230 sin explicar** (pendiente).
- **knex convertía el `'?'` literal en `'$1'`.** La matvista de prod (`NP.13`/`NP.14`) dice `'$1'` donde
  debía decir `'?'` para la unidad no declarada. Todavía no afecta datos (ninguna fila la usa); esta
  migración lo escribe escapado (`'\\?'` en el fuente).

### Lo que encontró la vista previa (3 productos reales)

- Doritos Nacho 33 g: de lista 15.6%, real 10.0% (88% de la venta), sobre lo pagado 9.9%. Se vende
  ~5.6 puntos por debajo del margen con el que se dio de alta.
- Candy Party 1 kg: el real sólo cubre el 22% de la venta (mayoreo sin costo en el renglón); el de lo
  pagado (9.7%) es el que cubre todo.
- El CEDIS aparece entre las sucursales (recibe, no vende): queda fuera del ranking.

### ⚠️ Hallazgo sin resolver: "venta por cada peso invertido" está inflado

Compara venta **con** impuesto contra compra **sin** impuesto: en un producto con IEPS 8% sale 8%
arriba, y con IVA 16%, 16%. Alimenta la recomendación ("recuperado alto" ≥ 0.8). Corregirlo cambia
recomendaciones, así que se deja para decidirlo aparte.

### Medido (local)

Candado `test-newdb-new-products.js` **145/145** (11 nuevas: margen por sucursal y compra por unidad
base contra una segunda implementación calculada de lo sembrado, más los casos que el escenario
ejerce). Prueba negativa: sin quitar el impuesto fallan los 2 productos con IVA/IEPS. La migración va
y vuelve (`down` → `up` → `up`). Lógica 50/50, pantalla 24/24.

### Para llevarlo a producción

1. Aplicar la migración `20261008131320` sola. Si un `REFRESH` de la matvista está corriendo, el `DROP`
   espera 5 s y falla entero: cancelarlo antes.
2. Nace vacía; el ciclo la llena en el siguiente tick (una vacía no espera su cadencia, `[NP.14]`).
3. Medir el refresco: suma la lectura de la meta (~0.7 s) al de `NP.14`.

---

## Octava entrega (2026-10-09): cuándo llegó, unidades por corte y reparto (`NP.16`)

Pedido de Compras sobre la pantalla de `NP.15`:
- en el comportamiento global, **cuándo llegó la mercancía a la empresa**, buscándolo en la base;
- en la tabla de 30·60·90 días y en «¿Dónde se mueve mejor?», **las cajas y piezas vendidas**;
- arriba de «Por sucursal», **lo que nos llegó en total y cuánto le tocó a cada sucursal**, con su existencia.

Todo en las unidades que registró Kepler en cada documento, sin convertir.

### Lo medido antes (prod, sólo lectura)

- **La llegada se busca en el kardex (`kdij`)**, decodificado en [`ERP_KEPLER.md`](../../ERP_KEPLER.md) §3.x.
  El barrido de los 1,207 productos nuevos con movimiento tarda 0.8 s por su llave.
- **La pantalla fechaba la compra con su aplicación contable (`X-A-20`)**, que llega días después de que
  entra la mercancía (`X-A-40`): en 33 productos el kardex trae una entrada anterior.
- **Primeras entradas:** compra 837 · ajuste de inventario 97 · traspaso 71 · otros 20 · sin kardex 182.
  145 productos nunca se compraron en Kepler (sólo llegaron por traspaso o ajuste).
- **`U-D-41` no es sólo traspaso:** también es carga a camión de ruta y, sobre todo, remisión a clientes de
  telemarketing, que se factura como `U-D-8` y ya cuenta como venta. Sólo se cuentan `TI###` (a sucursal) y
  `RUTA`/`RD` (a camión).
- **Producto de muestra (96087 Kinder Delice):** llegaron 150 cajas el 18-19 sep a Padre Hidalgo, Canindo y
  Morelia Abastos; Padre Hidalgo mandó 25 cajas a otras sucursales y 13 paquetes a rutas, Canindo 1 caja y 17
  paquetes; recibieron La Piedad Abastos 13 cajas, 8 Esquinas 10, Yurécuaro 2 y Zamora Centro 1 (26 = 26).

### Qué cambió

1. **La función** trae tres tipos más: `traspaso` (U-A-50 en el almacén principal), `salida_sucursal` y
   `salida_ruta` (U-D-41). La salida va **en la misma pasada que la venta**: en su propia rama volvía a recorrer
   los 180 días de encabezados de venta, lo más caro del cálculo. El traspaso entra por el índice de abonos por
   SKU: 118 ms reales para los ~1,200 productos. Los lanzamientos en vivo siguen contando sólo venta y compra.
2. **La matvista** agrega `llegada` (primera compra física y dónde, y la primera entrada de cualquier tipo),
   `venta_unidades_hito` (unidades vendidas en los primeros 30/60/90 días) y `reparto` (por sucursal: recibido de
   otra, mandado a otras y a rutas, y desde cuándo le llegó por traspaso).
3. **La pantalla:** «Llegó a la empresa» con fecha y sucursales (y aviso si entró antes por un ajuste o un
   traspaso, o si nunca hubo compra); unidades vendidas en cada corte; vendido en unidades y existencia en el
   ranking; arriba de «Por sucursal», el total comprado y la tabla del reparto; en cada tarjeta, lo que le llegó de
   otra y lo que mandó. Los días de una sucursal cuentan desde que le llegó, también por traspaso.

### Todo en cajas, y la existencia que Kepler sumó mal

**Las cantidades van en cajas completas y lo demás en paquetes o piezas**, con la ficha de Kepler de cada
sucursal: lo vendido (178 paquetes y 2 piezas → *29 cajas, 4 paquetes y 2 piezas*), lo que llegó, el reparto y
la existencia (334 piezas → *5 cajas, 3 paquetes y 4 piezas*). Los totales del producto usan la ficha común a
sus sucursales; si las fichas difieren (89 de 1,214 productos nuevos), se dicen como los registró Kepler. La regla
de la escalera es la de `/compras/pedido` (`escaleraUnidades`, RA-PRO.70), que se movió a `libs/contracts`
(`unit-ladder.contract.ts`) para que la usen el servidor y las dos pantallas; Pedido la re-exporta y no cambia.

**Al poner «Le llegó» junto a lo vendido, la existencia de Kepler dejó de cuadrar.** Medido 2026-10-09:

- Kepler guarda la existencia como la **suma cruda** de las cantidades del kardex, sin mirar el rótulo de cada
  renglón: en 4,781 de 4,959 plaza×producto nuevos (96.4%) su existencia es exactamente esa suma.
- Si la ficha cambia de unidad base, los renglones viejos se suman como si fueran de la nueva. 96087 Kinder
  Delice cambió de paquete a pieza el día que llegó: Canindo recibió 180 paquetes (1,800 piezas), Kepler le contó
  180, y la pantalla lo daba por **agotado** con ~1,500 piezas según el kardex (vendió 770 piezas cuando Kepler
  decía que tenía 167).
- **173 plaza×producto de 50 productos** traen renglones en un rótulo que no es el de su ficha y Kepler los sumó
  crudos; sólo en 6 la existencia sí sale convertida.

La matvista guarda por sucursal el kardex neto por rótulo, el último ajuste y la existencia de Kepler al calcular
(`kardex_plaza`) y la ficha (`escalera_plaza`). El servidor marca la existencia **en duda** sólo si (1) hay renglones
en otro rótulo, (2) Kepler de verdad sumó crudo y (3) no hubo un conteo físico (`N-A-30`/`N-D-30`) después: 8 Esquinas
y La Piedad hicieron ese ajuste y no se marcan. Una sucursal en duda **no se da por agotada**; decide la existencia
estimada (convertida con la ficha), y la recomendación dice *«conviene contarla antes de recomprar»*. Con eso, el
veredicto de 96087 pasa de *recomprar* (tres sucursales «agotadas») a *esperar*.

Candado: 159/159 contra una segunda implementación del kardex; negativa: con el kardex sólo de entradas fallan 2.

### ⚠️ Decisiones abiertas

- **El lanzamiento sigue fechado con la compra aplicada (`X-A-20`).** Con el kardex se podría fechar con la
  entrada física (`X-A-40`); cambia el día de seguimiento de 33 productos (en uno, 3 meses). No se cambió sin
  decidirlo.
- **97 productos aparecen primero por un ajuste de inventario**, algunos meses antes de su «lanzamiento»: es
  probable que no sean nuevos. La pantalla lo avisa en cada producto; reclasificarlos es otra decisión.

### Medido (local)

Candado **154/154** (9 nuevas contra una segunda implementación: reparto, unidades por corte y llegada). Prueba
negativa: contando las remisiones de telemarketing, «a rutas» da 2 cajas en vez de 1 y fallan 2. La migración
va y vuelve. Lógica 61/61, pantalla 36/36, escalera compartida 9/9 (Pedido 120/120 sin cambios).

### Para llevarlo a producción

1. Aplicar la migración `20261009085241` sola; si un `REFRESH` de la matvista corre, cancelarlo antes.
2. Mergear. Medir el primer llenado en el log `Refreshed analytics.mv_new_products (N ms…)` contra el tope de
   180 s: hoy tarda ~43 s y esto suma el barrido del kardex (un recorrido en paralelo de `kdij`, segundos).

---

## Novena entrega (2026-10-09): sin pantallazo y más rápida (`NP.17`)

Dos quejas de los jefes sobre la pantalla en producción: el **pantallazo** al cargar o actualizar, y que la
**consulta es lenta**.

### El pantallazo

La lista ya conservaba el último dato mientras se volvía a pedir cada minuto, pero **el detalle no**: al cambiar
el parámetro de recarga, `rxResource` deja el valor vacío, el panel mostraba «Cargando sucursales…» y se volvía a
pintar desde arriba. Ahora el detalle conserva el último del **mismo** producto mientras llega el nuevo (al abrir
otro producto sí se limpia, para no mostrar el del anterior). Candado en la pantalla, con prueba negativa: sin
el arreglo, el panel se vacía y la prueba falla.

### La lentitud, medida en prod (sólo lectura)

| Consulta | Lista (1,222 productos) | Detalle (uno) |
|---|---|---|
| Matvista | 245–363 ms | — |
| Lo de hoy (`fn_new_products_movimientos`) | 340–400 ms | 28–51 ms |
| **Existencia (`v_erp_stock_on_hand`)** | **1,736–2,270 ms** | **1,080–1,350 ms** |

La vista de existencia calcula el factor de caja de **todo el catálogo** (`v_product_box_factor`, ~8,800
productos y 79 mil renglones, dos veces: rama Kepler y rama Wincaja) en cada consulta, aunque se le pida un solo
producto; el planificador no puede quitar ese cruce porque vive dentro de una agregación. Esta pantalla no usa
ese factor.

**Arreglo:** la existencia se lee directo de `kepler_ods.kdil` con las mismas reglas de la rama Kepler de la vista
(almacén principal, SKU de servicio fuera, el `00` sólo desde su corte, piso en cero), en
`new-products.sql.ts`. La unidad base sale de la ficha que la matvista ya trae por sucursal (`escalera_plaza.u1`).
⚠️ La primera versión cruzaba también `v_kepler_unit_ladder` y pasó de 60 s: ese cruce no va dentro.

| | Antes | Ahora |
|---|---|---|
| Existencia, lista | 1.7–2.3 s | **134–163 ms** |
| Existencia, detalle | 1.1–1.35 s | **6–8 ms** |

Contra prod, las 4,322 sucursal×producto **idénticas** a la vista. Candado en `test-newdb-new-products.js`
(sección 11): corre el SQL REAL del servidor (no una copia) contra la vista; negativa: alterando la cantidad,
fallan las 10 combinaciones sembradas. Prueba 161/161, pantalla 38/38, lógica 61/61. Sin migración.

⚠️ La regla de la existencia queda escrita en dos lugares (la vista y esta consulta); el candado avisa si se
separan. El arreglo de fondo sería que la vista no calcule el factor de caja para quien no lo pide.

---

## Observaciones de diseño UI — revisión del plan (2026-10-26)

> **Con qué se miró: el plan, no la pantalla** (nivel C). Nada visual se da por medido; lo que
> sólo se comprueba con la pantalla viva va como criterio a verificar. La ley es
> [`ESTANDAR_DE_INTERFACES.md`](../../ESTANDAR_DE_INTERFACES.md) (§ = sus secciones) y su
> implementación [`DESIGN.md`](../../../DESIGN.md). Severidad: 🔴 la pantalla afirmaría algo falso,
> escondería lo que importa o perdería trabajo — **bloquea pasar C3 a 🚀** · 🟠 se resuelve dentro
> de la fase · 🟡 mejora; si no entra, queda como deuda con nombre.
> La pantalla existe: cada observación es un criterio a verificar en ella, no un defecto medido. Las
> cifras son las del plan (y las de las fases AB, PQ y PF donde se dice), con su fecha.

**La pregunta que contesta (prueba de la frase, §4.0b):**

- **Productos nuevos** (`/compras/catalogo/nuevos`): *«¿Los códigos nuevos que catalogamos están
  devolviendo lo invertido, y cuáles conviene volver a comprar?»* — dos preguntas: una del portafolio
  (inversión y retorno, la que pidió Compras) y una por producto (recompra). No hace falta otra
  pantalla, pero sí dos bloques con su universo dicho: los KPIs de la cohorte arriba, como respuesta
  del portafolio, y la lista con su veredicto como respuesta por producto (NP.UI.2).
- **Panel por sucursal**: *«¿En qué sucursales conviene volver a comprar este producto?»* — una
  pregunta; el ranking, los márgenes y el reparto son su evidencia.

**Jerarquía propuesta (§3.7 · DESIGN §Q.5):** primario = cuántos productos nuevos piden decisión hoy
(recomprar / revisar) y el retorno de la cohorte **con su universo** · secundario = la lista con su
veredicto y su venta por semana · terciario = márgenes, reparto, unidades por corte y fechas de
llegada.

| # | Sev | Observación (desde la silla de quien la usa) y costo | Ley | Criterio de aceptación |
|---|---|---|---|---|
| NP.UI.1 | 🔴 | **«Venta por cada $1 invertido» sale entre 8 % y 16 % alta** (venta con IVA/IEPS contra compra sin impuestos; hallazgo de NP.15, 8-oct, «se deja para decidirlo aparte») **y alimenta el veredicto:** «Recomprar» se dispara con $0.80 o más. Un producto con IVA que recuperó $0.69 se publica como $0.80 y sale «Recomprar». Lleva 18 días así, en una pantalla que usan los jefes de Compras. | §1.6 · §1.1 | Las dos puntas en la misma base (sin impuestos). Mientras no se decida, el rótulo lo dice: «Venta con IVA por cada $1 de compra sin IVA (sale 8–16 % alta)», y «Recomprar» no se dispara sólo por esa cifra. **Conflicto (decide Edgar):** corregirlo cambia recomendaciones que Compras ya vio. |
| NP.UI.2 | 🔴 | **Los KPIs de inversión y retorno se publican sobre un universo que el plan sabe sucio y ya no se puede limpiar:** el plan dice «antes de publicar cifras: [NP.0]», y NP.0 sigue ⬜ (fecha de alta de Kepler sin decodificar; el corte de carga masiva medido sólo en local, que mueve los «dados de alta sin recibir» de 1,821 a 116); 97 productos aparecen primero por un ajuste de inventario («es probable que no sean nuevos») y 145 nunca se compraron en Kepler; y desde NP.12 las recodificaciones y lo que no es mercancía **cuentan como lanzamiento**. La pantalla está en prod desde el 8-oct: «¿cuánto nos devuelve catalogar códigos nuevos?» —la pregunta de Compras— se contesta con códigos que no son nuevos. | §1.6 · §1.3 · §3.2 | El bloque de KPIs dice su universo en la misma línea: «~1,220 códigos · incluye 97 que aparecieron por un ajuste y N posibles recodificaciones que ya no se excluyen». Hasta cerrar NP.0, `p-tag` «Preliminar: fecha de alta de Kepler sin decodificar» junto a las cifras. Los 97 y las recodificaciones se pueden sacar con un clic, y el KPI se recalcula sin ellos. |
| NP.UI.3 | 🔴 | **Dos pestañas del mismo Catálogo de Compras le dan al mismo producto dos veredictos de compra con criterios distintos:** Productos nuevos dice «Recomprar / Esperar / No recomprar» por rotación y recuperación (`CRITERIO_RECOMPRA`); Productos (PF) dice «Comprar / Esperar / No comprar» por días de cobertura (menos de 15, o de 21 si es líder); y `/compras/pedido` calcula otra cantidad con 30 días. Las palabras se parecen; las preguntas no. Nada avisa cuando se contradicen, y los dos umbrales siguen como «propuesta a calibrar con Compras». | §1.5 · §1.1 · §3.9 | Cada veredicto dice su pregunta: NP «Vale la pena recomprarlo (por rotación)»; PF «Hace falta comprar (cobertura menor a 15 días)». En el panel de un producto nuevo, el otro veredicto a la vista cuando difiere: «En Productos: Esperar (alcanza para 40 días)». Los dos llevan «Propuesta sin calibrar» hasta que Compras firme sus umbrales (NP.6 ⬜, PF.UI.1). |
| NP.UI.4 | 🟠 | **«Posible recodificación» se sigue mostrando y ya no hay dónde resolverla** (NP.12: «sigue apareciendo como aviso, pero no hay dónde resolverla»), y el código sigue sumando como lanzamiento. Un aviso que no lleva a ningún lado se aprende a ignorar. | §3.4 · §4.6 | **Conflicto (decide Edgar; el usuario pidió quitar la clasificación):** o el aviso lleva a donde se resuelve (el endpoint `PUT …/classification` sigue vivo, sin consumidor), o la exclusión es automática y se dice: «Fuera de las cifras: mismo código de barras que [SKU anterior]». Lo que no va es un aviso sin salida. |
| NP.UI.5 | 🟠 | **«¿Dónde se mueve mejor?» y el veredicto miden sólo la venta registrada en Kepler** (NP.13, por pedido del usuario): las camionetas de Canindo no existen en Kepler (~$428 K por semana) y a las de Padre Hidalgo les faltan 27 días desde el 1-sep (FASE_AB §16.17, 26-oct). Un producto nuevo que se mueve en ruta sale con poca rotación —«Revisar» o «No recomprar»— y Canindo baja en el ranking. Pedido cuenta esa misma venta, en Padre Hidalgo dos veces (PQ.UI.1). | §1.6 · §1.5 | El universo se dice donde se lee el número: «Venta registrada en Kepler; no incluye camionetas de Canindo». Un producto con salidas a ruta (la función ya trae `salida_ruta`) no recibe «No recomprar» sin la nota «Se mueve por camioneta: su venta no se ve aquí». |
| NP.UI.6 | 🟠 | **El seguimiento cuenta los días desde la compra aplicada (`X-A-20`) y «Llegó a la empresa» sale del kardex (`X-A-40`):** en 33 productos la mercancía llegó antes; en uno, 3 meses antes (NP.16, decisión abierta). «Nuevo · día N», «Aún es pronto» (antes del día 21) y los cortes 30 · 60 · 90 usan una fecha; el bloque de llegada, otra, a un centímetro. | §1.6 · §1.1 | Una sola fecha de arranque, decidida. Mientras tanto, cuando difieren, se dice: «El seguimiento cuenta desde el 14-oct (compra aplicada); la mercancía llegó el 2-oct». |
| NP.UI.7 | 🟠 | **El plan tiene dos reglas de unidad que se contradicen:** NP.11, «nunca se convierte ni se suman rótulos distintos: "23 cajas · 86 piezas" son dos cifras»; NP.16, «las cantidades van en cajas completas y lo demás en paquetes o piezas» (178 paquetes y 2 piezas → 29 cajas, 4 paquetes y 2 piezas), salvo 89 de 1,214 productos con fichas distintas, que van «como los registró Kepler». La pantalla mezcla los dos formatos sin marcar cuál es cuál. Y la caja es la de la ficha de Kepler, mientras Pedido usa otra en 2 de cada 3 SKUs del CEDIS (PQ.UI.3). | §1.1 · §1.5 · §4.5 | Una regla escrita, y la misma en «Cómo se decide». La cantidad convertida dice su caja («29 CJA de 6 PAQ, 4 PAQ y 2 PZA»); la no convertida lleva `p-tag` «Como la registró Kepler: fichas distintas por sucursal». El factor es el `c84` de Kepler, el mismo que adopte Pedido con D20. |
| NP.UI.8 | 🟠 | **La existencia en duda está bien resuelta (NP.16), pero la lectura directa de `kdil` (NP.17) recorta los negativos a cero** («piso en cero»): un negativo de Kepler se lee como agotado, y «agotado en una sucursal que lo vende» dispara «Recomprar». | §1.3 | Un negativo se muestra como negativo, con `p-tag` «Negativo en Kepler», y no cuenta como agotado (D8 de PQ). Existencia en duda: las dos cifras en el `app-side-peek` («Kepler suma 180 · el kardex estima ~1,500 piezas: cambió de paquete a pieza el 18-sep»). |
| NP.UI.9 | 🟡 | **El encabezado del plan dice «sin push, sin PR, nada aplicado a prod» (7-oct) y la pantalla está en prod desde el 8-oct** (NP.13; NP.17 atiende quejas de los jefes sobre la pantalla en producción). Ninguna de las nueve entregas registra una revisión en nivel A. | método §4 · §1.1 | Encabezado al día con lo que está en prod. NP no sube de 🧪 sin `auditoria-diseno` en nivel A (claro, oscuro, `forced-colors`), con foco en el panel por sucursal y la gráfica semanal. |

**Lo que esta revisión no cubre:** contraste, panel lateral y gráfica semanal en pantalla real (exigen
nivel A); los umbrales de `CRITERIO_RECOMPRA`, que calibra Compras (NP.6); y el destino de
`catalog.new_product_reviews`, sin consumidor desde NP.12.


---

## Décima entrega (2026-11-03): hitos congelados, lo mismo con lo mismo y el universo dicho

Tarjeta **#33** (vence 2026-11-10). Auditoría del 2026-11-03 sobre `origin/main`: 18 items (✅ NP.14 ·
🧪 NP.1–5, 8–13, 15–17 · 🔨 NP.7 · ⬜ NP.0, NP.6) y cuatro observaciones 🔴 que bloquean pasar C3 a 🚀.
Todo lo de abajo se midió contra la base **LOCAL** (`platform_local`; sólo la sucursal 02 trae fichas y
precios completos; la historia llega al 2026-10-13). Lo que sólo se sabe en prod va **NO MEDIDO** con
el comando que lo mide: [`database/scripts/medir-np-productos-nuevos.js`](../../../database/scripts/medir-np-productos-nuevos.js)
(sólo lectura, `resolverProd()` + `dev_ro`; probado con `--local` como control).

### `[NP.18]` NP.UI.1 — «venta por cada $1 invertido», lo mismo con lo mismo

**Lo que estaba mal, y lo que apareció al medir.** La venta iba CON IVA/IEPS y la compra sin ellos (sale
8–16 % alta). Al medir el otro lado apareció un segundo defecto, en sentido contrario: la compra NO siempre
viene sin impuestos. `[PF.12.3]` (`costoSinImpuestos`, `catalogo-ficha.ts`) midió que en `kdm2` de `XA20` el
**signo** de la tasa decide: positiva o cero = neto; **negativa = el impuesto viene adentro**. La función de
`[NP.16]` lo suponía siempre neto («256 de 259 documentos», una semana).

| Medido (local) | Cifra |
|---|---|
| Renglones `XA20` de productos nuevos | 227 de 14 SKUs; **61 con tasa negativa (6 SKUs)**; 12 sin tasa (los del demo) |
| Por mes (impuesto adentro) | may 14 de 14 · jun 44 de 53 · jul 0 · ago 3 de 56 · sep 0 · oct 0 |
| Inversión de más por eso | 78229 +5.5 % · 44238 +5.1 % · 17085 +4.7 % · 70001 +2.6 % · 63018 +0.9 % · 88022 +0.02 % |
| SKUs nuevos con venta y MÁS de un par IVA/IEPS | **0 de 80** (por eso el factor de impuesto por producto es exacto) |
| SKUs nuevos con IVA **y** IEPS a la vez | 0 de 80 (la fórmula aditiva de la venta neta no se pone a prueba aquí) |

**Qué cambió.**
1. Mig `20261103172230_np_compra_sin_impuestos`: reemplaza SÓLO el importe de la rama de entradas de
   `fn_new_products_movimientos` por `c13 / ((1+|IEPS| si IEPS<0)·(1+|IVA| si IVA<0))`, la regla de
   `costoSinImpuestos`. Lee la definición instalada y exige encontrar el importe dos veces en esa rama; si no,
   falla. `CREATE OR REPLACE`, misma firma: no tira la matvista. Idempotente, `down` exacto (md5 igual).
2. El servidor trae `importe_neto` de lo de hoy y la lógica arma `venta_neta_total` por sucursal y producto
   (historia = `margen_plaza.n`, la MISMA venta de la serie sin impuestos). `venta_por_peso` = neta ÷
   inversión; la cohorte y el resumen usan el universo con las DOS medidas (`con_inversion`). Sin neta medida
   → NULL y la recomendación no dice cuánto recuperó (nunca la venta con impuestos en su lugar).
3. Cada hito trae `venta_neta` (factor de impuesto del producto) y `venta_por_peso`.
4. Pantalla: «Sin impuestos de los dos lados: $X por cada $1 invertido, de N productos con compra
   registrada»; la venta de arriba dice «con impuestos»; «Cómo se decide» lo explica.

**Antes/después (local, transacción revertida, `hoy` = corte local 2026-10-13, 78 en seguimiento):**

| | Antes | Sólo venta neta | Después (las dos) |
|---|---|---|---|
| Veredictos (recomprar/revisar/esperar/no recomprar/pronto) | 52/15/8/2/1 | 52/15/8/2/1 | 52/15/8/2/1 |
| Productos que cambian de veredicto | — | 0 | **0 de 78** |
| Cociente de la cohorte | $0.40 | — | **$0.37** |
| 17085 · 78229 · 44238 · 70001 | 0.69 · 0.65 · 0.59 · 0.49 | 0.59 · 0.61 · 0.55 · 0.45 | 0.62 · 0.64 · 0.58 · 0.46 |

⚠️ En local ningún producto cruza el umbral de $0.80 por los impuestos: **en prod NO MEDIDO** (§E del
script cuenta cuántos lo cruzaban SÓLO por los impuestos). Correrlo antes del merge y otra vez con la
migración aplicada: es un commit que cambia un número.

### `[NP.6]` Hitos 30/60/90 congelados y su semáforo

> ⛔ **RETIRADO el 2026-11-04** (decisión de David: cero migraciones). La tabla, el cron y «congelado manda» ya no
> existen; el corte se deriva de la historia. Ver la duodécima entrega. Se deja el texto como registro.

**Medido antes de construir.** `mv_new_products` (local) 218 filas, 82 con lanzamiento, 78 en seguimiento;
con el hito cumplido hoy: 77 a 30 d · 74 a 60 d · 71 a 90 d (222 fotos de la primera pasada, sólo 1 tomada
el mismo día del hito). ⛔ **La matvista olvida el producto al día 181** (`least(primera_recepcion,
primera_venta) >= corte - 180`): con él se van sus 30/60/90 y la cohorte del mes. Eso, y que la recomendación
del día depende de la existencia de ese día, es lo que no se puede derivar después.

**¿Existía el primitivo? (ADR-056).** Sí, con otro grano: `analytics.period_close` (`[VP.4.1]`) congela una
cifra por (superficie, MES) — `CHECK periodo ~ '^YYYY-MM$'`, `UNIQUE (tenant, superficie, periodo)` y
`cerrar_periodo()` sólo acepta `sell_out`. Se copió su FORMA (cifra jsonb + definición + quién/cuándo, sin
reescritura, el comparador declara) en una tabla propia y queda **deuda con nombre `[NP.6.D1]`**: generalizar
`period_close` a una llave libre y mudar esto ahí. El umbral SÍ reusa el registro existente:
`analytics.kpi_thresholds` (`[CDRP.2]`) + `clasificarKpi`/`umbralPara` de `libs/contracts`, sin tocarlos.

**Qué se construyó.**
- Mig `20261103172233_np_hitos_congelados`: `analytics.new_product_milestones` — una foto viva por (tenant,
  producto, hito), `tenant_id` + auditoría completa + RLS forzado; `app_runtime` tiene SELECT e INSERT, y
  UPDATE **sólo** de las columnas del borrado lógico: la cifra no se puede reescribir.
- `NewProductsService.congelarHitos` (`@Cron` cada hora a los :25, en el worker): arma todos los productos
  CON costo, `hitosPorCongelar` saca las fotos que faltan y un solo `INSERT … ON CONFLICT DO NOTHING`. Latido
  `np_hitos_congelados` con `latirCron` (cero es OK con motivo; sin tabla o sin matvista, ERROR con motivo).
- La foto guarda venta, venta neta, inversión, cociente, unidades, recompra y la recomendación **sólo si se
  tomó el día del hito** (una foto tardía —la primera pasada— no puede reconstruirla y la deja NULL).
- La lista y el detalle leen fotos y umbrales como lecturas OPCIONALES (en SAVEPOINT): sin tabla la pantalla
  sigue y lo declara en `hitos_info`. **Congelado manda**: el hito publica la foto y, si el cálculo de hoy
  difiere más de $1, lo dice (`foto.recalculado`). El semáforo juzga la cifra congelada contra
  `compras.productos_nuevos.venta_por_peso.d30|d60|d90` (periodo `mes` por convención); sin fila: «Sin meta»,
  nunca verde. Sin permiso de costo no viaja ni el cociente ni el semáforo ni el motivo con «$X por $1».
- Pantalla (panel): columnas «Por $1» y «Meta» (`p-tag`), estado «Congelado el …» / «Cerrado · sin foto
  todavía», y las notas de recálculo y de meta sin registrar.

**Cómo registra Compras su meta** (no hay pantalla; lo hace quien tenga acceso de escritura, con procedencia):

```sql
INSERT INTO analytics.kpi_thresholds (tenant_id, kpi_key, position_code, period, target, warn_at, escalate_at,
                                      direction, source, manual_lock)
VALUES ('00000000-0000-0000-0000-00000000d01c', 'compras.productos_nuevos.venta_por_peso.d30', NULL, 'mes',
        0.50, 0.35, 0.20, 'higher_is_better', 'Compras, <nombre>, <fecha>: meta a 30 días', true);
-- y lo mismo para .d60 y .d90. El CHECK de la tabla rechaza target < warn_at < escalate_at.
```

### `[NP.0]` La fecha de alta de Kepler y el umbral de carga masiva

- **En local, las 6 columnas fecha de `kdii` (`c50 c56 c60 c64 c65 c75`) valen `1800-01-01` —el vacío de
  Kepler— en el 100 % de las 9,678 fichas de la 02** (y en las fichas sembradas de las demás). El diccionario
  de formas (`KEPLER_DICCIONARIO_FORMAS.json`) no ata ninguna de ellas a una casilla de pantalla. Lectura:
  Kepler no guarda la fecha de alta en `kdii`, o la copia local no la trae. **Decidirlo exige prod** (§A del
  script: cuántas fechas reales hay por sucursal y si alguna se porta como alta contra el kardex).
- Mientras tanto la decisión #2 (el reloj arranca en la primera actividad) no depende de esa fecha: sólo la
  usa «dado de alta, sin movimiento».
- Umbral de carga masiva (local): días con 24–49 altas = **0**; 50–99 = 1 día (59); 100+ = 9 días. Con corte
  30, 50 u 80 salen los mismos **114** «dados de alta sin recibir»; con 200, 251. El 50 es estable en local;
  prod §B.
- Entradas `XA20` (180 días, local) que declaran su caja: **219 de 227** con `c55`, y la identidad
  `c9 = c56 × c58` cierra en las 219. Prod §C2.
- Refresco: el último en local tardó 2.4 s (`cron_runs`); con la función nueva, 1.4 s en una transacción de
  prueba. Prod §D2 (lee el latido; no refresca nada).

### `[NP.UI.3]` Dos veredictos de compra para el mismo producto — análisis (NO implementado)

Se corrieron **los dos servicios reales** (NP y PF) sobre los mismos 78 productos en seguimiento, en la misma
transacción y con el mismo `hoy` (local, fijado al corte):

| NP × PF | Productos |
|---|---|
| recomprar × comprar | 52 |
| revisar × comprar | 14 |
| esperar × comprar | 3 |
| esperar × traspasar | 3 |
| esperar × esperar | 2 |
| no recomprar × comprar | **1** |
| no recomprar × no comprar · revisar × sobra · pronto × sin movimiento | 1 · 1 · 1 |

**Contradicción fuerte (uno dice comprar y el otro no): 1** — y es justo un defecto de NP, no una diferencia de
criterio: el 28034 no tiene existencia en ninguna sucursal; NP dice «No recomprar: lleva 21+ días sin venderse»
y PF «Comprar: ya no hay existencia». La regla de los 21 días sin venta se evalúa ANTES que la del agotado: **no
se vende porque no hay**. Con el `hoy` real (historia local parada en octubre) el mismo patrón da 63 de 78: es el
modo de falla cuando un producto se agota y nadie lo surte. **Desacuerdo de urgencia: 17** (NP «revisar/esperar»
y PF «comprar»): preguntas distintas, mismas palabras. Prod: §E y §F (`--con-pf`) del script.

**Propuesta para el PM (decide él, con el dueño de PF):**
1. **Una sola pregunta de compra, de un solo motor.** «¿Compro ahora y cuánto?» la contesta PF (cobertura). NP
   deja de decir «recomprar» y contesta la suya: **«¿el lanzamiento funcionó / se queda en el catálogo?»**
   (Se queda · Revisar · Sacar · Pronto), por rotación y recuperación, juzgado en sus hitos congelados.
2. En el panel de un producto nuevo, el veredicto de PF a la vista con su pregunta («En Productos: Comprar —
   alcanza para 3 días»), como pide el criterio de `NP.UI.3`.
3. Corregir ya (cambia números → commit aparte, con su antes/después) el caso del agotado: sin existencia en las
   sucursales que lo vendían, «lleva N días sin venderse» no es evidencia de que no se venda.

### `[NP.7]` Catálogo digital — propuesta para sacarlo a su propia fase (texto para el PM)

> **NP.7 no es seguimiento de productos nuevos: es el ALTA.** Pedir un código nuevo desde la app (con foto,
> inversión y meta planeadas) cambia un proceso que hoy vive en Kepler, toca permisos, fotos y aprobación, y
> necesita su propia métrica (p. ej. «altas pedidas por la app ÷ altas en Kepler», HOY 0). Tenerlo como un item
> 🔨 de NP impide cerrar NP: la fase no puede llegar a ✅ con una pieza que es otro proyecto. Propuesta: **NP.7 →
> ⏸️ en NP y nace la fase «Altas de catálogo (CAT-ALTA)»** con su plantilla, su fila en el roadmap y su tarjeta,
> cuando haya cupo (método §3; hoy hay campaña de aterrizaje y no se abre nada nuevo). Lo que NP le deja listo: el
> «plan contra real» se apoya en las fotos de `[NP.6]` (la inversión y la venta de cada hito ya congeladas).

### Estado de las observaciones de diseño (2026-11-03)

| # | Estado | Qué se hizo / qué falta |
|---|---|---|
| NP.UI.1 🔴 | 🧪 resuelto en código | `[NP.18]`. Falta: aplicar la mig y medir en prod (§E). Conflicto declarado: cambia cifras que Compras ya vio (en local, 0 veredictos) |
| NP.UI.2 🔴 | 🟡 parcial | El universo se dice arriba («Cuentan N productos, entre ellos X posibles recodificaciones y Y que aparecieron por un ajuste») con `p-tag` «Preliminar». **Falta:** sacarlos con un clic y recalcular (decisión de producto) y cerrar `[NP.0]` en prod |
| NP.UI.3 🔴 | 🧪 resuelto en código (2026-11-03, D1 de David) | `[NP.20]`: NP contesta «¿el lanzamiento funcionó?» y el panel muestra el veredicto de compra de Productos. Ver [§ Undécima entrega](#undécima-entrega-2026-11-03-un-solo-motor-de-compra-y-el-agotado-np20--np21) |
| NP.UI.4 🟠 | 🟡 | El aviso ya dice «cuenta en las cifras como lanzamiento». Sigue sin salida: decide Edgar (reusar el `PUT …/classification` o excluir automático) |
| NP.UI.5 🟠 | 🟡 | El panel avisa cuando hubo salidas a camión de ruta; «Cómo se decide» dice que la venta de camionetas sin Kepler no se ve. Falta: que «No recomprar» lo matice en la lista |
| NP.UI.6 🟠 | 🟡 | El panel dice las dos fechas cuando la mercancía llegó antes de la compra aplicada. Falta: decidir UNA fecha de arranque |
| NP.UI.7 🟠 | ⬜ declarado | Dos reglas de unidad: no se tocó (es de unidades compartidas con Pedido, D20) |
| NP.UI.8 🟠 | ⬜ declarado | El piso en cero vive en `EXISTENCIA_KEPLER_SQL`, que también usa PF: cambiarlo cambia PF. Va con el dueño de PF |
| NP.UI.9 🟡 | ✅ encabezado | Encabezado al día. Falta: `auditoria-diseno` nivel A (claro, oscuro, `forced-colors`) |

### DoD (método §5) — estado real

| # | Punto | Estado |
|---|---|---|
| 1 | Métrica medida otra vez, antes/después publicado | 🟡 local sí (arriba); **prod NO MEDIDO** — §D1/§E del script antes y después de aplicar |
| 2 | Cada capa verificada o NO MEDIDA | C0 local ✔ (candado 179/179) · prod: refresco con la función nueva NO MEDIDO · C1 ✔ 76/76 · C2 ✔ servicio real contra base local · C3 ✔ 754/754 Compras; **sin validación visual** |
| 3 | Todo endpoint que escribe, ejercido contra base real | 🟡 el cron `congelarHitos` sí (sección 13, servicio real, idempotencia, inmutabilidad, RLS). ⛔ `PUT new-products/:id/classification` (`[NP.4]`) **nunca** se ejerció y no tiene consumidor desde `[NP.12]`: ejercerlo o retirarlo |
| 4 | Toda compuerta nueva rota a propósito | ✔ regla vieja de la venta → 1 rojo (unitaria) · función vieja = $108 (base) · cron sin tabla → ERROR · «congelado manda» mutado → 1 rojo · «sin meta» pintado verde → 1 rojo |
| 5 | Primitivo en `libs/` o deuda con nombre | Deuda: **`[NP.6.D1]`** foto congelada por llave (generalizar `period_close`) · **`[NP.6.D2]`** lectura opcional en SAVEPOINT (PF tiene `opcional()` y NP otro): subir a `platform-core` · la regla de impuesto de la compra vive en SQL y en `costoSinImpuestos` (TS), atadas por el candado §12 |
| 6 | Tracker, LOG y roadmap al día; ADR | ⬜ texto entregado a la sesión principal (no se tocan desde aquí) |
| 7 | En prod, o por qué no | ⬜ faltan: aplicar `20261103172230` y `20261103172233` (en ese orden), la entrada de `CRON_JOBS`, redeploy api+worker+view, y correr el script |

### Para llevarlo a producción

1. Correr el script en prod (sólo lectura) **antes**: deja el «antes» de §D1 y §E.
2. Aplicar, una por una y fuera de horario: **`20261103172230_np_compra_sin_impuestos`** (sólo reemplaza una
   función: la compuerta la ve NO_MEDIDO; aplicarla ANTES de mergear) y **`20261103172233_np_hitos_congelados`**.
3. Agregar a `CRON_JOBS` (`apps/api/src/modules/db-health/db-health.service.ts`), en el mismo cambio:
   `{ key: 'np_hitos_congelados', label: 'Hitos 30/60/90 congelados (NP.6)', cadence: 'cada hora (:25)', warnH: 2, critH: 26, maxRunH: 0.1 },`
4. Redeploy api + worker + view. El primer refresco de la matvista (≤ 30 min) recalcula la historia con la
   compra sin impuestos; la primera pasada del cron congela todo lo cumplido (tarde, sin recomendación).
5. Correr el script **después**: §D2 (latido verde, `rows_affected` = fotos), §E (antes/después real).
6. Compras registra sus metas (SQL de arriba) o queda «Sin meta», que es lo cierto.

---

## Undécima entrega (2026-11-03): un solo motor de compra y el agotado (`NP.20` · `NP.21`)

Decisiones de David del 2026-11-03 (D1 y D2), sobre `NP.UI.3`. Todo medido en la base **LOCAL**
(`platform_local`, 127.0.0.1) con los **servicios reales** (transacción `READ ONLY`); prod NO MEDIDO.

### `[NP.20]` D1 — Productos nuevos deja de decir si hay que comprar

**La pregunta cambia.** «¿Compro ahora y cuánto?» la contesta SÓLO Productos (motor PF, `product-flow.ts`, por
cobertura). Productos nuevos contesta **«¿el lanzamiento funcionó?»**:

| Antes (`np6-v1`) | Ahora (`np6-v2`) | Regla (mismos números de `CRITERIO_LANZAMIENTO`, antes `CRITERIO_RECOMPRA`) |
|---|---|---|
| Recomprar | **Se queda** | Se vende de forma sostenida (≥ `diasConVentaSano` de `ventana` días) y no cayó |
| Esperar | **Se queda** | Igual: «todavía hay existencia» era una razón de COMPRA, no del lanzamiento |
| Revisar | **Revisar** | Cayó a menos de `caidaMaxima`, o se vende pocos días, o el último corte quedó `bad` contra la meta de Compras |
| No recomprar | **Sacar** | Nunca se vendió, o `sinVentaDias`+ sin venta, CON mercancía donde se vendía |
| — | **Agotado: no se juzga** | `[NP.21]` cualquier conclusión negativa por falta de venta, cuando falta mercancía |
| Aún es pronto | **Aún es pronto** | Antes del día `diasMinimos` |

- **Sin umbrales nuevos.** Se quitó `recuperadoAlto` (0.80): era el disparador de «Recomprar», o sea de compra.
  La recuperación de lo invertido entra SÓLO contra la meta que Compras registre en `analytics.kpi_thresholds`
  (`compras.productos_nuevos.venta_por_peso.d30|d60|d90`, `[NP.6]`), en el último corte cerrado
  (`juzgarRecuperacion`): `bad` → «Revisar»; `warn` → se dice; `sin_meta`/`sin_medir` → se dice que no entró.
  Hoy no hay ninguna meta registrada: la recuperación **no mueve** ningún veredicto y cada «Se queda» lo dice.
- **El panel muestra el veredicto de compra de Productos** (`GET :id/flow`, el mismo endpoint y permiso que la
  ficha de Productos; no se copian reglas): chip con la etiqueta de Productos (`VEREDICTO_ETIQUETA`), título,
  motivos y la hora del cálculo. Si falla, lo dice («No se pudo leer…»), nunca queda en blanco. Cuando el
  lanzamiento sale «Sacar» y Productos pide comprar o mover, una frase lo explica (`cruceCompra`).
- La foto congelada guarda la recomendación ya juzgada contra la meta (el cron aplica `conHitos` antes de
  `hitosPorCongelar`). `DEFINICION_HITOS` sube a `np6-v2`. Una foto con el vocabulario viejo se lee con el
  nuevo (`veredictoVigente` en el servidor, `veredictoVista` en la pantalla): ninguna existía en prod.
- Pantalla: titular («De N productos nuevos, X se quedan y Y piden decisión… Z están agotados»), chips, columna
  «¿Funcionó?», «Cómo se juzga el lanzamiento» con el mapeo viejo→nuevo, y ayuda contextual nueva
  (`<app-context-help topic="productos-nuevos">`, diccionario versionado). Los conteos salen de las filas.

### `[NP.21]` D2 — Agotado no es «no se vende»

`faltaMercancia`: falta mercancía si no hay existencia en ninguna sucursal, si se agotó en una que lo vendió en las
últimas 4 semanas, o si ninguna de las que lo vendieron alguna vez tiene existencia (señal nueva
`vendio_con_existencia`). Por sucursal, la frase habla de esa sucursal. Con la existencia en duda en todas, lo dice.

⚠️ Una sucursal **sin renglón** de existencia cuenta como sin existencia (igual que el `agotado_en` de antes). En la
base local sólo la 02 trae fichas: por eso 66 de 78 salen sin existencia en ninguna sucursal. En prod todas las
sucursales tienen `kdil`: la magnitud de allá NO MEDIDA.

### Antes/después (local, servicio real, transacción de sólo lectura)

| | Antes (`np6-v1`) | Después (`np6-v2`) |
|---|---|---|
| `hoy` = corte local (2026-10-13), 78 en seguimiento | recomprar 52 · esperar 8 · revisar 15 · no recomprar 2 · pronto 1 | se queda 60 · revisar 1 · sacar 1 · agotado 15 · pronto 1 |
| Cambian respecto del mapeo 1 a 1 | — | **15 de 78**: 14 «revisar → agotado», 1 «no recomprar → agotado» |
| `hoy` real (local, venta parada en octubre) | no recomprar 78 | sacar 11 · agotado 67 (**67 de 78** cambian) |
| **CONTROL 28034** | «No recomprar: lleva 50 días sin venderse» | **«Agotado»**: «No hay existencia en ninguna sucursal: la venta no se puede juzgar» + «Si hay que comprar lo dice Productos» |
| NP × PF opuestos (`mide-np-vs-pf.js`, 74 comparables) | 63 (85.1 %) | **1 (1.4 %)**: 78229, «Sacar» (25 días sin venta con existencia en 3 sucursales) contra «Comprar: alcanza para 8 días». El panel lo explica |

Prod: NO MEDIDO — `medir-np-productos-nuevos.js --con-pf` §E (ahora falla si hay un «sacar» sin existencia) y §F.

### Pruebas y compuertas

- `commercial-products` (lib) 381/381 (antes 367) · candado de base `test-newdb-new-products.js` **182 ✓ · 0 ✗ · 1 NO
  MEDIDO** (sección 14 nueva: vocabulario, ningún «sacar» sin existencia, CONTROL 28034; la foto del día exacto del
  hito no existe en local).
- Pruebas negativas rotas a propósito: sin la guarda del agotado → 5 unitarias rojas y 2 del candado de base (28034
  vuelve a «sacar»); sin el `bad` de la meta → 2 rojas. Restaurado y verificado byte a byte.
- Pantalla: ver el reporte de la sesión (vitest de `compras`, `check:pantalla`, `ngc`). **Sin validación visual**:
  lo más probable de ajustar es el alto del bloque «¿Hay que comprar? · Productos» en el panel de 640 px.

### Abierto

- Compras ve palabras nuevas: lo anuncia el PM (texto en la bitácora de esta sesión).
- Calibrar `CRITERIO_LANZAMIENTO` y registrar metas por corte (sin ellas la recuperación no juzga nada).
- `NP.UI.5` en la lista: «Sacar» todavía no se matiza con «se mueve por camioneta» (el panel sí lo avisa).

---

## Duodécima entrega (2026-11-04): cero migraciones — NP.6 derivado y NP.18 en el servidor

Decisión de David del 2026-11-04: **CERO migraciones** (regla 1: todo del ODS, derivar, nada de copias). Las dos
migraciones de la décima entrega (`20261103172230_np_compra_sin_impuestos`, `20261103172233_np_hitos_congelados`)
se **borraron**: no estaban en git, ninguno de los dos ledgers locales (`public` e `identity`) las nombraba, la tabla
`analytics.new_product_milestones` no existía y la función de base seguía siendo la de `[NP.16]`. Con ellas se fueron
el cron `congelarHitos` y su latido `np_hitos_congelados` (nunca entró a `CRON_JOBS`), la lectura de fotos,
`DEFINICION_HITOS`, «congelado manda» y las secciones del candado que sólo probaban eso.
`check-migration-collisions --solo-git`: 1,415 migraciones, ninguna colisión, **ninguna nueva**.

### `[NP.6]` Los cortes 30/60/90, derivados

- Un corte cumplido es la cifra **definitiva** de esos N días, calculada con la historia del ODS que ya trae la
  matvista (`venta_dia` día por día desde el lanzamiento, y las entradas con su fecha). Uno que no llega va «en
  curso». En pantalla: «Definitivo» / «En curso» / «Todavía no llega».
- Semáforo contra `analytics.kpi_thresholds` (`semaforoHito`, sin cambio): sin meta, «Sin meta», nunca verde. La
  lectura de umbrales sigue OPCIONAL (SAVEPOINT) y `hitos_info` sólo habla de umbrales.
- **La ventana de 180 días — opciones medidas (local, 2026-11-04):**

| Opción | Lo medido | Decisión |
|---|---|---|
| A. Que la matvista conserve al menos lanzamiento + 90 | Ya lo cumple: un producto vive en la matvista hasta el día 180 (`least(primera_recepcion, primera_venta) >= corte − 180`) y su historia se pide desde `corte − 180`. 66 productos con el corte de 90 cumplido, **0 sin los 90 días de historia**, 0 productos de más de 180 días | **Se queda así**: cero cambios, cero costo |
| B. Corte bajo demanda en el detalle para productos de más de 180 días | Sería una consulta por SKU a `fn_new_products_movimientos` sobre toda su historia; `[NP.14]` midió esa forma en prod en 5–5.8 s para 200 productos (por SKU es más barato, pero NO MEDIDO). Además el producto ya no aparece en la lista: no hay desde dónde abrirlo | No se construye: no hace falta para que el 90 exista |
| C. Ampliar la ventana (p. ej. a 365 días) | Es cambiar la definición de la matvista = **migración** | **Pendiente, declarado**: decide David/PM |

- **Lo que ya no se puede contestar** (dicho en «Cómo se juzga el lanzamiento» y en el panel, no inventado):
  1. Qué recomendaba la pantalla **aquel día** (dependía de la existencia de ese día; no tiene historia).
  2. Si Kepler corrige un documento viejo, el corte se recalcula con la corrección: no hay foto contra qué compararlo.
  3. Después del día 180 el producto sale de la pantalla, y con él sus cortes y su mes de cohorte.
- Tiempos (local, servicio real, transacción de sólo lectura, `hoy` = 2026-10-13): lista **51–56 ms**, detalle
  **28–31 ms**. Prod NO MEDIDO (la meta es < 1 s; `[NP.17]` midió la lista en prod en 134–163 ms sin esto).

### `[NP.18]` La compra sin impuestos, en el servidor (sin tocar la función de base)

- `COMPRA_RENGLONES_SQL` (`new-products.sql.ts`) lee los renglones `X-A-20` de los documentos que ya trae la
  historia (plaza + folio de cada entrada), con sus tasas `c17`/`c18`, acotado a la ventana de fechas de esas
  entradas; `compraPorDocumento` les quita el impuesto con **`costoSinImpuestos`** (`[PF.12.3]`): UNA sola
  implementación de la regla (antes vivía también en el SQL de la migración). `compraSinImpuestos` pone el neto en
  cada entrada cuyo documento aparece y cuadra (a 5 centavos); lo que no aparece o no cuadra se queda como lo
  escribió Kepler y se cuenta en `compra_info`. Lectura OPCIONAL: si falla, `compra_info.medida = false` y el panel
  lo dice.
- Plan (local): `ix_kdm1_compra_fecha` + `kdm2_pkey`, 213 documentos, **2.3–2.9 ms**. Prod NO MEDIDO.
- **Antes/después (local, CONTROL):** 227 documentos neteados, **61 con el impuesto adentro**, 0 sin documento, 0 que
  no cuadran (las mismas cifras que midió la décima entrega: 227 renglones, 61 con tasa negativa). La inversión
  cambia en 6 productos y ningún veredicto cambia. **CONTROL 78229: $796,336.83 → $755,033.30 (+5.47 %)**, idéntico a
  lo que daba la función de la migración retirada (una segunda implementación independiente). 44238 +5.05 % · 17085
  +4.72 % · 70001 +2.56 % · 63018 +0.86 % · 88022 +0.02 %. Inversión de la cohorte $8,792,005.65 → $8,601,851.86;
  el cociente queda en $0.37 al centavo.
- ⚠️ Lo que NO cubre: el margen «sobre lo pagado» (`compra_base` de la matvista) se sigue calculando con la compra
  como la escribió Kepler. Arreglarlo sin migración exige la misma corrección en `margenesDe`: deuda con nombre
  **`[NP.18.D1]`**.

### Pruebas y compuertas

- Unitarias `commercial-products` **382/382** · view `compras` + `dashboard/layout` **811/811** · candado de base
  `test-newdb-new-products.js` **173 ✓ · 0 ✗** (sección 12: SQL real + `costoSinImpuestos` contra una segunda
  implementación en SQL, y la función de base intacta; sección 13: cada corte cumplido = lo sembrado, 7 cortes).
- Negativas: sin quitar el impuesto, 3 unitarias rojas y 1 del candado de base (el renglón −8 queda en $108); documento
  de otro SKU o fuera de la ventana de fechas → no se lee; sin mapa, ninguna entrada cambia.
- `check-pantalla` 0 nuevas, `ngc --noEmit` 0 errores, `tsc` de la librería sin errores en estos archivos (los 103
  que da son TS1272 de otros controladores, previos).
- **Sin validación visual.**

### Para llevarlo a producción (reemplaza al de la décima entrega)

1. **Nada que aplicar en la base.** Redeploy de api + view.
2. Correr `medir-np-productos-nuevos.js --con-pf` contra prod (sólo lectura) antes y después: §D3 (ventana), §E
   (`compra_info` y ningún «sacar» sin existencia), §F (NP × PF).
3. Compras registra sus metas por corte en `kpi_thresholds` (el SQL de la décima entrega sigue valiendo) o queda «Sin meta».

## Decimotercera entrega (2026-11-04): Productos nuevos dentro de Productos (`NP.22`)

**Decisión de David (2026-11-04):** una sola pantalla, menos ventanas. «Productos nuevos» sale del menú «Ver» y de
`CATALOGO_TABS`; vive en Compras › Catálogo › Productos como **«Mostrar › Productos nuevos»**, en Sencillo y en Detallado.
`/compras/catalogo/nuevos` **redirige** a `/compras/catalogo?mostrar=nuevos` (conserva `?resultado=`). Cero migraciones.

- **Universo:** «Productos nuevos» = los EN SEGUIMIENTO (el mismo del resumen de la pantalla vieja). ⚠️ Cambia el número
  de Detallado: antes contaba los que llevaban la etiqueta (≤ 90 días + sin movimiento; 138 en la base local), ahora los
  en seguimiento (78; incluye los de 90–180 días). Los sin movimiento siguen a un clic («Dados de alta, sin movimiento», 131).
- **Sub-filtros** (los de la pantalla vieja, con sus nombres y su conteo de la búsqueda): Todos en seguimiento · Sacar ·
  Revisar · Agotado · Se queda · Aún es pronto · Sin venta en su primer mes · Dados de alta, sin movimiento · No medibles ·
  Excluidos. Los filtra, cuenta, ordena (`orden=lanzamiento`: lo que pide atención primero) y pagina el SERVIDOR
  (`GET catalogo?vista=detallado&mostrar=nuevos&resultado=…`); Sencillo pide esa misma respuesta y la pinta con sus columnas.
- **Columnas** «¿Funcionó?» (resultado + razón principal) y «Día» (día N, «Cumplió 90 días»), sólo con el filtro.
- **Ficha** (Sencillo y Detallado): sección «Lanzamiento» (`producto-lanzamiento.component.ts`, mismo `GET new-products/:id`):
  ¿funcionó? con motivos, cortes 30/60/90 (Definitivo / En curso / Todavía no llega) con venta por $1 contra la meta
  («Sin meta»), comportamiento global, márgenes (con permiso de costo), dónde se mueve mejor, reparto y cada sucursal.
  No repite «¿Hay que comprar?» (es «Qué hacer»); si los dos tiran en contra, lo explica. Un producto que no es nuevo
  (404) no pinta nada.
- **Retirado por decisión de David el mismo día:** el bloque de resumen arriba de la lista (titular, cifras de inversión,
  venta y venta por $1, plegables de cohortes y criterio). Queda UNA línea: «Preliminar» + la base sin impuestos + la ayuda «?».
- Sencillo cuenta «Productos nuevos» sin esperar la foto (`FotoSwr.vigente`): la primera vez dice «sin medir».

**Medido (base local, `platform_local`):** conteos de Sencillo 114–152 ms antes → 114–135 ms después (un `FILTER` más; CONTROL:
el filtro dio 78 = los 78 en seguimiento activos contados aparte). Filtro + conteos + orden en memoria sobre los 11,008:
1.8 ms + 2.8 ms. Detallado con «nuevos» antes del cambio: 235–242 ms; el después end-to-end **NO MEDIDO** (la API local
corre el código anterior hasta que se reinicie). Conteos por resultado = `resumen.por_veredicto` (sacar 11, agotado 67).

**Ajustes a «Lanzamiento» pedidos por David al verla (mismo día):** se retiró la tarjeta del resultado (está en la columna
«¿Funcionó?») y «Comportamiento global» completo (cifras, avisos de fecha de seguimiento / camiones de ruta, tendencia, gráfica
semanal y la nota larga de los cortes, que pasó a la ayuda «?»). Los cortes 30/60/90 son ahora tres tarjetas (Vendido · Invertido ·
Por $1 · Meta), en fila y apiladas en angosto, sin tabla ni scroll; «sin impuestos de los dos lados» va en el encabezado. El cruce con
«Qué hacer» queda como UNA línea sólo cuando se contradicen. `check-pantalla` sella Q.1 en `producto-lanzamiento` (sin cifras de
encabezado por decisión de David; mismo sello que sus fichas).
