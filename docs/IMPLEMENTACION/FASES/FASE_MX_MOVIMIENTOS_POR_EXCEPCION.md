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
              MX.0.1 (medido 2026-10-28, 4,282 marcas): **3,882 (90.7 %) cayeron en documentos que el motor ya
              cuadraba por SKU**; sólo 21 tocaron una excepción, de 1,222 excepciones disponibles (1.7 %).
              → META: 0 clics sobre documentos cuadrados; la bandeja sólo trae excepciones.
          (2) Cifras publicadas por la pantalla/Excel que son falsas o incompletas SIN declararlo
              HOY: 6 confirmadas en prod (§1.1: #1, #2, #3, #4, #6, #7) + 1 de lógica sin caso medido (#5) → META: 0.
          Fecha meta: la fija el PM al abrir la fase.
CAPA TOPE: C3
ÁREA:      Logística (Almacén) · toca Finanzas por el mayor 515
DUEÑO:     por asignar (Edgar)
ESTADO:    🔨 abierta 2026-10-28 por Edgar («arranca entonces»), 6ª en curso por encima del cupo de 4. C0 medida entera (MX.0.1–0.4 ✅); MX.2.1/2.2 🧪.
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
| 8 | Se compara la **suma** del documento, no cada SKU. | ⚠️ **CORREGIDO 2026-10-28: no hay casos.** Los «4 documentos con productos cambiados» de la primera medición eran renglones **sin `product_id`** en los dos lados (p. ej. SKU 99225): una comparación por `product_id` nunca empata NULL con NULL. Comparados por **SKU** cuadran. Medido con el código real (MX.1.1): 0 cambios de veredicto en 30 y 90 d. Queda como **riesgo sin casos**, cubierto por una firma barata. | S:195, S:213, S:259 | MX.1.1 🧪 |
| 9 | ⭐ **El «importe» de una salida no tiene una sola unidad: depende del destino** (hallado en MX.0.2). `analytics.stock_movements.amount` sale de `kdm2.c13` (o `c12×qty`), que es lo que asienta el DOCUMENTO. | 90 d de `TrsfShip`: **a otra sucursal** ($79.7 M) el documento es el **valor de traspaso** y es idéntico a la recepción en **1,762 de 1,764** pares; **a cliente** (`C…`, **$31.2 M**) está a **precio de venta** (`c12 ≈ c66`, lista) y el kardex (`kdij.c13`, costo) vale **0.83×** — 0 de 119 iguales; **a ruta** (`R…`, $10.4 M) mezcla (74 de 181 iguales, 1.07×). «Valor movido», «Valor enviado» y los montos de «sin acuse cliente/ruta» suman unidades distintas sin decirlo. | importador `import-stock-movements.js:175` | MX.1.7 |

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
| **Nuevo (MX.1.3):** el filtro de destino dice «por defecto sólo sucursales», pero deja pasar las entregas a **clientes** (`C…`): de 186 salidas «en tránsito» del Diario por defecto, 136 eran a cliente o ruta | `applyDestFilter` | MX.3.1 |

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
| MX.0.1 | Medir el cruce **marcas de auditoría × estado del motor**: de las 4,237 marcas, cuántas cayeron en documentos `ok` por SKU. Fija el «HOY» real de la métrica (1). | ✅ medido 2026-10-28 | Veredicto por SKU (mismo pareo que el motor, ventana desde jun-2026) cruzado con `commercial.stock_movement_audits` (4,282 marcas): recepciones **1,899 de 1,905 ok** · 3 diferencia · 3 fuera de ventana; salidas **1,983 de 2,001 ok** · 14 diferencia · 4 sin recepción a almacén; compras/ajustes 376 sin comparación. **90.7 % de las marcas sobre documentos ya cuadrados; 21 sobre excepciones.** Universo del mismo periodo: 113 con diferencia + 1,109 salidas a almacén sin recepción = **1,222 excepciones, 1.7 % auditadas**. El pareo por SKU ya se había contrastado con el motor real (90 d: 2,203 ok en los dos). Script `mx01-marcas.js` |
| MX.0.2 | **Por qué llegan renglones sin costo** (`amount` y `unit_cost` NULL): ¿viene así de Kepler (`kdm2`) o se pierde al armar `analytics.stock_movements`? No adivinar. | ✅ medido 2026-10-28 | **Viene de Kepler, no de la ingesta.** El documento (`kdm2`) trae `c12 = 0` y `c13 = 0`; el importador sólo convierte el 0 en NULL (`NULLIF(t,0)`). Hipótesis descartadas con dato: *producto sin historia* (los 38 tenían costo días antes), *llegó de regalo* (en 37 de 38 la última entrada al mismo almacén traía costo), *almacén sin existencia* (24 de 30 tenían existencia; control 13 % vs casos 20 %, sin señal). **El kardex sí los vale:** `kdij.c13` (importe del kardex; validado: igual al documento en **539 de 539** recepciones) trae **$29.5 K** en las 30 salidas vacías; las 8 recepciones vacías también están en 0 en el kardex. ⚠️ No se rellena con `kdij`: en una salida el kardex está a costo promedio de origen y el documento a valor de traspaso (otra unidad, +6 % entre sucursales) → se declara `importe_incompleto` (MX.1.2). Hallazgo lateral: #9 de §1.1. La causa de que Kepler asiente 0 en esos renglones (varios son artículos promocionales: «= GRATIS», exhibidores, juguetes) queda **NO MEDIDA** |
| MX.0.3 | **Llave real del pareo de pólizas 515**: buscar en `gl_poliza_lines` / `kdc2*` la sucursal destino como columna (no regex sobre texto libre). Si no existe, el pareo por importe **se retira** y se publica sólo el neto por sucursal, con el descarte declarado. | ✅ medido 2026-10-28 | **La llave existe: el DOCUMENTO.** La póliza automática trae `(warehouse_id, tipo_pol, folio)` del documento que la generó: `UA5001` = recepción (`TrsfRcv`), `UD4102` = embarque (`TrsfShip`). Cadena: entrada 515-001 `UA5001` (R, folio) → `TrsfRcv` → `parent_folio/serie` → `TrsfShip` (S) → póliza `UD4102` de S. Jul–sep: **971 de 992 entradas (97.9 %) emparejan al peso, $55.37 M de $56.55 M; placebo (`parent_folio+1`) = 3**. Testigo: importe de póliza = Σ `amount` del documento (salida 498/518, entrada 853/992 al peso; placebo 0). ⭐ **Por qué el mayor 515 «no cuadra» por $38 M:** el que envía casi nunca asienta 515-002 — con la misma `UD4102` carga **401-003 «Ventas vecinal»** (379 entradas, $19.6 M), **515-002** (323) o **116 «Traspasos de mercancía»** (287). No es tránsito: es contabilización asimétrica. **Sin llave (no recuperable por esta vía):** lo que el regex descarta desde julio son pólizas **manuales del CEDIS** (`00`, `tipo_pol='0000'`, `folio='S/F'`): $30.8 M de entradas y $1.14 M de salidas; patrón `C#####` (340 renglones, $28.6 M) — hipótesis «consecutivo Wincaja» **refutada** (0 cuadran, igual que el placebo). Octubre NO MEDIDO. Scripts: `mx03-final.js` (re-corrido y confirmado), `mx03-llave.js`, `mx03-wincaja.js` |
| MX.0.4 | ¿La recepción `TrsfRcv` guarda el **almacén de origen** en algún `cN` de `kdm1`? Hoy se deduce por cantidad más cercana. | ✅ medido 2026-10-28 | **Sí: `kdm1.c10`** de la recepción (`U-A-50`) es la clave `TI…` de la sucursal que envió. Contra 200 pares con origen conocido (cantidad idéntica): **200 de 200** iguales al origen, **placebo (otra sucursal) 0**; la única otra columna con coincidencias (`c90`) da 2 contra 10 del placebo = ruido. Cobertura 90 d: **2,219 de 2,219** recepciones con `c10`, todas resolubles por `analytics.transfer_dest_map`. ⚠️ El importador lo **tira**: sólo guarda `dest_code` cuando el documento es `TrsfShip` (`import-stock-movements.js:189`). Con esto el pareo puede llevar **origen como llave** y deja de adivinar por cantidad (ver §5). Script `mx04-origen.js` |

⛔ Sin importer. Lo que no se pudo verificar **se declara**, nunca se dibuja como 0.

### C1 · Dominio
| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| MX.1.1 | **Pareo por SKU, en UNA implementación.** `TRANSFER_PAIRING_SQL` compara renglón por renglón (no `SUM(qty)` del documento), y el Diario (`near()`, S:615-681) y el detalle (S:816) usan el mismo veredicto. El filtro por SKU del Diario no altera el estado. ⚠️ La consulta por SKU tardó ~1.4 s sobre 90 d (consulta de prueba, no la del servicio): medir la del servicio acotada al rango; <500 ms. | 🧪 2026-10-28 | Firma de productos `SKU_SIG` = Σ(round(qty,2) × hashtext(sku)) en el MISMO barrido que suma piezas; `ok` exige suma Y firma, en las tres implementaciones (Cuadre `TRANSFER_PAIRING_SQL`, lista `annotateTransferStatus`, detalle `document()`). **Antes/después, código real HEAD vs árbol en prod:** Cuadre 30 d 270 → 325 ms y 90 d 375 → 447 ms, mismos totales; lista 30 d y 90 d, 0 cambios; detalle 40/40 iguales. **Prueba negativa** (fórmula leída del código, evaluada en Postgres): 10 de A ↔ 10 de B, intercambio con misma suma y decimales cambiados → DIFIERE; mismo producto, renglones partidos y SKU sin `product_id` → cuadra. ⚠️ La comparación renglón por renglón se intentó y se descartó: 1.9 s (30 d) y 7 s (90 d) aun materializada |
| MX.1.2 | **Vacío ≠ cero.** Un renglón sin importe hace que el documento diga `importe_incompleto` (con conteo); un lente sin datos en el rango devuelve `status: 'unknown'`, `measured: false` (ADR-056). El veredicto lo decide el backend, no `Number(x)\|\|0` en la pantalla. | ⬜ | Spec: base 0/null → `unknown`, no `ok` |
| MX.1.3 | **Envejecimiento del tránsito.** `en_transito` → `sin_acuse` pasados N días (hoy 45, §4 D5) **sólo** si el destino es almacén; ruta/cliente → `sin_recepcion_esperada`. Misma regla que los baldes de `[DM.21]`, una sola vez. | 🧪 2026-10-28 | `SIN_ACUSE_DIAS = 15` y `estadoSinRecepcion()` en el backend, una sola regla para el Diario y el Cuadre; estados nuevos `sin_acuse` y `sin_recepcion_esperada` (filtro, etiquetas de pantalla y PDF); el umbral viaja en `hallazgos.sin_acuse.umbral_dias`, la pantalla no lo repite. **Antes/después, código real HEAD vs árbol contra prod:** Diario 30 d (filtro por defecto) de 186 «en tránsito» → **136 «a ruta o cliente» + 50 en tránsito**; 90 d todas las salidas listadas 334 → 276 + 58. Cuadre «sin acuse viejos» 90 d: **49 ($1.21 M) → 60 ($1.66 M)** con el umbral de 15 d. **Cruce de las dos implementaciones:** 25 de 25 «viejos» del Cuadre salen «sin acuse» en el Diario. Tiempos del Diario sin cambio (~0.5 s, ya estaba al borde). ⚠️ **Arreglo de paso (defecto previo):** con filtro de estado, `lines()` pareaba ANTES de resolver el destino ([DM.20] dice que es la llave) — ahora resuelve primero. ⚠️ Con rangos largos el filtro de estado sigue topado a 2,000 docs (B1); la pantalla lo pide por día y no lo toca |
| MX.1.4 | **Catálogo de excepciones**: `diferencia_sku`, `diferencia_cantidad`, `sin_acuse_almacen`, `sin_origen`, `importe_incompleto`, `ajuste_inventario` (§4 D3) y `sin_comparacion` por `doc_code`. Primitivo en `libs/` (ADR-056: no inventar otra bandeja de hallazgos local). | ⬜ | Spec: cada `doc_code` del universo cae en exactamente un balde |
| MX.1.5 | **Medir y corregir netos y tolerancias** (§1.3): primero medir cuántas filas verdes esconden \|Δ\| > $5 K por sucursal/documento; luego tolerancia por fila, sin netear entre documentos. Commit de medición aparte del de cambio de regla. | ⬜ | Antes/después con la misma consulta |
| MX.1.6 | **Mayor 515 honesto**: una sola fuente para mayor y detalle, signo único, y el descarte publicado (renglones e importe fuera del pareo). Con MX.0.3: el pareo por importe ±2 % y el regex `destino()` se **retiran**; se empareja por la cadena de documentos y la salida se busca en **515-002, 116 y 401-003**; las pólizas manuales sin documento se publican aparte como «sin documento». | ⬜ | Mayor = detalle en el mismo rango, al centavo |
| MX.1.7 | **La unidad del importe se declara por destino** (§1.1 #9): a sucursal = valor de traspaso; a cliente = precio de venta; a ruta = mezcla sin resolver. Ningún total suma las tres sin rotularlo; si la pregunta es «cuánto costó lo que salió», se toma el costo del kardex (`kdij.c13`) y se dice. | ⬜ | Por destino: documento vs recepción (sucursal) y documento vs kardex (cliente/ruta) |

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
| D1 | **¿Cuándo se abre?** Fase 0 está en curso y hay 5 fases 🔨 (AB, LE, RH, PQ, FC) para un cupo de 4. | Dejarla ⬜ con este plan y abrirla cuando se libere un lugar. Mientras, sacar sólo D2. | **Abierta 2026-10-28 por decisión explícita de Edgar** («arranca entonces»), después de que Claude la dejara sin abrir por el cupo. ⚠️ Queda **6ª en curso** con cupo de 4: el método (§3.1) pide escribir por qué — Edgar la prioriza; Claude no la habría abierto. |
| D2 | **¿Se corrige ya lo que publica cifras falsas?** MX.2.1 (Excel) y MX.2.2 (conteo de documentos) son S y no cambian negocio: arreglan reportes que hoy mienten. Dinero en juego Alto (el Excel es el reporte que se quiere usar) × esfuerzo S = **prioridad 1**. | Sí, como fix suelto de `[DM]` antes de abrir la fase. | **Hecho 2026-10-28** — MX.2.1 y MX.2.2 en código (🧪); el Excel se quitó por decisión de Edgar. |
| D3 | **Ajustes de inventario (`InvOut1`/`InvIn1`, 393 docs en 90 d) y compras (`EntryOr1`, 3,143)**: ¿siempre a la bandeja, o «sin comparación» hasta tener contra qué compararlos (orden de compra, autorización)? | Ajustes: siempre a la bandeja (un ajuste ya es una excepción). Compras: «sin comparación», y su comparador va en otra fase (Recepción RE / Pedido PQ ya tienen la OC). | **Decidido 2026-10-28** (Claude, por delegación de Edgar: «sigue bajo tu razonamiento»): ajustes (`InvOut1`/`InvIn1`) **siempre a la bandeja**; compras y demás tipos **«sin comparación»**, visibles en el Diario y fuera de la bandeja hasta tener testigo. |
| D4 | **Nombre y ruta de la bandeja.** `/almacen/inventory/diferencias` ya existe (conteo físico). | `/almacen/movimientos/excepciones`, rótulo «Excepciones de traspasos». | **Decidido 2026-10-28** (Claude, por delegación de Edgar: «sigue bajo tu razonamiento»): **`/almacen/movimientos/excepciones`**, rótulo «Excepciones de traspasos». |
| D5 | **Días para que «en tránsito» pase a «sin acuse»** (a almacén). | 45 días, la regla que ya usa `[DM.21]`; medir la distribución real de días embarque→recepción antes de fijarla. | **Decidido 2026-10-28** (Claude, por delegación de Edgar: «sigue bajo tu razonamiento»): **15 días**, no 45. Medido (1,270 pares a almacén con cantidad idéntica, embarques mar–sep 2026): mediana 0 d, p90 4, p95 5; sólo 4 llegan después de 15 d (0.3 %), máx. 63. A los 45 d se esconden 30 días de alarmas reales. |
| D6 | **Cómo llega el origen de la recepción (`kdm1.c10`, MX.0.4) al pareo:** cambiar el importador `import-stock-movements.js` para que guarde `dest_code` también en `TrsfRcv`, o leerlo de `kepler_ods.kdm1` en el pareo. | Leerlo en el pareo (no tocar un importador en retiro), si su costo medido cabe en 500 ms; si no, el importador. | **Decidido 2026-10-28** (Claude, por delegación de Edgar: «sigue bajo tu razonamiento»): **leer `kdm1.c10` en el pareo**, sin tocar el importador. Costo medido sólo de esa lectura: 250–330 ms (90 d); sumado al pareo (~270 ms) roza el límite → se mide la consulta real en MX.1.1 y, si pasa de 500 ms, se escala a Edgar. |
| D7 | **Hallazgos contables de MX.0.3, fuera de esta fase:** salidas de traspaso asentadas en 401-003 «Ventas vecinal» ($19.6 M jul–sep) y pólizas manuales del CEDIS sin documento ($30.8 M). | Abrirlos como hallazgos de Contabilidad (`AUDITORIA_BASE_INICIAL.md`), no como items de MX. | **Decidido 2026-10-28** (Claude, por delegación de Edgar: «sigue bajo tu razonamiento»): **registrados en Contabilidad** como `AUD-DAT.23` (traspasos a 401-003, $19.6 M jul–sep) y `AUD-DAT.24` (pólizas manuales del CEDIS en 515: $87.7 M entradas / $95.0 M salidas jul–sep; $30.8 M de entradas ni identificables por referencia). |

---

## 5. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Cupo de fases 🔨 lleno + Fase 0 | Edgar | Método de trabajo §3 y §7 | D1 |
| Pareo por SKU puede pasar de 500 ms | dueño de la fase | Recorre ~110 K renglones de embarque en 90 d | Medir la consulta real del servicio acotada al rango antes de cambiarla (MX.1.1) |
| Pólizas 515 sin llave de destino | dueño de la fase | La sucursal vive en texto libre (`referencia`) | MX.0.3; si no hay llave, retirar el pareo por importe y publicar sólo el neto |
| El pareo deduce el origen por cantidad | dueño de la fase | MX.0.4: el origen SÍ está (`kdm1.c10`), pero `analytics.stock_movements` no lo guarda para `TrsfRcv` | ⚠️ **Decisión de Edgar (D6):** llevar `c10` a `stock_movements` toca el importador `import-stock-movements.js` (existente, no uno nuevo; `database/importers/**` está en retiro) o resolverlo en el pareo leyendo `kepler_ods.kdm1` por la llave del documento. Recomendación: lo segundo, sin tocar el importador, **si** su costo medido cabe en 500 ms (no medido: la nota de `bench-ods-derive-stock-movements.js` advierte que los joins a `kdm1/kdm2` con `btrim()` no usan índice) |

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
| 2026-10-28 | C0 medida entera (MX.0.1–0.4 ✅). Decisiones D1–D7 tomadas por Claude con delegación de Edgar («sigue bajo tu razonamiento»): la fase **sigue sin abrirse** (cupo); D5 = 15 días con dato; D6 leer `kdm1.c10` en el pareo; D7 → `AUD-DAT.23`/`.24`. | Claude (delegado) |
| 2026-10-28 | **Sin Excel** (Edgar: «nada de Excel»): sale el botón Excel del Diario, la ruta `GET /commercial/movements/export.xlsx` y `buildXlsx`. Queda el PDF para imprimir, con los KPIs de MX.2.1. La reportería es la pantalla. `check:pantalla` 0 nuevas antes → 0 nuevas después. | Edgar + Claude |
| 2026-10-28 | D2 arrancado por Edgar («inicia»): MX.2.1 y MX.2.2 en código y probados (🧪), sin abrir la fase. Verificación: el código real de HEAD y el del árbol corridos contra prod con la cuenta de solo lectura, columna por columna. | Edgar + Claude |
| 2026-10-28 | Plan escrito. Auditoría del motor (revisión de código + medición en prod): 8 defectos confirmados (§1.1; el #8 se corrigió después: sin casos), 6 sospechas descartadas con dato (§1.2), 8 sin medir (§1.3). Fase ⬜, no abierta. | Edgar + Claude |
