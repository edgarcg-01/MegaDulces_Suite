# Fase WMS-BI.4 — Movimientos: validar, corregir y optimizar

> **Estado:** 🔨 DISEÑADO (planeación) — 2026-09-14 · **ADR propuesto: ADR-062**
> **Alcance:** `/almacen/analisis-bi?tab=movimientos` (backend `commercial-bi-almacen` + componente).
> **Medido contra PROD** (`FLEET_DB_URL`, Railway, read-only) el 2026-09-14. Ninguna cifra de este
> documento viene de `platform_test`, donde la tabla está vacía — que es exactamente por lo que
> estos defectos llegaron a producción.

---

## 0. Lo que reformula el pedido

El pedido fue "validar, corregir y optimizar". La medición dice que **no es un problema de
columnas mal mapeadas**: es que la pestaña publica **dos granos distintos como si fueran uno**.

| | Kepler (`source_branch` `00`–`07`) | Wincaja (`source_branch` `W30`/`W32`/…) |
|---|---|---|
| Filas (tabla completa) | 335,138 (11%) | **3,364,207 (89%)** |
| Filas (ventana default 30 d) | 69,378 (51%) | 66,864 (49%) |
| Grano | **línea de documento** | **bucket (almacén, producto, día, tipo)** |
| `folio` | folio real del ERP | **sintético**: `WIN-<YYYYMMDD>-<tipo>` |
| Origen | `kepler_ods.kdm1` ⋈ `kdm2` | `wincaja.detalles_mov_almacen` agregado |

`import-wincaja-stock-movements.js:14` lo declara en su cabezal — *"GRANO: agrega por (almacén,
producto, día, tipo)"* — pero la tabla **no tiene columna que lo diga**, y la pantalla trata todo
como línea de documento: muestra "Hora", "Vendedor", "Folio" y deja hacer clic para abrir *el
documento*. Para el 89% de las filas ese documento no existe.

⛔ **Consecuencia para el plan:** corregir el mapeo sin declarar el grano deja la pantalla igual
de engañosa, sólo que con números mejores. **El grano se declara primero** (WMS-BI.4.1); todo lo
demás cuelga de ahí.

---

## 1. Lo medido, con su número

| # | Defecto | Medición (PROD, 2026-09-14) |
|---|---|---|
| **D1** | Columna **Sistema** dice `Kepler` siempre | Hardcodeada en la plantilla (`<td>Kepler</td>`) **y** en el SELECT (`'kepler'::text`). No existe columna `source_system` en la tabla. Falsa en **49%** de la ventana / **89%** de la tabla |
| **D2** | Ventas Wincaja publicadas en **"Importe costo"** | `WIN_V` + `WIN_D` fuera de `SALE_DOC_CODES`: **62,144 líneas / $20,325,383** en 30 d contra 7,197 / $1,214,885 bien clasificadas → **94% de los pesos de venta en la columna equivocada** |
| **D3** | `amount` tiene **dos significados** sin declararlo | `import-wincaja-stock-movements.js:144`: venta si es salida con `venta_total > 0`, costo si no. Y el `cost_total` de las ventas se descarta |
| **D4** | `tipo_operacion` inventa "Comercial" | `WIN_E`/`WIN_S`/`WIN_I`/`WIN_M` dicen "ajuste"/"Merma" en su propio `movement_label` → **163,109 filas** clasificadas como Comercial |
| **D5** | Línea / Tipo producto / Grupo vacíos en Wincaja | `ii.sucursal = w.code` compara `MD-30` contra `00`..`07` → **0 de 66,864** matchean. (Kepler: 97% / 99% / 94% ✓) |
| **D6** | Hora / Vendedor / Unidad operación vacíos en Wincaja | `enrichFromKdm` busca `h.sucursal IN ('W30','W32')` en `kepler_ods` — no existen ahí |
| **D7** | `importe_costo`: la rama de costo real está **muerta** | `c62`/`c63` poblados **sólo** en `U-D-5/10/12` (venta), donde `isSale` corta antes. En `X-A-20/30/35/37/40`, `N-A-20`, `X-D-40`: **0% poblados**. Son `text`: `''` no lo atrapa `??` → `Number('') = 0 -> amount`. **`importe_costo` es siempre `m.amount`** |
| **D8** | 19 s en frío / 3–5 s en caliente por 50 filas | `EXPLAIN`: el join a `analytics.v_unit_truth` descarta **8,981,845 filas** para devolver 50 (la vista corre `percentile_cont` sobre 76,822 filas de `kdpv_prov_prod` y ordena a disco por request). Sin ese join: 1.6 s. Más `external merge Disk: 8344kB ×3` en el `ORDER BY` y **353 funciones JIT** |
| **D9** | `/filters` paga 5,335 ms por una lista que nadie usa | `DISTINCT` sobre 3.7M filas → 19 `doc_types`; `grep doc_types` en el componente: **0 usos** |
| **D10** | El encabezado llama frescura a `max(doc_date)` | Kepler `imported_at` = **hoy**; Wincaja `imported_at` = 2026-09-12, último doc **2026-09-10 (4 d)** y es el 90% de la tabla. `max(doc_date)` = **2026-09-25**: **84 filas con fecha futura** (captura errónea). `max_imported_at` se calcula y **nunca se muestra** ⇒ viola ADR-056 |
| **D11** | El banner del Resumen está desmentido | Dice "sólo Kepler 01-06; Morelia y CEDIS no tienen feed". Medido 30 d: CEDIS `00` = 10,380 · `07` = 3,166 · W30 = 46,953 · W32 = 19,911. Y `coversAll` arranca en `true` con alcance `all` ⇒ quien más ve, menos advertencia recibe |
| **D12** | "Exportar" no exporta | `exportCurrent()` sólo lanza un toast describiendo algo que no existe |
| **D13** | IVA/IEPS con tasas **de hoy** sobre ventas históricas | y exigen ambas no-nulas: **2,984 de 11,239 productos (26.5%)** sin `iva_rate` → 3 columnas en blanco |
| **D14** | `SALE_DOC_CODES` tiene 4 entradas muertas | `Sale1`, `Remiss1`, `RtrnEn1`, `Rtrn1`: **0 filas** en la tabla |
| **D15** | El enrich es producto cruzado, no pares | `sucursal = ANY(...) AND folio = ANY(...)`: medido **2,950 filas de `kdm` para enriquecer 200** (37 folios), 1,670 ms. El folio se repite entre doctypes y sucursales |
| **D16** | El defecto no se ve en la página 1 | Ordenado por fecha desc, las primeras páginas son Kepler puro (Wincaja corta el 09-10). La mezcla rota aparece recién al paginar — por eso nadie lo reportó |

**Lo que SÍ está sano** (medido, para que nadie lo "arregle"): `kdii` es 1:1 por (sucursal, sku) y
`v_unit_truth` es única por llave ⇒ **no hay fan-out**, el `total` del paginador no miente.
`(warehouse_id, doc_code, folio)` no es ambiguo por serie (0 de 6,098 combos en 30 d).

---

## 2. Diccionario: cada columna, su tabla y su columna

> Éste es el entregable de *"asignarle su tabla y columna correspondiente"*. **Sin firmar.**
> Regla: una columna sin origen verificable **se declara ausente**, no se rellena (ADR-056).
> "⚠️ hoy" = lo que la pantalla publica hoy y está mal.

### 2.1 Identidad del movimiento

| Columna UI | Kepler → tabla.columna | Wincaja → tabla.columna | Nota |
|---|---|---|---|
| Fecha | `analytics.stock_movements.doc_date` ← `kdm1.c68` | `.doc_date` ← `wincaja.maestro_mov_almacen.fecha` | ✓ |
| **Grano** *(nueva)* | `linea_documento` | `bucket_diario` | **no existe hoy**; se deriva de `source_branch LIKE 'W%'` |
| **Sistema** | `kepler` | `wincaja` | ⚠️ hoy hardcodeado `Kepler`. Derivar de `source_branch`, **nunca** de un literal |
| Hora | `kdm1.c69` (texto `HH:MM`, 99.98% poblado) | **NO EXISTE** (el bucket es un día entero) | ⚠️ hoy "No disponible" sin decir por qué |
| Folio | `kdm1.c6` | **sintético** (`WIN-YYYYMMDD-tipo`) | ⚠️ hoy se presenta como folio real y es clicable |
| Código doc. | `.doc_code` (`Sale2`, `EntryOr1`…) | `.doc_code` (`WIN_V`…) | ✓ |
| Documento | `.movement_label` | `.movement_label` | ✓ — **es la fuente correcta para D4** |
| Zona / Sucursal / Almacén | `trade.zones.name` · `commercial.warehouses.code`,`.name` | idem | ✓ |

### 2.2 Clasificación

| Columna UI | Fuente canónica | Hoy |
|---|---|---|
| Tipo (entrada/salida) | `.movement_kind` | ✓ |
| **Tipo de operación** | **`.movement_label`** + `.doc_code` | ⚠️ sólo `doc_code` contra 2 listas que ignoran `WIN_*` (D4) |
| **¿Es venta?** | `.movement_kind = 'salida' AND .movement_label ILIKE 'Venta%'` ∪ `doc_code ∈ SALE_DOC_CODES` | ⚠️ sólo la lista, con 4 de 5 entradas muertas (D2, D14) |
| Canal | `kduv.c3` vía `kdm1.c12` (sólo género `U`) | **NO EXISTE** en Wincaja | ✓ ya declarado |
| Vendedor | `kduv.c3` vía `kdm1.c12` | **NO EXISTE** | ✓ ya declarado |

### 2.3 Producto

| Columna UI | Fuente | Cobertura medida |
|---|---|---|
| Código / Producto | `catalog.products.sku`, `.nombre` (fallback `.sku` del fact) | 100% |
| Línea | `kdig.c2` ← `kdii.c3`, por (sku, sucursal) | Kepler 97% · **Wincaja 0%** (D5) |
| Tipo producto | `kdie.c2` ← `kdii.c4` | Kepler 99% · Wincaja 0% |
| Grupo | `kdif.c2` ← `kdii.c5` | Kepler 94% · Wincaja 0% |

⭐ **Corrección D5:** el join debe ir por la **llave de sucursal canónica** (`branchKeySql(w)`,
ADR-050), no por `w.code` crudo. Para `MD-30`/`MD-32` **no hay catálogo Kepler** → la
clasificación se declara ausente **con un motivo distinto** ("la sucursal no está en Kepler") del
de un SKU sin línea. Ausencias distintas, etiquetas distintas (ADR-059 regla 4).

### 2.4 Cantidad y unidad

| Columna UI | Fuente | Nota |
|---|---|---|
| Cantidad | `.qty` | ✓ |
| Efecto en inventario | `.signed_qty` | ✓ |
| Unidad operación | `kdm2.c11` | Wincaja: no existe |
| Unidad base | `analytics.v_unit_truth.base_label` (ADR-057) | **NULL en 29,785 de 179,824 llaves (16.6%)** → se declara |
| Peldaño | `kdm2.c58` | ya persistido en `analytics.sales_daily.rung_factor` (U.5) |

⛔ **NO denormalizar la unidad dentro de `stock_movements`.** Congelaría el resolvedor y crearía
la segunda materialización que ADR-057 y la regla principal prohíben. La unidad se resuelve **una
vez, en el resolvedor**; lo que se materializa es *ese mismo resolvedor* (§4.1).

### 2.5 Dinero — el bloque que más duele

| Columna UI | Kepler | Wincaja | Hoy |
|---|---|---|---|
| Importe | `.amount` ← `kdm2.c9 × c12` | `.amount` = **venta O costo según la fila** | ⚠️ D3 |
| **Importe venta** | `.amount` si `doc_code ∈ SALE` | **`wincaja.detalles_mov_almacen.valor_venta`** (hoy colapsado en `.amount`, sólo para salidas) | ⚠️ vacío en el 94% de los pesos de venta (D2) |
| **Importe costo** | `.amount` de doctypes de costo | **`wincaja.detalles_mov_almacen.valor_costo`** — ⛔ **el importer lo DESCARTA para salidas** | ⚠️ D7: la rama `c62`/`c63` nunca se ejecuta |
| Costo unitario del movimiento | `.unit_cost` | `.unit_cost` (mismo doble significado) | ⚠️ |
| IVA / IEPS / Venta neta | `catalog.products.iva_rate`, `.ieps_rate` **de hoy** | idem | ⚠️ D13 — y no cubre IEPS **por cuota** (hallazgo LC.1) |
| Costo catálogo (hoy) | `catalog.products.cost_base` | idem | ⚠️ ADR-051: viene **por caja** en buena parte del catálogo. **No es conmensurable** con `unit_cost` en la misma fila sin declarar la unidad |

⭐ **`valor_costo` de las ventas Wincaja es dinero que existe en la fuente y se tira en el import.**
Sin él no hay margen por línea para el 89% de la tabla. Recuperarlo es WMS-BI.4.5 y es la única
modificación de importer que este plan admite.

---

## 3. Sprints

### ⬜ WMS-BI.4.1 — El grano se declara (⛔ ruta crítica)
Nada más se toca hasta que esto esté.
1. Migración aditiva: `analytics.stock_movements.grano text` (`linea_documento` | `bucket_diario`) + `source_system text` (`kepler` | `wincaja`), **derivadas de `source_branch`**, con `CHECK`. Backfill por rangos (⚠️ 3.7M filas, ventana fuera de horario, GOTCHAS §17).
2. Los dos importers las escriben al insertar.
3. `BiMovementRow` gana `grano` y `source_system` **reales**; se retira el literal `'kepler'` del SELECT y del `<td>`.
4. UI: columna **Origen** con el sistema; las filas `bucket_diario` **no son clicables** (no hay documento que abrir) y su Folio lleva chip "día agregado".

- **Aceptación:** 0 filas con `grano IS NULL`; `count(*) WHERE source_system='kepler' AND source_branch LIKE 'W%'` = 0.
- **Prueba negativa:** forzar una fila `W%` a `grano='linea_documento'` ⇒ el `CHECK` la rechaza.

### ⬜ WMS-BI.4.2 — Venta es venta (D2, D4, D14)
- `esVenta(row)` pasa a `movement_kind='salida' AND movement_label ILIKE 'Venta%'` ∪ `SALE_DOC_CODES`; se podan las 4 entradas muertas **midiendo primero** que siguen en 0.
- `tipoOperacion()` lee `movement_label` antes que las listas: `WIN_E/S/I/M` → *Ajuste de inventario*, `WIN_C/P` → *Comercial*, `WIN_D` → *Comercial (devolución)*.
- **Aceptación:** la suma de `importe_venta` de la ventana de 30 d pasa de **$1,214,885 a ≈$21,540,268**, y `importe_costo` deja de contener pesos de venta.
- **Prueba negativa:** test que falla si algún `doc_code` con `movement_label ILIKE '%venta%'` cae en `importe_costo`.

### 🧪 WMS-BI.4.3 — `mv_unit_truth`: la única materializada que hace falta (D8) — **EN CÓDIGO 2026-09-14**
- `CREATE MATERIALIZED VIEW analytics.mv_unit_truth AS SELECT *, now() AS refreshed_at FROM analytics.v_unit_truth` + `UNIQUE INDEX (tenant_id, warehouse_id, product_id)` para `REFRESH CONCURRENTLY`. ~180k filas.
- Se registra en `AnalyticsRefreshService` (`analytics-refresh.service.ts:109`, `deps: []`) **y su umbral en `CRON_JOBS`** — sin eso `db-health` cae en `cfg ? classify : 'ok'` y una MV parada se ve **verde** (lección OBS.1).
- **Es materialización por COSTO, no una segunda definición**: la MV es `SELECT *` de la vista canónica; `v_unit_truth` sigue siendo la única definición (ADR-057 intacto).
- **Aceptación:** la consulta baja de 3.3 s a **≤1.6 s en caliente** (medido: ése es el tiempo sin el join) y el `EXPLAIN` deja de mostrar los 8.9M de filas descartadas. `mv == vista`, 0 filas de diferencia.
- **Prueba negativa:** dejar la MV sin refrescar 2 días ⇒ el sensor se pone rojo (hoy no existiría).

**✅ Medido 2026-09-14** — `up()` ejercitado contra PROD dentro de una transacción con `ROLLBACK`
(nada quedó escrito):

| | |
|---|---|
| Construcción de la MV | **3.7 s** |
| Filas | **179,824** = las de la vista, 0 de diferencia |
| Columnas | **29 + `refreshed_at`**, idénticas y en el mismo orden que la vista |
| Join sobre la ventana de 30 d | **1,420 ms → 170 ms (8.4×)** |

Entregado: la migración, el registro en `AnalyticsRefreshService` (`deps: []`), el umbral en
`CRON_JOBS` (`analytics_refresh_unit_truth`), el service leyendo la MV con **fallback declarado**
a la vista viva si la migración no está aplicada, y `unit_provenance` en la respuesta + en pantalla.
⬜ **Pendiente prod: aplicar la migración + redeploy api.**

### ⬜ WMS-BI.4.4 — El resto de la latencia (D8, D9, D15)
- `/filters`: acotar el `DISTINCT` de `doc_types` a la ventana pedida **o retirarlo** — hoy cuesta 5.3 s por una lista con 0 consumidores. Si se retira, se retira del contrato.
- `enrichFromKdm`: de `sucursal ANY × folio ANY` a **pares** (`JOIN (VALUES …) v(sucursal, folio, doctype)`). Esperado: de 2,950 filas a ≈200.
- Evaluar índice `(tenant_id, doc_date DESC, folio DESC)` para matar el `external merge` de 8 MB — **medir antes y después**, no asumir.
- **Aceptación:** primera pintura útil **< 1.5 s** en caliente, con el número antes/después en el commit (regla del proyecto: un commit que cambia un número no cierra sin su medición).

### ⬜ WMS-BI.4.5 — El costo de la venta Wincaja (D7, §2.5)
- El importer deja de descartar `cost_total` en salidas: nueva columna `cost_amount` en el fact, poblada desde `wincaja.detalles_mov_almacen.valor_costo`. `amount` conserva su significado actual **pero deja de ser ambiguo**, porque `importe_venta`/`importe_costo` salen de columnas propias.
- Kepler: se **retira** la rama `c62`/`c63` de `enrichFromKdm` (medido: 0% poblada en los doctypes donde se lee) y se **declara** que el costo real por línea de compra no está disponible, en vez de simular que sí.
- ⚠️ Único cambio de importer del plan. Justificación: el dato existe en la fuente y no es derivable de otra forma. **No se crea ningún importer nuevo** (regla principal).
- **Aceptación:** margen por línea disponible para ≥95% de `WIN_V`; `cost_amount` nunca poblado sin `valor_costo` de origen.

### ⬜ WMS-BI.4.6 — Frescura y cobertura, declaradas (D10, D11)
- `movements_as_of` pasa a ser **por fuente**: `{ kepler: { max_doc_date, max_imported_at }, wincaja: { … } }`, servido con el envelope de `libs/contracts/http/provenance.contract.ts` (VP.2.1) — nada nuevo.
- El encabezado imprime **`imported_at`**, no `max(doc_date)`, con veredicto ternario `fresh | stale | unknown`.
- Las **84 filas con fecha futura** se declaran en pantalla (no se filtran en silencio: son un error de captura real que alguien debe corregir en Kepler).
- Se reescribe el banner del Resumen con los números medidos y `coversAll` deja de arrancar en `true` para alcance `all`.
- **Prueba negativa:** apagar el feed Wincaja un día ⇒ la píldora se pone ámbar. Hoy no pasa nada.

### 🧪 WMS-BI.4.7 — Frontend: zoneless real + RxJS donde rinde — **EN CÓDIGO 2026-09-14**

> ⚠️ **Corrección al pedido: la app YA es zoneless** — `provideZonelessChangeDetection()` en
> `apps/view/src/app/app.config.ts:33`, Angular 22, `zone.js` fuera de `polyfills.ts`. No hay
> migración que hacer. Lo que falta es que **este componente cumpla el contrato**, y que deje de
> disparar 3 requests en cascada.

- Estado que hoy vive en campos planos (`periodPreset`, `customFrom/To`, `selectedZoneIds`, `selectedWarehouseIds`, `visibleMovCols`) → **signals**. Bajo zoneless, un campo plano mutado desde un callback asíncrono (no desde un evento del template) **no repinta**, y ya no hay `zone.js` que lo tape.
- `movements$` como stream: `combineLatest(filtros, page, sort).pipe(debounceTime, distinctUntilChanged, switchMap(…))` → **`switchMap` cancela la request en vuelo**. Hoy, con 19 s de latencia, paginar rápido deja carreras y la respuesta vieja puede pisar a la nueva. Es el único punto donde RxJS resuelve un **bug**, no un estilo.
- `toSignal()` en el borde; `@if` sobre el signal. Cero `subscribe()` manual que escriba campos.
- `colOn()` se evalúa 25 × filas por render → `computed()` de un `Set`.
- **D12:** o se implementa el export de verdad (`GET /movements/export`, CSV en servidor, respetando alcance) **o se retira el botón**. Un botón que explica lo que no hace es peor que no tenerlo.
- El `(click)` se mueve del `<tr>` al folio (hoy seleccionar texto abre una pestaña).
- **Aceptación:** `nx test view` verde + validación visual con el navegador (paginar rápido 5 veces ⇒ la tabla termina en la página pedida, no en una anterior).

**✅ Medido 2026-09-14 — y aparecieron DOS bugs de señales que el plan no había previsto.**

No estaban en la lista D1–D16 porque se ven leyendo el código con el contrato zoneless en la
mano, no mirando la pantalla: bajo `provideZonelessChangeDetection()` el síntoma es **mudo** —
ni error, ni warning; el valor simplemente no cambia nunca.

| Bug | Qué pasaba | Por qué nadie lo reportó |
|---|---|---|
| `warehouseOptsFiltered` era `computed()` sobre el campo plano `selectedZoneIds` | elegir una **Zona** no volvía a filtrar el desplegable de **Almacén** | el computed SÍ se invalidaba — por la señal `filters()` de al lado. Parecía vivo al cargar |
| `selectedFields = computed(() => this.selectedFieldsList)` | **cero** dependencias de señal ⇒ congelado en su primera evaluación: tildar un campo en *Explorar datos* no cambiaba ni el encabezado ni las celdas | la casilla sí se tildaba (`isFieldSelected()` es un método), así que se veía "funcionando" |

⭐ **La lección del primero:** *"le puse un `computed` y se actualiza"* es falso — se actualizaba
por la señal de al lado, no por la que el usuario tocaba.

Entregado: todo el estado de filtros a señales (`[(ngModel)]` → `[ngModel]`/`(ngModelChange)`),
`switchMap` sobre un `Subject` para que **sólo la última página pedida pinte**, `colOn()` sobre un
`Set` en `computed` (eran 6,000 `Array.includes()` por render con 200 filas × 30 columnas), el
export de CSV que **de verdad baja un archivo** y dice cuántas filas tomó de cuántas tiene el
filtro, el `(click)` movido del `<tr>` al folio (como `<button>`, no `<td>` con handler), y la
nota de procedencia de la unidad en pantalla.

**Candados** (`+9` pruebas, 332 en total en `nx test view`):
`almacen-analisis-bi.reactividad.spec.ts` (4) documenta la regla con los dos casos REPRODUCE, y
`almacen-analisis-bi.component.spec.ts` (5) la ejerce sobre el componente real en TestBed —
incluida la carrera: se emiten 3 respuestas **fuera de orden** y se exige que gane la última
pedida. **Prueba negativa corrida:** cambiando `switchMap` por `mergeMap` el candado se pone rojo
exactamente en `movSubjects[0].observed` (`Expected: false / Received: true`).

⬜ **Pendiente: validación visual en el navegador + redeploy view.**
⚠️ `nx build view` **no se pudo correr**: falla con 14 errores en
`compras-pedido-real.component.ts` (`NG5002: Unclosed block`), WIP sin commitear de otra sesión —
**ninguno en los archivos de esta entrega** (0 menciones en el log). El componente sí compila y
monta: el TestBed lo llega a instanciar y a correr `ngAfterViewInit`.

### ⬜ WMS-BI.4.8 — Candado
`database/tests/test-newdb-bi-almacen.js` en la suite de regresión, contra prod read-only: grano,
`source_system`, clasificación venta/costo, paridad `mv_unit_truth` vs vista, latencia con
presupuesto. **Tercer estado obligatorio:** lo que no se pueda medir reporta `NO MEDIDO`, no ✔.

### ✅ WMS-BI.6 — El indicador se alcanza desde cualquier pantalla del almacén — **2026-09-19**

**El pedido era "que la pestaña de BI exista en todos los submódulos de /almacen".** Medido antes
de tocar nada: el módulo ya estaba entero — ruta, permiso `ALMACEN_BI_VER` **repartido** (10 roles
en `platform_test`: almacenista, supervisor, prevencion, compras, direccion…), backend de 12
endpoints, e item propio en el sidebar. Lo que faltaba no era el módulo sino **el atajo**: BI era un
área aislada, así que desde Inventario, Conteo o Control la barra de tabs no lo mencionaba y había
que salir al sidebar para llegar.

**Un solo tab, agregado en un solo lugar.** `ANALISIS_BI_TAB` se añade al final de la barra de
**cada** área dentro de `almacenTabsForUrl`, no copiado dentro de los cinco arrays de `ALMACEN_AREAS`.

**Por qué NO vive dentro de `area.tabs`, que era lo obvio:** `almacenLandingCandidates` lee ese
array para decidir a dónde apunta el item de sidebar de cada área — *el primer tab que el rol
alcanza*. Con BI ahí dentro, un rol que sólo tuviera `ALMACEN_BI_VER` habría hecho que el item
**"Inventario" aterrizara en `/almacen/analisis-bi`**, dejando dos items del sidebar sobre la misma
ruta. Está fijado con una prueba negativa, no con un comentario.

**Tres casos que se dejan como estaban, a propósito:**
- **Pantallas de foco** (Andén, Contar, detalle de vale): siguen sin barra. Sumarles BI la haría
  aparecer, que es exactamente lo que el diseño del área evita — una salida visible a media tarima.
- **El área de BI** no repite el tab: ya tiene su propia pantalla (*Panorama*).
- **Diario de Movimientos** (`/almacen/movimientos`) no cae en ningún área → sigue sin barra. Intocable.

**Sin cambio para quien no tiene el permiso:** `app-page-tabs` filtra por `permission` y se esconde
con un solo tab visible, así que esos roles ven la barra idéntica.

**Verificación:** `apps/view/src/app/modules/almacen/almacen-tabs.spec.ts`, 8 aserciones (4 áreas +
área de BI + 3 negativas). `nx test view` 370/379 y `nx build view` verde — los 6 fallos restantes
son de `landing-guards.spec.ts` (SN.4) y **preexistentes**: medidos en el árbol limpio antes del
cambio, mismo 6/362.

---

---

## 4. Decisiones que este plan toma — y las que rechaza

### 4.1 Se acepta
- **Una sola materializada** (`mv_unit_truth`), por costo, sobre la vista canónica.
- **Una sola modificación de importer** (`cost_amount` Wincaja), porque el dato existe en la fuente y no se deriva.
- Reusar `AnalyticsRefreshService`, `CRON_JOBS`, `ScopeService`, `provenance.contract.ts`. **Cero primitivos nuevos** (ADR-056).

### 4.2 Se rechaza, con motivo

| Idea | Por qué no |
|---|---|
| Materializar `stock_movements` entera (MV de 3.7M filas) | El `count(*)` filtrado ya tarda **266 ms**. El cuello no es el fact: es `v_unit_truth` (8.9M filas descartadas). Materializar el lado equivocado suma >1 GB y no arregla nada |
| Denormalizar `unidad_base`/`box_factor` dentro del fact | Congela el resolvedor y crea la segunda materialización que ADR-057 y la regla principal prohíben |
| Un importer nuevo que "arme la tabla BI ya resuelta" | ⭐ Regla principal: cero importers. Lo que falta se **deriva** |
| Separar Wincaja a otra tabla | Rompería `import-replenishment-cadence.js`, `import-supplier-params.js` y `commercial-replenishment`, que ya leen `WIN_C` de ahí. El grano se **declara**, no se parte |
| Filtrar en silencio las 84 filas futuras | Es un error de captura real. Se declara para que alguien lo corrija en el origen |
| "Migrar a zoneless" | Ya lo está. Medirlo antes de planearlo ahorró el sprint entero |

---

## 5. Orden y riesgo

```
4.1 grano ──┬── 4.2 venta/costo ──┬── 4.5 costo Wincaja
            │                     └── 4.6 frescura
            └── 4.3 mv_unit_truth ─── 4.4 latencia ─── 4.7 frontend ─── 4.8 candado
```

`4.1` es ruta crítica y toca 3.7M filas ⇒ **ventana fuera de horario**, migración una por una con
`lock_timeout`, nunca `migrate.latest()` en batch (lección PROD 2026-09-03, Fase LC).
`4.3` y `4.7` son independientes de `4.1` y pueden ir en paralelo.

**Pendiente de decisión (Edgar):**
(a) ¿el export se implementa o se retira el botón?
(b) ¿las filas `bucket_diario` se muestran mezcladas con un chip, o la pestaña arranca filtrada a
`linea_documento` y el bucket va a su propia vista?
(c) ¿se corrigen en Kepler las 84 fechas futuras, o sólo se declaran?
