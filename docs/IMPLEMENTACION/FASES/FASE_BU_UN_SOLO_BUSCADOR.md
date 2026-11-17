# Fase BU — Un solo buscador

> El método que la gobierna: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).

```
OBJETIVO: Que toda caja de búsqueda de la suite busque igual de bien — varias palabras, cualquier
          orden, proveedor + folio + monto en la misma consulta ("delicias 396 248") — y que el
          usuario DESCUBRA que puede hacerlo, sin motores duplicados.
MÉTRICA:  Servicios de búsqueda sobre el motor canónico `applySmartSearch` —
          HOY (medido 2026-11-06): 22 de 47 · 25 con búsqueda cruda `whereILike '%texto%'` ·
          1 duplicado del motor (`contpaqi/busqueda.ts`)
          → META: los de alto uso migrados, 0 duplicados, para <fecha al abrir>
CAPA TOPE: C3
ÁREA:      Plataforma
DUEÑO:     a definir (sugerido: David Cisneros)
ESTADO:    ⬜  (lista; arranca al liberarse cupo — hoy 6 🔨 contra tope 4)
```

⛔ Antes de pasar a 🔨: fila en el roadmap de `CLAUDE.md` **y** cupo (máximo 4 🔨).

---

## 1. Qué problema resuelve

El motor de búsqueda bueno **ya existe**: `applySmartSearch`
([`libs/platform-core/src/lib/search/smart-search.ts`](../../../libs/platform-core/src/lib/search/smart-search.ts)).
Parte la consulta en palabras (cualquier orden, sin acentos, minúsculas), tiene **columnas
numéricas** (monto y folios con ceros a la izquierda matchean por substring de dígitos), fuzzy por
trigramas, sinónimos de dominio y singular/plural. "delicias 396 248" → `delicias`→proveedor,
`396`→folio, `248`→monto. Es exactamente lo que el usuario recuerda y pide.

**El problema no es que falte: es que no está parejo** (medido 2026-11-06):

- **22 servicios ya lo usan** (catálogo, cotizaciones, clientes, cajas, comprobantes,
  cortes-sucursales, mi-trabajo, servicio, admin, usuarios…).
- **25 servicios siguen con búsqueda cruda** `whereILike '%texto%'` (un solo string en pocas
  columnas de texto, sin partir palabras ni tocar números). Entre ellos **el calendario de pagos**
  ([`payment-calendar.service.ts`](../../../libs/finance/src/lib/payment-calendar/payment-calendar.service.ts),
  el `if (q.search)` busca el string entero en 4 columnas) — por eso ahí "delicias 396 248" no
  encuentra nada. Es la pantalla que motivó la fase.
- **1 duplicado del motor**: [`libs/finance/src/lib/contpaqi/busqueda.ts`](../../../libs/finance/src/lib/contpaqi/busqueda.ts)
  reinventó la misma idea aparte (ADR-056 / regla 16).
- **~100 cajas de búsqueda** en la UI; el valor llega cuando la de más uso enseña lo que puede hacer.

Hoy el usuario **no sabe** que puede combinar palabras: la caja dice "Buscar…" y nada más.

---

## 2. Qué NO incluye

- **No toca los 22 servicios que ya usan `applySmartSearch`** — funcionan; migrarlos sería ruido.
- **No es un cambio de datos** (C0): no hay vista nueva ni tabla; el motor opera sobre las columnas
  que ya trae cada consulta.
- **No agrega una pantalla de ayuda, tour, ni modal de "cómo buscar"** — eso viola el estándar
  ("una sola interfaz por flujo"). Se enseña EN la caja y EN el resultado.
- **No pone fuzzy donde el operador escribe exacto** (cotizaciones ya usa `fuzzy:false` a propósito:
  "altos rollo 25 35" no debe traer "alto rollito"). Cada migración decide su modo.
- **No promete los ~100 inputs de golpe**: se migran por tandas de dinero×uso; "todos" es el
  universo, no el trabajo.

---

## 3. Las capas

### C0 · Dato
Sin cambios de dato. El motor opera sobre columnas existentes de cada consulta. — **N/A, declarado.**

### C1 · Dominio
| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| BU.1.1 | Retirar `contpaqi/busqueda.ts`; su consumidor pasa a `applySmartSearch` | ⬜ | la spec del puente ContPAQi busca "oscar hernandez" y "HERO84" con el motor único |

### C2 · API
| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| BU.2.1 | **Calendario de pagos** → `applySmartSearch` (texto: beneficiary, concept, doc_ref, payee_code · numérico: folio, monto) | ⬜ | no | consulta real: "delicias 396 248" trae el renglón; cada token por separado también |
| BU.2.2 | Migrar los 25 services crudos en tandas por dinero×uso (bancos, caos, gastos, movimientos, fiscal, logística, RH…) | ⬜ | no | por service: una búsqueda multi-token devuelve lo esperado |

### C3 · UI
| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| BU.3.1 | **Placeholder que enseña**: "Proveedor, folio o monto — ej. delicias 396 248" en cada caja migrada | ⬜ | sin fallas nuevas |
| BU.3.2 | **Resaltar el token que pegó** en la fila del resultado (el resultado enseña la capacidad; es el "valor extra" de D3) | ⬜ | sin fallas nuevas |
| BU.3.3 | (opcional) línea de ayuda bajo la caja vía `aria-describedby` ya existente | ⬜ | sin fallas nuevas |

⛔ Cargar la skill `diseno` antes de tocar el primer archivo. <500 ms por búsqueda.

### Frente BU.4 · Código de barras en todo buscador de producto (Edgar, 2026-11-14)

> *«Agreguémosle a todos los buscadores de productos que sirva con código de barras.»* — Edgar,
> sobre la captura de *Tomar pedido* del vendedor («Buscar producto o código»).

**Medido antes de escribir** (prod, sólo lectura, `system_identifier 7688376744939610156`):
- Los códigos viven en 7 casillas de `kepler_ods.kdii` (ERP_KEPLER §3.y.4): 71,779 de 8–14 dígitos,
  3,754 de 6–7. La etiqueta de caja `C`+clave **no** está guardada en ninguna casilla: Kepler la arma.
- El índice GIN `ix_kdii_codigos_verificador` resuelve 6 casillas en ~2 ms; `c102` no está en él y
  es la única casilla de **630** códigos → rama aparte, ~75 ms en las 9 sucursales, ~20 ms con una.
- El vendedor: la **cámara** ya traducía el código (`[VTK.18]`), pero **tecleado, pegado o de pistola**
  daba «sin resultados». *Cotizar* decía «Buscar producto o código» y no buscaba códigos (la ley 0).

| # | Item | Estado | Prueba |
|---|---|---|---|
| BU.4.0 | **Una regla de «qué es un código»** para navegador y API: `@megadulces/contracts/http/codigo-de-barras` (`pareceCodigoDeBarras`: 6–14 dígitos o `C`+5) | 🧪 | spec del vendedor: 7 sí / 8 no |
| BU.4.1 | **Vendedor — Tomar pedido y Cotizar**: el código tecleado, pegado o de pistola (Enter) se traduce a su clave con `claveDeCodigo` (copia del teléfono, también sin señal; si no, en línea), igual que la cámara. Pieza `codigo-tecleado.ts`: Enter resuelve ya; tecleado a mano, al dejar de teclear (450 ms), una sola vez | 🧪 | 62/62 vitest; 7 casos nuevos por el DOM (input + Enter). **Mutante** (sin el cableado, en copia fuera del árbol): 5 rojas, las negativas siguen verdes. `check:pantalla` **NO MEDIDA** (no recorre `apps/vendor`). Sin validación en dispositivo |
| BU.4.2 | **Servidor**: pieza `libs/platform-core/src/lib/kepler/codigo-de-barras.ts` (en `platform-core` porque la usan `commercial`, `trade`, `finance` y `reconciliation`, que no dependen entre sí): `applySmartSearchConCodigo` · `orPorCodigoDeBarras` · `sqlSkuPorCodigoDeBarras[Nombrado]` · `skusDeCodigoDeBarras`. Cableada en **31 consultas de 20 servicios** (abajo) | 🧪 | pieza medida contra prod con knex (EAN c7 → 00066 · sólo c102 → 08090 · C00066 → 00066 · inexistente → nada · «gomitas» → sin rama, 1 ms); spec 9/9 + `armarMatriz` 11/11; vitest commercial 2858 · finance 2835 · platform-core 138 · reconciliation 39 en verde; `api:typecheck` verde. ⚠️ **La consulta de CADA servicio con un código NO se ejerció contra base real** (sólo la pieza): NO MEDIDO por servicio |
| BU.4.3 | **Listas filtradas en el navegador** (`view`, 15 cajas): la fila no trae código; hace falta resolver el código a claves antes de filtrar (como `CodigoTecleado`) | ⬜ | — |
| BU.4.4 | **`c102` en la copia de precios y en `/kp/precio`** (`apps/api/src/modules/kp/kp.service.ts` `COLS_PRECIO`): hoy lee 6 casillas; 630 códigos viven sólo en `c102`. Lo usan el verificador de tienda, el checador y el traductor del vendedor | ⬜ | — |

**Censo del 2026-11-14** (61 cajas de producto: 39 de servidor, 22 de navegador). Antes: 15 encontraban
por código, 8 a medias (sólo `catalog.products.barcode`), 38 no.

Cableado en BU.4.2 (servidor): `commercial-products` `list` (las 14 pantallas de `app-product-search`,
incl. Salidas y Sell-out) y `priceReport` · `bi-almacen` `productSearch` · `warehouse-locations-assign`
`products` (con la sucursal de Kepler) · `expiry-reviews` `searchProducts` y `listExpediente` ·
`standard-cost` `universo`/`matriz`/`entreSucursales`/`contraUltimo` · `receiving-claims` `list` ·
`replenishment` `workbook` (y sus 3 hermanas) · `postmortem` · `sobrante` · `deadStock` · `movements`
`base` · `presale-picking` `substitutes` · `pricing` `listPrices` · `profitability` `breakdown` ·
`revision` `publicadas` · `weekly-analytics` `topProducts` · `negative-stock` `list` y `existencia`
`list` (filtro en memoria: claves resueltas antes) · `precios-catalogo` `sinClasificar` ·
`reconciliation` `movements` · `commercial-map` `resolveProductsByText` · `customer-ledger`
`buscarPorProducto` · `catalog-search` del portal (`listAllProducts`, `likeSearch`).

Fuera, a propósito: la búsqueda por IA del portal (`search`, vectorial) y el kardex de Diferencias
(caja de SKU exacto). `catalogo-buscador.ts` (`[COT.41]`) ya leía las 7 casillas y se deja: unificarlo
con la pieza es deuda con nombre (misma regla, dos implementaciones).

### Frente BU.5 · El orden por coincidencia (Edgar, 2026-11-17)

> «En Kepler, cuando busca *el rey* te arroja los productos El Rey; hoy nosotros ponemos *rey* y sale
> REYMA o REYHER antes. ¿Cómo podemos mejorar todos nuestros buscadores?»

`applySmartSearch` sólo FILTRA (cada palabra como substring, «el» descartada como relleno) y el orden
lo pone cada buscador: en el catálogo, lo más vendido. Así «rey» casa con «REYMA» y gana por venta.
Medido en Canindo (sólo lectura): «el rey» traía **1 de 12** productos El Rey entre los primeros; «vaso
el rey», **0 de 12** (10 REYMA VASO arriba).

| ID | Item | Estado | Criterio |
|---|---|---|---|
| BU.5.1 | **`smartSearchRank`** en `platform-core` (junto al filtro): 0 = la frase tal cual en palabras completas · 1 = todas las palabras completas · 2 = todas al inicio de palabra · 3 = el resto. Va después de los aciertos exactos (clave, código) y antes del orden de negocio. Cableado en `catalogo-buscador.ts` (cotizador y levantamiento) | 🧪 | Medido en prod con el SQL real de knex (Canindo): «el rey» **12 de 12** El Rey; «vaso el rey» los 3 vasos El Rey primero; «rey» ya no trae REYMA arriba; «reyma», «mazapan», «gomitas» iguales. Tiempo igual (antes 150–275 ms, después 135–292 ms). Spec 5/5 con mutante (la frase sin relleno → rojo) en copia fuera del árbol; vitest commercial 526 en verde |
| BU.5.2 | Adoptar el orden en los demás buscadores: **50 llamadas a `applySmartSearch` en 34 archivos** ordenan cada una a su manera (clientes por clave, proveedores por nombre…) | ⬜ | por buscador: una búsqueda de frase con un falso amigo («rey» / REYMA) trae primero la frase |
| BU.5.3 | El **detalle** de la cotización re-ordenaba los resultados ALFABÉTICO en el navegador (el alta ya no, COT.16): deshacía el orden del servidor. Quitado | 🧪 | `ngc` limpio; televenta 123/123 |

### Frente BU.6 · El súper buscador (Edgar, 2026-11-17)

> «Necesito que sea un súper buscador, que cubra todo tipo de necesidad, hasta por ejemplo *¿quisiste decir esto?*»

Lo que «todo tipo de necesidad» quiere decir, y dónde está cada cosa:

| Necesidad | Ejemplo | Dónde |
|---|---|---|
| Varias palabras en cualquier orden, sin acentos | «ortiz vera» | ✅ `applySmartSearch` |
| Plural y diminutivo | «paletas», «payasitos» | ✅ `stem` |
| Abreviaturas de Kepler | «paleta» → PAL | ✅ `synonyms` (catálogo) |
| Código de barras / clave en cualquier casilla | 7500533001091 | ✅ BU.4 / COT.41 |
| La frase primero, no el falso amigo | «el rey» antes que REYMA | 🧪 BU.5.1 (catálogo) |
| **¿Quisiste decir…?** (errores de dedo, palabras pegadas) | «gomtas» → gomitas · «elrey» → el rey | 🧪 **BU.6.1** (catálogo del cotizador) |
| Resaltar lo que pegó | GOM**ITAS** | ⬜ BU.3.2 |
| Lo mismo en TODOS los buscadores | clientes, proveedores, folios | ⬜ BU.5.2 / BU.6.2 |

| ID | Item | Estado | Criterio |
|---|---|---|---|
| BU.6.1 | **`corregirConVocabulario` + `similitudTrigramas`** en `platform-core` (puros): palabra existente se queda · si no, la más parecida del vocabulario (≥ 0.4, la fórmula de `similarity()` de pg_trgm) · si no hay parecida y está pegada, se separa. Endpoint `GET /commercial/quotes/catalog/suggest`: vocabulario = palabras de `kdii.c2` de la sucursal, en memoria 10 min (no tabla, no cron), y la sugerencia sólo sale si con ella SÍ hay artículos. Alta y detalle del cotizador la piden cuando no hay resultados: «¿Quisiste decir **gomitas**?» (clic = buscarla) | 🧪 | Hoy un error de dedo daba **0 resultados** (gomtas, mazapna, bubaloo, chamoyy, elrey). Con el vocabulario real de Canindo (4,510 palabras): gomtas→gomitas · mazapna→mazapan · elrey→el rey · bubaloo chamoyy→bubbaloo chamoy · mazapanes→mazapan; bien escrito, códigos y basura → nada; **9–17 ms** en memoria (la versión en SQL costaba 420–900 ms). Parecidos idénticos a pg_trgm (0.50 · 0.45 · 0.70 · 0.67). Spec 10/10 con mutante (partir antes que parecer → rojo). **Arranque de Nest no verificado** (ruta nueva con `@Query` string, mismo patrón que `catalog`). **Sin validación visual** |
| BU.6.2 | La misma sugerencia en los demás buscadores: cada uno da su vocabulario (clientes, proveedores…) | ⬜ | por buscador: un error de dedo sugiere la palabra correcta |

---

## 4. Decisiones (→ ADR)

| # | Decisión | ADR | Fecha |
|---|---|---|---|
| D1 | Arreglo chico de calendario-pagos: ¿ya o a la agenda de David? | — | pendiente Edgar |
| D2 | Fase BU completa: ¿abrir ahora (qué 🔨 se cierra/pausa) o ⬜ hasta liberar cupo? | — | pendiente Edgar |
| D3 | Valor extra priorizado: resaltar token · sinónimos por dominio · monto±tolerancia | — | pendiente Edgar |
| D4 | El motor único es `applySmartSearch` (platform-core); `contpaqi/busqueda.ts` se retira (ADR-056) | candidato | 2026-11-06 |

---

## 5. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Cupo 🔨 excedido (6 vs 4) | Edgar | no abre fase nueva sin cerrar/pausar | decisión D2 |
| `fuzzy` mal elegido mete ruido | dueño fase | trigramas donde se escribe exacto | cada service declara su modo; prueba con caso real |
| El resaltado del token rompe densidad de tabla | dueño fase | marcar texto cambia alto de fila | validación visual, estándar |

---

## 6. Definición de Terminado

- [ ] 1. Métrica remedida: servicios sobre el motor único, antes/después publicado
- [ ] 2. Cada capa verificada o declarada NO MEDIDA (ADR-056)
- [ ] 3. (no aplica: ningún endpoint de esta fase escribe — declarado)
- [ ] 4. Compuerta nueva (si la hay) rota a propósito una vez, rojo verificado
- [ ] 5. `contpaqi/busqueda.ts` retirado; 0 duplicados del motor
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` + roadmap de `CLAUDE.md` al día
- [ ] 7. En prod, o escrito por qué no y qué falta

---

## 7. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-06 | Doc creado. Medido: 22/47 services en `applySmartSearch`, 25 crudos (incl. calendario de pagos), 1 duplicado. Plan en 2 tramos: arreglo chico de calendario-pagos + fase BU. Pendientes D1–D3 de Edgar. | Claude (PM) |
| 2026-11-06 | **BU.2.1 codificado**: calendario de pagos pasa a `applySmartSearch` (columns beneficiary/concept/doc_ref/payee_code/original_amount, numeric original_amount/available_amount). **BU.3.1 codificado**: placeholder «Proveedor, folio o monto — ej. delicias 396 248». Typecheck 0 err; `check:pantalla` 0 fallas nuevas. **Verificado contra prod (sólo lectura, system_identifier 7688376744939610156)**: «bolsas 303 1591» (proveedor+folio+monto) → 1 fila correcta (ACREEDOR BOLSAS DE LOS ALTOS, folio 0000303, $1,591,000); el ILIKE viejo de frase entera → 0. Edgar: aplicarlo a TODOS los buscadores. Rollout iniciado en 3 oleadas (finance / commercial / logistics+fiscal+hr+trade), ~23 services, a revisar diff antes de empujar. BU.3.2 (resaltado) declarado pendiente. | Claude |
| 2026-11-17 | **BU.5.1** 🧪: el orden por coincidencia (`smartSearchRank`), cableado en el buscador del catálogo; «el rey» de 1 a 12 de 12 en Canindo. BU.5.2 (los otros 50 buscadores) pendiente. | Claude |
| 2026-11-17 | **BU.6.1** 🧪: «¿Quisiste decir…?» en el buscador de artículos del cotizador (alta y detalle); pieza pura en `platform-core`, vocabulario por sucursal en memoria. **BU.5.3**: el detalle ya no re-ordena alfabético. BU.6.2 (los demás buscadores) pendiente. | Claude |
