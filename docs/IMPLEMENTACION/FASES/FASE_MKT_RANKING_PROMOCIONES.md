# `[MKT.9]`–`[MKT.14]` — Ranking de promociones e incentivos (adiós al Excel semanal)

> **Estado:** 🧪 EN CÓDIGO y PROBADO EN LOCAL · 2026-11-11 · ⚠️ **fase nueva durante la Fase 0: falta que el PM la ratifique** (no tiene fila en el roadmap).
> **Hereda:** ADR-056 (lo no medido se declara) · ADR-059 (la cifra se arbitra) · ADR-063 (la unidad es la de Kepler) · regla principal (cero importers).
> **El pedido (2026-11-11):** «que se olvide de los Excel… automatizar lo que hace, sencillo para quien llegue después, intuitivo, completo, con reportes PDF».

## 1. El problema, medido (auditoría de los 45 Excel de 2026)

Mercadotecnia arma cada lunes `RANKING SEMANA NN.xlsx` (una hoja por sucursal + rutas/TLMKT/vecinal + incentivos «$X por caja»). Auditado el 2026-11-11, sólo lectura:

| Defecto | Medido |
|---|---|
| Incentivos que multiplican por otro monto que el de su texto | 165 renglones; el peor: Winis MA «$25 por caja» × 100 → **$4,875 donde eran $1,218.75**, 9 semanas |
| Cubrimiento sin tope decide el lugar | CAN: objetivo 1, venta 34 = 3,400 %; con esa fila CAN pasa de 0.77 a 1.56 y queda #1 |
| Promedios que dejan filas fuera | 20 de 45 semanas (`AVERAGE(G5:G45)` salta la fila 4) |
| «PROMEDIO GENERAL» tecleado | 45 de 45; no reproducible (8 sucursales = 0.640, la hoja dice 0.689) |
| Objetivo sin regla | a mano, INV/4, INV/10 o = INV |
| Códigos con letra O | 44 en la semana 45 |
| Copias de semanas viejas / promos vencidas listadas | títulos «SEMANA 2» y «43» en la 45; 5 promos vencidas en MA |

## 2. El dato (C0) — verificado contra prod (sólo lectura)

- **VENTA del Excel = cantidad del código de promo en mostrador, lunes a domingo** (`analytics.v_kepler_sales_lines`, la línea canónica). Contra la semana 45: **186 de 229 renglones exactos (81 %), 201 con ±1 (88 %)**; los 43 restantes son errores del Excel (objetivo tecleado como venta, preventa sumada a veces sí, a veces no). 8E y DAMASO al 100 % → **DAMASO = Zamora Centro (05)**.
- Los códigos de promo son productos simbólicos de `kdii` ($0.01 / «= GRATIS», `ERP_KEPLER` §2.9). Kepler **no guarda vigencia** y **reutiliza códigos** → la promo se DA DE ALTA.
- **INV** = existencia del código en Kepler (los regalos): PH 09066 = 10 igual que el Excel. Se rotula «según Kepler».
- **Canales**: los de la vista canónica — mostrador · preventa (vecinal) · ruta · mayoreo (= televenta: `VMPH01…`, `TLMKT01/02`).
- **Unidades base y caja**: `mv_kepler_sales_daily.units` = `kdm2.c9` en 21 de 21 cruces; caja = unidades ÷ `v_kepler_unit_ladder.factor_caja` de ESA sucursal. Sin factor → se declara «sin factor», no se paga.
- **Tiempos (prod)**: ranking semanal sobre la línea 0.43–0.58 s · incentivo por caja 3 semanas **128 ms** (unido a la escalera dentro de la consulta tardaba **31 s**) · 2 meses **299 ms** (sobre la línea, 8.7 s) · sugerido 4 semanas **132 ms** (antes 1.7 s).
- ⚠️ `mv_kepler_sales_daily` hace `INNER JOIN catalog.products`: un código recién creado en Kepler que no esté en el catálogo **no tendrá sugerido** (el ranking sí lo cuenta: lee la línea).

## 3. Decisiones (del dev responsable, 2026-11-11)

| # | Decisión |
|---|---|
| D1 | Objetivo **sugerido** (promedio de las 4 semanas previas dentro de la vigencia, hacia arriba, mín. 1) **y editable**; se guarda su fuente |
| D2 | Las promociones las **da de alta Mercadotecnia** (código Kepler + vigencia + canales + sucursales) |
| D3 | Cubrimiento con **tope de 100 %** por promoción; lugar = promedio de las promos CON objetivo |
| D4 | Alcance completo: sucursales + vecinal + rutas + televenta + incentivos + PDF |

## 4. Lo construido

| Pieza | Archivo |
|---|---|
| Tablas (4, RLS forzado, audit) | `database/migrations-newdb/20261111131929_mkt_ranking_promociones.js` |
| Reglas puras | `libs/commercial/src/lib/mkt-ranking/mkt-ranking.logic.ts` |
| Servicio + controlador (sin claves nuevas) | `…/mkt-ranking.service.ts` · `…/mkt-ranking.controller.ts` |
| Pantallas | `apps/view/…/comercial/pages/mkt-ranking.component.ts` (`/mkt/ranking`) · `mkt-ranking-promos.component.ts` (`/mkt/ranking/promociones`) · `mkt-incentivos.component.ts` (`/mkt/incentivos`) |
| PDF (formato común de la suite) | `apps/view/…/comercial/mkt-ranking-pdf.ts` |
| Semilla de desarrollo (sintética) | `database/scripts/dev-seed-mkt-ranking.js` |
| Prueba HTTP con cruce a SQL | `database/tests/http-mkt-ranking-test.js` |

Permisos: **sin claves nuevas** — `MKT_AGREEMENTS_VER` (ve) y `MKT_AGREEMENTS_GESTIONAR` (da de alta), ya repartidos en prod a `marketing` (3) y `jefe_marketing` (1); VER también `direccion`, `telemarketing`, `credito_cobranza`.

## 5. Las pantallas (skill `diseno` §0a)

**Ranking** — propósito: «¿quién cumplió las promociones de la semana y quién no?». Nivel 0: semana · canal · PDF; franja (promedio general, vigentes, **sin objetivo** con desglose, primer lugar); tabla (lugar, quién, cubrimiento con barra, cumplidas, sin venta, sin objetivo). Desglose: la fila abre el detalle por promo (objetivo, venta, cubrimiento, regalos en existencia, aviso de código reutilizado). Jerarquía: primario lugar/cubrimiento; secundario cumplidas/sin venta/sin objetivo; terciario clave y método.

**Objetivos** — alta (busca el código en Kepler, vigencia, canales, sucursales) y captura de objetivos con su sugerido; «Sugerir los que faltan» nunca pisa lo capturado; cerrar con cambios sin guardar pide confirmación. **Dar de baja = terminar ayer** (las semanas pasadas se siguen midiendo); sólo se borra una promo que aún no empezaba.

**Incentivos** — regla capturada una vez (por caja · por unidad · por cada $X · por cliente distinto · por exhibidor capturado); semana y acumulado por vendedor; PDF de pago con firmas. **Calcula, no paga.**

## 6. Pruebas

- Backend `vitest`: 24 (lógica + validaciones); mutación del tope de 100 % → 2 rojas.
- Frontend `vitest`: 12 (PDF, objetivos, formulario) + 6 de la pantalla montada.
- DB local: 5 CHECK rotos a propósito (canal inventado, fin < inicio, objetivo 0, por monto sin base, captura en miércoles) → los 5 rechazados; `down`→`up`→`up` sin error.
- HTTP contra la API local con la semilla: **37/37**, dos corridas seguidas (no deja rastro); cruza venta, cubrimiento, puntaje y pago por caja contra SQL directo.
- Compuertas: `check:pantalla` 0 fallas en las 3 · `boundary` limpio · `check:templates` ✅ · migraciones sin colisión (contra git; contra el ledger de prod: **NO MEDIDO**, falta `PROD_DB_URL`).
- **Sin validación visual** (la vista local no estaba levantada).

## 6b. `[MKT.15]` El producto (SKU) de cada promoción — 2026-11-11

**El pedido:** «jala el SKU de las promociones; ya los dan de alta, sólo jálalos» — y medir su venta.

**El dato (C0), medido en prod, sólo lectura:**
- Kepler **no guarda** qué producto activa un código simbólico. Barrido de las **242 tablas** de `kepler_ods` buscando un renglón con `09066` y la leche (`99891/99893`): sólo `kdmx_26`, que es el XML del ticket (otra vez la venta). `kdpv_gratisxq/xm` tienen 5 reglas por sucursal, vencidas en 2025. `commercial.promo_agreement_codes`: 0 filas. El Excel tampoco lo trae (columna CÓDIGO = el código de promo).
- La liga vive sólo en el **ticket**: el cajero cobra la leche y aplica el código en la misma venta. Se deriva con DOS pruebas a la vez: sale en ≥ 10 % de los tickets del código (mín. 2) **y** su nombre comparte una palabra con lo que la promo pide comprar (antes del «=»).
- Barrido de 4 semanas de mostrador (117 códigos con venta): **60 identificados** (09066 → leche entera y deslactosada San Juan; 00196 → wafer Colombina; 00209 → Orbit…); **34 sin identificar** (sólo la prueba del ticket daba M&M's para «4 GALL INDICADAS», 39 %); **23 con < 3 tickets**.
- ~10 códigos «+ GRATIS» (27100 WINIS T7, 2714x FRUTAFFY, mayonesas) **no son simbólicos**: tienen precio real y son el producto con contenido extra → su producto es el mismo código. Se distingue por «= GRATIS» en el nombre o $0.01 en todas las plazas (`ERP_KEPLER` §2.9).
- **Tiempo:** unir la vista con la lista de códigos por `unnest` hacía que el planificador recorriera los 104 mil encabezados del periodo una vez por código (**5.7 s**); filtrar la vista con constantes y recortar la ventana después: **2.0 s** (3 códigos reales) / 1.8 s (30 en lote).

**Decisión:** derivado **en vivo**, sin tabla ni captura (regla 1: derivar, no copiar). La ventana son las 4 semanas que cierran la del ranking, **sin salir de la vigencia** (un código reutilizado no mezcla la campaña anterior). Lo que no pasa las dos pruebas se **declara** «sin identificar» con su porqué, nunca se adivina.

**Lo que se ve:** en el detalle del ranking, bajo cada promoción, su producto y lo vendido de él en la semana (piezas y cajas por la escalera de esa sucursal; sin factor, se dice). En Objetivos, el producto bajo cada promo, y se busca por él. En el PDF, el mismo renglón y una nota de cómo se deduce.

**Pruebas:** lógica 8 casos con los casos medidos (leche, galletas indicadas, Winis, < 10 %, < 3 tickets, tope de 6) — 32/32; frontend 19/19 (incluye el PDF con «sin factor de caja» y «sin identificar»); el SQL exacto del servicio corrido en prod contra 09066/00517/27100; semilla local con un producto por promo (DM009 sin producto a propósito) y venta cruzada: Canindo DM001 × 36 → 72 pz de leche entera (2 por aplicación) ✓. `check:pantalla` 0 fallas.

**Límites declarados:** el ranking pasó de ~0.5 s a ~2.5 s por la identificación (corre en paralelo con lo demás); Objetivos tarda ~2 s más. Si molesta, se guarda el resultado por semana cerrada. No hay corrección manual del producto (no se pidió): si Marketing la necesita, va como item aparte.

## 6c. `[MKT.16]`–`[MKT.18]` — filtros, objetivo dinámico y quién vendió (2026-11-11)

**Pedido:** filtros por sucursal, promoción, venta y canal; ranking de promociones; «quién hizo la venta», ligado al arqueo para que las cajeras lo escriban; objetivo dinámico. Decisiones del dev responsable: dinámico = se recalcula solo cada semana; captura por ticket, precargada de Kepler; lista = quien checó en el reloj (RH no tiene plantilla con puestos); opcional, no bloquea el arqueo; filtro de venta = cumplida / no cumplida / sin venta.

| Item | Qué | Dato que lo sostiene |
|---|---|---|
| MKT.16 | Vista «Por promoción» (misma regla: `puntaje` + `ordenarRanking`); filtro de promoción recalculado en el servidor (`?promo=`, id inválido = 400); sucursal filtra filas y recalcula el ranking de promos (`?sucursales=`); estado sobre los renglones | — |
| MKT.17 | Sin objetivo fijado → **dinámico** de esa semana (promedio de las 4 previas en la vigencia, hacia arriba, mín. 1), calculado al consultar, no guardado; lo fijado gana; se quitan «Sugerir los que faltan» / «Llenar vacíos» | HTTP: dinámico DM007 = ceil(4 semanas ÷ 4) por SQL directo |
| MKT.18 | Pestaña del arqueo «Promociones vendidas»: la cajera elige quién vendió cada ticket con promo de sus turnos; ranking «Por vendedora» (mostrador) que declara la cobertura | Kepler no sabe quién vendió (148/149 tickets de PH a nombre de «PISO»); `kdm1.c80` liga el ticket a su turno 543/543; `hr.employees` = 0 filas, reloj: 57 personas en PH en 30 días |

**MKT.18 — reglas:** la tabla `commercial.mkt_promo_ticket_sellers` guarda sólo QUIÉN (clave del reloj + nombre de ese momento); ticket, promos y cantidades se leen de Kepler. El servidor vuelve a buscar cada ticket en los turnos de quien guarda (o la sucursal si supervisa: misma regla que el arqueo para revelar) y pone el nombre. Sin claves nuevas (`STORE_ARQUEO_CAPTURAR`).

**Pruebas:** HTTP local 61/61, dos corridas sin rastro; frontend comercial+tienda 889/889 + 4 de la pestaña; migración: 4 negativas + down→up→up; prod (sólo lectura): lista del reloj 93 ms, tickets del turno 377 ms. **NO MEDIDO:** el alcance de una cajera sin permiso de supervisor (no hay ese usuario en local). Sin validación visual.

**Antes de soltar:** aplicar en prod `20261111131929` y `20261111173031` (en ese orden, una por una). Base local: se aplicaron además 6 migraciones de RH que faltaban (`hr_attendance` … `hr_secciones_por_ficha`) para poder probar.

## 6d. `[MKT.19]`–`[MKT.21]` — rediseño tras la auditoría de uso (2026-11-12)

Auditoría en la pantalla viva (local, semilla): **13 controles y 533 px** antes de la primera fila; al recargar, la tabla parpadeaba a vacío; el resumen no cambiaba con la vista; el filtro de estado no aplicaba en «Por vendedora».

| Item | Qué | Medido |
|---|---|---|
| MKT.19 | Una sola barra (semana · canal · vista · «Filtros»); filtros plegados con etiquetas quitables; semana en calendario (`p-datepicker` con número de semana, elige el lunes ISO); secciones del módulo en menú de lista (`app-page-tabs variant="menu"`, aditivo: los otros 103 usos no cambian); resumen de 3 cifras por vista; vendedora abre su detalle; al recargar se conservan los datos (sin salto: 0 px medido) | primera fila a 316 px, 7 controles |
| MKT.20 | Mercadotecnia con su propio menú lateral (`PROJECT_KEY.mkt`); antes caía al de Auditoría en ruta | — |
| MKT.21 | Con filtros, el PDF trae sólo lo que se ve (canal abierto, mismas filas que la pantalla), lo declara en portada, nota y nombre de archivo; sin filtros, el reporte general de 4 canales | 27 pruebas (componente + PDF) |

**NO MEDIDO:** tiempo de punta a punta en prod (local: Sucursales 1.1–1.2 s, Rutas 0.17 s); contenido visual del PDF filtrado (cubierto por pruebas, no leído a ojo).

## 6e. `[MKT.22]` — las promociones salen de Kepler, no de un alta (2026-11-13)

**El hallazgo:** en prod `/mkt/ranking` salía vacío. Código y migraciones estaban desplegados, pero `commercial.mkt_ranking_promos` tenía **0 filas**: el ranking medía sólo lo que Mercadotecnia diera de alta, y nadie lo había hecho. La app de vendedor no tiene ese paso: lee las promociones de `catalog.products.is_promo` (los «= GRATIS» de Kepler).

**Decisión (David, opción A):** entran al ranking **todas las promociones de Kepler que vendieron esa semana** en ese canal; Mercadotecnia sólo ajusta objetivos (el dinámico de MKT.17 cubre el resto). Costo aceptado: el lugar se reparte entre ~64 promociones (no ~15 como en el Excel) y no es comparable con él.

| Pieza | Regla |
|---|---|
| Qué entra | `is_promo` con venta en la semana (la línea `v_kepler_sales_lines`) en ese canal |
| Sucursales de cada promo | donde vendió, la semana o las 4 previas — una sucursal que nunca la tuvo no sale «sin objetivo» |
| Inicio para el dinámico | su primera venta dentro de las 4 semanas previas (no promedia ceros de antes de existir) |
| Objetivos | la pantalla «Objetivos» lista las que vendieron en 5 semanas (matview); al fijar el primero se crea su renglón en `mkt_ranking_promos` (guarda la llave de los objetivos; el nombre se relee de Kepler). Sin renglón, el id es `k-<código>` |
| Sacar una del ranking | `activo = false` en su renglón (sin pantalla todavía) |
| Sin migración | usa las tablas ya aplicadas |

**Medido en prod (sólo lectura, las mismas consultas):** 355 códigos de promo en el catálogo; semana 45 Sucursales **64 promos** (cuadra con la medición independiente del 13-nov) en 0.76 s; preventa 21; semana en curso 54; lista de Objetivos 111 en 0.16 s.

**NO MEDIDO:** el endpoint de punta a punta (la API local no se pudo reiniciar con el código nuevo: un proceso anterior ocupa :3334 y no se verificó su dueño); el tiempo total del ranking con ~64 promos (la identificación del producto de cada promo, MKT.15, medía 1.8 s por 30 códigos). Sin validación visual.

**Quedó sin uso (deuda con nombre):** los endpoints de alta/edición/baja de promos (`POST/PATCH/DELETE promos`, `codigos-kepler`) siguen en el backend; la pantalla ya no los llama.

## 6f. `[MKT.23]` — «¿Quién vendió las promociones?» del arqueo (2026-11-13)

**Por qué no funcionaba en prod (dos causas, medidas en prod en sólo lectura, 6–13 nov):**
1. Buscaba tickets con una promo **dada de alta** (`mkt_ranking_promos`, 0 filas): la lista nunca traía nada. Con las promos de Kepler hay **625 tickets** en 8 sucursales, todos ligados a su turno y cajero.
2. La cajera veía sólo SUS turnos, comparando su usuario de la Suite con el de caja de Kepler (`kdpv_folio_caja.c8`): sólo **17 de 36** cajas tienen un usuario idéntico. **221 de 625 tickets (35 %) no los veía nadie**; en la 06, ninguno (5 cajas sin usuario). `C01` existe en la 07 y la 08 y en la Suite es uno solo.

**Arreglo (opción A de David):** promos de Kepler (`catalog.products.is_promo`) y **toda la sucursal** (el alcance de escritura de sucursal ya lo limita); cada ticket sigue mostrando caja, turno y cajero. Costo aceptado: una cajera puede asignar un ticket de otra. Si se prefiere la B (filtro por turno + igualar los usuarios en Sistemas), es una línea (`cajero`) en `tickets()` y `guardar()`.

**Probado en local (API con el código nuevo en :3339, base `platform_local`, cuenta superadmin):** la pestaña trae 18 tickets por sucursal e incluye DM009/DM010 (promos sólo de Kepler, que antes quedaban fuera); guardar una vendedora → 200 y «sin vendedora» bajó de 2 a 1. Ranking: 10 promos, una `k-DM009`; fijarle objetivo desde «Objetivos» creó su renglón (`k-DM009` → UUID, 1 objetivo). Control: `GET promos/k-DM999/objetivos` = 200 `[]` (el código viejo daba 400).

**NO MEDIDO:** la vista con una cuenta de cajera (en local no hay contraseña conocida de una); tiempos en prod de punta a punta (local: arqueo 3.7–3.9 s, ranking 2.3 s, objetivos 1.0 s). Las primeras pruebas de esta sesión pegaron por error a un proceso viejo de la API (detener la tarea de `nx serve` no mata su `node`): no cuentan.

## 6g. `[MKT.24]`–`[MKT.26]` — proveedor, piezas, quién vendió y tiempo de carga (2026-11-13)

Pedido de David: «agregarle los proveedores (identificarlos si ya vienen, y un filtro), quiénes la vendieron, cuánto vendieron (piezas y cajas)».

**`[MKT.24]` El proveedor — el código de la promo no lo trae; el producto que la activa sí, en la mitad (medido en prod, sólo lectura):**

| Fuente | Lo que trae |
|---|---|
| Ficha (`catalog.products.supplier_id` = `kdii.c3`) | 356 códigos de promo: 207 «PROMOCIONES MKT» (cubeta), 123 sin proveedor. De las 69 vendidas: 66 cubeta, 3 sin |
| Marca (`brand_id`) | «PROMOCIONES», «PRODUCTOS VARIOS», «POR CLASIFICAR»: no lleva al proveedor |
| Compras (`X-A-20`, `kdm1.c10`) | 103 de 114 promos vendidas en 5 semanas entraron por compra, **las 103 a nombre del mismo acreedor** (cubeta interna) |
| **Producto que la activa** (`[MKT.15]`, ticket + nombre) | de 108 promos de 5 semanas: **57 con un solo proveedor**, que el nombre confirma (VOLT → AJEMEX, Kisses → Hershey, Nutresa → Tresmontes Lucchetti, Barcel/Bimbo → Barcel); 5 con varios; 46 sin producto identificado |

⚠️ **Corrección:** la primera medición de esta sesión decía «0 de 69» por el ticket. Era un error de instrumento: se miró un ticket que sólo traía la línea de la promo y se excluyeron mal los candidatos. Con la regla real de `[MKT.15]` (ticket + nombre) el producto se identifica en 40 de 61 (semana) y 60 de 108 (5 semanas).

**Regla:** proveedor = el que **asignó** Mercadotecnia; si no asignó, el **del producto** (`proveedor_fuente = producto`), sólo si TODOS sus productos identificados tienen proveedor y es el MISMO, y nunca de `mismo_codigo` (el propio código de la promo, cuya ficha es la cubeta). Se deriva en vivo, no se guarda; en pantalla y PDF dice «del producto». En Objetivos el derivado es la **sugerencia** del selector, no su valor: elegirlo lo confirma. Adivinarlo por el nombre de la promo («3 PROD LA ROSA…») sigue prohibido (regla 10). **Opción A de David** para el resto: Mercadotecnia lo asigna **una vez por promo** en la celda (sin abrir panel: abrir uno por cada una era retrabajo). Columna nueva `commercial.mkt_ranking_promos.supplier_id` (nullable, FK `(tenant_id, supplier_id)` → `catalog.suppliers`, `ON DELETE SET NULL (supplier_id)`) — migración `20261113161815_mkt_ranking_promo_proveedor.js`. Asignarla a una promo `k-…` crea su renglón como el primer objetivo; quitarla a una sin renglón no crea nada.
- **Ranking:** filtro por proveedor (incluye «Sin proveedor asignado»), aplicado en el SERVIDOR como el de promoción: el lugar se recalcula sólo con sus promos; etiqueta quitable, nota «El lugar se calcula sólo con…», portada del PDF filtrado. Cada promo dice su proveedor (fila, detalle y PDF).
- **Objetivos:** KPI «Sin proveedor» con desglose al filtro; buscador por proveedor; quien sólo VE lo lee como texto.
- **Seguro ante el orden del despliegue:** antes de aplicar la migración la lectura no truena (todas salen sin proveedor) y asignar responde **503 «Falta aplicar la migración…»**, no un 500 mudo. Igual: **la migración va ANTES de soltar.**

**Cuánto vendieron — piezas y cajas:** en Kepler la caja de un código de promoción es de **1 pieza** (69 de 70 vendidos con `factor_caja = 1`, todos `PZA`): en cajas da lo mismo, por eso la columna dice «Venta (pz)» y no se agrega otra igual. Las cajas que sí cambian son las del **producto que activa** la promo (ya se muestran debajo de cada una cuando se identifica, `[MKT.15]`). Dicho en la ayuda, el criterio y el PDF.

**`[MKT.25]` Quién la vendió, dentro de cada promoción:** el detalle de una promo trae su proveedor, la tabla por sucursal o vendedor (objetivo, venta, cubrimiento) y, en mostrador, **las vendedoras** que las cajeras escribieron en el arqueo con sus piezas de ESA promo, respetando el filtro de sucursal, y **cuánto de la venta ya tiene vendedora** («Con vendedora: 9 de 18 piezas…»): lo atribuido no se presenta como el total. Sin captura, lo dice y liga al arqueo. Sin endpoint nuevo: sale de lo que el ranking ya traía.

**`[MKT.26]` Tiempo de carga — auditoría en prod con el código nuevo (sólo lectura, el servicio real en transacciones READ ONLY):**

| Llamada | Antes | Ahora (1ª vez) | Ahora (con caché) |
|---|---:|---:|---:|
| Ranking · Sucursales (mostrador) | **17–20 s** | 2.6–2.8 s | 1.4–1.8 s |
| Ranking · otros canales | 1.6–2.6 s | 2.1–3.7 s (carga del servidor) | 1.1–2.5 s |
| Objetivos · lista | **28 s** | 1.7 s | — |

Causas y arreglos: (1) en `productosDePromos` el planificador estimaba 1 fila para `co` (son ~27 mil) y la **recalculaba una vez por promoción** (61 × 255 ms) → `co AS MATERIALIZED`: 14.9 s → 1.4 s y 27.3 s → 1.4 s, **mismo resultado fila por fila** (948 y 1,203). Lo empeoró `[MKT.22]`: antes eran pocas promos dadas de alta, ahora son todas las de Kepler — **el #541 ya mergeado sale con los 17 s si se suelta sin esto**. (2) El ranking era UNA transacción con sus consultas en fila: ahora va en tramos cortos y en paralelo **sin anidar** (pool de 10: anidar podía trabar peticiones simultáneas), como `inventory-variance`; lo que no depende del proveedor se pide para todo el canal y se filtra en memoria. (3) Existencias desde el primer instante, para los 355 códigos como arreglo (0.8 s; como subconsulta `ANY(ARRAY(SELECT…))` el plan empeoraba a ~5 s — medido y descartado). (4) Caché del producto identificado con `TenantCacheService` (Redis, 10 min, ya existía en `libs/`). **Igualdad:** la salida del ranking antes/después en 9 casos (4 canales, filtros por proveedor, «sin», sucursales) es **idéntica** sin y con caché.

**Probado:** dominio 60 pruebas (12 nuevas: proveedor resuelto, sin columna = null, lista del filtro, asignar con/sin renglón, quitar, 400/404, 503 sin migración, ranking filtrado por proveedor y por «sin», control sin filtro); pantalla 82 (13 nuevas: filtro al servidor, etiqueta y portada, «sin», vendedoras por promo y lo atribuido, negativa sin captura, KPI y desglose, guardar en la celda, doble clic = una escritura, mismo proveedor = nada, falla 503 vuelve a lo guardado, sólo lectura). Después: dominio **65** (+5 del proveedor derivado: uno/varios/ninguno, lo asignado gana, `mismo_codigo` no deriva) y pantalla **83** (+1: el derivado es sugerencia, cuenta como con proveedor, elegirlo escribe). **Prueba negativa:** 5 mutaciones del dominio y 4 de la pantalla → rojo, restauradas → verde. `check:pantalla` 2 de 2 sin falla, tipan. La migración corrió **dos veces** contra `platform_local` (idempotente; FK creada).

**NO MEDIDO:** el arranque de la API con los decoradores y el constructor nuevos (`@Optional() TenantCacheService`, como margin-engine; no se levantó: lo mide el CI); los endpoints HTTP de punta a punta y la escritura del proveedor en prod (prohibido escribir en prod: probada en unitarias y la migración en local); la pantalla viva; el tiempo con varios usuarios a la vez; el peso de la respuesta en la red (mostrador ≈ 194 KB de JSON sin comprimir).

## 7. Pendiente / abierto

- ⚠️ Ratificación del PM (fase nueva en Fase 0) y fila en el roadmap.
- Aplicar la migración en prod (una sola, aditiva) **antes** de soltar el código.
- `[MKT.24]` Aplicar `20261113161815_mkt_ranking_promo_proveedor.js` (aditiva: una columna nullable + FK) **antes** de soltar; y que Mercadotecnia asigne el proveedor a las ~53 promos que no lo derivan del producto (de 108; el KPI «Sin proveedor» dice cuántas faltan). La alternativa para no capturarlo es que Compras dé de alta en Kepler cada promo con su proveedor real (hoy la cubeta «PROMOCIONES MKT»).
- `[MKT.26]` **Soltar el arreglo de velocidad junto con el #541 o antes:** con sólo el #541 el ranking de Sucursales tarda 17–20 s y Objetivos 28 s.
- **Revisar si se pagaron incentivos con la cifra mal calculada del Excel** (Winis MA, +$3,656.25, S31–S40) — fuera del sistema, con Finanzas.
- Preguntas a Mercadotecnia: ¿«por cliente distinto» es por semana o por vigencia? ¿«por exhibidor colocado» lo captura Mercadotecnia o la ruta? ¿el ranking de vecinal/ruta lleva objetivo por vendedor o por ruta?
- El alcance por sucursal (que el encargado vea sólo la suya) no está: hoy lo ve sólo quien tiene `MKT_AGREEMENTS_VER`.
