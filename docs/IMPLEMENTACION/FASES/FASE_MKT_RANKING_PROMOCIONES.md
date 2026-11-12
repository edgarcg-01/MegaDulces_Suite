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

## 7. Pendiente / abierto

- ⚠️ Ratificación del PM (fase nueva en Fase 0) y fila en el roadmap.
- Aplicar la migración en prod (una sola, aditiva) **antes** de soltar el código.
- **Revisar si se pagaron incentivos con la cifra mal calculada del Excel** (Winis MA, +$3,656.25, S31–S40) — fuera del sistema, con Finanzas.
- Preguntas a Mercadotecnia: ¿«por cliente distinto» es por semana o por vigencia? ¿«por exhibidor colocado» lo captura Mercadotecnia o la ruta? ¿el ranking de vecinal/ruta lleva objetivo por vendedor o por ruta?
- El alcance por sucursal (que el encargado vea sólo la suya) no está: hoy lo ve sólo quien tiene `MKT_AGREEMENTS_VER`.
