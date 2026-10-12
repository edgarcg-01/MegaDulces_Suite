# Fase PF — Flujo de venta de cualquier producto (Compras › Catálogo › Productos)

> Estado: 🧪 PF.1–PF.9 en código y probados en local (2026-10-12). **Dos migraciones sin aplicar en prod**: `20261009183328_product_flow_watch` (PF.6) y `20261012083236_mv_product_margins_30d` (PF.8).

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
- **Corrección del pedido (2026-10-09):** «Para cuidar hoy» son **dos lados**: de uno **todos los líderes** (por su lugar,
  con su venta del mes, lo que piden y su margen), del otro **lo que no se vende** (PF.4). Lo de abajo (criterio de
  «piden atención») queda como **filtro por motivo** dentro de Líderes, no como la lista.
- Primera versión: los líderes que piden atención. ⛔ El primer criterio (cualquier sucursal
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

## PF.4 — Los que no se venden (el otro lado de «Para cuidar hoy»)

- **Qué es**: con existencia en la red y **sin una sola venta en 30 días o más** (o ninguna en el año que se mira).
  Existencia con las reglas de Productos nuevos (`EXISTENCIA_KEPLER_SQL`); última venta de `mv_kepler_sales_daily`
  y el servidor descarta los que vendieron HOY en vivo. Primero lo de más **dinero detenido** (costo estándar
  `kdii.c77`; sin permiso de costo no hay pesos, sólo cajas).
- **Medido en prod**: **928 productos, $1.16M detenidos**; 273 de 30–89 días, 380 de 90 o más y 275 sin venta en el
  año. Muchos son de **temporada** (navideños, de Halloween): la pantalla no los distingue todavía.
- Fuera los **productos nuevos** de los últimos 90 días (tienen su pestaña). ⚠️ Si la matvista de Productos nuevos no
  está poblada (truena al leerla, `55000`) se usa la variante sin esa exclusión y **la pantalla lo declara**.
- **Caducidad** (PF.3) vive aquí como filtro «Caducan antes de venderse»: es mercancía que hay que sacar.
- ⚠️ **Encontrado de paso**: 439 fichas de Kepler traen el costo (`c77`) **vacío** y `''::numeric` truena; la consulta de
  costo de PF.1 (`KDIL_CRUDO_SQL`) caía con esos productos. Corregido en las dos.

## PF.5 — Márgenes en el catálogo (como en Productos nuevos)

- **Los tres de `[NP.15]`** con la **misma función** (`margenesDe`): de lista (la meta de la ficha por el peldaño
  vendido), real (`kdm2.c62`) y sobre lo pagado (compras `XA2001` por unidad base). Cada uno con su cobertura.
- **En la tabla**: columna «Margen 30 d» (sólo el real) de `analytics.mv_erp_margin_daily`, venta de tienda desde el
  corte de cada sucursal. 200 productos en 0.42 s.
- **En el producto**: los tres, en total y por sucursal, con `fn_new_products_movimientos` (la de Productos nuevos):
  1.1–1.4 s con los que más se venden → **carga aparte**, el panel no la espera.
- ⭐ **Dos implementaciones del mismo margen, cruzadas**: por sucursal coinciden **al centavo** hasta ayer (medido en
  prod con 70001 y 17085; candado en la prueba de base de datos). Hoy la matvista lleva un tramo parcial, por eso el
  periodo son los **30 días cerrados** (hasta ayer).
- **Sólo con permiso de costo** (`COMPRAS_COSTO_ESTANDAR_VER`): un margen junto a la venta deja despejar el costo. El
  endpoint responde 403 sin él y la pantalla ni lo pide.
- **Hallazgo**: en 70001 (Mazapán, líder #2) el margen de lista es 14.1% y el real 13.6%, pero **sobre lo pagado 7.9%**
  (Morelia Abastos 5.2%): la ficha de Kepler tiene un costo más bajo que lo que se paga.

## PF.6 — «Para cuidar hoy» calculado en segundo plano (pedido 2026-10-09: «que nadie lo espere»)

- **Medido antes**: el cálculo tarda 2.9–3.6 s con los datos calientes y **6.5 s la primera vez** (datos fríos); las
  columnas de la lista llegaron a 7.4 s y los márgenes del producto a 14 s en su primera consulta.
- **Diseño**: la API de prod **no corre trabajos programados** (`DISABLE_CRONS=true`, ADR-043) y está pensada para varias
  réplicas, así que una memoria por proceso no sirve. El **worker** calcula cada minuto (`@Cron('0 * * * * *')`) y
  guarda la foto en `analytics.product_flow_watch` (caché de una derivación, RLS forzado); la API sólo la lee.
- **Una pasada, dos variantes** (con y sin permiso de costo) sobre las mismas consultas: 2.7–3.8 s en prod, lo mismo
  que una sola. Verificado contra prod que la variante sin costo no trae dinero: 257 `inmovilizado` en nulo, cero
  textos de dinero detenido, cero valores ni márgenes.
- **Si la foto falta, tiene más de 3 minutos o la tabla todavía no existe** (código desplegado antes de la migración),
  la API calcula en vivo como antes y **lo declara**: la pantalla dice «Calculado en vivo… la foto del servidor no está
  al día». Con foto: «Calculado a las hh:mm; se actualiza cada minuto».
- **Latido** `product_flow_watch` en `analytics.cron_runs` (rojo si falla o escribe menos de 2 variantes) y **umbral en
  `CRON_JOBS`** (6 min aviso, 30 min crítico): sin umbral una foto parada se vería verde (OBS.1).
- **Medido en local**: con foto, 23–50 ms por petición; foto vieja → cálculo en vivo; foto nueva → vuelve a la foto.
- ⚠️ **Carga**: ~3 s de base cada minuto, todo el día. Además mantiene calientes las páginas que la pantalla lee.
- ⚠️ **La respuesta pesa ~450 KB** (245 líderes + 300 que no se venden con su análisis): viaja comprimida, pero si pesa
  en celular, el siguiente paso es recortarla.
- **Para activarlo en prod**: aplicar la migración (aditiva; puede ir antes o después del código, el código aguanta sin
  la tabla) y redesplegar api + worker.

## PF.7 — «Para cuidar hoy» ligero

- Cada producto de la lista llevaba su análisis completo (motivos, impacto, traspasos, sucursales): **~477 KB**. Ahora
  lleva sólo lo que la pantalla pinta (`ResumenCuidar`: venta del mes, variación, veredicto, agotadas, líder, margen
  y caducidad); el análisis completo llega al abrir el producto. Medido en prod: **234 KB** (lo más pesado ya es
  «No se venden», 136 KB), **37 KB comprimido** (la API comprime todas las respuestas).
- ⛔ **Arreglado de paso un error de PF.6**: al refactorizar quedó un mapa vacío que tapaba el de los nombres, y los
  líderes y las caducidades salían **sin SKU ni nombre**. Las pruebas del servicio no lo veían porque simulaban el
  cálculo; ahora hay una que arma la respuesta de verdad (probada rompiéndolo).

## PF.8 — Márgenes del producto al instante

- **Antes**: el panel los calculaba al abrir el producto con `fn_new_products_movimientos` (entra por SKU): 1.1–1.5 s,
  **14 s** la primera vez.
- **Ahora**: `analytics.mv_product_margins_30d` guarda las piezas de los tres márgenes por (producto, sucursal,
  peldaño, unidad base) de los 30 días cerrados, **entrando por fecha** para todos los productos: 15–17 s en prod,
  27,315 filas, 4,807 productos. Se refresca en el nocturno del worker (06:20) con su latido
  (`analytics_refresh_product_margins`) y umbral en `CRON_JOBS`.
- ⭐ **Cruzada contra la función** (las mismas expresiones, dos implementaciones): en prod, 5 productos, **51 celdas
  sin una sola diferencia**; en local, el candado de la prueba de base de datos (13 celdas).
- **El panel la lee si está poblada y llega hasta ayer**; si no (sin poblar, el nocturno no corrió, o antes de las 06:20
  cuando todavía llega a anteayer) calcula con la función, **mismo periodo y mismas cifras**, y lo dice.
- Medido en local: matvista **33–38 ms**; sin poblar, cálculo en vivo con las mismas cifras.

## PF.9 — El catálogo por proveedor (rediseño de la pestaña Productos)

- **Por qué**: Compras revisa muchos productos de un mismo proveedor. La tabla anterior era un listado paginado de
  13 columnas en mayúsculas, con «Para cuidar hoy» y cuatro tarjetas de conteo antes de llegar al primer producto.
- **Ahora**: a la izquierda los proveedores ordenados por venta del mes (con su variación, y aparte **los sin
  proveedor**, que nadie está pidiendo); a la derecha el proveedor elegido con 4 cifras (venta del mes, para comprar,
  agotados en alguna sucursal, líderes), chips por situación (Comprar · Mover · Esperar · No comprar · Líderes, con su
  conteo) y un renglón por producto **en palabras**: nombre legible, venta del mes, *para cuántos días alcanza* con su
  barra, margen (con permiso de costo) y *qué hacer* con el porqué en una frase (`motivoCorto`). El clic abre el mismo
  panel de siempre, con «Editar producto» adentro. «Para cuidar hoy» pasa a una vista aparte (botón arriba) y su
  número cuenta sólo lo que pide hacer algo hoy. La búsqueda de arriba sigue buscando en todo el catálogo.
- **Backend**: `GET /commercial/products/flow/proveedores` (proveedores con productos activos y venta del mes contra
  los mismos días del anterior; los `NULL` y el comodín «PRODUCTOS SIN PROVEEDOR» de Kepler juntos) y
  `GET /commercial/products/flow/proveedores/:id` (`sin` = sin proveedor): el flujo de todos sus productos activos
  con `resumenes()`, **en vivo** y guardado un minuto por proveedor y permiso; dos pedidos simultáneos comparten el
  cálculo. Sin migración.
- **Medido**: prod (sólo lectura) proveedores **280–340 ms**; La Rosa (269 productos activos) **1.1–1.9 s** la
  primera vez, al instante dentro del minuto. Local: 0.27 s / 0.46 s / 0.22 s.
- **Decidido con el usuario**: en vivo con espera corta (no una foto en segundo plano).
- ⛔ **Hallazgo del dato**: los productos sin proveedor en Kepler (591 en prod, ~13 vendieron en el mes) no los
  está pidiendo nadie; se ven primero en la barra.
- ⛔ **De paso**: `--c-surface-2` no cambia con el tema oscuro (apunta fijo a `--neutral-100`): en este componente se
  usa `--hover-bg`. Otras pantallas de Compras lo siguen usando (38 usos).

## Tiempos (prod, sólo lectura, con el servicio real)

- «Para cuidar hoy» (líderes + lotes + lo que no se vende): **~3.2 s**; antes de PF.4, 2.0–2.5 s (historia 0.54 s y kardex de los líderes). Es igual para todo el
  tenant y la pantalla lo pide cada minuto: se guarda **un minuto** y, vencido, se entrega el anterior mientras se
  recalcula. ⚠️ El primer pedido tras arrancar el servidor o tras más de un minuto sin nadie sí espera ~2 s; el bloque
  carga aparte, la tabla no lo espera.
- Lista de 50 líderes: 0.57–0.79 s (desde esta máquina; en el servidor no hay viaje por la red). Detalle: 0.33–0.48 s.

## Abierto

- Calibrar los umbrales con Compras (incluidos los 21 días del líder, los 30 días de «caduca pronto» y el corte del 50%).
- Que el andén y la revisión registren más fechas: hoy la caducidad cubre 60 productos.
- El tránsito (órdenes de compra por recibir) todavía no resta del «hace falta comprar».
- Plazo de entrega por proveedor: hoy el umbral de 15 días es fijo para todos.
