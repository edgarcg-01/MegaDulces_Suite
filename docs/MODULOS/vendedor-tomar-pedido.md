# App del vendedor › Tomar pedido

La pantalla donde el vendedor arma el pedido de un cliente (`/vendor/take-order/:cliente`): busca productos, elige la
unidad (pieza, paquete, caja) y agenda el pedido. Las entradas más nuevas van arriba.

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
