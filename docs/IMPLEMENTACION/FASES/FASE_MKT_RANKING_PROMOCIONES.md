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

## 7. Pendiente / abierto

- ⚠️ Ratificación del PM (fase nueva en Fase 0) y fila en el roadmap.
- Aplicar la migración en prod (una sola, aditiva) **antes** de soltar el código.
- **Revisar si se pagaron incentivos con la cifra mal calculada del Excel** (Winis MA, +$3,656.25, S31–S40) — fuera del sistema, con Finanzas.
- Preguntas a Mercadotecnia: ¿«por cliente distinto» es por semana o por vigencia? ¿«por exhibidor colocado» lo captura Mercadotecnia o la ruta? ¿el ranking de vecinal/ruta lleva objetivo por vendedor o por ruta?
- El alcance por sucursal (que el encargado vea sólo la suya) no está: hoy lo ve sólo quien tiene `MKT_AGREEMENTS_VER`.
