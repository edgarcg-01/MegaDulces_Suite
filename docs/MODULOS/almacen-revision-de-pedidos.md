# Almacén › Revisión de pedidos (caja)

La pantalla donde la cajera revisa cada pedido de preventa que terminó el surtidor, antes de cobrarlo
(`/almacen/pedidos/revision`, pestaña junto a «Guías de carga»). Las entradas más nuevas van arriba.

---

## Un día a la vez y por vendedor (MCP.24, 2026-11-12 — en código, sin desplegar)

- **Problema:** la lista mezclaba días. Medido en prod: **52 pedidos por revisar de 18 días distintos**, desde el
  28 de septiembre, en una sola lista. Lo de hoy quedaba revuelto con lo que nadie cerró.
- **Solución:** abre siempre en **Hoy**: lo que el surtidor terminó hoy, por revisar y ya revisado. «Ayer» y un
  día del calendario muestran lo surtido ese día. Lo que quedó sin revisar de otros días va en un aviso arriba, por
  día («mar 27 oct · 1»), y tocarlo abre ese día. Arriba se elige vendedor; «Todos» conserva los encabezados.
- **Implementada:** `GET …/presale-review?date=AAAA-MM-DD` (lo surtido ese día en hora de México, revisado o no;
  400 si la fecha está mal escrita). Pantalla: `almacen-revision-preventa.component.ts`; la lógica pura en
  `pedidos-por-dia.ts`, compartida con el surtidor.
- **Por qué así:** el día de la caja es el día en que se **surtió**, no el de entrega. En 30 días, 451 de 467
  revisiones se hicieron el mismo día del surtido, pero 108 de 515 surtidos se hicieron después de su fecha de entrega.
  Con la fecha de entrega, uno de cada cinco pedidos de hoy habría quedado en otro día. La búsqueda «está en otro
  pedido» y la métrica «Por revisar» siguen viendo todo lo pendiente.
- **Pendiente:** verlo en pantalla. Cancelar un pedido completo desde la caja es `[MCP.25]`.

---

## Los pedidos a revisar, separados por vendedor y en orden de folio (MCP.14, 2026-11-10)

- **Problema:** «separar los pedidos a revisar por vendedor» (solicitud de rutas vecinales, 2026-11-09). La lista era
  una sola, por la hora en que el surtidor terminó, con todos los vendedores mezclados.
- **Solución:** cada vendedor encabeza su grupo y dentro van por folio; arriba el vendedor cuyo pedido terminó primero
  el surtidor. La misma regla que Surtir (`almacen/pedidos-por-vendedor.ts`).
- **Por qué:** la cajera revisa y cobra por vendedor; tenerlos juntos y en el orden en que se capturaron evita buscarlos.

---

## Revisar escaneando, y tocando cuando no hay lector (MCP.10.3, 2026-11-09)

- **Problema:** con la lista para tocar (MCP.10.2) la cajera dejó de escarbar en el carrito, pero no ganó tiempo:
  la búsqueda se mudó del mostrador a la pantalla. En una simulación de un pedido de 30 productos, buscar (en el
  mostrador o en la lista) cuesta unas 217 miradas; sólo escanear la quita. En prod, de 963 productos que el
  surtidor dio por completos la caja cambió 3: lo valioso de la revisión está en los faltantes, no en tocar
  «Está bien» 30 veces.
- **Solución:** arriba del producto en grande hay un campo «Escanea el producto». La cajera escanea lo que tiene en la
  mano: si el pedido trae 1 y escaneó esa misma unidad, queda «bien» solo; si trae varias, es otra unidad o faltó,
  lo pone en grande para revisarlo; si ya estaba revisado, si el código es de dos productos del pedido o si no es del
  pedido, lo dice junto al campo. Si el campo pierde el foco se pone ámbar: «El lector no está listo: toca aquí».
  **Sin lector** (o con un producto sin código) se toca en la lista, que ahora pone «Por revisar» arriba y «Ya
  revisados» aparte.
- **Cómo:** el detalle trae los códigos de cada producto de la ficha de Kepler de la sucursal (`kepler_ods.kdii`, con
  el mismo lector del checado de almacén) y cuántas piezas trae cada código (pieza, paquete, caja). La pantalla
  compara el código exacto (sin quitar ceros). Si los códigos no se pudieron leer, se dice y se revisa tocando.
  Sin migración.
- **Por qué:** escanear quita la búsqueda (simulación: 30 productos ≈ 1 min contra 3.3 de antes) y además comprueba
  que el producto está ahí; escanear la pieza de un pedido de «1 caja» no la da por buena. Medido en prod: 99.3 %
  de los productos revisados tienen código de su unidad en Kepler.
- **El buscador no tiene límites:** el mismo campo acepta el código de barras, el SKU (el que se ve en pantalla), el
  código con ceros de más o de menos y parte del nombre. Lo que se escribe filtra «Por revisar» y lo dice («1 de 9»,
  con «Ver todos»). Sólo el código exacto de un producto de 1 unidad lo da por bueno solo; lo demás lo señala para
  revisarlo. Si no es de este pedido, lo busca en los otros pedidos por revisar de la sucursal y deja abrirlo con el
  producto ya señalado.
- **Se quitó la nota del vendedor** del pedido (el recuadro azul, p. ej. «Dejar en la bodega de atrás»), decisión de
  David: a quien revisa no le dice qué revisar. ⚠️ Era el único lugar del flujo vecinal donde se veía (36 de 265
  pedidos la traen); el dato sigue guardado en el pedido.
- **Pendiente:** probarlo con el lector de la caja (no hay escaneos reales registrados todavía en la Suite) y decidir si
  la nota del vendedor se muestra en la guía del repartidor.

---

## Se revisa el producto que se tiene en la mano (MCP.10.2, 2026-11-09)

- **Problema:** la pantalla señalaba un producto a la vez en el orden en que el vendedor capturó el pedido, y los
  demás de la lista no se podían tocar. Pero el surtidor acomoda el carrito por cómo es el producto: lo blando (un
  bombón) arriba y lo duro o lo que aguanta peso abajo. La cajera sacaba el de arriba y la pantalla le pedía el de
  abajo: tenía que escarbar o acordarse. En 30 días se revisaron 252 pedidos; la mitad trae 3 productos o menos, pero
  19 trajeron 10 o más (el más grande, 41).
- **Solución:** lo que falta revisar en la lista es un botón. La cajera toca el producto que tiene en la mano y ése
  pasa a revisarse, en grande, como siempre. Al resolverlo (o dejarlo esperando al surtidor) la pantalla vuelve al
  primero pendiente. «← Anterior» regresa a ese mismo producto. Lo ya revisado no se toca: se corrige con «Anterior».
  Sobre la lista dice «¿Tienes otro producto en la mano? Tócalo en la lista.» mientras quede más de uno.
- **Cómo:** sólo en la pantalla. `renglonActual` recibe el producto tocado; el componente lo guarda en `elegido` y lo
  suelta al resolverlo. Después de tocar, la vista y el foco van al producto en grande (en un pedido largo queda arriba,
  fuera de la vista). Sin cambios en el servidor ni migración.
- **Por qué:** ordenar la pantalla como el carrito no es posible sin adivinar: el catálogo no dice qué es frágil
  (departamento y línea vacíos en los 1,000 renglones revisados) y cada surtidor acomoda a su manera. Dejar que la
  cajera escoja hace que el orden deje de importar, y conserva «un producto a la vez y en grande».
- **Siguiente paso posible:** escanear el producto en lugar de buscarlo en la lista (994 de 1,000 renglones tienen
  código de barras; se reusaría el lector del checado de almacén). Depende de que haya lector donde se revisa.

---

## Lo que cambia la caja lo ven todos (MCP.10.1, 2026-11-03)

- **Problema:** en PD-2026-00203 (PH) el surtidor sacó 1 de 2 salsas y la caja completó la otra. El pedido quedó
  bien, pero el vendedor seguía viendo el reporte del surtido («2 → 1» y un total menor) y el surtidor veía «2 cajas
  surtidas», como si las hubiera sacado él.
- **Solución:** el vendedor, en «Mis pedidos», ve el paso «Revisado en caja» (quién y a qué hora, y si la caja
  completó o quitó algo) y «Cómo quedó el pedido»: por producto, pediste → surtió → quedó, con un solo total final.
  El surtidor ve el pedido como «Revisado en caja» y, en cada producto que cambió, «Surtiste N · la caja dejó M».
- **Cómo:** `GET /vendor/presale-status` trae `review` y `reviewed`; el detalle del surtido trae `picked` (lo que
  surtió el surtidor, recuperado del reporte) y `final` (cómo quedó). Sin migración: el dato ya existía.
- **Por qué:** las tres pantallas tienen que contar lo mismo. Si no, el vendedor le dice al cliente que algo no llegó
  y sí se lo llevó, o el surtidor cree que surtió completo cuando faltó.

---

## Revisar antes de cobrar (MCP.10, 2026-10-29)

- **Problema:** en Padre Hidalgo 8 de 28 pedidos de preventa salieron con faltantes y en los 8 Kepler decía que sí
  había. El surtido quita del pedido lo que no hubo, así que se cobraba de menos sin que nadie lo pidiera a la bodega.
- **Solución:** la cajera ve los pedidos surtidos de su sucursal y los revisa **un producto a la vez**, resaltado y en
  grande (la mayoría son personas mayores). Lo normal es un toque, «Está bien». Si faltó, la tarjeta se pone amarilla,
  dice si el sistema tiene existencia y cuánto pedirle al surtidor; cuando se lo trae, «Ya se completó». Otros botones
  para cuando algo no cuadra: «No coincide» / «Trajo otra cantidad» (− y + grandes), «No hay», «Ya los devolví» (vino
  de más), «Seguir con otro» (mientras espera al surtidor) y «← Anterior» (deshacer). Los otros pedidos se pueden tocar
  para cambiar. Al terminar dice en rojo lo que no se cobra.
- **Cómo:** `GET /warehouse/presale-review`, `GET /:id` (con la existencia de Kepler en la unidad del pedido) y
  `POST /:id/finish`. El cierre corrige el pedido de la Suite en la misma transacción (`ajustarTrasRevision`: sube lo
  completado, quita lo que no hubo y repone el renglón que el surtido había borrado) y guarda quién, cuándo y qué en
  `presale_picks.review`. La vendedora recibe aviso si el pedido cambió. Lo revisado a medias se guarda en el navegador:
  recargar no lo pierde. Permiso `PREVENTA_GUIAS_GESTIONAR` (el de las guías, ya repartido a cajero y encargado).
- **Por qué:** «primero revisan y luego cobran» (decisión de David). El pedido de la Suite tiene que decir lo que de
  verdad se cobró; si no, la vendedora ve «faltó» de algo que sí se llevó el cliente. No hay pantalla del surtidor: la
  cajera se lo pide de viva voz y ella confirma (maqueta v7 aprobada en conversación).
- **Lo no revisado no caduca:** se queda arriba con «Sin revisar · hace N días» hasta que alguien lo revise (antes
  desaparecía a los 3 días sin avisar). Lo surtido antes de que existiera la revisión no aparece (`review_required`).
  No se marca «cobrado sin revisar»: el ticket de Kepler en el ODS no trae hora y en PH sólo 9 de 28 surtidos tienen
  un ticket del cliente que se pueda detectar; afirmarlo erraría en 2 de cada 3.
- **Límites declarados:** los renglones borrados antes del 29-oct no guardaron copia y sólo admiten «No hay». Cobrar
  sigue en Kepler: la Suite no puede impedir que se cobre sin revisar. Sólo ruta vecinal por ahora.
