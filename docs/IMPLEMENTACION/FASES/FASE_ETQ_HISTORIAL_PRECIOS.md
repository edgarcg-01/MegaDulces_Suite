# ETQ-HISTORIAL — Buscar un producto y ver su historial de cambios de precio

> **Dónde:** `/tienda/etiquetas/cambios` (Cambios de precio). **Dueño:** 0Sistemas. **Estado:** 🧪 construido en LOCAL, sin commitear ni PR (2026-10-28): falta que el revisor lo vea en el navegador y corra el E2E.
> **Pedido:** «agregar un buscador de productos para que nos despliegue su historial de cambio de precios… probarlo en local para revisarlo y mandar su PR».
> **La pregunta que contesta (una sola, sin «y»):** *¿qué precio ha tenido este producto en esta tienda, y desde cuándo?*
> **Métrica (HOY):** hoy esa pregunta **no se puede contestar** desde ninguna pantalla: «Cambios de precio» sólo muestra **un día**. Meta: de un producto a su historial en **≤ 2 acciones** (escribir, elegir) y **≤ 0.5 s** de carga.


> ⭐ **[ETQ-HISTORIAL.4] 2026-10-28 — cambio de dónde (reemplaza D3 y los puntos 1–2 de §2):** al PM no le gustó el buscador embebido en la cabecera de «Cambios de precio» con el historial en un panel lateral. Ahora es **una pestaña propia, «Historial de precios»** (`/tienda/etiquetas/historial`), al lado de «Cambios de precio», mismo permiso (`STORE_LABELS_VER`): se busca el producto y su historial **se despliega en línea** en esa pantalla (sin `side-peek`). «Cambios de precio» vuelve a quedar como estaba. El endpoint, el contrato y la regla de compactar no cambian. Probado: spec del componente (+2: la pestaña y el estado «sin producto elegido»; mutación quitando la pestaña da rojo). **Sin validación visual** hasta que se vea en el navegador: lo más probable de ajustar es el ancho del buscador y el espacio bajo las pestañas.
---

## 1. Lo medido (prod, sólo lectura, 2026-10-28, cuenta `sistemas`; `system_identifier` = 7688376744939610156)

| Hecho | Medida |
|---|---|
| Profundidad de la bitácora | **2 años**: de 2024-10-12 a ayer, en las **9** plazas (`analytics.v_label_price_changes`) |
| Costo de pedir UN producto en UNA plaza | **65 ms** toda la historia · **29 ms** 365 días · 11,631 / 10,152 bloques · usa el índice **`ix_kdpv_bitacora_cambio_plaza_dia`** que ya existe → **no hace falta migración ni índice nuevo** |
| Costo de pedirlo en las 9 plazas a la vez | **386 ms** y 107,929 bloques (recorre el índice entero filtrando el SKU) → **v1 es por plaza** |
| ⭐ **Las filas NO son cambios** | SKU 92013 (`REYMA VASO #16 LARGO 25P`), plaza 06, caja: **687 filas en 98 días, 676 de 686 pasos repiten el mismo precio** (`1152.44 → 1152.45`, 5–10 veces el mismo día). Kepler **recalcula y vuelve a escribir** lo mismo |
| Variedad real | ese producto tiene **21 precios distintos** en 2 años, no 700 cambios |

⭐ **Consecuencia de diseño:** mostrar las filas tal cual sería publicar ruido (700 renglones donde hay ~21 hechos). El historial **se compacta en tramos**: *«a $1,152.45 desde el 2026-10-27»*, por presentación (pieza / paquete / caja). Una ida y vuelta (A → B → A) **sí** son tres tramos: sólo se funden los renglones **consecutivos** con el mismo precio.

**H.0.1 — medido el 2026-10-28:** de los **3,580** códigos que cambiaron de precio en la plaza 06 en los últimos 90 días, **3,566 (99.6 %)** existen como `products.sku`. Los 14 que faltan son descontinuados («* DESCONTINUADO») y códigos de promoción de Kepler («PEGAR 1 PZ…», «= GRATIS»): no son productos que alguien vaya a buscar. El `sku` del catálogo **es** el `c3` de la bitácora.

---

## 2. Qué se construye

1. **Buscador** en la cabecera de «Cambios de precio» (nombre / código / código de barras): **reutiliza** `GET /store/labels/search` (ya marca las promociones de $0.01). Búsqueda por `applySmartSearch` en el cliente, nunca `.includes()` (D.8).
2. **Historial en un `app-side-peek`**: al elegir un producto se abre al lado **sin perder la lista del día** (patrón canónico master-detalle). Muestra, de la plaza elegida:
   - **Primario:** el precio **vigente** y desde cuándo; **secundario:** los tramos (desde · hasta · precio · cambio vs. el tramo anterior · veces que Kepler lo escribió); **terciario:** hora, presentación.
   - Rango (`app-segmented`): **90 días · 1 año · todo**. Por defecto 1 año.
3. **Endpoint de lectura** `GET /store/labels/price-history?sucursal=&sku=&dias=` (permiso **`STORE_LABELS_VER`** ya repartido → regla 20 no aplica).
4. **Regla de compactar en `libs/contracts`** (`compactarHistorial`, función pura), como `agruparPorCodigo`: la usa el servidor y se prueba una vez (ADR-056: un primitivo no se inventa en una pantalla).

**Lo que se declara y no se dibuja como cero:** si la plaza no tiene filas del producto → «sin cambios registrados en este rango» **distinto** de «la bitácora no llega» (`fuente_al`, ya existe); `es_baja` (precio nuevo 0) va con su bandera («Kepler le quitó el precio»), no como rebaja; un error de lectura dice «no se pudo leer», no «sin historial».

---

## 3. Por capas (método: una capa no sube hasta que la de abajo está verificada)

| Capa | Item | Qué | Se prueba con |
|---|---|---|---|
| **C0 dato** | H.0.1 | Contrastar `products.sku` ↔ `c3` de la bitácora: % de productos del catálogo con historial, y los que no (por qué) | consulta de sólo lectura a prod; número en la fase |
| | H.0.2 | Sembrar local **reversible** la bitácora (`kepler_ods.kdpv_bitacora_precios` + la vista) con casos conocidos: repeticiones, A→B→A, precio 0, dos presentaciones, producto sin cambios | `database/scripts/etq-historial-sembrar-local.js` con `--borrar` |
| **C1 dominio** | H.1.1 | `compactarHistorial` en `libs/contracts` + spec: colapsa consecutivos iguales, **conserva A→B→A**, separa por presentación, marca `es_baja`, orden y tope | vitest; **mutación** (colapsar globalmente → rojo) |
| **C2 API** | H.2.1 | `price-history` en `CommercialLabelsService` sobre la vista; `sku` y `sucursal` validados (400 si faltan o no son de la forma); **sin** `btrim()` envolviendo en el `WHERE` del consumidor que anule el índice (GOTCHAS §28) | bloque nuevo en el E2E de etiquetas contra la base local; `EXPLAIN` ≤ 0.5 s a escala de prod |
| **C3 UI** | H.3.1 | Buscador + `side-peek` + tramos + rango; estados con `app-load-state`, edad con `app-freshness-pill`; sucursal **por nombre**, nunca «06» | specs de DOM (mutados) + `check:pantalla -- tienda-cambios-precio` **antes: 0 fallas nuevas (3 en deuda declarada)** y después igual |
| | H.3.2 | Desde el historial: «Imprimir etiqueta» manda el código a la etiquetera (misma ruta que hoy, no se duplica la maquinaria) | spec del `router.navigate` |
| **Cierre** | H.4 | Tracker, log, CHANGELOG, protocolo §8.0b si hay lección nueva, y el PR detallado | regla 19 |

**Sin migración, sin permiso nuevo, sin escritura:** es lectura sobre una vista y un índice que ya existen → no aplica el carril de migraciones ni «escrituras pesadas».

---

## 4. Cómo se prueba en local antes del PR

1. **Sembrar** (yo, un script de Node reversible contra la base local `:5442`, nunca prod) y **medir** (EXPLAIN a escala).
2. **Levantar lo hace quien revisa** (regla 3 y memoria): `npm run api` y `npm run view`; entra con `felipe_galvan` y abre `/tienda/etiquetas/cambios`.
3. **Qué mirar:** buscar un producto con repeticiones → pocos tramos, no cientos · el A→B→A tiene tres · el precio 0 sale «Kepler le quitó el precio» · un producto sin cambios dice «sin cambios en este rango» · la plaza sin bitácora dice que **no llega**, no «sin cambios» · en oscuro y a 390 px.
4. **Qué NO se verá aquí y se declara:** cifras de negocio reales (la base local es sintética), y la pantalla en el navegador la revisa quien la abre.

---

## 5. Decisiones (cerradas por el PM el 2026-10-28)

| | Decisión | Resultado |
|---|---|---|
| **D1** | Plazas | **Las 9 a la vez** (no una). ✅ **Medido en prod el 2026-10-28 con el peor caso conocido (SKU 92013, 5,683 filas):** **280 ms** (365 días, 5,575 filas) y **360 ms** (toda la historia), tibio; **350 / 400 ms** en frío. Dentro de 0.5 s **sin migración**: la consulta usa `sucursal = ANY(9 plazas)` con el índice por plaza y día. El índice parcial por SKU queda como remedio si algún día se pasa |
| **D2** | Filas o tramos | **Todas las filas** primero, «para ver cómo se ve»; el interruptor «Agrupar repetidos» queda disponible para comparar |
| **D3** | Dónde | **Dentro de Cambios de precio** (buscador en la fila superior; el historial abre en un panel lateral) |
| **D4** | Exportar | **No** |
| — | Rama | **Sin ramas**: se trabaja en local sobre `main` y, ya revisado, se arma el PR para Edgar |

---

## 6. Riesgos

| Riesgo | Mitigación |
|---|---|
| Un SKU del catálogo sin `c3` equivalente → «sin historial» que en realidad es «no se pudo cruzar» | Medido (99.6 % de cobertura; los que faltan son descontinuados y promociones) y la pantalla distingue los dos textos |
| Las filas repetidas de Kepler cambian de patrón y el tramo queda mal | la regla es sobre el **precio impreso** (la misma de la vista), no sobre un umbral; spec con A→B→A |
| `btrim()` en el `WHERE` desactiva el índice (386 ms → segundos) | H.2.1 mide `EXPLAIN` y el spec de contrato lo vigila |
| La pantalla ya es larga (820 líneas) | el historial vive en **un componente propio** (`tienda-historial-precio.component.ts`), no se agrega a ese archivo |

---

## 7. Bitácora

| Fecha | Qué pasó |
|---|---|
| 2026-10-28 | Plan y mediciones en prod (sólo lectura). **Durante la 3.ª medición pg-prod entró en «recovery mode»**; no se sabe si fue causa de la consulta (de sólo lectura) u otra cosa; se dejó de consultar prod. Quedan **NO MEDIDOS**: el costo de las 9 plazas a la vez en prod y la cobertura `products.sku` ↔ bitácora (H.0.1) |
| 2026-10-28 (tarde) | `pg-prod` se recuperó (`pg_is_in_recovery() = false`; el proceso principal no se reinició). Se retomaron las dos mediciones, una consulta a la vez, con `statement_timeout` corto y **sin `EXPLAIN ANALYZE`** (plan sin ejecutar + `SELECT` plano medido desde el cliente): **9 plazas = 280–400 ms** y **cobertura 99.6 %**. No se repitió ninguna caída. La causa de la recuperación de la mañana sigue sin conocerse |
| 2026-10-28 | Construido en local: `compactarHistorial` (8 pruebas, mutación en rojo), `GET /store/labels/price-history`, siembra reversible `database/scripts/etq-historial-sembrar-local.js`, E2E `database/tests/http-label-price-history-test.js` (**sin correr**: necesita el API arriba), componente `historial-precio.component.ts` (12 pruebas de DOM) montado en Cambios de precio. SQL del servicio probado contra la base local sembrada (usa el índice; 6,087 filas en 9 ms: escala local, no de prod). `check:pantalla`: la pantalla, 0 fallas nuevas (3 en deuda); el componente, 0 fallas. Una prueba de DOM cazó un defecto real: leer `value()` de un recurso en error lanza y la pantalla se caía |
