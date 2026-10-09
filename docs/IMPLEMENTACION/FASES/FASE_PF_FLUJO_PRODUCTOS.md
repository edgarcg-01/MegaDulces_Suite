# Fase PF — Flujo de venta de cualquier producto (Compras › Catálogo › Productos)

> Estado: 🧪 PF.1 en código y probado en local (2026-10-09). Sin migración. Sin push.

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

## Abierto

- Calibrar los umbrales con Compras.
- El tránsito (órdenes de compra por recibir) todavía no resta del «hace falta comprar».
- Plazo de entrega por proveedor: hoy el umbral de 15 días es fijo para todos.
