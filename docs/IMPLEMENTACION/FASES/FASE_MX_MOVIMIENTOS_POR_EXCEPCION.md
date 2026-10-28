# Fase MX — Movimientos por excepción: el motor cuadra, el humano audita sólo las diferencias

> El método que la gobierna: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> Pantalla actual: `/almacen/movimientos` (Diario + Cuadre de traspasos, items `[DM.2]`–`[DM.22]`).
> Plan escrito el 2026-10-28 a pedido de Edgar, sobre una auditoría del motor medida en prod (solo lectura).

```
OBJETIVO: El Diario de movimientos pasa a ser REPORTERÍA (sin clic de auditoría) y nace una bandeja donde
          sólo se auditan las DIFERENCIAS que el motor no puede dar por buenas — para Almacén/Prevención.
MÉTRICA:  (1) Documentos que un humano revisa a mano sin que el motor haya detectado nada
              HOY: 4,237 marcas «auditado» (2,884 sólo en oct-2026, una sola persona), sobre un universo donde
              el 99.5 % de las recepciones pareadas cuadra por SKU (2,199 de 2,209, 90 d, medido 2026-10-28).
              Cuántas de esas 4,237 caían en documentos que el motor ya cuadraba: NO MEDIDO (item MX.0.1)
              → META: 0 clics sobre documentos cuadrados; la bandeja sólo trae excepciones.
          (2) Cifras publicadas por la pantalla/Excel que son falsas o incompletas SIN declararlo
              HOY: 6 confirmadas en prod (§1.1: #1, #2, #3, #4, #6, #7) + 1 de lógica sin caso medido (#5) → META: 0.
          Fecha meta: la fija el PM al abrir la fase.
CAPA TOPE: C3
ÁREA:      Logística (Almacén) · toca Finanzas por el mayor 515
DUEÑO:     por asignar (Edgar)
ESTADO:    ⬜ planeada — NO abierta (Fase 0 en curso y cupo de 🔨 lleno; ver §4 D1)
```

---

## 1. Qué problema resuelve

**Hoy se audita uno por uno lo que el motor ya cuadró.** El Diario pone un botón «Auditar» en cada documento
(`commercial.stock_movement_audits`, `POST /audit`), y la gente lo usa: 4,237 marcas desde el 27-jul-2026, 2,884
en octubre. Pero el motor de pareo salida↔recepción ya dice qué cuadra, y medido por SKU **el 99.5 % cuadra exacto**.
El trabajo humano se gasta confirmando lo que la máquina ya sabía, y lo que de verdad no cuadra queda mezclado.

**Pero antes de dejar de revisar uno por uno, el motor tiene que merecer esa confianza.** La auditoría del
2026-10-28 (código línea por línea + medición en prod de cada hallazgo) encontró que **el lente físico (piezas) es
sólido, y los lentes de dinero y la exportación no lo son.** Usarlo como filtro hoy escondería exactamente lo que se
quiere encontrar.

### 1.1 Hallazgos de la auditoría del motor — confirmados con dato en prod

Rutas: `S` = [`commercial-movements.service.ts`](../../../libs/commercial/src/lib/commercial-movements/commercial-movements.service.ts) ·
`X` = [`movements-export.service.ts`](../../../libs/commercial/src/lib/commercial-movements/movements-export.service.ts) ·
`F` = [`almacen-movimientos.component.ts`](../../../apps/view/src/app/modules/almacen/pages/almacen-movimientos.component.ts).

| # | Defecto | Medido en prod (2026-10-28) | Dónde | Item |
|---|---|---|---|---|
| 1 | El detalle de pólizas 515 **descarta en silencio** toda póliza cuya referencia libre no reconoce el regex `destino()`. | Desde jul-2026: **$35.9 M de entradas (21 %)** fuera contra $1.9 M de salidas. Brecha real 515-001 vs 515-002 = **$38.3 M**; la pantalla deja ver $4.4 M. | S:1207-1221 | MX.0.3 · MX.1.6 |
| 2 | Las pólizas 515 se parean **sólo por importe ±2 %**, sin sucursal ni destino. | Control negativo (salidas desplazadas +5..+7 meses, imposibles): **96.1 %** de las entradas encuentra pareja igual, contra **98.7 %** real. Mediana 8 candidatos por entrada. **El pareo no discrimina**: sus baldes «exacto/costo» no significan nada. | S:1233-1246 | MX.0.3 · MX.1.6 |
| 3 | El Excel calcula «Recibidos OK», «Δ neto» y «Valor enviado» sobre las **primeras 500 filas** (con los problemas primero), no sobre el total. | Hay más de 500 traspasos sin recepción **cada mes** desde ago-2026 (742 · 1,269 · 1,398). «Recibidos OK» sale en 0 o casi 0. `t.totals` existe y no se usa. | S:964 · X:82-86, X:269-280 | MX.2.1 |
| 4 | El número de documentos se cuenta con `COUNT(DISTINCT folio)`; el folio se repite entre sucursales y tipos. | 30 d: dice **3,772**, son **8,139** (−54 %). | S:472, S:519 | MX.2.2 |
| 5 | **Vacío = verde.** `Number(x)\|\|0` + tolerancia: si un lado o los dos vienen vacíos, los veredictos de arriba, la matriz y «pólizas sin rastro» dicen **«cuadra»**. Reportado por Edgar. | Defecto de lógica confirmado en código. Si hoy hay algún mes en ese estado: NO MEDIDO. | F:1470-1501 | MX.1.2 · MX.3.1 |
| 6 | Un **importe vacío** se suma como si no existiera; el total no avisa que le falta algo. | 90 d: 38 renglones de traspaso sin `amount` ni `unit_cost` (~$26 K a costo típico del SKU). **8 están vacíos en la salida Y en su recepción** (mismo SKU, 114 pzs): el motor dice `ok` y el dinero no lo vio nadie. Sigue entrando (salidas del 00 del 27-oct, folios 0001245 y 0001255). | sumas de `amount` | MX.0.2 · MX.1.2 |
| 7 | **«En tránsito» nunca envejece** en el Diario. | 2,109 salidas de +180 d siguen «en tránsito» (ruta/cliente, nunca tendrán acuse). **234 iban a un almacén y llevan +45 d sin recibirse: $3.56 M**, pintados en gris como si fuera normal. | S:656 | MX.1.3 |
| 8 | Se compara la **suma** del documento, no cada SKU. | 90 d: **4 documentos** con productos cambiados (26 pzs) que el motor da por `ok`. | S:195, S:213, S:259 | MX.1.1 |

### 1.2 Descartados con dato (hoy no pasan — no se trabajan, se vuelven a medir al cerrar)

| Sospecha | Medido | Nota |
|---|---|---|
| Dos recepciones toman el mismo embarque | 24 grupos / 48 recepciones / $1.63 M — **no son duplicados**: el mismo número de folio lo usan embarques de sucursales distintas, y el pareo por cantidad más cercana los separa bien | ⚠️ Riesgo latente: la recepción no guarda el almacén de origen; cuando trae diferencia, el pareo puede escoger el embarque equivocado → MX.0.4 |
| Recepciones con `parent_group≠'41'` que el Cuadre no ve | 0 (las 2,211 de 90 d son grupo 41) | |
| Wincaja con negativos o nulos (`SUM(ABS(...))`) | 0 en 30/32/50, 90 d | |
| Marcas «auditado» sobre documentos que ya no existen | 0 | La marca sí puede quedar **rancia** si el documento cambia (ver §1.3) |
| Destinos mapeados a almacenes retirados | 0 | |
| Cantidad vacía o cero | 0 de ~330 K renglones | El riesgo de «vacío = ok» en piezas es sólo de lógica |

### 1.3 Vistos en código, sin medir todavía

| Sospecha | Dónde | Item |
|---|---|---|
| Netos que se compensan (+X/−X entre documentos) pintan «cuadra» en la matriz, el mayor y Wincaja | S:977, S:1137, S:1441 | MX.1.5 |
| Tolerancias relativas al total de la red: `ledgerOk` <0.1 % de la entrada del mes (~$25 K), `wincajaOk` <$500 o <2 % (~$60 K por tienda) | F:1493-1501 | MX.1.5 |
| Filtrar el Diario por un SKU cambia el `transfer_status`: compara ese SKU contra la recepción completa | S:382, S:412-416, S:655 | MX.1.1 |
| Mayor (`ledger_monthly`) y detalle (`gl_poliza_lines`) usan fuentes y signos distintos: pueden contradecirse en la misma pantalla | S:1126 vs S:1299 | MX.1.6 |
| Si falla la carga del detalle, queda el número del rango anterior, sin error | F:1425 | MX.3.1 |
| Topes que cortan totales sin aviso: 300 (matriz), 1,000 (PDF), 2,000 (filtro de estado / drill), 50,000 sin `ORDER BY` | S:588, S:949, S:979, S:1067, X:476 | MX.2.1 |
| La marca «auditado» no guarda qué se vio (cantidad, importe, estado): si el documento cambia, sigue diciendo «Auditado» | S:734-739 | MX.2.4 |
| Tipos de documento sin árbitro (`EntryOr1`, `InvOut1`/`InvIn1`, `RtrnPur1`, `PhysInv*`, `WIN_*`) llevan el mismo botón «Auditar» | F | MX.1.4 |

Scripts de medición (solo lectura, `PROD_DB_URL`): `dm-medir2.js`, `dm-vacios.js`, `dm-vacios2.js`, `dm-hallazgos.js`
(scratchpad de la sesión del 2026-10-28). Las consultas de cada hallazgo se re-corren al cerrar para el antes/después.

---

## 2. Qué NO incluye

- **No toca Kepler** ni escribe en el ODS. Todo sale de `analytics.stock_movements`, `analytics.gl_poliza_lines` y `kepler_ods.*`.
- **No es el conteo físico** (`/almacen/inventory/diferencias` es de la fase IC: diferencias del conteo contra sistema). Esta fase es salida↔recepción y el mayor 515. **La pantalla nueva no puede llamarse igual** (§4 D4).
- **No es el arqueo de caja** (fase SM / CSU).
- **No juzga la venta** (`Sale2`, `WIN_V`): quedan en el Diario como reporte, marcadas «sin comparación».
- **No inventa un comparador** para compras/ajustes en esta fase: se declaran «sin comparación» hasta que exista uno con testigo (§4 D3).

---

## 3. Las capas

### C0 · Dato
| # | Item | Estado | Verificado contra |
|---|---|---|---|
| MX.0.1 | Medir el cruce **marcas de auditoría × estado del motor**: de las 4,237 marcas, cuántas cayeron en documentos `ok` por SKU. Fija el «HOY» real de la métrica (1). | ⬜ | Pareo por SKU de `dm-medir2.js` contra `/transfers-check` del mismo rango (dos implementaciones) |
| MX.0.2 | **Por qué llegan renglones sin costo** (`amount` y `unit_cost` NULL): ¿viene así de Kepler (`kdm2`) o se pierde al armar `analytics.stock_movements`? No adivinar. | ⬜ | El mismo renglón en `kepler_ods.kdm2` (folios 0001245/0001255 del 00, 27-oct) |
| MX.0.3 | **Llave real del pareo de pólizas 515**: buscar en `gl_poliza_lines` / `kdc2*` la sucursal destino como columna (no regex sobre texto libre). Si no existe, el pareo por importe **se retira** y se publica sólo el neto por sucursal, con el descarte declarado. | ⬜ | Control negativo: el placebo (+6 meses) debe caer muy por debajo del real. Hoy 96.1 % vs 98.7 % |
| MX.0.4 | ¿La recepción `TrsfRcv` guarda el **almacén de origen** en algún `cN` de `kdm1`? Hoy se deduce por cantidad más cercana. | ⬜ | Contra el embarque real de 10 pares conocidos ([`ERP_KEPLER.md`](../../ERP_KEPLER.md) §5 regla 0) |

⛔ Sin importer. Lo que no se pudo verificar **se declara**, nunca se dibuja como 0.

### C1 · Dominio
| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| MX.1.1 | **Pareo por SKU, en UNA implementación.** `TRANSFER_PAIRING_SQL` compara renglón por renglón (no `SUM(qty)` del documento), y el Diario (`near()`, S:615-681) y el detalle (S:816) usan el mismo veredicto. El filtro por SKU del Diario no altera el estado. ⚠️ La consulta por SKU tardó ~1.4 s sobre 90 d (consulta de prueba, no la del servicio): medir la del servicio acotada al rango; <500 ms. | ⬜ | Spec contra base real: el caso «10 de A ↔ 10 de B» da `diferencia`; los 4 documentos de §1.1 #8 |
| MX.1.2 | **Vacío ≠ cero.** Un renglón sin importe hace que el documento diga `importe_incompleto` (con conteo); un lente sin datos en el rango devuelve `status: 'unknown'`, `measured: false` (ADR-056). El veredicto lo decide el backend, no `Number(x)\|\|0` en la pantalla. | ⬜ | Spec: base 0/null → `unknown`, no `ok` |
| MX.1.3 | **Envejecimiento del tránsito.** `en_transito` → `sin_acuse` pasados N días (hoy 45, §4 D5) **sólo** si el destino es almacén; ruta/cliente → `sin_recepcion_esperada`. Misma regla que los baldes de `[DM.21]`, una sola vez. | ⬜ | Spec con un embarque de 200 d a almacén y otro a ruta |
| MX.1.4 | **Catálogo de excepciones**: `diferencia_sku`, `diferencia_cantidad`, `sin_acuse_almacen`, `sin_origen`, `importe_incompleto`, `ajuste_inventario` (§4 D3) y `sin_comparacion` por `doc_code`. Primitivo en `libs/` (ADR-056: no inventar otra bandeja de hallazgos local). | ⬜ | Spec: cada `doc_code` del universo cae en exactamente un balde |
| MX.1.5 | **Medir y corregir netos y tolerancias** (§1.3): primero medir cuántas filas verdes esconden \|Δ\| > $5 K por sucursal/documento; luego tolerancia por fila, sin netear entre documentos. Commit de medición aparte del de cambio de regla. | ⬜ | Antes/después con la misma consulta |
| MX.1.6 | **Mayor 515 honesto**: una sola fuente para mayor y detalle, signo único, y el descarte publicado (renglones e importe fuera del pareo). Depende de MX.0.3. | ⬜ | Mayor = detalle en el mismo rango, al centavo |

### C2 · API
| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| MX.2.1 | **PDF desde los totales del conjunto completo** (el Excel se quitó el 2026-10-28) (`t.totals`, no las 500 filas). Todo tope que corte filas lo **declara** en el archivo (`truncated`, N de M). ⭐ Pedazo S con dinero: ver §4 D2. | 🧪 2026-10-28 | no | Código real HEAD vs árbol contra prod: 30 d «Recibidos OK» 0 → 1,215, «Valor enviado» $7.5 M → $54.5 M. Spec rojo contra HEAD. Falta el Excel descargado de prod |
| MX.2.2 | **Conteo de documentos por identidad real** (`warehouse_id, doc_code, doc_serie, folio`) en resumen, agregados y export. | 🧪 2026-10-28 | no | KPI 30 d 3,735 → 7,103 (sin docs informativos); demás celdas idénticas. Deuda: vista por producto más lenta |
| MX.2.3 | `GET /commercial/movements/exceptions` — bandeja paginada; los totales y montos se calculan sobre el conjunto completo; <500 ms. | ⬜ | no | Suma de baldes = universo de traspasos del rango |
| MX.2.4 | `POST` **resolución con motivo** (merma, error de captura, faltante de proveedor, …). Extiende `commercial.stock_movement_audits` (⛔ no copiar tabla) con motivo + **foto de lo visto** (cantidad, importe, estado) para detectar la marca rancia. Migración generada e idempotente. | ⬜ | **sí** | ⛔ Obligatoria con el payload de la pantalla, en CI |
| MX.2.5 | Permiso: clave propia para resolver excepciones, **repartida** en prod (regla 20) y `MATRIZ_ACCESOS.md` regenerada. | ⬜ | — | Diff de `role_permissions` en prod |

### C3 · UI
| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| MX.3.0 | **Observaciones de diseño al plan** ([`auditoria-diseno` §9](../../../.claude/skills/auditoria-diseno/SKILL.md)) al final de este doc. Sus 🔴 se vuelven items. | ⬜ | — |
| MX.3.1 | **Diario = reportería**: sale el botón «Auditar»; cada documento dice «cuadrado por el motor», «excepción → bandeja» o «sin comparación»; un vacío se pinta como NO MEDIDO, nunca verde; un error de carga limpia el dato anterior. | ⬜ | |
| MX.3.2 | **Bandeja de diferencias de movimientos** (nombre y ruta: §4 D4). Nace de los «Hallazgos» de `[DM.21]`, no desde cero: lista priorizada por $, ventana del documento con su contraparte, resolver con motivo. | ⬜ | |

⛔ Cargar la skill `diseno` **antes** de tocar el primer archivo. Permiso propio + entrada de sidebar. <500 ms.

---

## 4. Decisiones (las toma Edgar)

| # | Decisión | Recomendación | Estado |
|---|---|---|---|
| D1 | **¿Cuándo se abre?** Fase 0 está en curso y hay 5 fases 🔨 (AB, LE, RH, PQ, FC) para un cupo de 4. | Dejarla ⬜ con este plan y abrirla cuando se libere un lugar. Mientras, sacar sólo D2. | pendiente |
| D2 | **¿Se corrige ya lo que publica cifras falsas?** MX.2.1 (Excel) y MX.2.2 (conteo de documentos) son S y no cambian negocio: arreglan reportes que hoy mienten. Dinero en juego Alto (el Excel es el reporte que se quiere usar) × esfuerzo S = **prioridad 1**. | Sí, como fix suelto de `[DM]` antes de abrir la fase. | pendiente |
| D3 | **Ajustes de inventario (`InvOut1`/`InvIn1`, 393 docs en 90 d) y compras (`EntryOr1`, 3,143)**: ¿siempre a la bandeja, o «sin comparación» hasta tener contra qué compararlos (orden de compra, autorización)? | Ajustes: siempre a la bandeja (un ajuste ya es una excepción). Compras: «sin comparación», y su comparador va en otra fase (Recepción RE / Pedido PQ ya tienen la OC). | pendiente |
| D4 | **Nombre y ruta de la bandeja.** `/almacen/inventory/diferencias` ya existe (conteo físico). | `/almacen/movimientos/excepciones`, rótulo «Excepciones de traspasos». | pendiente |
| D5 | **Días para que «en tránsito» pase a «sin acuse»** (a almacén). | 45 días, la regla que ya usa `[DM.21]`; medir la distribución real de días embarque→recepción antes de fijarla. | pendiente |

---

## 5. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Cupo de fases 🔨 lleno + Fase 0 | Edgar | Método de trabajo §3 y §7 | D1 |
| Pareo por SKU puede pasar de 500 ms | dueño de la fase | Recorre ~110 K renglones de embarque en 90 d | Medir la consulta real del servicio acotada al rango antes de cambiarla (MX.1.1) |
| Pólizas 515 sin llave de destino | dueño de la fase | La sucursal vive en texto libre (`referencia`) | MX.0.3; si no hay llave, retirar el pareo por importe y publicar sólo el neto |
| El pareo deduce el origen por cantidad | dueño de la fase | La recepción no guarda el almacén de origen (MX.0.4) | Encontrar el `cN` en Kepler o declarar el riesgo en el veredicto |

---

## 6. Definición de Terminado

- [ ] 1. Métricas de la cabecera **remedidas**, antes/después publicado (mismas consultas de §1)
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056)
- [ ] 3. `POST` de resolución **ejercido contra base real** con el payload de la pantalla
- [ ] 4. Toda compuerta nueva **rota a propósito una vez**, rojo verificado
- [ ] 5. El catálogo de excepciones vive en `libs/` **o** es deuda con nombre en el tracker
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` + roadmap de `CLAUDE.md` al día
- [ ] 7. **En prod**, o escrito por qué no y qué falta

---

## 7. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-28 | **Sin Excel** (Edgar: «nada de Excel»): sale el botón Excel del Diario, la ruta `GET /commercial/movements/export.xlsx` y `buildXlsx`. Queda el PDF para imprimir, con los KPIs de MX.2.1. La reportería es la pantalla. `check:pantalla` 0 nuevas antes → 0 nuevas después. | Edgar + Claude |
| 2026-10-28 | D2 arrancado por Edgar («inicia»): MX.2.1 y MX.2.2 en código y probados (🧪), sin abrir la fase. Verificación: el código real de HEAD y el del árbol corridos contra prod con la cuenta de solo lectura, columna por columna. | Edgar + Claude |
| 2026-10-28 | Plan escrito. Auditoría del motor (revisión de código + medición en prod): 8 defectos confirmados (§1.1), 6 sospechas descartadas con dato (§1.2), 8 sin medir (§1.3). Fase ⬜, no abierta. | Edgar + Claude |
