# Fase VT — Captura de pedido del vendedor (`/vendor/take-order`)

> **ADR-062** · arrancó 2026-09-11 · estado 🧪 en código y probado, **falta validación visual + redeploy**

Pedido de 0Sistemas (2026-09-11):

> *"hay que darle mas fluidez a la app de vendedor. reportan bugs o poca fluidez al seleccionar
> las unidades en `/vendor/take-order/`, ademas agreguemos que se pueda editar un pedido."*

Aclarado por él mismo en la misma conversación: **"seleccionar las unidades" es cuando agregan algo
al carrito** — o sea la captura de cantidad, no el selector de medida en sí.

---

## 1. Lo que se midió antes de tocar nada

Todo contra **prod** (`analytics.product_units`, `commercial.orders`), read-only.

| Medición | Valor |
|---|---|
| SKU con escalera de medidas | **8,928** |
| SKU con una segunda medida (el selector se muestra) | 8,198 (**91.8 %**) |
| SKU con **rótulo repetido** en la escalera | **2,061 (23.1 %)** |
| SKU con los **tres peldaños con el mismo rótulo** | **163** |
| SKU con el mismo rótulo y **factor distinto** (contradicción real) | **1** (`PAQ` vale 1 y 11) |
| SKU cuyo **default** tiene factor > 1 (donde vive el error de conteo) | **393** |
| Pedidos vivos `confirmed` (30 d) | **9, todos preventa** (sin stock reservado) |
| Pedidos vivos `pending_approval`/`confirmed` por autor | vendedor_ruta 10 · supervisor_ventas 3 · superadmin 1 |
| Pruebas de `apps/vendor` antes de esta fase | **cero** (no existía target `test`) |

---

## 2. El defecto de fondo: dos espacios de cantidad mezclados

La línea del pedido se guarda **siempre en unidad base**; la presentación (PZA/PAQ/CJA) era capa de
display. La fila mostraba:

```ts
return f > 1 ? Math.round(base / f) : base;   // ← el defecto
```

`Math.round` **inventa** un número que no corresponde a ninguna cantidad real. Como la cantidad
inicial sale del promedio histórico del cliente —que casi nunca es múltiplo del factor— el error
salta a la primera:

| Caso real | Lo que se pedía | Lo que la fila mostraba |
|---|---|---|
| promedio 5 pz, paquete de 6 | 5 piezas | **1** (= 6 piezas) |
| promedio 3 pz, caja de 8 | 3 piezas | **0**, con la línea ya creada |
| tocar `+` sobre las 5 anteriores | 11 piezas | **2** (= 12 piezas) |

Y de ahí salen los tres síntomas reportados:

1. **"toco + y aparece 0 / un número raro"** — el redondeo hacia abajo.
2. **"+ y − no me dejan donde estaba"** — `5 + 6 = 11` tampoco es múltiplo de 6: el resto queda
   pegado para siempre y cada paso arrastra la mentira.
3. **"se me mueve solo el pedido"** — `setQtyTyped` multiplicaba lo tecleado por el factor, así que
   **teclear el mismo número que la fila ya mostraba cambiaba la cantidad**.

### La invariante que se establece

> **lo que la fila MUESTRA × factor = lo que el pedido PIDE**

Toda cantidad que nace o se toca desde la fila cae en la **rejilla** del factor activo. La aritmética
vive aislada y probada en [`apps/vendor/src/app/core/order/qty-units.ts`](../../../apps/vendor/src/app/core/order/qty-units.ts).

Lo que llega **fuera de rejilla** (voz, canasta predicha, pedido viejo, otro dispositivo) **no se
redondea ni se corrige solo**: la fila lo declara en unidad base con su rótulo, y sólo un toque
explícito del vendedor lo acomoda (ADR-056 — lo que no cuadra se declara, no se dibuja).

---

## 3. El selector traía chips repetidos

`analytics.product_units` deriva de `v_product_unit_ladder` y sus tres peldaños pueden traer el
**mismo rótulo**. Publicado sin sanear, el app pintaba 2 o 3 chips idénticos, **los marcaba todos
activos a la vez** (la comparación es por rótulo) y su `@for ... track u.unit` quedaba con **clave
duplicada** (NG0955 — en Angular 22 es un `console.warn` sólo en dev; en prod la reconciliación
keyed sigue corriendo con claves ambiguas).

Dos casos, dos tratos, y esto es deliberado:

- **mismo rótulo y mismo factor** → es la misma presentación repetida: se **colapsa** (2,060 SKU).
- **mismo rótulo y factor distinto** → contradicción real de la fuente: **no se elige una en
  silencio**, se desambigua el rótulo con su factor (`PAQ` / `PAQ x11`) para que la ambigüedad se
  vea y se pueda elegir. Elegir una escondería media escalera de presentaciones.

Saneado en el **origen** (`CommercialPricingService.escaleraSaneada`) y también en el cliente, que es
quien tiene que sobrevivir a un backend viejo.

---

## 4. La lista se reordenaba dos veces por cada toque

Esta es la otra mitad de *"poca fluidez"*, y no tiene que ver con la velocidad de la red:

1. `t ≈ 0` — el ajuste optimista pinta la cantidad (esto siempre estuvo bien).
2. `t ≈ 500 ms` — vuelve el `reloadCart` y, como `habitualRows` arrancaba recorriendo
   `cartLines()`, **el producto agregado saltaba al tope** de su sección.
3. `t ≈ 1,700 ms` — Thot devuelve un ranking nuevo y **todo se mueve otra vez**.

Con el dedo ya viajando al siguiente renglón, la lista se movía dos veces debajo.

Ahora: Habituales va en el orden de los habituales (que se carga una vez y no se mueve), Sugeridos
excluye por **habitual** y no por *"está en el carrito"* —agregar una sugerencia ya no la hace
desaparecer de donde el vendedor la está mirando— y la posición de lo ya mostrado queda
**congelada**. El re-ranqueo cart-aware **se conserva**: lo nuevo entra al final.

---

## 5. Corregir un pedido agendado

Hasta acá `requireEditableForLines` aceptaba `draft` y `pending_approval`. Un pedido **agendado** no
se podía tocar: la única salida era **cancelarlo y recapturarlo entero**.

**`POST /commercial/orders/:id/reopen`** — `confirmed`/`pending_approval` → `draft`, **conservando el
folio** (es el mismo pedido, no uno nuevo), con su fila en `order_status_history`.

Se reabre en vez de permitir editar líneas sobre `confirmed` **a propósito**: un pedido que se está
corrigiendo **no está listo para surtir**, y el estado tiene que decirlo. Además, reabrir reusa tal
cual toda la edición de borrador que ya existía y el `place()` idempotente para volver a agendar.

### ⭐ Lo que de verdad se juega: el stock

En **preventa** `place()` **no reserva nada** (mira `isPreventa`). Entonces devolver *"la cantidad de
la línea"* al reabrir **le suelta el apartado a otro pedido** — `release()` clampea con
`Math.min(reservado, cantidad)`, así que no queda negativo: queda **robado**.

Por eso `reopen()` **no mira las líneas**: netea el **libro de movimientos**
(`reserve − release` por `reference_id`). Medido en `test-newdb-order-reopen` (7/7):

- el pedido que **sí** reservó vuelve **exacto** al baseline;
- reabrir dos veces **no** libera dos veces;
- el de preventa **no netea nada**;
- **prueba negativa**: el criterio por línea **sí** habría liberado 10 unidades que eran la reserva
  del pedido vecino.

> ⚠️ **`cancel()` tiene ese mismo defecto hoy** y **no se tocó en este commit**: es un cambio de
> comportamiento en una ruta viva que merece su propia medición. Queda **declarado como deuda**.

---

## 6. Abierto y declarado (no resuelto)

| Qué | Por qué queda así |
|---|---|
| **`cancel()` libera por línea** | Mismo defecto que arriba; cambio de comportamiento en ruta viva, merece su propia medición. |
| **`supervisor_ventas` no puede corregir los de su gente** | El alcance elegido es *"propio"*; `isPlatformAdminRole` sólo cubre `superadmin`/`admin`. 3 de los 14 pendientes vivos son de supervisores. |
| **El botón puede aparecer sobre un pedido ajeno** | `/vendor/pending` lista por `mine=true`, que es la **cartera de hoy**, no la autoría. El backend responde *"Este pedido lo tomó otro vendedor"* — honesto, pero el botón no debería ofrecerse. |
| **Sin conexión no se corrige** | El modo offline trabaja sobre borradores de Dexie y abriría **otro** pedido. Se avisa y se vuelve a "Por entregar". |
| **`apps/vendor` estrena pruebas con 11** | La app del campo no tenía ninguna. Las 11 cubren la aritmética de cantidad; el componente sigue sin candados de render. |

---

## 7. Verificación

| Qué | Resultado |
|---|---|
| `nx test vendor` (nuevo) | **11/11**, cada bloque con su prueba negativa |
| `node database/tests/test-newdb-order-reopen.js` | **7/7** contra `platform_test` |
| `nx test commercial` | 60/60 (4 suites) |
| `nx build vendor` (prod) | verde — inicial 811.99 kB / 182.48 kB comprimido |
| `nx build api` | verde |
| Barrido de acentos graves en comentarios | limpio |

**Falta: validación visual + redeploy de `api` y `vendor`.** Sin migraciones ni permisos nuevos
(`reopen` reusa `COMMERCIAL_ORDERS_CONFIRMAR`) → **sin re-login**.
