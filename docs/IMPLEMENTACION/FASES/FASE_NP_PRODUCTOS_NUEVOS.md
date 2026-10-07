# Fase NP — Productos nuevos (seguimiento a 30, 60 y 90 días)

> Estado: 🧪 **EN CÓDIGO Y PROBADO EN LOCAL** · 2026-10-07 · sin push, sin PR, nada aplicado a prod.
> Pantalla: `/compras/catalogo/nuevos` (pestaña **Productos nuevos** del Catálogo de Compras) +
> etiqueta "Nuevo · día N" en `/compras/catalogo`.

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
| 7 | **Todo en pesos y sin margen.** | Entrada y venta pueden venir en peldaños distintos (caja/paquete/pieza). El costo del hecho de venta es álgebra sobre el markup (ADR-051): publicarlo como retorno sería inventar. |
| 8 | **Inversión sin entrada en Kepler = NULL ("no medida"), nunca 0.** "Venta por cada $1 invertido" usa el MISMO universo arriba y abajo. | El CEDIS fue Wincaja hasta el 30-sep, y las plazas 01/02/06 antes de pasar a Kepler. Un 0 daría retorno infinito o un fracaso falso. |
| 9 | **El costo viaja sólo con `COMPRAS_COSTO_ESTANDAR_VER`** (o admin), y se quita en el SERVIDOR antes de agregar. | Mismo criterio que la pestaña Costos (`[CAT-COSTO.4]`). Ocultarlo en pantalla no lo protege. |
| 10 | **Compras confirma qué es cada código** (`catalog.new_product_reviews`): nuevo / recodificación / promoción / no mercancía. La decisión humana manda sobre la automática. | Un código nuevo no siempre es un producto nuevo. El sistema sólo propone (DESC, promoción, descontinuado, mismo código de barras que uno más viejo). |
| 11 | **Materializada, refresco nocturno** (06:20 MX, `AnalyticsRefreshService`, latido `analytics_refresh_new_products` con umbral en `CRON_JOBS`). Nace `WITH NO DATA`. | La primera actividad exige recorrer toda la historia; no cabe en el gate de 1 s. El primer poblado va de noche, no al desplegar. |

## Lo construido

| Item | Qué | Estado |
|---|---|---|
| `[NP.0]` | Decodificar la fecha de alta de Kepler (`kdii.c50…c75`) contra prod; re-medir el umbral de carga masiva; medir el refresco y el gate de 1 s con volumen real. | ⬜ requiere acceso de lectura a prod |
| `[NP.1]` | Mig `20261007200000_np_mv_new_products.js` — matvista + índice único + grants. | 🧪 aplicada en local |
| `[NP.2]` | `libs/commercial/.../new-products.ts` (lógica pura) + `new-products.service.ts` + 2 endpoints en `commercial-products.controller.ts` (`GET new-products`, `PUT new-products/:id/classification`) + refresco nocturno + umbral en `db-health`. | 🧪 |
| `[NP.3]` | Candado `database/tests/test-newdb-new-products.js` sobre el escenario `database/tests/_lib/new-products-scenario.js` + demo `database/scripts/seed-local-new-products-demo.js` (`--undo`). | 🧪 |
| `[NP.4]` | Mig `20261007200100_np_new_product_reviews.js` — clasificación de Compras (RLS forzado, auditoría completa, soft-delete). | 🧪 aplicada en local |
| `[NP.5]` | Pestaña `compras-catalogo-nuevos.component.ts` + `productos-nuevos.service.ts` + etiqueta en la lista de Productos. | 🧪 |
| `[NP.6]` | Umbrales y veredicto (en `analytics.kpi_thresholds`, nacen vacíos → "sin meta") + hitos 30/60/90 **congelados** en tabla propia. | ⬜ |
| `[NP.7]` | Alta solicitada en la app (pestaña Solicitudes) con inversión y meta planeadas → plan contra real. | ⬜ decisión de proceso |

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

1. Aplicar las 2 migraciones **una por una** (`apply-one-migration-prod.js`), fuera de horario.
2. Redeploy api + view. La pestaña dirá "todavía no se calculan" hasta el primer lote nocturno (06:20).
3. Re-login no hace falta: no hay permisos nuevos.
4. Antes de publicar cifras: `[NP.0]`.
