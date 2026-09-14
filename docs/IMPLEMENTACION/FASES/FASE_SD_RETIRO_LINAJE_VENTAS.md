# Fase SD — Retiro del linaje imperativo de ventas (`analytics.sales_daily` → ODS)

> **Estado**: 🔨 DISEÑADO (planeación) 2026-09-11 · **NO ejecutado**.
> Nace de la petición "purgar todo lo inventado / no fresco / obsoleto". La purga de basura
> (respaldos, latidos zombie, tablas dead-on-arrival) se aplicó a prod aparte. **Esto es lo que
> quedó identificado como "inventado" pero que NO se puede purgar: es load-bearing.**

## Tesis

`analytics.sales_daily` (3.76 GB) y su cadena de rollups imperativos son **el mismo hecho de venta
que el ODS, materializado por importer y desincronizado**. Es "inventado" en el sentido del proyecto
(valor materializado que no cuadra con la primaria), pero **65 servicios lo leen** — entre ellos el
motor de margen. No se purga: **se declara no-autoritativo y se migran los lectores al linaje
declarativo del ODS**, con un candado de paridad. Purgar sin migrar tira prod; y borrar dato stale
no lo vuelve fresco, lo vuelve ausente.

## Evidencia medida — ⚠️ la de 2026-09-11 era APPLES-TO-ORANGES (SD.0, corregida 2026-09-14)

> La comparación "por canal" de abajo estaba mal: los dos objetos usan **taxonomías de canal
> distintas** (`mostrador/preventa/ruta` en el matview vs `tienda/credito/mayoreo` en la tabla), así
> que comparar `tienda`↔`tienda` (matview = $0) no significaba nada, y el "$21.30M tabla" **omitía el
> canal `mayoreo`** ($7.5M). Se conserva tachada como caso testigo del pecado que SD existe para evitar.

~~tabla $21,296,918 vs matview $25,742,139 · brecha $4,445,220 (17.3%) · `tienda` −$265,485~~

### SD.0 ✅ — el −$265k no existe; la brecha REAL es la venta de RUTA (medido en PROD 2026-09-14)

Re-medido channel-agnóstico (la única comparación honesta), agosto-2026:

| linaje | Ago total | cubre |
|---|--:|---|
| `sales_daily` (tabla, lo que leen 65 servicios) | **$54,369,414** | ramas 01-06 + **ruta** + Wincaja |
| `mv_kepler_sales_daily` (el target que este plan nombraba) | $25,742,139 | **solo ramas Kepler — le falta ruta + Wincaja** |
| **`mv_sales_blended`** (matview ODS-derivada) | **$54,265,356** | todo — **cuadra con la tabla al 0.19%** |
| `v_sellout_daily` (vista ODS) | $55,204,315 | todo (~1.5%) |
| `v_route_sales_lines` (vista ODS de ruta) | $7,275,639 | la pierna de ruta |

**Diagnóstico (ruta crítica CERRADA):** reconciliando tabla vs `mv_kepler_sales_daily` a grano
`(product_id, día)`, las **ramas fijas 01-06 cuadran al 0.4%** ($104k sobre $25.7M) — los dos linajes
**coinciden** en la venta de sucursal. **Toda** la brecha de ~$3.73M/mes son **6 almacenes
`kind='truck'`** (`RUTA-21..28` Kepler + `RUTA-3xx/5xx` Wincaja) que:
- entran a `sales_daily` por el camino **push→mart** (`analytics.route_push_lines`, $6.47M/65k filas en Ago),
- tienen **`kepler_code = null`** → **no se replican a `kepler_ods`**,
- por lo tanto están **ausentes de `mv_kepler_sales_daily`** (`source_branch` = sólo 01-07),
- y en la tabla caen mayormente en el canal **`credito`** ($3.14M) — por eso el `credito` de la tabla
  se veía 54× inflado vs el del matview. **No es sobreconteo de la tabla: es un HUECO de cobertura del ODS.**

**Consecuencia para el plan:** el target NO es `mv_kepler_sales_daily` (incompleto, sólo ramas). El
linaje ODS-derivado **completo ya existe** — `mv_sales_blended` cuadra con la tabla al **0.19%** e
incluye ramas + ruta + Wincaja. SD.3 deja de ser "reconstruir" y pasa a ser **"repuntar los lectores a
`mv_sales_blended`/`v_sellout_daily`"**. Mover a `mv_kepler_sales_daily` habría tirado **$3.62M/mes de
venta de ruta Kepler (~12%)** en silencio — el error que este plan (con el target mal elegido) iba a cometer.

## Lectores (medido: 65 refs a `sales_daily` vs 13 a `mv_kepler_sales_daily`)

Prioridad (dinero primero):
1. `libs/commercial/src/lib/commercial-profitability/commercial-profitability.service.ts` — motor de margen.
2. `libs/commercial/src/lib/commercial-analytics/commercial-analytics.service.ts` — Command Center.

## Costo del duplicado

16 objetos del mismo hecho ≈ 30% del tamaño de la DB: `sales_daily` 3.76 GB · `mv_wincaja_sales_daily`
2.74 GB · `mv_sales_blended` 1.47 GB · `product_sales_daily` 1.30 GB · `sales_boxes_monthly` 689 MB ·
`sales_monthly` 242 MB · `sales_by_vendor_monthly` 297 MB · `product_sales_monthly` 92 MB · …

## Plan (sin big-bang, sin borrar tablas)

- **SD.0 ✅ CERRADO 2026-09-14 — la brecha es la venta de RUTA, no un −$265k de tienda** (ver arriba).
  El bloqueante quedó nombrado y cuantificado: `mv_kepler_sales_daily` es incompleto (sólo ramas); el
  linaje ODS COMPLETO que cuadra con la tabla al 0.19% es **`mv_sales_blended`**. **Corrige el target de SD.3.**
- **SD.1 ✅ CERRADO 2026-09-14** — `database/tests/test-newdb-sales-lineage-parity.js` (11/11 contra
  prod, registrado en `run-all-tests.js`). Candados: `sales_daily`==`mv_sales_blended` ≤0.5% en meses
  cerrados (calibrado: jul 0.012% · ago 0.191%) + la ruta(truck) empata al peso (Δ$0) + **prueba
  negativa** que congela SD.0: `mv_kepler_sales_daily` sólo tiene ramas 00-07 y hay venta de truck
  material invisible → migrar ahí tiraría $3.62M/mes. Umbral roto a propósito (0.1% → ago falla) = rojo
  verificado. Cae a `FLEET_DB_URL` del `.env` si no hay `DATABASE_URL_NEW` (read-only, assert de prod).
- **SD.2 — Declarar `sales_daily` no-autoritativa** (comentario en tabla + doc), sin borrarla.
- **SD.3 🧪 EN CÓDIGO 2026-09-14 — motor de margen migrado a `mv_sales_blended`.**
  `commercial-profitability.service.ts`: las 3 lecturas del fact (`salesAgg` + `dataAsOf` + desglose de
  canal) pasan por una sola constante `SALES_FACT = 'analytics.mv_sales_blended'`. Arquitectura limpia:
  `salesAgg()` es el único método que lee la venta y todo el margen/GMROI/breakdown lo consume.
  **Antes/después medido en prod (el número NO se mueve):** margen ago **11.25%→11.24%** (Δ 0.01 pp),
  jul **idéntico**; cobertura de costo incluso **mejora** (99.47%→99.98%). Ninguna de las 6 columnas que
  a `mv_sales_blended` le faltan (`id/margin/rung_factor/rung_mixed/units_base/units_unresolved`) se usa.
  `nx test commercial` **60/60**. ✅ **Sin cambio visible en el número.** ⚠️ **Corrección (SD.4 lo cazó):**
  el **desglose por canal** NO se migró — se queda en `sales_daily` a propósito. `mv_sales_blended`
  **carece del canal `mayoreo`** ($9.88M/30d, medido) y lo reparte en credito/preventa/ruta → migrarlo
  haría **desaparecer mayoreo** de la pantalla y duplicar credito ($6.03M→$13.22M). Es taxonomía de
  negocio, se **declara como dependencia**, no se fuerza (mi afirmación inicial "las etiquetas pasan a
  mostrador/preventa/ruta" era falsa — ésa es la taxonomía de `mv_kepler`, no la del blend). **La deuda
  de costo de MR (Kepler 50/50) se preserva IGUAL** — SD.3 mueve el linaje, no arregla el costo.
  **Pendiente: validación visual (`/comercial/rentabilidad`) + redeploy.** 1 de 65 lectores.
- **SD.4 🟡 EN CURSO 2026-09-14 — Command Center: el dinero YA estaba migrado.** Al medirlo (no asumirlo):
  `commercial-analytics.service.ts` ya lee **`mv_sales_blended`** en los KPIs de dinero (overview, top
  productos, mix por marca, serie diaria — migrados en KV.1/KV.4/"PARIDAD-ODS"). Lo que **sigue** en
  `sales_daily` son **dependencias declaradas, no pendientes triviales**: (1) **tickets** —
  `mv_sales_blended.tickets` = **20× menor** (26k vs 536k/mes; no cuenta folio), es una dependencia REAL;
  (2) **desglose por canal** — el `mayoreo` ($9.88M/30d) no existe en el blend; migrarlo lo desaparece;
  (3) facets de filtro + algún detalle por rango. Las tres **bloquean el retiro (SD.5)** hasta resolver
  la taxonomía de canal y el conteo de folio en el ODS. No se fuerza ninguna: se **declaran**.
- **SD.4b ✅ FOLIO-COUNTING — APLICADO A PROD 2026-09-14. Tickets del ODS: de 5% a 99.68–100.01%.**
  Edgar corrió `sd4b-folio-counting-blend.js --apply` en ventana (refresh 381 s). Medido:
  `mv_sales_blended.tickets` ago **26,222 → 534,437** (99.68% de sales_daily) · jul **27,096 → 562,844**
  (100.01%). El candado `test-newdb-sales-lineage-parity` pasó de 11/11 a **13/13** (bloque 5 de tickets,
  umbral 2% calibrado: ago 0.32% · jul 0.01%; el recreate NO regresó revenue/ruta/prueba negativa). **La
  dependencia de `sales_daily.tickets` está resuelta** — queda sólo la taxonomía `mayoreo` para SD.5.
  Detalle del diseño abajo. ~~diseño VALIDADO, sin aplicar~~
  El bloqueante de tickets tiene solución medida. `mv_sales_blended.tickets` (26k/mes) es 20× menor que
  `sales_daily.tickets` (536k) porque sus 3 piernas hardcodean `0 AS tickets` salvo rutas. **Feasibilidad
  probada:** reconstruir `count(DISTINCT documento)` desde `kepler_ods.kdm1` (llave `c1..c6`, mismo
  FROM/WHERE/grano que `mv_kepler_sales_daily`) reproduce `sales_daily.tickets` al **98–99.9% en las 5
  sucursales puras-Kepler**. El "10% de gap" era **100% la sucursal 06** (Canindo corre **los DOS ERPs en
  el mismo almacén** — KX.2): su Kepler = 30,811 (mi reconstrucción 30,769, 99.9%) + Wincaja = 27,165.
  **Diseño:** `tickets = count(DISTINCT doc)` en `mv_kepler_sales_daily` (llave kdm1) + `mv_wincaja_sales_daily`
  (su folio) + sumar las 3 piernas en `mv_sales_blended` (quitar los `0 AS tickets`). ⚠️ **Es cirugía de
  matview en PROD:** agregar columna a un matview obliga `DROP MATERIALIZED VIEW … CASCADE` (el de
  `mv_kepler` **arrastra `mv_sales_blended`**) + recrear + refresh (mv_kepler 730k / mv_wincaja 4M /
  blend 4.5M filas → minutos sin sell-out). **Necesita ventana + autorización de Edgar.** Candado: extender
  `test-newdb-sales-lineage-parity` con paridad de tickets. Con esto resuelto, `sales_daily.tickets`
  deja de bloquear el retiro. **Script escrito y VALIDADO 2026-09-14 (sin aplicar):**
  [`database/scripts/sd4b-folio-counting-blend.js`](../../../database/scripts/sd4b-folio-counting-blend.js)
  — dry-run por default, `--apply` sólo en ventana. DDL validada contra prod por EXPLAIN dentro de una
  transacción revertida (3/3, cero cambios); la validación cazó un `GROUP BY` incompleto antes de que
  nadie lo corriera. **Falta: correrlo con `--apply` en ventana fuera de horario + autorización + el candado de tickets.**
- **SD.5 — Retirar los rollups imperativos** que ya nadie lea (convertir a vista sobre el ODS o
  declarar deuda con nombre). Recién aquí se libera espacio, y sólo tras probar 0 lectores, y tras
  resolver los dos bloqueantes declarados (SD.4b tickets + la taxonomía de canal `mayoreo`).

## Verificación

- La comparación agosto por canal debe explicarse **por completo** (los tres deltas) antes de mover
  un lector.
- `node database/run-all-tests.js` verde antes y después.
- Frescura: `sales_daily` por canal hoy muestra `tienda`/`credito` en 0 días de atraso; si el cambio
  los rompe, revertir.
- Visual: `/comercial/rentabilidad` + Command Center (dev servers los levanta Edgar).

## Relación con otras fases

Hereda **ADR-056/VP** (verdad y procedencia: el número declara con qué se calculó; `fresh|stale|unknown`)
y **ADR-059/VERDAD_ABSOLUTA** (la venta se arbitra contra el ODS; ya movió la venta +$15.8M/90d). Es
la contraparte de escritura de VP: VP declaró el problema, SD retira la fuente equivocada.

## Lo que este plan NO es

- No es una purga. Nada se borra hasta SD.5, y sólo con 0 lectores probados.
- No toca el ODS ni los matviews (son la fuente correcta que se adopta).
