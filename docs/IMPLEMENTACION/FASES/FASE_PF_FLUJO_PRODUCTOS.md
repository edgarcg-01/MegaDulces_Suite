# Fase PF — Flujo de venta de cualquier producto (Compras › Catálogo › Productos)

```
OBJETIVO:  Compras sabe, producto por producto, si de verdad hace falta comprarlo, qué ya viene y dónde se estancó,
           sin que la Suite le dé dos respuestas distintas al mismo producto.
MÉTRICA:   Productos nuevos con veredicto de compra OPUESTO entre Productos nuevos (NP) y Productos (PF)
           — HOY: 63 de 74 (85.1 %) en la base LOCAL, 2026-11-03 (`node database/scripts/mide-np-vs-pf.js`);
             PROD: NO MEDIDO (mismo script, sólo lectura).
           → META: 0 opuestos sin explicación en pantalla, para el cierre que fije el PM (decisión D-PF.3 abajo).
MÉTRICA 2: Observaciones 🔴 de diseño abiertas (bloquean 🚀) — 2026-10-26: 4 → HOY 2026-11-03: siguen 4, pero lo
           que tocaba al motor está hecho en las 3 que lo tenían (PF.UI.1/2/3); a las 4 les queda un pendiente de
           PANTALLA en archivos del PR de PF.12.1/PF.12.3 (cambio exacto en «Estado al 2026-11-03»). META: 0 al cierre.
CAPA TOPE: C3
ÁREA:      Comercial (Compras)
DUEÑO:     David
```

> **Estado real (auditoría del 2026-11-03, sobre `origin/main` = `origin/prod-release` = `43b58464c`):**
> PF.1–PF.8 y PF.12 están en `main` y en `prod-release`. PF.9 también, pero **PF.12 lo reemplazó**. **PF.10 y PF.11
> no existen en ningún commit** (perdidos, ver «Corrección del tracker»). Las migraciones de PF.6 y PF.8: **NO
> MEDIDO en prod** (`node database/scripts/check-pf-migraciones.js` con la URL de prod lo contesta).
> PF.13–PF.17 (2026-11-03) en código y probados, **sin commit**.
> ⚠️ `prod-release` hoy apunta al mismo commit que `main`: estar en esa rama no fecha CUÁNDO llegó a prod
> (PF.12 llegó el 2026-10-27 con #460, `ff1f04437`).

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

## Abierto (actualizado 2026-11-03)

- **Calibrar los umbrales con Compras** (15 días; 21 para el top de venta; 60 de «le sobra»; 30 de «caduca pronto»;
  el corte del 50 %). Desde `[PF.13]` el veredicto lo dice en pantalla: «Es una propuesta todavía sin calibrar con
  Compras». Sin fecha: depende de una sesión con Compras (D-PF.2).
- **Tránsito: ya no está abierto como dato, sí como decisión.** `[PF.13]` lee las órdenes de compra abiertas de
  Kepler (`X-A-35`, misma regla que el diálogo «En camino» del Pedido) y las DICE en el veredicto, **sin restarlas**:
  es la política vigente del Pedido (`POLITICA_TRANSITO = 'ignorar'`, Edgar 2026-10-08: 151 de 394 OC llevaban más
  de 60 días). Restarlas aquí y no en el Pedido daría dos «hace falta comprar» distintos. Si se quiere restar, se
  cambia en UN lugar (`transito.ts`) para los dos. ⚠️ Falta medir en prod que la cantidad de la OC esté en la
  unidad base (`check-pf-ui-prod.js`, bloque 1); en la base local no hay ni un `X-A-35`.
- **Plazo de entrega por proveedor:** el umbral de 15 días sigue fijo para todos. El Pedido ya deriva un `lead_days`
  por producto (`commercial-replenishment.service`, `econ.lead_days`): usarlo aquí es un cambio de alcance que
  decide el PM con la calibración (D-PF.2), no antes.
- **Venta de las camionetas** (Canindo, y Padre Hidalgo incompleta): no está en Kepler (FASE_AB §16.17, D18 sin
  dueño). `[PF.15]` evita las dos mentiras que eso producía («estancado» y «no se vende» sobre lo que sale por
  camioneta) leyendo la CARGA a camioneta (`U-D-41` a `RUTA`/`RD`), pero el ritmo de venta de esas sucursales
  sigue corto: el veredicto lo dice. La cifra completa depende de D18.
- **Temporada** (PF.UI.6): no se puede distinguir con Kepler — su historia empieza en el corte de cada sucursal
  (local: `mv_kepler_sales_daily` desde el 21-ene-2026; Canindo, Madero y Morelia Abastos desde ago–sep 2026), así
  que la temporada del año pasado no está. Necesita la réplica de Wincaja (Fase WR) o se declara en pantalla.
- Que el andén y la revisión registren más fechas: la caducidad cubría 60 lotes (2026-10-09; no re-medido).
- **Un solo motor de compra** (NP vs PF, D-PF.3): medido el mecanismo, no se unifica sin el PM.
- **«Editar producto»** quedó sin lugar desde PF.12 (falta decidir dónde vive).

---

## Observaciones de diseño UI — revisión del plan (2026-10-26)

> **Con qué se miró: el plan, no la pantalla** (nivel C). Nada visual se da por medido; lo que
> sólo se comprueba con la pantalla viva va como criterio a verificar. La ley es
> [`ESTANDAR_DE_INTERFACES.md`](../../ESTANDAR_DE_INTERFACES.md) (§ = sus secciones) y su
> implementación [`DESIGN.md`](../../../DESIGN.md). Severidad: 🔴 la pantalla afirmaría algo falso,
> escondería lo que importa o perdería trabajo — **bloquea pasar C3 a 🚀** · 🟠 se resuelve dentro
> de la fase · 🟡 mejora; si no entra, queda como deuda con nombre.
> La pantalla existe: cada observación es un criterio a verificar en ella, no un defecto medido. Las
> cifras son las del plan (y las de las fases AB, PQ y NP donde se dice), con su fecha.

**La pregunta que contesta (prueba de la frase, §4.0b):**

- **Productos, por proveedor** (PF.9): *«¿Qué tengo que hacer hoy con cada producto de este
  proveedor?»* — una pregunta. Bien partida.
- **Panel del producto**: *«¿Qué hago con este producto, y por qué?»* — una pregunta; flujo,
  sucursales y márgenes son su evidencia. «Editar producto» es otra tarea: va como acción en el
  encabezado del panel, no como una sección más.
- **«Para cuidar hoy»**: *«¿Cómo van mis líderes y qué tengo detenido?»* — dos preguntas («dos
  lados», PF.2) bajo un título que no cubre ninguna entera: conflación (§4.0 A). Corte: dos vistas,
  cada una con su conteo (PF.UI.3).

**Jerarquía propuesta (§3.7 · DESIGN §Q.5):**

- Productos por proveedor: primario = qué hay que comprar o mover de este proveedor hoy (cuántos
  productos y cuánto) · secundario = el renglón por producto con su qué hacer · terciario = margen,
  venta del mes y barra de días.
- Panel: primario = el veredicto con su porqué (y lo que ya viene) · secundario = las sucursales con
  su estado · terciario = gráfica acumulada, compras y reparto, márgenes.

| # | Sev | Observación (desde la silla de quien la usa) y costo | Ley | Criterio de aceptación |
|---|---|---|---|---|
| PF.UI.1 | 🔴 | **«Comprar» es un criterio de compra más en el mismo departamento, sin calibrar y sin restar lo que ya viene:** menos de 15 días de cobertura (21 si es líder) sobre el ritmo real, mientras `/compras/pedido` usa el motor con 30 días, Autoabasto 21 días en las sucursales que no son matriz y Productos nuevos la rotación (NP.UI.3). El plan lo dice: «el tránsito (órdenes de compra por recibir) todavía no resta del "hace falta comprar"», y los umbrales son «propuesta a calibrar con Compras» desde el 9-oct. Su premisa («el plan de RA tiene 20 renglones en prod», 9-oct) no coincide con lo que AB cruzó contra ese plan el 12-oct (2,777 renglones sólo en La Piedad Abastos; no re-medido aquí). Con 108 líderes «a comprar» (PF.2), se pide lo que ya viene en una OC. | §1.5 · §1.3 · DESIGN §X.3–X.4 | «Comprar» resta lo que ya viene (OC abiertas y traspasos de AB.34) o lo dice: «No resta lo que ya viene: 40 cajas en OC abiertas». El veredicto lleva «Propuesta: umbral sin calibrar». Desde el veredicto, enlace a `/compras/pedido` con proveedor y producto puestos, que es donde se compra (§3.4). **Conflicto (decide Edgar):** un solo criterio de «hace falta comprar» para Compras, o varios con su pregunta escrita en cada rótulo. |
| PF.UI.2 | 🔴 | **La venta de PF es la de Kepler (`mv_kepler_sales_daily` + ODS en vivo), y en Kepler no están las camionetas de Canindo** (~$428 K por semana) ni 27 días de las de Padre Hidalgo desde el 1-sep (FASE_AB §16.17, 26-oct). Un producto que sale por camioneta se ve «Estancado» en la sucursal que las carga, o cae en «No se venden» con dinero detenido, mientras se vende. Pedido, en cambio, cuenta las camionetas de Padre Hidalgo dos veces (PQ.UI.1): el mismo producto con dos «venta del mes». | §1.3 · §1.5 · §1.6 | El panel y la lista dicen su universo: «Venta registrada en Kepler; no incluye camionetas de Canindo». «Estancado» y «No se venden» no se afirman sobre un producto con salidas a ruta en el periodo (el reparto ya las trae): «Se mueve por camioneta: su venta no se ve aquí». A verificar con un producto de ruta de Canindo. |
| PF.UI.3 | 🔴 | **«Para cuidar hoy» publica un número que no es lo que muestra, y una lista que no llega a su universo:** el botón cuenta «sólo lo que pide hacer algo hoy» (PF.9); la vista trae **los 245 líderes** (de ellos piden atención 217) y, de los **928** productos que no se venden por **$1.16 M** (PF.4), la respuesta lleva **300** (PF.6). Si el encabezado dice 928 o $1.16 M, faltan 628 productos; si dice 300, el dinero detenido sale corto sin aviso. | §1.2 · §1.4 · §4.0 A | Dos vistas con su propio conteo (`app-segmented` con el número adentro): «Líderes que piden atención: 217» y «Sin venta en 30 días o más: 928 · $1.16 M». Si se recorta, se dice: «Se muestran los 300 con más dinero detenido de 928 ($X de $1.16 M)». `npm run check:cifra` en verde. |
| PF.UI.4 | 🔴 | **Dos «venta» en el mismo panel, con distinta base y distinto periodo:** «Este mes» y el flujo son venta **con impuestos** del 1 a hoy (la matvista no quita el IEPS); los márgenes son sobre venta **sin impuestos** de los 30 días cerrados. En la tabla, «Este mes» y «Margen 30 d» son columnas vecinas: quien multiplica una por la otra para saber cuánto deja infla el resultado entre 8 % y 16 %. | §1.6 · §1.1 | Cada venta dice su base y su periodo en el rótulo: «Venta con IVA · 1 al 26 de oct» y «Margen sobre venta sin impuestos · 30 días al 25 de oct». Si se publica el dinero del margen, lo calcula el servidor sobre una sola base. |
| PF.UI.5 | 🟠 | **«Es líder: el #N…» afirma liderazgo de mercado** —el pedido decía «los líderes del mercado»— y es el ranking de **nuestra** venta en 90 días («no hay datos del mercado», PF.2). Un comprador que negocia con el proveedor con ese rótulo dice algo que nadie midió. | §1.1 · §3.8 | Rótulo «Top de nuestra venta: #N» con `app-context-help` del diccionario: «Los 245 productos que juntos hacen la mitad de nuestra venta en 90 días. No es participación de mercado». |
| PF.UI.6 | 🟠 | **«No se venden» junta lo muerto con lo de temporada** («muchos son de temporada —navideños, de Halloween—; la pantalla no los distingue todavía», PF.4). A finales de octubre, la lista invita a sacar o devolver justo lo que está por venderse, ordenado por dinero detenido. | §1.1 · §3.2 | Mientras no haya regla, la lista lo dice arriba: «Puede incluir productos de temporada: todavía no se distinguen». Con un año de historia en la sucursal, `p-tag` «De temporada: se vendió en [mes] del año pasado». |
| PF.UI.7 | 🟠 | **«Margen 30 d» en la tabla no dice sobre cuánta venta se calculó;** en el panel, cada margen trae su cobertura (PF.5). NP.15 midió por qué importa: el costo del renglón falta en mucha venta de mayoreo (en un producto, sólo 6 % de la venta de una sucursal lo traía; Candy Party 1 kg, 22 %). Un margen sobre la quinta parte de la venta se lee igual que uno sobre el total. | §1.6 · §1.3 | La celda lleva su cobertura cuando no es completa («13.6 % · sobre 22 % de la venta») y, debajo de un mínimo a fijar con Compras, «—» con el porqué en `app-context-help`, nunca el número solo. |
| PF.UI.8 | 🟠 | **«Qué mover entre sucursales antes de comprar, en cajas» y «existencia en cajas» no dicen qué caja.** Productos nuevos usa la ficha de Kepler (`escaleraUnidades`); Pedido usa un resolvedor que en 2 de cada 3 SKUs del CEDIS prefiere la etiquetera (PQ §12.2). «Mueve 5 cajas» en el panel y «traspasa 3 cajas» en Pedido pueden ser la misma mercancía. | §1.5 · §4.5 | Toda cantidad en cajas dice su contenido («5 CJA de 24 PZA») y su factor es el `c84` de Kepler, el mismo que adopte Pedido con D20 (PQ.UI.3). |
| PF.UI.9 | 🟠 | **«Agotado» se decide con la existencia de Kepler con piso en cero** (las reglas de Productos nuevos, NP.17): un negativo de Kepler cuenta como agotado y empuja a «Comprar». Y «en la red alcanza pero está mal repartido» suma un CEDIS que en ~900 de los 1,264 SKUs que embarca está en cero o negativo por falta de conteo (PQ §12): la red parece más corta de lo que está y el veredicto pasa de «Mover» a «Comprar». | §1.3 | Negativo con `p-tag` «Negativo en Kepler», no «Agotado» (D8 de PQ). La cuenta de la red dice cuándo no incluye al CEDIS: «Sin la existencia del CEDIS: sin contar desde el 30-sep». |
| PF.UI.10 | 🟡 | **PF está en 🧪 desde el 12-oct «probado en local», con dos migraciones que entonces no estaban en prod, y el rediseño PF.9 no anota ni una vista en pantalla.** El propio PF.9 encontró que `--c-surface-2` no cambia en oscuro y lo dejó en 38 usos de otras pantallas de Compras. | método §4 · skill `diseno` §4 | Nivel A con `auditoria-diseno` (claro, oscuro, `forced-colors`) antes de 🚀, con foco en la barra de días y los chips de situación, que no dependan sólo del color. El encabezado dice qué migraciones están aplicadas hoy. |

**Lo que esta revisión no cubre:** contraste, foco y teclado reales (exigen nivel A); la gráfica de
venta acumulada (DESIGN §G), que exige verla; los umbrales de negocio (15 / 21 / 60 días, los 30 de
«caduca pronto», el corte del 50 % de líderes), que calibra Compras; y la caducidad (PF.3), que cubre
60 lotes y ya declara su cobertura.

---

## Auditoría de cierre — 2026-11-03 (tarjeta #34 del tablero, vence el 2026-11-06)

### Corrección del tracker (lo que decía contra lo que es verdad)

Verificado con `git log --all --grep`, `git log --all -S`, el reflog, los dos `stash` y los worktrees del equipo.
«En prod» = ancestro de `origin/prod-release` (hoy = `origin/main` = `43b58464c`).

| Item | El tracker decía | Lo verificado | Estado propuesto |
|---|---|---|---|
| PF.1 | 🧪 | `09193cd9b` en `main` y en `prod-release` | 🚀 (en prod; sin métrica antes/después) |
| PF.2 / PF.3 | 🧪 | `305f79cfb` en `main` y `prod-release` | 🚀 |
| PF.4 / PF.5 | 🧪 | `826ab1d49` en `main` y `prod-release` | 🚀 |
| PF.6 | 🧪 «mig sin aplicar en prod» | código `3b0641d54` + `eb8acc6c4` en prod. La migración `20261009183328`: **NO MEDIDO**. ⛔ La nota «los 300 de más dinero detenido, de 957 en la red» del 2026-10-29 **no prueba** que la tabla exista: sin ella la API calcula en vivo y devuelve lo mismo | 🚀 código · migración NO MEDIDA (`check-pf-migraciones.js`) |
| PF.7 / PF.8 | 🧪 «mig sin aplicar» | `ee6dfb47a` en prod. La matvista `20261012083236`: **NO MEDIDO** | 🚀 código · migración NO MEDIDA |
| PF.9 | 🧪 | `898584238` (#375) en prod, **reemplazado por PF.12** (la barra de proveedores se quitó a pedido de David) | ❌ reemplazado por PF.12 (sus endpoints `flow/proveedores*` siguen vivos y sin pantalla) |
| PF.10 | 🧪 con cifras de prod y «471 pruebas en verde» | **Ni un commit** en ninguna rama, ni en el reflog, ni en stash, ni en los worktrees; `master_data_history` no aparece en ningún archivo TS. Se perdió antes de commitearse | ❌ perdido. No re-planear hasta que Compras lo pida: PF.12 cambió la tabla donde vivía. Si vuelve, su deuda con nombre sigue: «quién lo revisó» es HITL y necesita su tabla |
| PF.11 | 🧪 orden por 6 columnas | **Ni un commit.** PF.12 trae su propio orden en Detallado (`siguienteOrden`: Producto y «Este mes») | ❌ perdido · lo útil lo cubre PF.12 (2 columnas, no 6) |
| PF.12 | 🧪 «falta medir en prod» | `ff1f04437` (#460) en prod desde el 2026-10-27 | 🚀 · le faltan validación visual y tiempos de prod |
| PF.13–PF.17 | — | Nuevos, 2026-11-03, sin commit | 🧪 |

### PF.13–PF.17 — lo hecho el 2026-11-03 (motor; la pantalla ya pinta estos motivos en «Qué hacer»)

- **`[PF.13]` Lo que ya viene, sin restarlo (PF.UI.1).** El detalle lee las órdenes de compra abiertas de Kepler
  (`TRANSITO_SQL`: `X-A-35` de 120 días, sin entrada, estatus no F/C/R — la regla del diálogo «En camino» del
  Pedido) en un SAVEPOINT. El veredicto «Comprar» o «Mover» dice, por ejemplo: «Ya vienen 15 CJA en 2 órdenes de
  compra abiertas de Kepler; 1 de 14 días o menos, la más vieja de hace 80 días: con eso alcanzaría para 23 días.
  Este veredicto no las resta, igual que el Pedido: muchas órdenes no se surten». Si la lectura falla: «No se pudo
  leer lo que ya viene…» (nunca «no hay»). Y «Comprar»/«Esperar» dicen su umbral: «Criterio: comprar con menos de
  15 días de inventario. Es una propuesta todavía sin calibrar con Compras». La lista NO busca el tránsito (sería
  una consulta más por página); sólo el detalle.
- **`[PF.14]` Medición NP contra PF** (`database/scripts/mide-np-vs-pf.js`, sólo lectura): llama a los DOS
  servicios reales y agrupa el porqué.
- **`[PF.15]` Lo que sale por camioneta (PF.UI.2/PF.UI.3).** Una sucursal con existencia, sin venta de mostrador y
  con carga a camioneta (`U-D-41` a `RUTA`/`RD`) en los últimos 14 días ya no es «Estancado»: «Sale por camioneta
  (última carga: 31 de octubre); lo que vende la camioneta no está en Kepler». Si es lo único que mueve el producto,
  el veredicto pasa de «No comprar: no se vende» a «Esperar · Sale por camioneta: su venta no está en Kepler».
  «No se venden» saca los que su sucursal cargó a camioneta en 30 días y los cuenta aparte (`por_camioneta`), y el
  total dice si es un mínimo (`total_es_minimo`: la consulta tiene tope de 1,200).
- **`[PF.16]` Rótulos (PF.UI.5).** «Es líder: el #N…» → «Top de nuestra venta: el #N de la red en 90 días (X % de lo
  que vendemos; no es participación de mercado)». La sucursal sin nombre en la base se nombra con `warehouseName`
  (antes «Sucursal 06»).
- **`[PF.17]` Migraciones de PF.6/PF.8** (`database/scripts/check-pf-migraciones.js`, sólo lectura): objeto, LOS DOS
  ledgers, datos y latido. Control local: los dos objetos existen, la foto late cada minuto y ningún ledger local
  los nombra (la base local se armó con el arranque de desarrollo). Prueba negativa: `PF17_NEGATIVO=1` → sale 1.
- Instrumento de tamaño para prod: `database/scripts/check-pf-ui-prod.js` (tránsito y su unidad, camionetas,
  tope de «No se venden», negativos, cobertura del margen). Corrido en local como control.

Pruebas: `product-flow-transito.spec.ts` (20 pruebas, 8 de ellas negativas); `commercial-products` 349/352 — las 3 rojas son de
`new-products.spec.ts`, que no importa nada de PF: las rompe el trabajo sin commit de otra sesión en
`new-products.ts` (NP.UI.1). `compras` (view) 745/745.

⚠️ **Cambia números en prod** (regla 15): «No se venden» deja fuera lo que sale por camioneta, y algunos veredictos
«No comprar» y «Estancado» pasan a «Esperar» y «Se mueve». El antes/después se mide con `check-pf-ui-prod.js`
(bloque 2) contra prod ANTES de soltarlo: NO MEDIDO hoy.

### Estado al 2026-11-03 de las observaciones de diseño

| # | Tamaño hoy | Qué quedó hecho | Qué falta (y dónde) |
|---|---|---|---|
| PF.UI.1 🔴 | Prod NO MEDIDO (`check-pf-ui-prod.js` §1: OC abiertas, cuántas de más de 60 días, unidad). Local: 0 `X-A-35` | Motor: dice lo que viene sin restarlo y el umbral como propuesta (`[PF.13]`) | Pantalla (PR pendiente): enlace «Ir a Pedido» con el SKU puesto (Q.4). Decisión: D-PF.1 |
| PF.UI.2 🔴 | ~$428 K/semana de Canindo fuera de Kepler (FASE_AB, 26-oct, no re-medido). Local: Canindo con 194 cargas a camioneta del 14-ago al 9-oct; 0 de los 6 «No se venden» locales con carga | Motor: no «estancado» ni «no se vende» con carga reciente (`[PF.15]`) | Pantalla: rótulo del universo de la venta. Dato: D18 (venta de camionetas al ODS) sin dueño |
| PF.UI.3 🔴 | Prod: 957 «no se venden» el 29-oct (nota de pantalla), tope 1,200. Local: 6 | PF.12 quitó la vista conflada (dos filtros con su conteo). Motor: `total_es_minimo` y `por_camioneta` | Pantalla: la nota dice el dinero y «o más» (cambio exacto abajo) |
| PF.UI.4 🔴 | IEPS 8 % (Kinder) a IVA 16 % (plan) | PF.12 ya rotula la lista («venta con impuestos del 1 a hoy») y el margen («Venta sin impuestos») | Pantalla: «¿Cómo va la venta este mes?» no dice su base |
| PF.UI.5 🟠 | 245 top de venta (9-oct) | Motor (`[PF.16]`) | Pantalla: chip «Líder #N» y filtro «Líderes con pendiente» |
| PF.UI.6 🟠 | No medible con Kepler (historia desde el corte de cada sucursal) | — | Declarar en pantalla; la temporada real necesita la Fase WR |
| PF.UI.7 🟠 | Local: de 12 productos con venta, 6 con el margen sobre menos del 50 % de la venta | El panel ya trae la cobertura (`m.cubre`) | Prod NO MEDIDO (`check-pf-ui-prod.js` §4) |
| PF.UI.8 🟠 | — | PF.12 escribe cajas con la escalera de la ficha; el tránsito también | Alinear con D20 del Pedido (PQ.UI.3) |
| PF.UI.9 🟠 | Local: 3 sucursal×producto en negativo con venta en 30 días (salen «Agotado») | — | La existencia con piso en cero es de NP (`EXISTENCIA_KEPLER_SQL`): bandera `negativa` a pedir a su dueño |
| PF.UI.10 🟡 | — | Migraciones con script | Auditoría visual nivel A (aquí no se levanta nada) |

### Un solo motor: NP contra PF (NP.UI.3 / PF.UI.1) — NO se unifica aquí, lo decide el PM

Medido en la base LOCAL el 2026-11-03 con `mide-np-vs-pf.js` (los dos servicios reales, transacción de sólo
lectura; ⚠️ sobre el `new-products.ts` del árbol, con cambios sin commit de otra sesión que NO tocan la regla de
abajo): de 218 productos nuevos, 78 con veredicto de NP; 74 comparables. **63 opuestos (85.1 %), todos «PF compra
/ NP no recompra»**, y **62 por el mismo mecanismo**: PF dice «Comprar: ya no hay existencia» y NP «No recomprar:
lleva N días sin venderse». NP evalúa los días sin venta (`sinVentaDias`, 21) ANTES de mirar si está agotado, y un
producto agotado no se vende porque no hay. ⚠️ La base local no tiene venta después del 23-oct, lo que infla el
número: mide el MECANISMO, no la magnitud de prod (NO MEDIDO; mismo script).

**Propuesta:** (1) corto, regla de NP: «sin venta N días» no da «No recomprar» si en esos días estuvo agotado donde
se vendía — la misma regla que PF ya tiene («una caída con sucursales agotadas no es falta de demanda»); (2)
mediano, un solo veredicto de compra en `libs/` que NP y PF consuman, con la pregunta escrita en cada rótulo
(«¿lo vuelvo a comprar?» de NP es de lanzamiento; «¿hace falta comprar hoy?» de PF, de reposición).

### Definición de Terminado (método §5) — estado real

| # | Punto | Estado |
|---|---|---|
| 1 | Métrica medida otra vez, con antes/después | ⚠️ Medida HOY sólo en local (63/74). Prod NO MEDIDO; el antes/después espera la decisión D-PF.3 |
| 2 | Cada capa verificada o declarada NO MEDIDA | C0: venta cruzada al centavo (9-oct), márgenes cruzados (51 celdas); tránsito: unidad de la OC NO MEDIDA. C1: 102 pruebas PF. C2: lectura, sin escrituras nuevas. C3: sin validación visual (NO MEDIDO) |
| 3 | Endpoint que escribe, ejercido contra base real | La pantalla sólo lee. La única escritura es la foto del worker (PF.6): ejercida en local (latido `ok`, 2 variantes, hoy); en prod NO MEDIDO |
| 4 | Compuerta nueva rota a propósito | `check-pf-migraciones.js` rojo con `PF17_NEGATIVO=1` ✅. Las pruebas nuevas traen sus negativas |
| 5 | Primitivo genérico en `libs/` o deuda con nombre | La lectura opcional en SAVEPOINT (`opcional()`) es local al servicio: **deuda con nombre `[PF.18]`**. El tránsito reutiliza la regla del Pedido |
| 6 | Tracker, LOG y roadmap con el estado real | ❌ hasta que se aplique el texto de la corrección (lo integra la sesión principal) |
| 7 | En prod o por qué no | PF.1–PF.9 y PF.12 en prod; PF.13–PF.17 sin commit; migraciones NO MEDIDAS |

### Cambios propuestos para los archivos del PR pendiente (PF.12.1 / PF.12.3) — NO aplicados aquí

1. `libs/commercial/src/lib/commercial-products/catalogo-detallado.ts` — `Cuidado` gana `noSeVendenValor`,
   `noSeVendenMinimo` y `noSeVendenCamioneta` (de `no_se_venden.valor_total`, `.total_es_minimo` y `.por_camioneta`
   en `cuidadoDe`); la nota de `contarDetallado` pasa a decir «Los 300 de más dinero detenido, de 957 [o más] en la
   red ($X a costo); fuera N que salen por camioneta». Por qué: PF.UI.3.
2. `apps/view/src/app/modules/compras/catalogo-detallado.ts` — `etiquetasTexto`: «Líder #N» → «Top venta #N»; el
   filtro «Líderes con pendiente» → «Top de venta con pendiente». En `queHacer`, el respaldo «Sucursal NN» →
   `warehouseName(código)` de `@megadulces/contracts`. Por qué: PF.UI.5 y «una sucursal se nombra».
3. Mismo archivo, `comoVaLaVenta`: agregar al final de la frase «Venta con IVA e IEPS registrada en Kepler (sin lo
   que venden las camionetas).». Por qué: PF.UI.4 y PF.UI.2.
4. Mismo archivo, `sucursalesDetalladas`: si la plaza del motor trae `por_camioneta`, la columna «Sin vender» dice
   «Sale por camioneta» en vez de los días. Por qué: PF.UI.2 (si no, la tabla contradice al veredicto).
5. `apps/view/src/app/modules/compras/pages/producto-ficha-detallada.component.ts`, bloque «Qué hacer», después de
   los traspasos: enlace «Ir a Pedido con este producto» a `/compras/pedido` con `?search=<sku>` (la pantalla de
   Pedido ya hidrata `search`). Por qué: PF.UI.1 / DESIGN Q.4.

### Los 5 cambios de pantalla, APLICADOS (2026-11-03, D3 de David) y el motor único (D1)

Verificado cada uno contra el código del árbol antes de aplicarlo:

| # | Archivo | Qué quedó | Prueba (con su negativa) |
|---|---|---|---|
| 1 | `libs/commercial/.../catalogo-detallado.ts` | `Cuidado` trae `noSeVendenValor` / `noSeVendenMinimo` / `noSeVendenCamioneta`; `notaNoSeVenden`: «Los 300 de más dinero detenido, de 957 o más en la red ($X a costo); fuera N que salen por camioneta». Sin permiso de costo el servidor manda `valor_total` null y no se dice dinero (ni $0) | `catalogo-detallado.spec.ts`: con tope+dinero+camioneta; sin costo; [negativa] lista completa → sin nota; servidor previo → la nota de antes |
| 2 | `apps/view/.../catalogo-detallado.ts` + `compras-catalogo.component.ts` | «Líder #N» → «Top venta #N» (ficha Y renglón de la lista, que deben decir lo mismo); filtro «Top de venta con pendiente»; pie «no es participación de mercado». El respaldo «Sucursal NN» → `warehouseName` en `queHacer` y en las otras 5 frases del mismo archivo | spec: `warehouseName('04')` y nunca `/^Sucursal /` |
| 3 | mismo, `comoVaLaVenta` | La frase termina con `BASE_VENTA_MES`: «Venta con IVA e IEPS registrada en Kepler (sin lo que venden las camionetas).» | spec de la función y de la ficha |
| 4 | mismo, `sucursalesDetalladas` | «Sale por camioneta» en «Sin vender» cuando la sucursal trae `por_camioneta` **y** no vende en mostrador desde `diasEstancado` (la MISMA condición con que el motor la llama «se mueve»). ⚠️ Corrección al texto propuesto: el motor pone `por_camioneta` con cualquier carga reciente, aunque haya vendido hoy; sin la condición, «Hoy vendió» se habría tapado | spec + [negativa] con venta de mostrador hace 2 días dice «2 días» |
| 5 | `producto-ficha-detallada.component.ts` | Enlace «Ir a Pedido con este producto» → `/compras/pedido?search=<sku>` (verificado: Pedido hidrata `search` de la URL, `compras-pedido-real.component.ts` §Q.4). Sólo con `COMPRAS_PEDIDO_VER` (el guard de Pedido) | spec: `href` exacto; [negativa] sin la clave no se pinta |

**D1 — un solo motor de compra (`PF.UI.1` / `NP.UI.3`), hecho del lado de NP:** Productos nuevos ya no dice «Recomprar /
Esperar / No recomprar»; su panel muestra el veredicto de Productos (`GET :id/flow`) con su motivo. Detalle y medición
en `FASE_NP_PRODUCTOS_NUEVOS.md` § Undécima entrega: opuestos NP × PF en local 63 de 74 → **1 de 74**.

Quedan fuera (otras pantallas, mismo rótulo «Líder»): `producto-flujo-panel.component.ts` («Líder · #3 en venta de la
red») y el filtro «Líderes» de `catalogo-proveedor.ts`. Sin validación visual.

### PF.20–PF.23 (2026-11-04) — en código y probados, en el PR del catálogo

| Ítem | Qué | Estado |
|---|---|---|
| `[PF.20]` | Descontinuado (regla única en `libs/contracts`, etiqueta y al final de la lista Sencillo, Estado en la ficha) + el cliente externo nunca ve el último costo | 🧪 |
| `[PF.21]` | Sucursal del precio recortada al alcance (403 fuera de él) y selector «Precios de» en Detallado; la ficha usa la misma | 🧪 |
| `[PF.22]` | Último costo por cada unidad en las dos fichas, con la función de la lista | 🧪 |
| `[PF.23]` | Calendario de periodo en la ficha (venta por sucursal / compras), corte a Kepler declarado, total con sucursales faltantes dicho | 🧪 |

Medido en la base de desarrollo: venta por periodo = consulta directa ($17,711.05, sep-2026, suc. 02). Sin medir en
prod: tiempos del periodo y de la consulta de alcance (scripts de sólo lectura listos).
