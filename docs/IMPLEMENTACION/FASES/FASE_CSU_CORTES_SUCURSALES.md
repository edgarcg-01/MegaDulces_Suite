# Fase CSU — Cortes/Sucursales (corte de caja → cobro → ingreso a la empresa)

> Pedido por Francisco el 2026-10-05: *"monitorear los cortes y cobros; que el dinero que se
> cobró por corte llegue como ingreso a la empresa y amarrar la conciliación bancaria, más el
> corte, más el cobro en sistema"*. Pantalla `/finanzas/cortes-sucursales`, sección nueva
> **Ingresos** del menú de Finanzas.

## 1. Qué sigue el módulo

```
 1. CORTE (Kepler U-D-23)      2. COBRO (Kepler U-A-5)        3. INGRESO REAL (entrega 2)
 Corte de Caja POS       ──►   Cobro PUE aplicado al    ──►   abono en el estado de cuenta /
 cargo al cliente CONTADO      corte (kdm5)                   efectivo por Caja Fuerte → depósito
 "se vendió y se contó"        "se registró que entró"        "llegó a la empresa"
```

Sólo lectura sobre Kepler: el cobro se sigue capturando en el ERP. Derivado del ODS, sin
importer ni tabla nueva (regla principal del proyecto).

## 2. Decode — medido en prod el 2026-10-05 (no supuesto)

| Qué | Dónde | Verificado contra |
|---|---|---|
| Corte | `kepler_ods.kdue` `c29='C'`, `c4=23`, `c5=1`, `btrim(c2)='CONTADO'`. `c6` folio, `c7` fecha, `c11` importe, `c16` = `Caja <caja>-<folio de arqueo>` | Pantalla "Alta de cobro" de Kepler, Zamora Centro: los 10 documentos y sus saldos al centavo |
| Cobro aplicado | `kepler_ods.kdm5` con `c8='D'`, `c9=23`, `c10=1`, `c11`=folio del corte; `c3/c4/c5/c6` = el cobro (`UA0501-…`), `c13` monto | Cobro `UA0501-0000003` ($1,907.62) de la pantalla "Consultar cobro"; saldo previo $11,010.30 reproducido |
| Forma de pago / concepto del cobro | `analytics.erp_collections` por `(sucursal, doc_prefix, folio)` | — |
| Arqueo del turno | `analytics.cash_cuts` por `(warehouse_code, caja, folio)` | 108 de 110 cortes de oct-2026 encuentran su arqueo |

**Hallazgos que definieron la lógica:**

1. **El monto del corte es lo que CONTÓ el cajero**, no lo que vendió (efectivo + tarjeta +
   transferencia del arqueo): 91 de 121 pares iguales al centavo contra lo contado y 73 contra lo
   esperado. Por eso la caja 5-151 de Zamora Centro (02-oct) tiene corte de $1,203.36 contra
   $10,203.36 vendidos: el POS esperaba $10,067.30 de efectivo y se contaron $1,067.30. **Faltan
   $9,000.00 en el arqueo**, y el corte los arrastra.
2. **El cuadre se hace por TURNO, no por día.** Contra los tickets del día salían diferencias falsas
   de +$85,262 (Hidalgo caja 1) y −$91,413 (Abastos caja 5) porque el turno cruza la medianoche.
3. **El folio de arqueo se repite entre fechas** (Hidalgo caja 1 folio 93: 22-sep, 28-sep y
   2-oct). Se casa con la fecha más cercana dentro de ±3 días, nunca con cualquiera.
4. **El corte U-D-23 arrancó con el cambio del 1-oct-2026**: en septiembre sólo hay 5 (Hidalgo).
   La pantalla lo avisa si el periodo es anterior.
5. **Se aplican cobros al corte equivocado**: en Zamora, $1,907.62 y $421.63 son tarjeta y
   transferencia del turno 5-149 y se aplicaron al corte de la caja 4-199.

**Foto 1–5 oct 2026 (8 sucursales):** 105 cortes por **$4,531,431.68**, cobrado en Kepler
**$66,210.22 (1.5%)**, pendiente **$4,465,221.46**; 25 cortes con diferencia contra su arqueo,
1 sin arqueo, 5 cortes en blanco (< $1) declarados aparte.

## 3. Reglas del motor (`cortes-sucursales.engine.ts`)

- **Estado de cobro**: `sin_cobro` · `parcial` · `cobrado` · `sobrecobrado` (saldo = monto − Σ cobros).
- **Cuadre contra el arqueo del turno** (tolerancia $1): `cuadra` (= esperado) · `faltante_arqueo`
  / `sobrante_arqueo` (corte = contado y contado ≠ esperado) · `corte_distinto` · `sin_arqueo`.
  ⛔ Sin arqueo **nunca** es "cuadra" (prueba negativa en el spec).
- Cortes de menos de $1 (cierre de caja sin venta) no se listan; se **declaran** en el conteo.

## 4. Filtro de fechas

Mes (por defecto el **mes en curso**, hora de México) o **rango específico** (`from`+`to`), que
manda sobre el mes. Costo medido: un mes completo (106 cortes), **630–750 ms en caliente**; el plan usa índice en `kdue`, `kdm5` y `cash_cuts`, y casi todo el tiempo es la vista `analytics.erp_collections` (forma de pago del cobro).

## 5. Items

- [x] **[CSU.0]** Decode y medición en prod (este documento §2). ✅ 2026-10-05
- [x] **[CSU.1]** Backend `GET /finance/cortes-sucursales` (`libs/finance/src/lib/cortes-sucursales/`),
  contrato `cortes-sucursales.contract.ts`, permiso `FINANCE_CORTES_VER` + migración
  `20261005200000` que lo reparte calcando `FINANCE_INCOME_VER` (11 roles). Motor puro con 10
  pruebas, incluida la negativa. 🧪 2026-10-05
- [x] **[CSU.2]** Pantalla `/finanzas/cortes-sucursales`: resumen, tabla por sucursal, cortes de la
  sucursal y detalle (arqueo esperado/contado por forma de pago + cobros aplicados). Sección nueva
  **Ingresos** en el menú (Cortes/Sucursales · Ingresos contables · Crédito). 🧪 2026-10-05
- [x] **[CSU.6]** **Quién ve qué** (decisión de Francisco, 2026-10-05): Finanzas, todas las
  sucursales; encargados y auxiliares de tienda, **sólo la suya**. Lo decide `ScopeService`
  (ADR-050, el mismo del arqueo de tienda) con `role_scopes`/`user_scopes`, no un `if` por rol
  ni un `_VER_ALL`. La migración nueva `20261005210000` suma `encargado_tienda` y `auxiliar_tienda`
  al permiso (va aparte: `20261005200000` ya está en `main` y no se modifica). La
  respuesta trae `alcance` y la pantalla lo dice ("Viendo sólo tu sucursal: 05 Zamora Centro") o
  avisa si la ficha no tiene sucursal. **Medido en prod con el servicio real** (148 usuarios
  activos, 44 con acceso): 31 de 32 de Finanzas → todas; `jlh_lopez` (vendedor de ruta con
  superadmin como complemento) → sólo 04, porque el alcance toma el rol principal; 11 de 12 de
  tienda → su sucursal; `yadira_campero` → ninguna (sin `warehouse_code`; asignarla en
  Personas). Excepciones personales sobre INCOME/CORTES: 0. La API relee permisos cada 30 s; el
  menú necesita re-login. 🧪 2026-10-05
- [x] **[CSU.7]** **Devoluciones pagadas en caja** (pedido de Francisco al revisar Zamora `Caja 2-171`,
  "Corte distinto −$179.92"). El arqueo de Kepler (`kdpv_folio_caja`) espera la venta **bruta** del
  turno; el corte `U-D-23` ya **resta** las notas de crédito POS pagadas en esa caja. Son dos
  documentos: `U-A-21-1` "Nota Créd/Dev POS" (fiscal) y `U-A-25-1` "Nota Créd/Dev NoFis POS",
  ligados al turno por `kdm1.c81` (caja) + `kdm1.c80` (folio de turno), ±1 día porque el folio de
  turno se repite entre fechas. Ej.: esperado $12,908.53 − `UA2101-0000071` $179.92 = corte
  $12,728.61. **Medido en prod con el motor real, 1–8 oct-2026 (los 196 cortes con arqueo que lista la pantalla):** cuadraban 141; con el esperado
  neto cuadran **184** («con diferencia» baja de 55 a 12) — incluidos los "Faltante en arqueo" de Madero 4-28 (−$2,641.97) y Abastos
  3-12 (−$3,450.52), que eran devoluciones. `U-A-35-1` también trae caja pero no explica ningún
  corte: fuera. Un caso (Madero 2-23) tiene devolución y el corte salió por el bruto: se acepta
  como `cuadra` contra el bruto y la pantalla lo dice ("Kepler no la descontó en este corte");
  ⚠️ ese respaldo va antes del chequeo contra lo contado, así que en ese caso un faltante del
  arqueo no se ve (igual que antes del cambio). **Declarado, no resuelto:** hay devoluciones POS
  sin caja o sin turno en Kepler (38 desde el 24-sep; p. ej. una de Yurécuaro por $937.06) que no
  casan con ningún corte, y las devoluciones sólo se pintan cuando el corte tiene arqueo. Quedan 9 `corte_distinto`, casi todos con el corte **arriba** de
  lo esperado (Abastos, hasta +$18,141.81): otra causa, sin investigar. El detalle muestra cada
  devolución (cliente y motivo) y el "esperado neto". Motor 17 pruebas, mutación verificada (4
  rojas con el bruto). Sin migración ni permisos. ⚠️ La consulta del mes tarda **~6 s** contra prod
  **desde antes de este cambio** (la parte de devoluciones cuesta ~36 ms); el "630–750 ms" de
  CSU.1 quedó viejo — revisar aparte. 🧪 2026-10-08
- [x] **[CSU.10]** **Rendimiento: la pantalla tarda demasiado y el personal reporta que «no sirve»**
  (objetivo pedido: **≤ 0.5 s**). Sólo forma, **ninguna cifra cambia**: la vista
  `analytics.erp_collections` (DISTINCT ON sobre todos los cobros de la historia) se evaluaba
  **por cada corte** dentro de un LATERAL; ahora se consulta **una vez** con la lista exacta de cobros
  y se casa en memoria. `ap` se arma desde el corte (entra completo a `ix_kdm5_aplicacion_factura`) y
  `dv` repite sus filtros con la forma de `ix_kdm1_abono_doc` (redundantes, con AND). Paridad
  vieja↔nueva **idéntica campo por campo** en la base local `:5442` con fixtures (réplica cruzada,
  folio repetido entre sucursales, cobro sin vista, devolución cancelada/fuera de fecha/U-A-35), y
  la prueba negativa (quitar el casado por folio) se pone roja. 27/27 del motor en verde.
  **Medido en banco LOCAL a escala de prod** (`:5442`, PG 18.6, todo en una transacción con
  ROLLBACK: `kdm1` 880,697 filas / 825 MB, `kdue` 600k, `kdm5` 400k, 34k cobros, 504 cortes de
  oct con 389 cobrados y 50 con devolución): **vieja 88,615 ms → nueva 192 ms** (mediana de 3 en
  caliente con `csu-cortes-bench-local.js`; + 2 ms de nombres; otra corrida: 82,380 → 163),
  salida **idéntica** a escala. ⭐ Primera versión de la reescritura
  medía 456 ms con 2 % de los datos: el planner inlineaba los agregados `a`/`d` y los recalculaba
  por corte (loops=504) — por eso van `MATERIALIZED`. Los 82–95 s de la vieja calzan con que en prod la
  petición **falle** (el navegador mostró `cortes-sucursales` en rojo): pasa el límite del túnel.
  ⚠️ **NO MEDIDO en prod**: hardware, `kdud`/complementos y el resto de la API (alcance, JSON) son
  locales o sintéticos. No se cierra ✅ (regla 15) hasta correr el de prod.
  **Re-medir** (`database/scripts/`): `csu-cortes-bench-local.js` (escala de prod, exit 1 si pasa de
  500 ms o rompe la paridad) · `csu-cortes-paridad-local.js [--mutar]` (casos borde + prueba
  negativa) · `csu-cortes-paridad-prod.js` (sólo lectura, candado de identidad del clúster).
  Fuera de alcance, a propósito: el bug del arqueo mal casado (folio de turno repetido el mismo día,
  SM.35) cambia cifras y va en su propio item. 🧪 2026-10-21
- [x] **[CSU.11]** **Cobros cancelados en Kepler: dejan de sumar, de raíz** (pedido del PM: «omitir todo
  lo CANCELADO» y «corregirlo de raíz, no parchar»). Kepler cancela en la cabecera (`kdm1.c43='C'`,
  importe 0) y deja la aplicación viva en `kdm5`: 854 de 70,478 en prod. Vista canónica
  `analytics.kepler_kdm5_vigente` (mig `20261021102646`, se verifica sola); la leen el CTE `ap` de
  Cortes y la cartera (mig `20261021102648`: `erp_receivable_documents`, `erp_receivable_doc()`,
  `v_route_credit_sales`, desde su definición viva). Compuerta `check:kdm5-vigente` en el `pre-push`,
  con `--db` para el catálogo. **Medido en prod (oct):** cobrado −$171,986.56 (14 cobros),
  pendiente +$6,816.36, resto idéntico; cartera +$165,615.07 (21 docs); 13 facturas «pagadas» que no
  lo estaban. Paridad local con cobro cancelado sembrado + `--mutar=cancelado` en rojo. ⚠️ Migraciones
  a prod ANTES del código, una por una, fuera de horario. GOTCHAS §89 · ADR-098. 🧪 2026-10-21
- [x] **[CSU.12]** **Del lado proveedor, los cancelados tampoco cuentan.** Los $13.3 M de pagos
  cancelados aplicados a entradas (`kdm5` X-D) NO los sumaba ninguna vista de prod (medido en el
  catálogo). El daño estaba en la CABECERA: `expense_documents` traía **1,021 documentos cancelados,
  $3,177,101.13** (263 con importe vía el agregado contable) → Comprobaciones, pagables de Caja,
  materialidad, MAAT; `mv_supplier_prompt_discount`, **101 pagos cancelados con $1,450,384.26 de
  descuento** que no existió → tasa de pronto pago inflada (CF004 7.39 % → 6.20 %). Mig
  `20261021121257` (definición viva + `c43 <> 'C'`; verificada en prod: quita exactamente los 1,021;
  la matview se recrea con índice, permisos y comentario, **~18–25 s: fuera de horario**).
  `check:kdm5-vigente:db` revisa además «cabeceras kdm1 con dinero sin c43»: 6 declarados con su
  porqué, uno nuevo → rojo. 🧪 2026-10-21
- [x] **[CSU.13]** **Buscador de cortes, y los cobros cancelados se VEN (no suman).** Pedido del PM: «no contamos con un apartado de búsqueda, reducir el tiempo para consultar». Después: «este corte cancelado no me aparece au501-00076». Qué se hizo:
  - **Buscador** «Buscar corte», sobre la lista completa del periodo, con `filtrarPorBusqueda` (la semántica de `applySmartSearch`). Busca por folio con o sin ceros, caja-turno, sucursal, fecha, montos como se ven, estados, cajero, cobros (folio, forma, concepto, cuenta) y devoluciones. Atajos: `/` enfoca, `Esc` limpia. Si no hay resultados en la sucursal elegida, dice cuántos hay en otras.
  - **Folios escritos a mano:** se comparan **por número**. Letras en cualquier orden, tipo con o sin ceros y cualquier cantidad de ceros, con un terminador para que el 76 no traiga el 761.
  - **Cancelados:** vista `analytics.kepler_kdm5_cancelado` (mig `20261021135510`), complemento exacto de la vigente, verificado al crearse (vigentes + canceladas = kdm5). El corte publica `cobros_cancelados`; el detalle los marca «Cancelado en Kepler — no suma», con el monto tachado; la lista lleva «N cancelado»; el buscador los encuentra (también con la palabra «cancelado»).
  - **Medido en prod, sólo lectura:** 11 cortes de octubre, 14 cobros, $171,986.56 que NO suman; el resto de la salida idéntica a `main`; 236 ms contra 228.
  - **Arreglos vistos en el navegador:** la lupa (`p-inputicon` no tiene `styleClass` en PrimeNG 22; corregido en CSU.15: el `class` estático sí llega) y NG0955 del esqueleto de carga (`track i` sobre 8 `undefined`). 🧪 2026-10-21
- [x] **[CSU.14]** **«Por sucursal» se reduce a la elegida.** Pedido del PM: «cuando se seleccione una sucursal las demás se oculten para optimizar la vista y el espacio». Con una sucursal elegida, la tabla deja sólo su fila y el encabezado dice «N ocultas · ver todas»; vuelven con ese enlace o con otro clic sobre la misma fila. Sólo pantalla (dos `computed`). Validado en el navegador: 8 → 1 → 8, consola limpia. 🧪 2026-10-21
- [x] **[CSU.15]** **Barrido: la lupa invisible y el NG0955 en todo `apps/view`, con compuertas.** Lo que CSU.13 dejó como deuda era más de lo declarado. Sobre `main`:
  - 36 `p-inputicon` y 28 `p-iconfield` con `styleClass`, que PrimeNG 22 no tiene: lupas de 0 px y buscadores sin su `min-width`. Pasan a `class=`.
  - 27 `@for … track i` sobre `Array.from({ length: N })`, en 15 archivos: pasan a `track $index`.

  Son 36 archivos de 7 módulos. Compuertas: `check:primeng` con techo 0 para los dos componentes, y `check:track`, nueva, en el `pre-push` con `--self-test`. Las dos salen rojas contra el `main` sin barrer, con los números exactos. `check:pantalla --todas` queda igual (629 fallas, 0 nuevas). Corrige lo que CSU.13 explicó mal: el `class` estático **sí** llega, sólo se pierde `styleClass`. Protocolo §8.0b 58–59, GOTCHAS §90. 🧪 2026-10-21
- [ ] **[CSU.3]** Entrega 2 — banco: cruzar los cobros con `finance.bank_movements` (tarjeta y
  transferencia), tolerando que un abono cubra varios cobros y que el cobro no trae la fecha real.
  Requiere el estado de cuenta de oct-2026 cargado en Bancos.
- [ ] **[CSU.4]** Entrega 2 — efectivo: tramo Caja Fuerte (`/finanzas/caos`) → Caja General →
  depósito, por corte.
- [ ] **[CSU.5]** "Cobro sin corte": cobros de CONTADO aplicados a otros documentos (La Piedad
  cobró $38,363.81 y sólo $113.45 quedó en cortes). Pendiente decidir si se muestra.

## 6. Pendiente para prod

1. Aplicar las migraciones `20261005200000_grant_finance_cortes_ver.js` y
   `20261005210000_grant_finance_cortes_ver_tienda.js`, una por una y en ese orden.
2. Redeploy api + view (automático al entrar a `main`).
3. Re-login de los usuarios para que el permiso llegue al token.
4. **Validación visual pendiente**: no se levantó la app en local (regla del 2026-10-02); la
   consulta y el motor sí se ejecutaron contra prod en solo lectura.

---

## Observaciones de diseño UI — revisión del plan (2026-10-26)

> **Con qué se miró: el plan, no la pantalla** (nivel C). Nada visual se da por medido; lo que
> sólo se comprueba con la pantalla viva va como criterio a verificar. La ley es
> [`ESTANDAR_DE_INTERFACES.md`](../../ESTANDAR_DE_INTERFACES.md) (§ = sus secciones) y su
> implementación [`DESIGN.md`](../../../DESIGN.md). Severidad: 🔴 la pantalla afirmaría algo falso,
> escondería lo que importa o perdería trabajo — **bloquea pasar C3 a 🚀** · 🟠 se resuelve dentro
> de la fase · 🟡 mejora; si no entra, queda como deuda con nombre. **La pantalla existe: cada
> observación es un criterio a verificar en ella, no un defecto medido.** Para lo que sigue en ⬜
> (CSU.3–CSU.5), es criterio de construcción.

**La pregunta que contesta (prueba de la frase, §4.0b):** *«¿Qué cortes de este periodo no tienen
su cobro aplicado en Kepler **y** cuáles no cuadran con su arqueo?»* — dos preguntas sobre el mismo
renglón, con dueños distintos (cobranza y la sucursal). No piden dos pantallas: piden dos veredictos
separados arriba y un filtro de un clic para cada uno. La tercera —«¿llegó el dinero?»— el módulo la
promete y todavía no la contesta (`CSU.UI.1`).

**Jerarquía propuesta (§3.7 · DESIGN §Q.5):** primario = **sin cobro en Kepler y faltante en arqueo
del periodo, como dos cifras separadas** · secundario = la tabla por sucursal · terciario = el
detalle por forma de pago, folios y devoluciones.

| # | Sev | Observación (desde la silla de quien la usa) y costo | Ley | Criterio de aceptación |
|---|---|---|---|---|
| CSU.UI.1 | 🔴 | **«Pendiente» se lee como dinero que no llegó, y es un cobro que no se capturó.** Del 1 al 5 de octubre: 105 cortes por $4,531,431.68, cobrado en Kepler $66,210.22 (1.5 %), pendiente **$4,465,221.46**. Eso mide el paso 2 (que alguien registró el cobro en Kepler), no el 3 (que el dinero llegó): el cruce con banco y Caja Fuerte (CSU.3, CSU.4) no existe. Y la pantalla vive en la sección «Ingresos», con un pedido de origen que dice «que el dinero llegue como ingreso a la empresa». | §1.1 · §1.4 | La columna y el KPI se llaman «Sin cobro en Kepler». Una línea fija bajo el título: «Todavía no se mide si el dinero llegó al banco o a Caja Fuerte (entrega 2)». Se retira cuando CSU.3 y CSU.4 estén en prod. |
| CSU.UI.2 | 🔴 | **Si la consulta falla, la pantalla no puede decir «0 cortes».** En prod la versión vieja tardaba 82–95 s y la petición fallaba (el navegador la mostró en rojo); el personal reporta que «no sirve». La nueva mide 192 ms en banco local y está **NO MEDIDA en prod** (CSU.10). El estándar trae este caso literal: «0 corte(s)» con el endpoint devolviendo 1. | §1.3 · §3.5 | `app-load-state` con los tres estados: un error dice «No se pudieron leer los cortes (la consulta tardó más de N s): reintenta». Nunca KPIs en $0.00 ni tabla vacía después de una falla. Medición en prod con `csu-cortes-paridad-prod.js` antes de cerrar. |
| CSU.UI.3 | 🔴 | **El «corte» es lo que se contó, no lo que se vendió, y el faltante del arqueo no entra en «pendiente».** Caja 5-151 de Zamora Centro (2-oct): corte $1,203.36 contra $10,203.36 vendidos; faltan $9,000.00 y el corte los arrastra (hallazgo 1). Como pendiente = corte − cobros, ese faltante no aparece en la cifra grande: 25 cortes con diferencia en cinco días quedan fuera del total. | §1.1 · §4.0c | Rótulos «Contado (corte)» y «Esperado (venta del turno)». El encabezado publica aparte «Faltante en arqueos: $X en N turnos», con filtro de un clic a esos renglones. |
| CSU.UI.4 | 🔴 | **«Cuadra» puede ser un verde sin comprobar.** Cuando hay devolución y Kepler no la descontó (Madero 2-23), el motor acepta el corte contra el bruto, y ese respaldo va **antes** del chequeo contra lo contado: un faltante en ese turno no se ve (CSU.7). | §1.3 · §2.3 | Estado propio, con texto y no sólo color: «Cuadra contra el bruto · contado sin verificar». Prueba negativa: ese caso con un faltante sembrado no sale como «Cuadra». |
| CSU.UI.5 | 🟠 | **«Corte distinto» suena a culpa y no tiene causa.** Quedan 9, casi todos con el corte **arriba** de lo esperado (Abastos, hasta +$18,141.81): «otra causa, sin investigar» (CSU.7). | §1.1 · §3.2 | El estado dice «Corte arriba de lo esperado · causa sin investigar» y no suma a faltantes. Cuando la causa se conozca, la causa reemplaza al texto. |
| CSU.UI.6 | 🟠 | **La Piedad parece no cobrar lo que sí cobró.** Cobró $38,363.81 de contado y sólo $113.45 quedó en cortes (CSU.5, «pendiente decidir si se muestra»). La pantalla la dibuja casi sin cobro. | §1.3 · §1.5 | Por sucursal, una línea: «Cobros de contado aplicados a otros documentos: $X (no entran a los cortes)». CSU.5 se decide antes de dar la fase por cerrada. |
| CSU.UI.7 | 🟠 | **Un cobro aplicado al corte equivocado deja dos renglones mal y no señala ninguno.** En Zamora, $1,907.62 y $421.63 de tarjeta y transferencia del turno 5-149 se aplicaron al corte de la caja 4-199 (hallazgo 5): uno sale sobrecobrado, el otro pendiente, y nada los une. | §3.3 · §3.4 | En el detalle, el cobro cuya forma de pago no aparece en el arqueo de su turno lleva «posiblemente de otro turno: [caja-turno]» con enlace a ese corte. Si el motor no puede detectarlo, se declara como límite conocido en `app-context-help`. |
| CSU.UI.8 | 🟠 | **Con una sucursal elegida, el encabezado puede seguir hablando de las ocho.** CSU.14 reduce la tabla a la elegida («N ocultas · ver todas»); el plan no dice qué pasa con los KPI de arriba. | §1.5 · §1.4 | El resumen dice de qué universo es («Resumen: Zamora Centro» / «Resumen: 8 sucursales») y cambia con la selección, o no cambia y lo dice. |
| CSU.UI.9 | 🟠 | **La sucursal aparece con su código.** El texto de alcance que fija CSU.6 es «Viendo sólo tu sucursal: 05 Zamora Centro». | regla PM 2026-10-22 · DESIGN skill §4 | «Viendo sólo tu sucursal: Zamora Centro», con la pipe `\| sucursal`; igual en la tabla, el buscador y los `aria-label`. |
| CSU.UI.10 | 🟠 | **Las devoluciones que no casan con ningún corte desaparecen.** 38 devoluciones POS sin caja o sin turno desde el 24-sep (una de Yurécuaro por $937.06), y las devoluciones sólo se pintan cuando el corte tiene arqueo (CSU.7). | §1.3 · §1.2 | Un contador por periodo: «N devoluciones · $X sin corte al que aplicarse», que abre su lista. |
| CSU.UI.11 | 🟡 | **El cobro cancelado se distingue con un tachado.** «Cancelado en Kepler — no suma», con el monto tachado (CSU.13). En Alto Contraste el tachado puede perderse. | §2.3 | Verificar en `forced-colors` que la etiqueta «Cancelado» queda visible y que el monto no se lee como sumado. |
| CSU.UI.12 | 🟡 | **CSU.11 y CSU.12 cambiaron cifras que publican otras pantallas, y ellas no lo dicen.** Cartera +$165,615.07 y 13 facturas «pagadas» que no lo estaban; Pronto pago sin 101 pagos cancelados ($1,450,384.26 de descuento que no existió). Quien compare antes y después del 21-oct ve dos números sin explicación. | §1.6 | Las pantallas afectadas (cartera, Pronto pago, Calendario de pagos) declaran junto a la cifra la fecha del cambio de regla. Ver `TP.UI.3` y `CDRP.UI.5`. |
| CSU.UI.13 | 🟡 | **El roadmap dice 🟢 y el plan no lo sostiene.** Todos los items están en 🧪, §6 dice «validación visual pendiente» y CSU.10 dice «no se cierra ✅ hasta correr el de prod». | método §4 | Revisión en nivel A con `auditoria-diseno` (claro, oscuro y `forced-colors`) y la medición de prod de CSU.10 antes de declarar la fase cerrada. |

**Lo que esta revisión no cubre:** la entrega 2 (CSU.3–CSU.4), que no tiene diseño en el plan;
contraste, alto de fila, foco y teclado reales (exigen nivel A), y el texto exacto de los avisos, que
se valida con Francisco.
