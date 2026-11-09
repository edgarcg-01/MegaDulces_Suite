# App del vendedor › Tomar pedido

La pantalla donde el vendedor arma el pedido de un cliente (`/vendor/take-order/:cliente`): busca productos, elige la
unidad (pieza, paquete, caja) y agenda el pedido. Las entradas más nuevas van arriba.

---

## Lo que el cliente pide se captura aunque no haya; el servidor lo registra para Compras (DN.7, DN.8, DN.11a — en código el 2026-11-07, sin desplegar)

- **Problema:** el bloqueo de MCP.3.16 frenaba el producto agotado EN EL TELÉFONO, sin llamar al servidor: lo que el
  cliente pidió no quedaba en ningún lado. Medido (misma base): antes del bloqueo entraba sin existencia el 14.2 % de
  los renglones de preventa (31 de 218); con el bloqueo, el 0.23 % (2 de 857). Compras perdió la señal.
- **Solución (ADR-115):** el «+» agrega siempre, sin aviso emergente; la fila conserva su estado (rojo «Sin
  existencias», gris «no se maneja»). Elegir en la tira una sucursal en 0 también se deja, y la fila lo dice como
  opción («En PH puede no haber: puedes surtir de otra sucursal»). El pedido **sugerido** sigue sin proponer lo que no
  hay, también sin conexión con la lectura guardada de menos de 6 h, y dice qué dejó fuera (lo predijo el
  sistema, no lo pidió el cliente). Con una lectura más vieja no se afirma nada: entra, y si al agendar
  resulta agotado se registra (declarado: el registro no sabe que vino del sugerido).
- **Cómo:** el servidor ya no responde 409: `addLine`/`updateLine` guardan el renglón y devuelven `stock_state` y
  `stock_review`. Al agendar, `place()` registra cada renglón en `commercial.order_stock_notices` con su existencia
  (`agotado` / `no_se_maneja` = demanda negada). La app manda `client_build` para medir por versión.
- **Por qué:** el «agotado» de Kepler no es testigo fiable (29.4 % de los saldos ≤ 0 son negativos) y el vendedor no
  debe sustituir por intuición: captura lo que el cliente pide y el sistema le corrige la plana al agendar (la hoja
  con sustitutos es el frente 2 del anexo A de la fase DN).

---

## La existencia dice la verdad y no deja agregar lo que no hay (MCP.3.16, 2026-10-27)

> ⚠️ **El bloqueo de esta entrada se quita con ADR-115 (en código el 2026-11-07, sin desplegar; entrada de arriba).**
> Los cuatro estados se quedan.

- **Problema:** a 40–64 % del catálogo no se le veía existencia (productos que la sucursal nunca ha manejado), CAN y
  MM decían «Sin existencias» de lo que no manejan, y 573 productos estaban duplicados (el viejo sin existencia).
- **Solución:** cuatro estados — «Existencias: N» · rojo «Sin existencias» (agotado) · gris «Sin existencias en PH»
  al final (no se maneja) · gris «Sin dato de existencia» (lectura vieja). El duplicado toma la existencia de su
  gemelo. Agregar de una sucursal sin existencia no se deja, y se dice qué sucursal de la zona sí tiene.
- **Cómo:** `stock_state=1` en el catálogo, `stale`/`checked_at` en la zona y 409 `SIN_EXISTENCIA` en `addLine` /
  `updateLine`, todo con un solo resolvedor sobre la vista canónica del ODS y la frescura de `ods_live_hot`.
- **Por qué:** «en blanco» no le decía nada al vendedor y un 0 inventado le quitaba ventas. Sin dato y sin conexión
  no bloquean: bloquear con un dato que no sabemos sería quitar una venta real.

---

## Indicaciones para el surtidor (MCP.3.15, 2026-10-26)

- **Problema:** el vendedor no tenía dónde decir cómo quiere el cliente su mercancía.
- **Solución:** en «Tu pedido», antes de agendar, un recuadro «Indicaciones para el surtidor» (una sola para todo
  el pedido; nombrar el producto) con botón **Dictar**. Si habla de sabores, avisa que cada sabor es otro producto
  en Kepler y hay que agregarlo por sabor. El «Agendar» de la barra abre «Tu pedido» para que el recuadro se vea.
- **Cómo:** `notes` en `placeOrder`; dictado con la Web Speech API (`apps/vendor/.../dictado.ts`).
- **Por qué:** un solo recuadro por pedido (decisión de David). Sin conexión las indicaciones no viajan y se avisa.

---

## Vender de otras sucursales de la zona: «pedido agrupado» (MCP.3.12–3.13, 2026-10-23)

### El problema

Se dio permiso de vender de otras sucursales, pero el vendedor sólo veía y pedía la existencia de SU sucursal, y
todo el sistema (precio, surtido, ticket de Kepler, guía, liquidación) suponía una sucursal por pedido.

### La solución

- En cada producto, una tira discreta con la existencia de cada sucursal de la zona. Tocar una = de ahí se surte
  ese producto (con su precio). El carrito y el pedido agendado dicen en qué sucursales se surte.
- Para el vendedor y el cliente es UN pedido; por dentro, cada sucursal recibe su parte.

### Cómo se implementó

- `GET commercial/vendor-routes/my-zone-stock` (zona = `warehouses.purchase_zone`, existencia de `commercial.stock`).
- `order_lines.source_warehouse_id` (validado contra la zona en el servidor) y precio de esa sucursal.
- `place()` separa: los renglones de otra sucursal pasan a una parte (`orders.group_id` = principal); si todo era
  de otra sucursal, el principal toma esa sucursal (no queda pedido vacío).
- Surtido de ruta por sucursal (`seller_route_day_picks`), clave Kepler del cliente por sucursal
  (`customer_branch_keys`), reparto con las partes del grupo y liquidación en una sola caja. ADR-105.

### Después: el vendedor ve UN pedido (MCP.3.14, 2026-10-26)

- La lista de pedidos del vendedor (`GET commercial/orders?group=1`) trae un renglón por grupo, con el total
  sumado, y `group_parts` con la sucursal, el estado y el surtido de cada parte.
- El estado por sucursal sólo se muestra si surten 2+ (si surte una, se ve como cualquier pedido).
- Almacén, mesa y caja no piden `group`: siguen viendo cada parte, porque cada sucursal surte y cobra la suya.

### Por qué se hizo así

- Separar en partes deja cada parte como un pedido de UNA sucursal: surtido, ticket y guía siguen funcionando
  como hoy. Poner la sucursal en cada renglón obligaba a rehacer ~30 puntos del sistema.
- Se cobra en cada sucursal porque cada Kepler registra lo que salió de su almacén (regla de David).

---

## La fecha de entrega es hoy por omisión (MCP.3.4, 2026-10-20)

### El problema

Al levantar un pedido, la fecha de entrega aparecía en el próximo día hábil (mañana). Los pedidos que se
surten el mismo día había que cambiarlos a mano, y si no se cambiaban le llegaban al surtidor en «Mañana».

### La solución

La fecha propuesta es **hoy**. El vendedor la puede mover a otro día como siempre. El domingo, que no hay
reparto, propone el lunes.

### Cómo se implementó

- `fechaEntregaPorOmision()` en `apps/vendor/src/app/core/date/biz-days.ts`, en hora local, recibe «hoy» para
  poder probarla sin el reloj. `vendor-take-order` la usa como valor inicial.
- Al corregir un pedido ya hecho se conserva su fecha (no se reagenda solo).

### Por qué así

- **La regla de fechas vive en un solo lugar** (`biz-days.ts`), como ya estaba decidido: antes estuvo
  triplicada y divergente.
- **El domingo se respeta**: es la razón por la que antes se usaba el próximo día hábil.

---

## Volver al inicio desde «Pedido agendado» (MCP.3.3, 2026-10-19)

### El problema

Después de agendar un pedido, la pantalla de éxito sólo mostraba «Capturar exhibición». El botón que regresa al
inicio («Finalizar visita») existía, pero la barra de abajo de la app lo tapaba: el vendedor no tenía cómo volver.

### La solución

El botón se ve y dice lo que hace: **«Finalizar visita e ir al inicio»**, con ícono de casa. Cierra la visita y
regresa a Mi ruta.

### Cómo se implementó

- Los botones (fijos) suben por encima de la barra: `bottom` de 5rem + 0.75rem y `z-index` 11 (la barra es 10).
- Si cerrar la visita falla, igual lleva al inicio.

### Por qué así

- **No se agregó un segundo botón** que vaya al inicio sin cerrar la visita: dejaría visitas abiertas en la ruta.

---

## Abrir el cliente sin esperar el catálogo (VTK.11, 2026-10-15)

### El problema

Aun con el servidor rápido, el catálogo (~1.2 MB comprimido, 9,429 productos) se bajaba completo cada vez que el
vendedor abría un cliente: en la oficina 2–6 s de descarga, más en 4G. Y es el mismo para todos los clientes de la
ruta.

### La solución

La pantalla abre con el catálogo que el celular ya tiene y baja el nuevo detrás. Mientras llega, dice de cuándo son
los precios y la existencia que se ven.

### Cómo se implementó

- `VendorService.catalogInstant`: primero el catálogo de esta sesión (en memoria), luego el guardado en el celular
  (`VendorCatalogCache`, la misma copia que ya usaba el modo sin conexión) y sólo si no hay copia que sirva, el
  servidor.
- Reglas puras en `catalogo-al-abrir.ts`: la copia sirve si es de la misma sucursal y tiene menos de un día; se
  refresca detrás si tiene más de 2 minutos.
- Al abrir con copia sólo se guarda el cliente; el catálogo se reescribe cuando llega el nuevo.

### Por qué así

- **La existencia cambia por almacén**: una copia de otra sucursal (o de la camioneta) no se usa.
- **Lo que se cobra no sale de la copia**: el renglón lo tarifa el servidor al agregarlo, como siempre.
- **La edad se dice** (ADR-056): unos precios de hace 10 minutos no se presentan como de este momento.
- **No pisa lo que el vendedor está viendo**: si cambió a la camioneta mientras llegaba el catálogo nuevo, se guarda
  para la próxima apertura y no reemplaza la vista.

---

## Abrir un cliente tardaba 13–19 segundos (VTK.10, 2026-10-15)

### El problema

Al escoger el cliente, la pantalla se quedaba cargando entre 13 y 19 segundos antes de dejar capturar. Y al buscar
algunos productos no aparecían, aunque existían y tenían precio.

### La solución

- El catálogo se arma en menos de un segundo del lado del servidor.
- Llega **completo**: los 9,429 productos con precio, no sólo los 8,000 más vendidos.
- El precio que se cobra no cambia.

### Cómo se implementó

- **Se midió antes de tocar nada** (prod, usuario de prueba de la vendedora vecinal de La Piedad Abastos). Todas las
  peticiones de la pantalla respondían en menos de 0.6 s salvo el catálogo: 11–12 s de servidor. Comprimido son
  1.2 MB y bajan en un segundo, así que la red no era el problema.
- Dentro del catálogo, **9.4 s** eran la vista de mayoreo (`analytics.product_volume_tiers`): saca la moda de los
  precios de todas las sucursales y el costo estándar, y filtrar por producto no la abarata. Se recalculaba entera en
  cada apertura, de cada vendedor. La escalera de unidades de la sucursal sumaba otro segundo y medio.
- Las dos se sirven ahora como **foto**: se entrega la que hay al momento y se recarga detrás (el mayoreo cada
  2 minutos, la escalera cada minuto). La respuesta dice de cuándo es cada foto (`freshness`). El mecanismo
  (`FotoSwr`) vive en `libs/commercial/shared`, con su prueba.
- La app pedía 8,000 productos; ahora pide hasta el techo del servidor, 10,000.

### Por qué así

- **No se tocó la vista de mayoreo**: también la usa el cálculo del precio por cantidad, y cambiarla es cambiar lo que
  se cobra. La foto sólo cambia lo que el vendedor **ve**, y el renglón lo sigue tarifando el motor al agregarlo, con
  su propia lectura.
- **Foto y no tabla nueva**: no se copia ningún dato a otra tabla. Es memoria del servidor y su edad se declara.
- **El tope de 8,000 escondía lo menos vendido**: el catálogo viene ordenado por venta, así que lo que se cortaba era
  justo lo que el vendedor no se sabe de memoria y tiene que buscar.
- **Lo que queda pendiente**: medir el tiempo real en prod después del despliegue (en local no se levanta el
  servidor), y mover a `FotoSwr` la copia privada que todavía tiene la pantalla de Existencia.
