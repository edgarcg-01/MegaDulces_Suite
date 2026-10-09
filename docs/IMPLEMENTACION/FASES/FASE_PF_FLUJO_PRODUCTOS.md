# Fase PF — Flujo de venta de cualquier producto (Compras › Catálogo › Productos)

> Estado: 🧪 PF.1, PF.2 y PF.3 en código y probados en local (2026-10-09). Sin migración. Sin push.

## Pedido (Compras, 2026-10-09)

Lo de Productos nuevos, para **todos** los productos, en la sección de **Productos**:

1. El flujo de venta comparado con el mes anterior, **en tiempo real**.
2. Si se **estancó** y en qué sucursales.
3. Si **de verdad hace falta comprarlo**, y en qué afecta.

## Qué se construyó

- **En la tabla de Productos**, dos columnas por producto de la página: **Este mes** (venta del 1 a hoy, con su cambio
  contra los mismos días del mes anterior) y **Situación** (comprar / mover entre sucursales / esperar / sobra / no
  comprar, más «Estancado en N · Agotado en N · Se frenó en N»). Se refrescan cada minuto sin vaciarse.
- **Al hacer clic en un renglón** se abre el comportamiento del producto (editar sigue en el lápiz):
  1. **El veredicto primero**: qué hacer, por qué, en qué afecta (cuándo se acaba, cuánto se deja de vender por día,
     cuánto dinero está detenido con permiso de costo) y **qué mover entre sucursales antes de comprar**, en cajas.
  2. **Flujo de venta**: mes en curso contra los mismos días del anterior, el mes anterior completo, y la gráfica de la
     venta acumulada día por día de los dos meses.
  3. **Cada sucursal**: estado (agotado / estancado / se frenó / le sobra / se mueve), venta del mes y cambio, venta por
     día, días sin vender, existencia en cajas (con la existencia en duda de NP.16) y para cuántos días alcanza.
  4. **Compras y reparto** de los últimos 90 días: primera y última compra física, lo comprado, lo recibido de otra
     sucursal y lo mandado a otras y a rutas (sin las remisiones de telemarketing, que ya son venta).

## Lo medido antes de construir (prod, sólo lectura)

- **Fuentes que coinciden**: la venta diaria cerrada (`mv_kepler_sales_daily`, refresco nocturno) y la venta en vivo del
  ODS dan el MISMO `monto` (con impuestos) y las mismas `units` (unidad base) al centavo: 14 de 14 producto×sucursal.
  `monto_neto` NO coincide (la matvista no quita el IEPS: 8% en Kinder) → **la comparación va con impuestos**.
- **Historia + en vivo**, como Productos nuevos: lo cerrado de la matvista hasta el corte, y del corte a ahora directo
  del ODS. Nada se cuenta dos veces ni se pierde un día si el nocturno falló.
- **La función en vivo de NP no sirve para esto**: entra por SKU y con los productos que más se venden recorre toda su
  historia (200 productos, un día: 5–5.8 s; dos meses de 50: hasta 7 s). La venta en vivo nueva **entra por fecha**
  (`ix_kdm1_venta_fecha` → `ix_kdm2_venta_doc`): 73–160 ms, mismas filas (0 diferencias en tres rangos).
- **El plan de reabastecimiento (Fase RA) no alcanza** para decidir la compra: en prod tiene 20 renglones. Los mínimos y
  máximos de la ficha de Kepler (`kdii.c33/c35`) están capturados en 1,917 de 86,888 fichas. El veredicto sale del
  **ritmo de venta real y la existencia** (días de cobertura).
- **El kardex de toda una página es caro** (0.5–1.8 s con los más vendidos): en la lista sólo se pide para los productos
  con alguna sucursal que Kepler da por agotada y sí vende (el caso donde la existencia mal sumada cambia el veredicto).
  En el detalle se revisa todo.
- **Tiempos con el SQL real del servidor contra prod**: lista de los 50 más vendidos **0.40 s**; detalle **0.21 s**.

## Reglas (en `product-flow.ts`, puras y probadas)

- El mes se compara contra **los mismos días** del mes anterior (del 1 al día de hoy; un 31 contra un mes de 30 es el mes
  completo). Sin venta en el mes anterior no hay variación (guion, no +100%).
- Con menos de 7 días del mes no se juzga el frenado (pocos días mueven mucho el porcentaje).
- **Estancado**: hay existencia y 14 días o más sin venderse (sin venta en 120 días se dice «más de 120 días»).
- **Agotado**: se vende y no hay existencia. Con la existencia en duda decide la estimada del kardex; sin estimada no
  se da por agotado.
- **Le sobra**: se vende pero tiene para más de 60 días: de ahí se sugiere mover.
- **Veredicto**: comprar (< 15 días de cobertura), mover entre sucursales (en la red alcanza pero está mal repartido),
  esperar (15–60), sobra (> 60), no comprar (no se vende y hay existencia), sin movimiento.
- ⛔ **Una caída con sucursales agotadas no es falta de demanda**: no se avisa «podría sobrar»; se dice que bajó porque
  se agotó.
- Los umbrales (`CRITERIO_FLUJO`) son una **propuesta a calibrar con Compras**.

## Pruebas

- Lógica `product-flow.spec.ts` 32 · panel 9 · catálogo 5 (con negativas: el panel y la columna no se vacían al recargar).
- Base de datos `test-newdb-product-flow.js` 9/9: la venta por fecha = la función por SKU, la historia por periodos = un
  cálculo en JS, el kardex = lo sembrado, y las salidas por destino. Encontró que el `'?'` literal de tres consultas
  rompía knex (habría fallado en prod).

## PF.2 — Líderes (pedido 2026-10-09: «los líderes del mercado, a los que hay que meterles cuidado»)

- **Qué es un líder**: está entre los productos que juntos hacen la **primera mitad** de la venta de la red en 90 días
  (`analytics.product_sales_stats`, que el carril `live` recalcula cada 30 min). ⚠️ Es el ranking de **nuestra** venta, no
  participación de mercado: no hay datos del mercado.
- **Medido en prod**: 245 líderes hacen el 50%. La clase A (el 80%) son 952: demasiados para «cuidado especial».
- **El cuidado**: se le recomienda comprar con menos de **21** días de inventario (al resto, 15); el veredicto lo dice
  primero («Es líder: el #N…») y, si está agotado en una sucursal, cuánto se deja de vender ahí por día.
- **Para cuidar hoy** (arriba de la tabla): los líderes que piden atención. ⛔ El primer criterio (cualquier sucursal
  estancada o frenada) marcaba **239 de 245**: una lista que marca todo no ayuda. Pide atención un líder que hay que
  comprar, mover, que está agotado donde se vende o cuya venta de toda la red se frenó. Aun así son **217**: medido,
  104 agotados en alguna sucursal, 108 a comprar, 107 mal repartidos. Por eso la lista va **ordenada por lo que se
  juega por día** (lo que ya se deja de vender donde está agotado; si se acaba en menos de una semana, toda su venta),
  muestra 8 y filtra por motivo.

## PF.3 — Caducidad (pedido: «cuáles están en riesgo y tenemos que sacarlos antes»)

- **Fuente**: `commercial.stock_lots` con fecha (la llenan el andén y la revisión de caducidades). Una sola tabla, sin copia.
- **Medido en prod 2026-10-09: casi no hay registros** — 60 lotes vivos con fecha (48 de Padre Hidalgo, 10 del CEDIS,
  1 de La Piedad y 1 de 8 Esquinas); 17 renglones de revisión, todos de Padre Hidalgo. ⛔ **Sin fecha registrada no quiere decir que no caduque**:
  la pantalla lo dice y muestra la cobertura (cuántos lotes, de cuántos productos, en qué sucursales).
- **⚠️ La cantidad es la REGISTRADA**: Kepler no descuenta por lote al vender. Se topa con la existencia de hoy de la
  sucursal, repartida del lote más viejo al más nuevo (el lado prudente: si se vendió primero lo viejo, aquí sobra).
- **El juicio por lote**: se vende primero lo que caduca primero; cada lote cuenta con la venta que le queda después de
  los que caducan antes, al ritmo de los últimos 30 días. Estados: **caducado** (según el registro: confirmarlo en el
  piso), **no alcanza a venderse** (con a dónde moverlo: la sucursal que lo vende a tiempo después de su propia
  existencia; si ninguna, promover o devolver), **caduca pronto** (≤ 30 días, alcanza: ponerlo al frente), a tiempo.
- **El CEDIS no vende en mostrador**: su lote se mide contra la venta de toda la red. Sin eso, los 10 lotes del CEDIS
  salían todos «no alcanza».
- Hay lotes registrados como caducados en 2023 y 2024 con la misma cantidad que la existencia de hoy: o siguen en el
  piso o el registro quedó viejo. Se muestran como «caducado según el registro» para que se confirmen.
- La unidad de `stock_lots` no está declarada en la tabla (se toma como unidad base). La revisión de caducidades puede
  capturar en cajas y la alimentación al lote no convierte (1 renglón en prod con `unidad = caja`): declarado, no corregido aquí.

## Tiempos (prod, sólo lectura, con el servicio real)

- «Para cuidar hoy» junta ~300 productos: **2.0–2.5 s** (historia 0.54 s y kardex de los líderes). Es igual para todo el
  tenant y la pantalla lo pide cada minuto: se guarda **un minuto** y, vencido, se entrega el anterior mientras se
  recalcula. ⚠️ El primer pedido tras arrancar el servidor o tras más de un minuto sin nadie sí espera ~2 s; el bloque
  carga aparte, la tabla no lo espera.
- Lista de 50 líderes: 0.57–0.79 s (desde esta máquina; en el servidor no hay viaje por la red). Detalle: 0.33–0.48 s.

## Abierto

- Calibrar los umbrales con Compras (incluidos los 21 días del líder, los 30 días de «caduca pronto» y el corte del 50%).
- Que el andén y la revisión registren más fechas: hoy la caducidad cubre 60 productos.
- El tránsito (órdenes de compra por recibir) todavía no resta del «hace falta comprar».
- Plazo de entrega por proveedor: hoy el umbral de 15 días es fijo para todos.
