# Fase G — Growth: Mercadotecnia (alta de promoción · ranking · sell-out)

> **Plan maestro pedido por el PM** en el issue #96 del repo del PM («MKT (Marketing) — asignado a un dev»,
> 2026-11-19): *«Estructuralo sobre G para no abrir fase duplicada (método §7)»*. Este doc reemplaza el stub
> original de G, que se conserva completo como **frente G4 (⏸️)** al final.
> **Método:** [`METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md) — C0 dato → C1 dominio → C2 API → C3 pantalla; una capa no sube hasta que la de abajo está verificada.
> **Calidad:** entra bajo el estándar del issue #95 del PM (autorizado el 2026-11-19): 5 preguntas de diseño + capa escritas en el item **antes** de codear, con OK de un par; **revisor con nombre** antes de mergear; registro de cada do-over (FIN / COD / DATO).

```
OBJETIVO: que Mercadotecnia lleve sus promociones en la Suite de punta a punta —pactarlas con el proveedor,
          ver cómo se venden y cobrar lo que el proveedor prometió— sobre un sell-out arbitrado.
MÉTRICA:  1) promociones con expediente en la Suite — HOY: 0 (prod, 2026-11-20) → META: [fecha del PM]
          2) canales del Ranking con dinero contrastado contra Kepler — HOY: 1 de 4 (mostrador) → META: 4 de 4
          3) sell-out arbitrado contra un testigo independiente por compuerta — HOY: 0 compuertas → META: 1, con prueba negativa
CAPA TOPE: C3
ÁREA:      Comercial / Mercadotecnia
DUEÑO:     el dev asignado a MKT en el issue #96
ESTADO:    ⬜ — plan para que el PM le ponga fechas y entregables
```

**Cómo se midió el HOY** (2026-11-20, `pg-prod` en sólo lectura verificada por `system_identifier`):
`commercial.promo_agreements` = 0 filas · `DINERO_CONTRASTADO` en código = `mostrador:true`, los otros 3 `false`
(`libs/commercial/src/lib/mkt-ranking/mkt-ranking.service.ts:328`) · compuertas de sell-out: 5 pruebas en
`database/tests/` (`test-newdb-sellout-*`), **todas comparan la Suite consigo misma**.

---

## 1. Lo que ya existe (no se construye dos veces — ADR-056)

| Pieza | Dónde | Estado |
|---|---|---|
| Acuerdo con proveedor (MKTN001) y su expediente | `commercial.promo_agreements` + 3 tablas (`[MKT.1]`), `libs/commercial/src/lib/commercial-promo-agreements/` | En prod desde el 2026-10-01, **0 filas**: no hay pantalla de alta |
| Ranking de promociones y de vendedores | `/mkt/ranking`, `libs/commercial/src/lib/mkt-ranking/` (`[MKT.9]`–`[MKT.31]`, #560) | ✅ En prod. Mercadotecnia lo usa: 105 llamadas en 30 días |
| Sell-out de la empresa | `/comercial/sell-out`, `analytics.v_sellout_daily` + rollups mensuales, `GET commercial/analytics/sell-out*` (`COMMERCIAL_SELLOUT_VER`) | ✅ En prod, con defectos conocidos (§4) |
| «Resultado» de un acuerdo | `/mkt/resultado` (`[MKT.6]`), `commercial.v_promo_agreement_sellout` | En prod, mide sólo códigos con producto ligado; hoy sale `sin_alcance` |
| Primitivos | buscador `applySmartSearch`, almacenamiento `ObjectStorageService`, visor `app-doc-viewer`, PDF `compras-pdf-comun.ts` | Se reutilizan; ninguno se inventa |

---

## 2. Las cuatro preguntas del PM

### 2.1 Sell-out: ¿de qué fuente sale y contra qué testigo se valida?
- **Fuente:** `analytics.v_sellout_daily` (última definición en `database/migrations-newdb/20261026104753_sellout_rutas_sin_doble_conteo.js`). Une tres tramos: **Kepler** (`mv_kepler_sales_daily` ← `kepler_ods.kdm1/kdm2`), **Wincaja** antes del corte de cada plaza, y el **envío de cada camioneta** de ruta. Es derivada del ODS, sin importer. [`VERDAD_ABSOLUTA.md`](../../VERDAD_ABSOLUTA.md) la nombra resolvedor canónico.
- **Qué cuenta como venta al consumidor:** `U-D-10` ticket, `U-D-8` factura de mayoreo/telemarketing, `U-D-12` factura no fiscal. **Fuera:** la factura global `U-D-6` (re-factura los tickets), `U-D-13` (es traspaso al CEDIS), pedidos y embarques, compras y cancelados (`VERDAD_ABSOLUTA.md:436-443`).
- **Grano:** día × sucursal × producto × **marca** × canal × vendedor. Unidad: pieza o kg (la caja se convierte con el factor de caja); dinero bruto y neto de descuento de cabecera.
- **Testigos:**
  - El total de un documento: `kdm1.c16`, el importe que Kepler cobró (VERDAD §4.4-bis).
  - La venta de ruta: el control manual RD (VERDAD §19).
  - El total del mes: **ContPAQi, cuentas 401** (VERDAD, medición del 2026-10-07). Es el único testigo independiente. La balanza de Kepler **no** sirve de testigo, porque lee el mismo Kepler (VERDAD §21).
  - ⚠️ **Ninguna compuerta arbitra hoy el sell-out contra ContPAQi**: es el hueco que cierra `G3`.

### 2.2 Alta de promoción: ¿quién la da de alta y qué define una promoción?
- **Quién:** el **jefe de Mercadotecnia** y quien tenga `MKT_AGREEMENTS_GESTIONAR` (ya repartido a los roles `jefe_marketing` y `marketing`). Cualquier rol con `MKT_AGREEMENTS_VER` la consulta; las tiendas ven la de su sucursal.
- **Qué la define:**
  - la **evidencia de aprobación del proveedor** (correo, WhatsApp o PDF; sin ella no se autoriza);
  - proveedor (del catálogo de Kepler, o escrito a mano si es una marca que no está);
  - vigencia: fechas, u «hasta agotar»;
  - mecánica;
  - **qué prometió el proveedor a cambio**: nota de crédito, producto sin cargo, promocionales, presupuesto u otro;
  - canales + sucursal;
  - el código de promoción de Kepler, que se anota en el expediente y se liga **con su vigencia**, porque Kepler reutiliza los códigos.
- **La meta** no se define en el alta: vive en «Objetivos» del Ranking (`[MKT.17]`). Si la meta se pacta con el proveedor, es la decisión D-G6.
- Detalle completo: [`FASE_MKT_ANEXO_ACUERDOS_PROVEEDOR.md`](FASE_MKT_ANEXO_ACUERDOS_PROVEEDOR.md).

### 2.3 Ranking: ¿contra qué rankea?
- **Contra volumen vendido**: paquetes, es decir, las veces que se aplicó el código de promoción en Kepler. Al lado va el **dinero cobrado**. **No** rankea contra el cumplimiento de la meta: la meta se muestra como avance, pero no ordena (decisión del dev, 2026-11-18, con la finalidad que pidió Mercadotecnia: cuánto se vende, cuánto dinero, cuál es la más vendida y quién vendió más).
- Son **dos rankings que no se mezclan**: promociones (toda la venta) y vendedores (sólo lo cargado a cada uno).
- **Margen: no.** No hay árbitro de costo para calcularlo: el motor de rentabilidad (fase MR) está ⚠️ bloqueado.
- **Testigo:** la línea de Kepler (`analytics.v_kepler_sales_lines`) y, para el dinero, `kdm1.c16`. Hoy sólo el mostrador está contrastado; preventa, ruta y mayoreo se publican marcados «sin contrastar» hasta `[MKT.34]`.

### 2.4 Cómo se liga con lo que ya existe
| Con | Liga |
|---|---|
| **Catálogo** | Los códigos de promoción son productos `is_promo` de Kepler (`catalog.products`). El proveedor sale de `catalog.suppliers` y la marca de `catalog.brands`. Los códigos de barras ya entran al buscador del Ranking (`[MKT.27]`) |
| **Precios** | Fuera de este plan. El precio de lista de la promoción no tiene fuente verificada en Kepler: primero se arbitra la fuente y después se muestra |
| **Caducidades** | El formato MKTN001 incluye «apoyo para desplazar inventario». Más adelante, el alta podría sugerir productos por caducar (`commercial-expiry-reviews`). Queda anotado, no está en este plan |
| **Growth ⏸️** | Su stub (campañas B2B, segmentación, cupones) no tiene código. Se conserva como frente G4 ⏸️ |
| **MDTask** | Las promociones dejan de capturarse ahí. Cambia la decisión D9b de la fase MDT |

---

## 3. Los frentes y su orden

| Orden | Frente | Por qué en ese lugar (dinero × esfuerzo, método §3.1) |
|---|---|---|
| 1 | **G2a · Dinero contrastado del Ranking** (`[MKT.34]`) | Esfuerzo S. El dinero ya se ve en prod: lo publicado sin árbitro es el riesgo más inmediato. Además, G1 lo reutiliza |
| 2 | **G1 · Alta de promoción, C0–C2** (`[MKT.32]`–`[MKT.39]`) | Esfuerzo M. Es lo que hoy no existe y lo que recupera dinero: lo que el proveedor prometió |
| 3 | **G3 · Sell-out arbitrado, C0** | Esfuerzo M. La cifra decide dinero en otros módulos (presupuestos, comisiones). Recrear matviews pesadas va fuera de horario |
| 4 | **G1 · Alta de promoción, C3** (`[MKT.40]`–`[MKT.44]`) | Sólo con C0–C2 verificados y la revisión de diseño hecha |
| 5 | **G2b · Pendientes del Ranking** | Esfuerzo S cada uno, sin dinero nuevo |
| — | **G4 · Campañas B2B** | ⏸️ Depende de las fases D y F |

---

## 4. Desglose por capas

### G1 · Alta de promoción
Detalle, criterios y decisiones en [`FASE_MKT_ANEXO_ACUERDOS_PROVEEDOR.md`](FASE_MKT_ANEXO_ACUERDOS_PROVEEDOR.md). Resumen:

| Capa | Items | El número y su árbitro |
|---|---|---|
| C0 | `[MKT.32]` migración: folio propio, canal + sucursal, proveedor con FK, archivo de cumplimiento · `[MKT.33]` lo vendido por código + vigencia | «Lo vendido» se arbitra con **dos implementaciones**: la misma semana tiene que dar la misma cifra que el Ranking. Placebo: un código fuera de su vigencia no suma |
| C1 | `[MKT.35]` ciclo (no se autoriza sin evidencia, no se cierra sin prueba de cumplimiento) · `[MKT.36]` el cálculo de lo vendido es el mismo que el del Ranking | Pruebas unitarias con sus cinco caminos |
| C2 | `[MKT.37]` alta, autorizar y cerrar (409 sin evidencia o sin prueba) · `[MKT.38]` subida real de archivos con lista blanca · `[MKT.39]` historial con buscador | Prueba contra base real con el payload de la pantalla. Un `.exe` disfrazado se rechaza |
| C3 | `[MKT.40]` bandeja (activas con lo vendido) · `[MKT.41]` alta (la evidencia primero) · `[MKT.42]` expediente · `[MKT.43]` PDF para el proveedor · `[MKT.44]` historial | `check:pantalla` antes y después; el dinero sin contrastar va marcado |

### G2 · Ranking de promoción (en prod; lo que falta)
| # | Item | Capa | Árbitro |
|---|---|---|---|
| `[MKT.34]` | **El dinero de preventa, ruta y mayoreo queda contrastado** — `DINERO_CONTRASTADO` pasa a `true` canal por canal | C0 | `kdm1.c16` del mismo documento. Si no cuadra, se queda `false` y se dice |
| `[MKT.45]` | **La ayuda contextual explica cómo se ordena y de dónde sale cada número** (`mkt-ranking` en `context-help.dictionary.ts`) | C3 | — |
| `[MKT.46]` | **La cámara del buscador vuelve a montarse** en el detalle | C3 | — |
| `[MKT.47]` | **Pesos por caja:** el incentivo por producto sale de Kepler y deja la cuenta a mano de los Excel. Auditado en la fase MKT §6l, va aparte | C0→C3 | Excel vs Kepler, hoy NO MEDIDO |

### G3 · Sell-out de la empresa (existe; se arbitra y se corrige)
⛔ La pantalla `/comercial/sell-out` ya existe: **no se hace otra**. Antes de tocarla, `auditoria-diseno`.

| # | Item | Capa | Árbitro |
|---|---|---|---|
| `[MKT.48]` | **El sell-out se arbitra contra ContPAQi por compuerta**: prueba mensual del total contra las cuentas 401, por canal fiscal, **con prueba negativa** (rompe a propósito y da rojo). Ruta y preventa se declaran sin testigo fiscal (cobran en efectivo, VERDAD §19) | C0 | ContPAQi 401, sin IVA |
| `[MKT.49]` | **La venta vecinal deja de contarse dos veces**: hoy `mv_kepler_sales_daily` suma el `U-D-12` que re-factura el ticket vecinal (VERDAD:459; existe un runbook sin ejecutar). Antes/después con la misma consulta (regla 15). Recrear la matview va **fuera de horario** (regla 9) | C0 | `/comercial/ventas-por-ruta` del mismo mes |
| `[MKT.50]` | **Se decide y se declara si el sell-out es bruto o neto**: hoy no resta devoluciones (`U-A-10`), y que `kdm2.c13` traiga IVA sólo lo dice un comentario. Medir ambos tamaños y que la pantalla diga cuál muestra | C0 | Ticket de Kepler (`kdm1.c16`) con y sin IVA |
| `[MKT.51]` | **Los productos fuera del catálogo dejan de perderse sin aviso**: se mide cuánto cae por el cruce con `catalog.products` y se declara en la pantalla | C0 | Total de líneas de Kepler del mismo día |
| `[MKT.52]` | **La pantalla de sell-out pasa la revisión de diseño** (`auditoria-diseno`); sus 🔴 se vuelven items | C3 | — |
| deuda | La **marca** llega por un importer heredado (`database/importers/kepler/import-brands-lineas.js`). No se toca en este plan (regla 1); queda como deuda con nombre | — | — |

### G4 · Campañas B2B (el stub original de G) — ⏸️
Se conserva sin cambios. Pre-requisitos: fases D y F, proveedor de correo. Sprints: G.0 motor de segmentación ·
G.1 campañas + envío omnicanal · G.2 promociones complejas (combos escalonados, precios dinámicos, cupones) ·
G.3 checkpoint. Métricas: uplift de ticket por segmento contra control, redención de cupones y conversión por canal.
Referencia: `PLAN_PLATAFORMA_B2B.md` §3.

---

## 5. Decisiones

| # | Decisión | Recomendación | Quién |
|---|---|---|---|
| D-G1 | ¿Los items conservan el código `[MKT.N]` dentro de la fase G? | **Sí**: el tracker, los commits y los PR ya usan `MKT.*`. G es la fila del roadmap; MKT, el prefijo de sus items | PM |
| D-G2 | Cupo: qué fase en curso del dev de MKT pasa a ⏸️ para abrir G | el dev propone, el PM decide (issue #96) | PM + dev de MKT |
| D-G3 | Sell-out bruto o neto de devoluciones; con o sin IVA | **Neto y sin IVA** para arbitrar contra ContPAQi; la pantalla dice cuál muestra | PM |
| D-G4 | ¿La venta vecinal se cuenta por el ticket `U-D-10`? ¿Y el `U-D-8` facturado a ruta vecinal se suma a la ruta? | Ticket `U-D-10`, como `/comercial/ventas-por-ruta`. El `U-D-8` es decisión de negocio (VERDAD) | Dirección / PM |
| D-G5 | `/mkt/resultado` y `v_promo_agreement_sellout`: ¿se absorben en el expediente de G1? | **Absorber**: dos medidas del mismo hecho terminan diciendo cosas distintas | PM |
| D-G6 | ¿La meta de una promoción se pacta con el proveedor (alta) o la fija Mercadotecnia (Objetivos)? | Objetivos, como hoy, salvo que Mercadotecnia diga otra cosa | Jefe de Mercadotecnia |
| D-G7 | Revisor con nombre de los PR de G | El que asigne el PM (el #95 ya propone un revisor para finanzas) | PM |
| Abiertas de G1 | MOR, unidad de «vendido», piezas regaladas, reutilización de códigos | Ver el anexo, §4 | Jefe de Mercadotecnia |

---

## 6. Riesgos y bloqueos

| Bloqueo / riesgo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Cupo de fases | PM | Hoy 8 🔨 contra 4 | D-G2 |
| Recrear `mv_kepler_sales_daily` (`[MKT.49]`) | dev de MKT + PM (ventana) | Matview pesada; un `CREATE MATERIALIZED VIEW` ya sostuvo el candado de migraciones 22 min | Ventana fuera de horario hábil, aprobada por el PM |
| ContPAQi como testigo (`[MKT.48]`) | dev de MKT | Hay que confirmar que la Suite lee ContPAQi en sólo lectura y en qué grano | Medirlo antes de escribir la compuerta |
| Cifras de VERDAD medidas en la prod vieja (Railway, 2026-09-09) | dev de MKT | Pueden no valer en `md` | Re-medir en `md` en cada item de G3 antes de publicarlas |
| Cambios de otras sesiones en archivos compartidos | dev de MKT | Checkout compartido | Commits con pathspec; no tocar lo ajeno |

---

## 7. Cómo se trabaja y se reporta (estándar del #95)

- **Antes de codear cada item:** las 5 preguntas de diseño (si es C3) y su capa escritas en el item, con OK de un par.
- **Cada item:** una capa a la vez. Un endpoint que escribe se prueba contra base real o se declara «no probado».
- **Antes de mergear:** revisión del par con nombre (D-G7).
- **Reporte al PM:** en este doc (bitácora §9) y en `docs/PM/REPORTE_SEMANAL_DAVID.md` cada viernes. Cada do-over, una línea con su tipo (FIN / COD / DATO) en el registro del #95.

---

## 8. Definición de Terminado (por frente)

- [ ] 1. Métricas de la cabecera **remedidas** en prod, antes/después publicado
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056)
- [ ] 3. Todo endpoint que escribe ejercido contra base real con el payload de la pantalla
- [ ] 4. Toda compuerta nueva rota a propósito una vez (`[MKT.48]`, los 409 de G1)
- [ ] 5. Ningún primitivo nuevo fuera de `libs/`
- [ ] 6. Tracker, `03_LOG_REVISIONES.md` y la fila de G en el roadmap de `CLAUDE.md` al día
- [ ] 7. En prod, confirmado con `/api/health`

---

## 9. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-19 | El PM asigna MKT a un dev (issue #96) y pide el plan sobre G | PM |
| 2026-11-20 | Plan maestro: 4 preguntas contestadas con fuente en el código y en VERDAD; G1 con maqueta validada por el usuario; G3 parte de lo que ya existe; el stub de G pasa a G4 ⏸️ | dev de MKT + Claude |
