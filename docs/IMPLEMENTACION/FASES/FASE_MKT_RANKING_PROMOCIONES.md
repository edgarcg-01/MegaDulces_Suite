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

## 6h. `[MKT.27]` — buscar dentro del detalle, también con pistola (2026-11-17)

**Pedido (Mercadotecnia):** dentro del detalle de una sucursal (35 promociones en 8 Esquinas, semana 46) no había cómo encontrar una: «proveedor, producto, promoción, SKU, precio, todo en un buscador» y «que se pueda con lector de código de barras».

**Las cinco preguntas (diseño §0b):**
1. *Qué ve y en qué orden:* la frase del cumplimiento, el buscador y la tabla. El buscador arranca vacío y la tabla completa, en el orden del servidor (de más a menos cubrimiento).
2. *Qué no ve:* no se agregó otra barra de filtros. El filtro de venta de arriba ya llega al detalle; el buscador es uno solo.
3. *Accesibilidad:* encuentra por palabras en cualquier orden, sin acentos ni mayúsculas. Con la pistola, el Enter selecciona lo leído y la siguiente lectura lo reemplaza. «N de M» dice cuánto se ve, y si nada coincide lo dice con lo buscado.
4. *Ligas:* el proveedor (asignado o «del producto») se ve ahora en la fila, junto al código, para que una coincidencia por proveedor se entienda.
5. *¿Le toca a esta pantalla?* Sí. Es buscar dentro de lo que ya se muestra, sin datos nuevos de otra área.

**Cómo:**
- El backend manda **una vez por respuesta** `codigos_barras: { sku → códigos }`, de `catalog.product_barcodes` (principal y secundarios; Kepler y Wincaja), para los SKU que activan alguna promoción. Se lee en paralelo.
- Si esa lectura falla, el ranking sale igual con `codigos_barras: null`. La pantalla avisa «No se pudieron leer los códigos de barras» en vez de decir que no hay coincidencias.
- La pantalla reusa `app-scan-field` (la barra del Andén: pistola, cámara y tecleado; ya la usa Ubicaciones).
- Deuda con nombre: moverla a `shared/` (ADR-056). No se movió para no tocar los archivos del Andén en este cambio.

**Medido en prod (sólo lectura, `system_identifier` verificado):**
- Los 5 productos de la captura (control) tienen código; 2 traen también el de Wincaja.
- Los códigos de promoción no tienen código de barras: se encuentra la promoción por el producto que la activa, que es lo que se escanea en la tienda.
- **148 códigos de barras apuntan a más de un SKU**: escanear uno de ésos muestra todas las promociones que coinciden.
- En total: 9,083 códigos activos para 8,038 SKU.

**Imprimir lo filtrado (pedido el mismo día).** Junto al buscador, «Imprimir este detalle» (sin buscar) o «Imprimir lo filtrado». Es el PDF de siempre (`pdfRanking`) en modo `soloDetalle`:
- trae sólo la tabla del detalle con las MISMAS promociones que se ven (`reporteDetalle` usa `promosDelDetalle`);
- no trae las tablas de lugares, por promoción ni por vendedora, que son de toda la semana;
- la portada dice «Reporte filtrado», cada filtro de la pantalla, la sucursal o el vendedor, lo buscado y «Promociones: N de M»;
- el archivo se llama `RANKING-PROMOCIONES-S<n>-DETALLE-FILTRADO-…`.

Si nada coincide, el botón se apaga: no se imprime una hoja vacía. Cada renglón del detalle impreso dice ahora su proveedor (`proveedorPdf`, la misma redacción que la tabla por promoción), para que una búsqueda por proveedor se entienda en papel. Eso también agrega la línea al reporte de la semana.

**Precio: fuera de este cambio.** Ni la promoción ni el producto traen precio en el ranking, y no se ha verificado en Kepler de dónde sale el precio de una promoción (regla 10). Va aparte, después de investigarlo.

**Pruebas:**
- Dominio: 68 (+3: los códigos viajan una sola vez; si la lectura truena → `null` y el ranking sale; sin productos no consulta).
- Componente: 33 (+8: la pistola deja sólo su promoción y «1 de 2»; SKU, producto, código, proveedor y palabras en cualquier orden; lo que no coincide se dice; sin códigos se avisa; abrir otra sucursal vacía el buscador; el reporte lleva sólo lo que se ve y su portada; si nada coincide no hay reporte y el botón se apaga; sin buscar imprime el detalle completo).
- PDF: 9 (+2: el modo detalle trae una sola tabla con el proveedor por renglón y sin la nota de vendedoras; el reporte de la semana conserva sus 4 tablas).
- Pruebas negativas: devolver `{}` en vez de `null`; quitar los códigos de la búsqueda; imprimir las tablas de la semana en el modo detalle; armar el reporte con todas las promociones en vez de las filtradas → rojo; restaurado → verde.
- Compuertas: `check:pantalla` 2 de 2 sin fallas (tipa); lint con 0 errores.

**NO MEDIDO:** la pantalla viva (sin validación visual); la pistola y la cámara en un equipo real; el arranque de la API (`Logger` nuevo como campo, el constructor no cambió; lo mide el CI); el peso que agregan los códigos a la respuesta.

## 6i. `[MKT.28]` — Vecinal, Rutas y Telemarketing por vendedor (2026-11-18)

**Pedido:** «hay que desglosarlos por vendedor, creo que ahora lo generalizas» y cambiar Televenta a Telemarketing.

**Lo medido en prod (sólo lectura, semana 46):**
- **Vecinal:** 8 claves de Kepler (`1V001`, `2V003`…), una por ruta. 5 de 8 tienen nombre de ruta («RUTA VECINAL …»), no de persona: por eso se veía «generalizado».
- **Cartera como control:** las 9 rutas vecinales ligadas en `trade.catalogs` (`[VK.1]`) compran 97–100 % de sus tickets (4 semanas) en su propia clave. La liga es buena.
- **Asignación:** 8 de 9 rutas tienen una sola persona toda la semana; `07:2V003` tiene 2 (una de apoyo). Nadie trabaja dos rutas.
- **Rutas:** toda la venta va a una sola clave (`06:30001`) y una sola caja. La ruta real está en `kdm1.c67`: 5001 (195 tickets en la semana, 654 en 8 semanas) y 5004 (2 y 20). Las demás (5002–5009) no vendieron en 8 semanas.
- `commercial.order_kepler_documents` (liga pedido ↔ documento) no sirve para esto: 14 ligas, todas del 16-oct, ninguna de la semana.

**Qué cambió:**
- El nombre de cada vendedor sale de quién tiene asignada esa ruta en la Suite (`trade.catalogs.erp_vendor_code` → `daily_assignments` → `users.nombre`). Debajo: sucursal, ruta de Kepler y apoyo. Se busca también por ruta.
- Ruta sin ligar: queda el nombre de Kepler y la pantalla dice «ruta sin ligar en la Suite: nombre de Kepler». En el PDF, «(sin ligar: nombre de Kepler)».
- Si la asignación no se puede leer, el ranking sale igual con el nombre de Kepler.
- «Televenta» → «Telemarketing» en Ranking, Objetivos, Incentivos y el PDF.

**⚠️ Límite:** `daily_assignments` es la plantilla de HOY, sin historial. En una semana pasada, si cambiaron a alguien de ruta, sale quien la tiene hoy. Está dicho en el criterio.

**Rutas: lo que falta para ligarla** (no se hizo; no se adivina):
1. Saber qué ruta de la Suite es la 5001 de Kepler (y la 5004). Los clientes de las rutas 501–505 no tienen clave de Kepler, así que el dato no lo prueba: lo tiene que confirmar Canindo o Logística.
2. «RUTA 501» está **duplicada** en el catálogo, con una persona asignada en cada una.
3. No hay pantalla para poner la clave de Kepler a una ruta. Hoy sólo se lee.
4. Si se liga `06:30001` a una sola ruta, la venta de la 5004 (~3 %) se le atribuye. Separarlas bien pide la `c67` en la vista de venta (migración) y los objetivos por esa llave.

**Pruebas:** dominio 76 (+8: a quién se nombra por una ruta, empate estable, nadie asignado → null; ruta ligada → persona con ruta y apoyo; sin ligar → nombre de Kepler dicho; la asignación truena → sale igual; mostrador no consulta; Telemarketing). Componente 35 (+2) y PDF 10 (+1). Mutaciones: usar el nombre de Kepler; quitar el aviso «sin ligar» → rojo.

**NO MEDIDO:** la pantalla viva; el nombre real que sale para cada ruta en prod (se probó con datos simulados); el peso de la consulta de asignación (es una lectura chica, no se midió el tiempo).

## 6j. `[MKT.29]` — Rutas por camioneta, y quién trabaja la ruta (2026-11-18)

**Pedido:** «busca la forma de que ligues todas las rutas… audita y busca la forma de sacar las ventas de cada vendedor de ruta directa». **Supera la parte de Rutas de §6i:** la respuesta no estaba en Kepler central sino en el push de las camionetas, que ya usaba `/comercial/ventas-por-ruta`.

**Lo que ya existía (leído en docs y código, no se reconstruyó):**
- `analytics.v_route_sales_lines`: la venta por renglón de cada camioneta (cada una corre su Kepler y lo sube). La usan Ventas por ruta y el motor de comisiones de RD; se contrastó contra el Excel de comisiones (312 celdas, razón 1.0001, cobertura de agosto ~85 %; `FASE_RD_INDICADORES_RUTA.md` §2.4a).
- `wincaja.branches` (`is_route`, `parent_branch`): la sucursal de cada camioneta, igual que en Ventas por ruta.
- `routeDrivers` (Ventas por ruta): el chofer por la comisión o el nombre de Kepler.

**Lo medido en prod (sólo lectura, 2026-11-18):**

| Pregunta | Resultado |
|---|---|
| ¿`06:30001` es la misma venta que el push 501–505? | **No.** 9 de 24 días, 1 cliente por día, 13–33 piezas por ticket; gemelos por renglón (día+SKU+cantidad) 521 de 2,484 contra **418 del placebo** (rutas de otra plaza). Se suma, no se reemplaza |
| ¿Misma unidad? | Precio unitario en la misma escala en 966 de 971 SKU |
| ¿Fuente `wincaja` todavía? | No: desde septiembre la ruta directa llega sólo por push (4 renglones con fecha de diciembre, basura) |
| Sucursal de cada camioneta | 21–28 → `01`; 501–505 → `06`; 321/322 → `07` (sin venta en vivo) |
| Liga de las RD en la Suite | 0 de 15 con `erp_*`: sólo la etiqueta («RUTA 501» ×2, «502» a secas además de «RUTA 502») |
| Costo | 115 ms la semana; 198 ms cinco semanas; sin tenant en la sesión, 0 filas |

**Qué cambió:**
- En Rutas, cada camioneta es un participante (`ruta:<número>`) con su venta, sus objetivos dinámicos (historia del push) y las promos que sólo ella vendió. `06:30001` sigue como participante propio.
- `libs/commercial/src/lib/rutas/quien-trabaja-la-ruta.ts`: **una** respuesta para el ranking y Ventas por ruta. Orden: **comisión → asignación de la Suite → nombre de persona en Kepler → nadie**. Las personas asignadas que no son el chofer de comisión se devuelven aparte (se ven: «asignado en la Suite: …»). Una clave de Kepler con sucursal no usa la liga por etiqueta (el vendedor «21» de una sucursal no es la camioneta «RUTA 21»); con la misma clave en dos sucursales y nada para desempatar, no se adivina.
- Camioneta sin nadie: «Ruta N» y «sin chofer en la comisión ni en la Suite» (`vendedor_fuente: sin_dato`).

**Antes / después (semana 46):** Rutas **1 participante, 27 piezas de promo → 10 participantes, 159 piezas**. Sobre 17 rutas, el nombre: ningún nombre de comisión cambia; 505, 1V001, 1V003, 1V004 y 3V001 pasan de «sin chofer» a la asignación; 2V005 pasa del nombre de Kepler a la persona asignada (otra); en el ranking, 1V002 pasa de la asignada al chofer de comisión (la asignada se ve aparte).

**⚠️ Para Comercial (conflictos de captura, no de código):** 21 y 1V002 (comisión ≠ asignación) · 2V005 (Kepler ≠ asignación) · 505 sin chofer de comisión · «RUTA 501» y «502» duplicadas en el catálogo. Corrección a lo dicho antes en esta sesión: 502 **sí** tiene personas asignadas (en la fila «502» a secas).

**Pruebas:** `quien-trabaja-la-ruta.spec.ts` 13 (orden de fuentes, nombres capturados a mano, etiquetas, ligas, no adivinar); `mkt-ranking.vendedor.spec.ts` 15 (+7: camionetas con su venta y chofer, `06:30001` se suma, sin chofer lo dice, promo sólo de camionetas, objetivo dinámico del push, la clave «01:21» no toma la etiqueta «RUTA 21», Vecinal no lee el push); componente +1; PDF +1. Mutaciones (asignación antes que comisión; camionetas fuera de la venta; la etiqueta casa con claves de Kepler) → 9 rojos; restauradas → verde. Compuertas: `check:pantalla` 2 de 2 sin fallas; lint 0 errores; `tsc` sin errores en los archivos tocados.

**NO MEDIDO:** la pantalla viva; el arranque de la API (no cambian decoradores ni el constructor); **Incentivos** con canal Rutas sigue leyendo sólo Kepler central (sin camionetas): pendiente.

## 6k. `[MKT.30]`–`[MKT.31]` — el ranking por VOLUMEN y el DINERO de la promoción (2026-11-18, C0)

**Re-análisis con el dev responsable.** La finalidad de la pantalla, en sus palabras: *«revisar cuánto se va vendiendo de todas las promociones (piezas o paquetes), cuánto dinero, cuál es la más vendida y quién vendió más, en persona»*. Hoy la pantalla contesta otra pregunta (*¿quién cumplió su meta?*, la del Excel): ordena por cubrimiento (`ordenarRanking`, logic:115), «Mejor promoción» es la de mejor cubrimiento, no hay total de la semana y no hay dinero.

| # | Decisión (dev responsable, 2026-11-18) |
|---|---|
| D1 | Dinero = lo **cobrado** del SKU que activa la promoción, en los tickets donde se aplicó (`kdm2.c13`, con impuestos), todos sus renglones del ticket |
| D2 | Promoción sin producto identificado = **«sin dato»**, y el total lleva su cobertura; nunca $0 |
| D3 | Lo principal pasa a ser el volumen (opción A); el cubrimiento queda como columna. **Lo confirma el dev con Mercadotecnia** antes de cambiar el orden de la pantalla |

**Medido en prod (sólo lectura, `system_identifier` verificado, 2026-11-18; semana 46 = 9–15 nov, mostrador; el producto con el código real `productosDePromos`):**

| Qué | Resultado |
|---|---|
| Promociones con venta | 67, **1,537 aplicaciones** |
| Producto identificado | 45 ticket+nombre · 2 mismo código · **13 sin identificar · 7 pocos tickets** |
| Con dinero en la semana | 44 de 67 (3 identificadas no salieron con su producto en el mismo ticket esa semana) |
| Dinero cobrado (sin doble conteo) | **$111,337.44** · sumado por promoción $113,251.41 (un renglón puede activar dos promociones: el total general se cuenta sin repetir) |
| A precio de lista (`kdm2.c66` × cantidad) | $118,382.62 → lo cobrado es ~6 % menos |
| Control de unidad (`precio × cantidad = importe`) | 629 de 629 |
| Producto > total del ticket | 0 de 368 tickets |
| Árbitro `kdm1.c16` en los 658 tickets con promoción | Σ renglones $1,182,642.48 vs Σ total $1,182,500.29 (0.012 %) |
| Más dinero | 62253 «3 PROD LA ROSA» $27,464.80 (157 apl.) · 09015 «4 EXH MINI PPR» $14,119.44 · 00209 «5 EXH ORBIT» $12,297.86 |

**⚠️ Hallazgo, revisado a mano en `kdm2` (ticket 08-4-0007170):** en una promoción **de marca** («3 PROD LA ROSA») el ticket trae 10 productos La Rosa por **$566.42**, pero la medición contó **$193.61**: sólo los SKU que la identificación eligió (`MAX_PRODUCTOS`, los más frecuentes). En promociones de un solo producto («3 LECHE SAN JUAN») no pasa. Queda abierto cómo contar las de marca (D5).

**Opción D medida (mismo día, sólo lectura): «al menos» = SKU identificados; nota = otros productos de la MISMA marca del catálogo (`catalog.products.brand_id`, nunca el nombre) en esos tickets.** Control con resultado conocido, ticket 08-4-0007170: **$193.61 y $372.81 en 7 renglones, exacto**. La marca del catálogo, en el control de La Rosa: 13 de 13 SKU con la misma marca y el mismo proveedor; buscar por nombre falla en los dos sentidos (43 SKU de la marca sin «ROSA» en el nombre; 184 con «ROSA» de otra marca). En este catálogo la marca es, en la práctica, la del distribuidor.

| Clase (por los SKU identificados) | Promociones | «Al menos» |
|---|---:|---:|
| Un producto | 16 | $22,412.35 |
| Varios, una marca | 25 | $75,202.87 |
| Varios, varias marcas | 6 | $15,636.19 |
| Sin dato | 20 | — |
| **Total sin doble conteo** | **67** | **$111,337.44** (igual a la primera medición) |

Nota de marca de la semana: $63,661.17. Lectura de los renglones de los tickets: 2.1 s, 15,952 renglones.

**Lo que enseña la medición (por qué D sola no basta):**
- En una promoción de MARCA la nota es real y grande: «3 PROD LA ROSA» al menos $27,464.80 **+ $44,507.19** de La Rosa en 81 de 86 tickets.
- En una promoción de PRODUCTO específico la nota es ruido: «5 EXH ORBIT» suma $4,038.63 de otros productos de su distribuidor; «1 BLS KISSES LECHE 807 GR», $471.47 de otros Hershey. El sistema no puede distinguir los dos casos sin la lista de la promoción (leer el nombre está prohibido, regla 10). → **La nota de la semana ($63,661.17) NO se publica como total.**
- En «varias marcas» la identificación pudo admitir un producto que no es de la promoción (09015 «4 EXH MINI PPR», $14,119.44, con SKU de 3 distribuidores): ahí «al menos» **no está garantizado como piso**.
- Hay tickets con la promoción y producto de la marca, pero sin ningún SKU identificado: aportan $0 al «al menos» (00126: 1 ticket con SKU identificado, 3 con nota).
- **Uso real (prod, sólo lectura, 2026-11-18):** `mkt_incentives` **0 reglas**, `mkt_incentive_captures` 0, `mkt_ranking_objectives` **0 objetivos fijados**, `mkt_ranking_promos` 0 renglones; `ui_usage` 30 días: Ranking 104 llamadas (marketing, telemarketing, administrativo), Objetivos e Incentivos sólo administrativo/superadmin. Las metas y los «pesos por caja» existen pero viven en pantallas que Mercadotecnia no abre → en la propuesta ágil se capturan **dentro del detalle de la promoción** (objetivo por sucursal e incentivo «$X por caja vendida», reusando el motor de `[MKT.13]`, sin tabla nueva).
- Conclusión: con 31 de 67 promociones de varios productos y 20 sin dato, **la lista confirmada por Mercadotecnia (opción E) es la única que da el dinero exacto**; D sirve de puente si la nota va sólo en el detalle de cada promoción.

**NO MEDIDO:** Vecinal, Rutas (push) y Telemarketing (puede traer descuento de documento, `kdm1.c13`); el tiempo con el código de la pantalla (el script de medición tardó 36 s y no está optimizado).

## 6l. Auditoría de «pesos por caja» (2026-11-18, C0/C1, sin código)

**Pedido:** «investiga si se pueden sacar los pesos por caja; funciona como una comisión a cada vendedor; estaba en los Excel». Fuente leída: los Excel SEMANA 35, 36 y 37 de Mercadotecnia (bloques «PESOS POR CAJAS», con fórmulas), la auditoría de los 45 archivos del 2026-11-11 (§1) y el motor de `[MKT.13]` (`mkt-ranking.service.ts`, `resultadoIncentivo`).

**Qué es en el Excel.** Un bloque aparte del ranking, por hoja: `FECHA` (vigencia) · regla en texto · `VENTA` (semana) · `ACUM` (desde el inicio de la vigencia) · `$ DINERO` = `ACUM × monto`, tecleado a mano. ⭐ **No va ligado a un código de promoción sino a PRODUCTOS reales de Kepler** (el texto trae «CODS: …» o una marca/línea). Se paga a la sucursal, a su jefe, a una persona del mostrador, a cada ruta o al jefe de zona: un bloque por beneficiario.

| Regla que aparece | ¿La calcula el motor `[MKT.13]`? |
|---|---|
| $X por caja vendida de un producto/marca | ✅ `por_caja`: unidades base ÷ `factor_caja` de la ficha de Kepler de esa sucursal; sin factor → «sin factor», no se paga |
| $X por cada N piezas (p. ej. 60), aunque la caja de Kepler sea otra | ⚠️ no: falta «cada N unidades» (hoy sólo `por_monto` lleva base) |
| $X por bolsa / por unidad | ✅ `por_unidad` (⚠️ «bolsa» puede no ser la unidad base: probar la unidad) |
| $X por cliente distinto / por tienda a la que se le venda | 🟡 `por_cliente`, pero cuenta por semana; el Excel acumula en la vigencia |
| $X por cada venta realizada (ticket) | ❌ no existe |
| $X al mes por cliente que compre ≥ $500 de una marca | ❌ no existe (umbral por cliente) |
| Concurso: monto fijo al que más venda / al jefe que cumpla | ❌ no es «por caja»; queda fuera |

**Defectos del Excel que el motor ya evita:** el multiplicador de `$ DINERO` distinto al del texto (Winis ×100 con «$25»; un concurso multiplicado ×20; Rondix ×1 en una hoja con «$30»); `VENTA` en piezas en una hoja y en cajas en otra para la misma regla; `ACUM` igual a `VENTA`; códigos tecleados mal (95498 por 96498).

**Huecos para «a cada vendedor»:** (1) el motor agrupa por sucursal × clave de vendedor de la línea de Kepler: en mostrador depende de que se capture la vendedora (cobertura **NO MEDIDA**); (2) **Ruta directa: el motor no lee el push de las camionetas** (ya anotado en §6j); (3) jefe de sucursal o de zona no está en el dato (sería el total de la sucursal o de la zona); (4) el objetivo se guarda por `promo_id` de `mkt_ranking_promos` (0 renglones), y con la opción A las promociones ya no se dan de alta: `[MKT.30]` debe resolver esa llave.

⭐ **Implicación de diseño:** el incentivo es de un **producto**, no de una promoción. Ponerlo dentro del detalle de la promoción (maqueta v11) no calza con cómo lo usa Mercadotecnia → decisión abierta con el dev responsable.

**NO MEDIDO (prod sin responder el 2026-11-18 noche):** el arbitraje `VENTA/ACUM` del Excel contra unidades ÷ `factor_caja` (Rondix y Sabritas, semanas 35–36, sucursales 01/02/06; script listo en el scratchpad de la sesión, `arbitra-pesos-caja.js`); si el `factor_caja` de Kepler coincide con el «/N» del nombre; cuánto venden las camionetas de esos productos.

## 6m. `[MKT.30]`–`[MKT.31]` — construido: dos rankings que no se mezclan (2026-11-19, C1–C3)

**Pedido (dev responsable, sobre la maqueta v14):** «desarróllalo y manda el PR». Decisiones del mismo día: un solo PR con `[MKT.28]`/`[MKT.29]`; el dinero se programa y el de los canales sin contrastar se DECLARA y se contrasta antes del merge; los «pesos por caja» quedan fuera (§6l, van después).

**La regla del dev (2026-11-18):** el ranking de PROMOCIONES cuenta toda la venta y se filtra por canal, sucursal o zona; el ranking de VENDEDORES cuenta sólo lo que se le cargó a cada uno. Son dos preguntas; la promoción ya no dice «quién la vendió» y el ranking de promociones ya no filtra por vendedor.

| Capa | Pieza | Verificado con |
|---|---|---|
| C1 | `libs/commercial/src/lib/mkt-ranking/mkt-venta.logic.ts` — `armarRankings`: paquetes, dinero (piso, sin repetir un producto que active dos promos en los totales), objetivo y avance dentro del filtro, sucursal #1, vendedores con precio y total, tickets de mostrador sin asignar | `mkt-venta.logic.spec.ts` 11 casos con resultado conocido (total 310 contra 350 sumando por promo; «Sin zona»; lo no asignado no es de nadie) |
| C2 | `GET /commercial/mkt-ranking/venta?semana&canal&sucursal&zona` (sólo lectura, `MKT_AGREEMENTS_VER`, sin claves nuevas); `venta()` en `mkt-ranking.service.ts`: línea de Kepler de los tickets con promo (sólo promos y sus productos), camionetas por folio (push), cajera (`mkt_promo_ticket_sellers`), objetivos (fijo gana, si no el dinámico), zona (`warehouses.zone_id` → `trade.zones`), proveedor y códigos de barras | `mkt-ranking.venta.spec.ts` 12 casos (llave del ticket con espacios, cajera, camioneta, vecinal ligada y sin ligar, objetivo fijo/mixto, barras que fallan → `null`) |
| C3 | `/mkt/ranking` reescrita (`mkt-ranking.component.ts`, mismo selector y ruta): pestañas Ranking de promociones / de vendedores, filtros canal · sucursal · zona, ficha de la promo (por canal, por sucursal o zona) y del vendedor (promo · paquetes · precio · total), panel **Objetivos** (PUT `promos/:id/objetivos` de siempre, mostrador, todas las sucursales donde se vende), PDF de la pestaña (`mkt-venta-pdf.ts`) | componente 15 casos (escribe el PUT con el payload exacto; vacío = `null`; sin permiso no escribe; falla → lo escrito se queda), PDF 4; `check:pantalla` 0 fallas (el aviso #9 se cerró con `@container`); `check:templates` y `check:templates-types` verdes |

**Prueba negativa:** 4 mutaciones (total con doble conteo · sin producto = $0 · mostrador cargado al genérico de Kepler · la pantalla pinta $0) → las 4 en rojo; restauradas → verde.

**Lo que se conserva y lo que se va:** se conservan la búsqueda con pistola (`[MKT.27]`), el proveedor en el buscador (`[MKT.24]`), el calendario por semana, Objetivos por sucursal (`/mkt/ranking/promociones`) e Incentivos. Se van de esta pantalla la lectura con la **cámara** del celular (el buscador es un campo simple: la pistola escribe en él y funciona; `app-scan-field` del Andén ya no se monta aquí), el lugar por cubrimiento, el filtro por proveedor (queda en el buscador) y la existencia de regalos; el PDF anterior (`pdfRanking`) queda sin usar en el código, sin borrarlo.

**NO MEDIDO:** la pantalla viva y el tiempo de `venta()` en prod (prod no respondía el 2026-11-19); el dinero de Ruta vecinal, Ruta directa y Telemarketing contra `kdm1.c16` (declarado en pantalla y PDF con `DINERO_CONTRASTADO`; se contrasta antes del merge); el arranque de la API (se agregó un método al controlador sin tocar el constructor); el texto de la ayuda contextual `mkt-ranking` todavía describe el ranking por cubrimiento (`context-help.dictionary.ts` tiene cambios sin commitear de otra sesión: no se tocó).

## 7. Pendiente / abierto

- `[MKT.29]` **Incentivos con canal Rutas** sin las camionetas (`resultadoIncentivo` lee sólo `v_kepler_sales_lines`/`mv_kepler_sales_daily`). Y pasar a Comercial los conflictos de captura de §6j.

- `[MKT.27]` **Buscar por precio:** investigar en Kepler el precio de una promoción (o el de lista del producto), contrastarlo contra lo cobrado y, si se valida, agregarlo al buscador.

- ⚠️ Ratificación del PM (fase nueva en Fase 0) y fila en el roadmap.
- Aplicar la migración en prod (una sola, aditiva) **antes** de soltar el código.
- `[MKT.24]` Aplicar `20261113161815_mkt_ranking_promo_proveedor.js` (aditiva: una columna nullable + FK) **antes** de soltar; y que Mercadotecnia asigne el proveedor a las ~53 promos que no lo derivan del producto (de 108; el KPI «Sin proveedor» dice cuántas faltan). La alternativa para no capturarlo es que Compras dé de alta en Kepler cada promo con su proveedor real (hoy la cubeta «PROMOCIONES MKT»).
- `[MKT.26]` **Soltar el arreglo de velocidad junto con el #541 o antes:** con sólo el #541 el ranking de Sucursales tarda 17–20 s y Objetivos 28 s.
- **Revisar si se pagaron incentivos con la cifra mal calculada del Excel** (Winis MA, +$3,656.25, S31–S40) — fuera del sistema, con Finanzas.
- Preguntas a Mercadotecnia: ¿«por cliente distinto» es por semana o por vigencia? ¿«por exhibidor colocado» lo captura Mercadotecnia o la ruta? ¿el ranking de vecinal/ruta lleva objetivo por vendedor o por ruta?
- El alcance por sucursal (que el encargado vea sólo la suya) no está: hoy lo ve sólo quien tiene `MKT_AGREEMENTS_VER`.
