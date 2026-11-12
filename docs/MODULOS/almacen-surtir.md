# Almacén › Surtir

La pantalla del surtidor (`/almacen/surtir`): toma un pedido, marca renglón por renglón lo que levantó
(Completo / Faltante / No había) y lo cierra. Hay dos orígenes que no se mezclan: **Sucursal** (lo que levantan
vendedoras y preventa en la app) y **Telemarketing** (lo que llega de Kepler). Las entradas más nuevas van arriba.

---

## Surtir en otra unidad cuando no hubo la caja completa (MCP.17, 2026-11-10)

- **Problema:** se pacta «1 caja» pero al surtir la caja ya está abierta. El sistema cuenta piezas, no cajas cerradas, así
  que sólo el surtidor lo sabe. Hasta hoy sólo podía marcar «no había» y la venta se perdía, o pedirle al vendedor que
  usara «Corregir» (medido: 15 de 35 correcciones de un mes se hicieron con el surtido ya empezado y 11 ya terminado).
- **Solución:** en el renglón con faltante, **«Surtir en otra unidad»**: ofrece sólo las presentaciones más chicas del
  mismo producto (PAQ, PZA) que Kepler tiene con precio en la sucursal, dice cuántas caben y se pone. Al terminar, el
  pedido queda con esa cantidad al precio de esa unidad; la caja lo revisa («en lugar de X en CJA») y la vendedora
  recibe «1 en otra unidad».
- **Implementada:** pestaña Sucursal de esta pantalla. Servidor: el cambio de producto de MCP.13 acepta el mismo producto
  en otra unidad, con tope en lo que faltó; nueva consulta `GET …/:id/lines/:lineId/units`. La regla del tope
  (`topeEnUnidad`) vive en `libs/contracts` y la usan la pantalla y el servidor.
- **Por qué el surtidor y no el vendedor:** en preventa el vendedor no está en la bodega, y «Corregir» con el surtido
  empezado reemplaza los renglones que el surtidor está marcando. Decisión de David, 2026-11-10.

---
## Pedidos separados por vendedor y en orden de folio (MCP.14, 2026-11-10)

- **Problema:** la operación de rutas vecinales pidió «separar los pedidos por vendedor» y «mostrar un orden de
  folios capturados por vendedor». La lista de preventa era una sola, por hora de llegada, con todos los vendedores
  intercalados: para surtir lo de un vendedor había que buscarlo entre los demás.
- **Solución:** cada vendedor encabeza su grupo («Vendedor · N pedidos») y dentro sus pedidos van por folio, el orden
  en que los capturó. Los grupos siguen el orden de llegada: arriba el vendedor del pedido más viejo. La tarjeta ya
  no repite el nombre del vendedor. Lo mismo en Revisión de pedidos (las cajeras).
- **Dónde:** en esta pantalla, pestaña **Sucursal** (la de las capturas del documento), y en `/almacen/surtir-preventa`.
  Aquí lo que el surtidor ya empezó va primero y aparte, «Los que estás surtiendo · N»: es lo que tiene que
  terminar, y en esas tarjetas sí va el vendedor porque ahí se mezclan.
- **Corrección del mismo día:** la primera versión sólo agrupó `/almacen/surtir-preventa`; esta pestaña seguía en
  una sola lista. Se encontró al revisar contra las capturas del documento.
- **Cómo:** regla compartida `almacen/pedidos-por-vendedor.ts`, sólo en la pantalla.
- **Por qué los folios «se saltan»:** el folio es un solo contador para toda la empresa. Medido el 2026-11-09: del
  PD-2026-00376 al 00407 existen los 32, repartidos entre 5 vendedores; no se pierde ninguno.

---

## Cambiar lo que faltó por otro producto (MCP.13, 2026-11-04)

### El problema

- Cuando no hay un producto, el surtidor sólo podía quitarlo del pedido: la venta se perdía aunque en la bodega
  hubiera algo equivalente. En prod, del 23-oct al 4-nov, 16 de 167 pedidos de preventa salieron con faltantes:
  7 renglones quitados y 9 recortados (lo que no se vendió se mide con `total_before − total_after` del reporte).

### La solución

- En el renglón que no se surtió completo aparece **«Cambiar por otro producto»**. Abre sugerencias con
  existencia en la sucursal y un buscador (nombre, SKU o código de barras). Al elegir uno se pone por lo que
  faltó, en la unidad del original si el sustituto la tiene; el surtidor ajusta cantidad y unidad.
- Lo cambia el surtidor sin esperar a nadie; la **cajera lo valida** al revisar («En lugar de X · lo cambió el
  surtidor») y el **vendedor lo ve** en *Mis pedidos* («X · faltó 1 → Y · 1 PZA»).
- Se cobra al **precio de Kepler del sustituto**, y sólo se cambia **lo que faltó** (si hubo 1 de 2, va 1 del
  original y 1 del sustituto).

### Cómo se implementó

- `POST …/finish` acepta `substitute: { product_id, quantity, unit }` por renglón. `planearCierre` valida la forma
  (sólo en un renglón con faltante, no el mismo producto, cantidad entera salvo peso).
- `cerrarPedido` valida contra la base (activo, no promoción, no repetido en el pedido, unidad en la escalera de
  Kepler, no agotado) y mete el renglón con `CommercialOrdersService.agregarSustitutos` **antes** de recortar,
  para que un pedido con todo cambiado no quede vacío y el total se recalcule una sola vez.
- El reporte del surtido guarda `substituted`. La revisión en caja (`armarRenglonesRevision`) da por cubierto el
  faltante del original: no se le pide completarlo ni se cobra dos veces.
- Sugerencias: `GET …/:id/lines/:lineId/substitutes?q=` (`presale-substitute.engine.ts` para el puntaje).

### Por qué se hizo así

- «Similar» no tiene fuente: el catálogo no trae familia ni línea, y la «categoría» es el nombre del proveedor.
  Afirmar que dos productos son similares sería adivinar el dato, así que el sistema **sugiere** por palabras del
  nombre (sin tamaño ni empaque) y proveedor, y **decide el surtidor**, que tiene el anaquel enfrente.
- Sin migración: el cambio vive en el reporte (`presale_picks.report`, JSON) y el sustituto es un renglón normal,
  así que la caja, el cobro en Kepler y la entrega no cambian.
- Pendiente a propósito: el surtido por ruta (consola) no tiene el botón, y si el cliente rechaza el sustituto al
  recibir no hay paso para eso todavía.

---

## Indicaciones del vendedor y llegada pedido por pedido (MCP.3.15, 2026-10-26)

### El problema

- Hay pedidos que llevan condiciones («las Sabritas con caducidad de diciembre», «bajar por la puerta de atrás») y
  el surtidor no tenía dónde verlas: el pedido ya tenía campo de notas, pero nadie podía escribirlo ni verlo
  (0 de 60 pedidos de 30 días con nota).
- Con la ruta abierta, el surtidor no recibía nada hasta «Finalizar ruta»: en un día de ejemplo, 3 h 43 min de
  espera promedio por pedido.

### La solución

- El vendedor escribe o dicta UN recuadro por pedido antes de agendar. El surtidor lo ve en grande arriba de la
  lista y no puede terminar sin marcar «Cumplí las indicaciones».
- Cada pedido llega al momento, suelto, como el método anterior.

### Cómo se implementó

- `orders.notes` por `place()`; `presale-picking` lo lee y lo manda como `instructions` en el renglón de la bandeja.
- `SURTIDO_DE_RUTA = false` (`presale-route.engine.ts`): sin retener el aviso, sin `NOT EXISTS` de la ruta en la
  bandeja, sin rutas que listar, `routeStart` rechaza y «Finalizar ruta» no avisa. ADR-106.

### Por qué se hizo así

- Las notas ya existían en el pedido y viajan a las partes de otra sucursal: no hizo falta migración.
- La marca vive sólo en pantalla por decisión de David; el día que se quiera saber quién la cumplió, es una columna.
- La ruta junta se apaga con una constante, no se borra: si se decide volver, es un cambio de una línea.

---

## La ruta del vendedor llega como UN pedido global (MCP.3.6, 2026-10-22)

### El problema

El surtidor surtía pedido por pedido conforme llegaban: muchas vueltas al anaquel por el mismo producto y la
lista se mezclaba con lo que el vendedor seguía levantando.

### La solución

Cuando el vendedor finaliza su ruta, al surtidor le llega **un pedido global**: el total de cada producto y
cuánto va para cada cliente. Lo **recolecta** en una vuelta (por marca, «3 CJA = 90 piezas», «Lo tomé» / «Hay
menos») y lo **reparte** en un pedido por cliente. Lo levantado después de finalizar llega como «Fuera de la
ruta», también global.

### Cómo se implementó

- `commercial.seller_route_days` (ventana inicio → fin de la ruta; `kind` ruta / fuera_de_ruta). Los pedidos
  no se copian: se derivan por la ventana (`PEDIDO_EN_RUTA_SQL`), la misma que los saca de la bandeja suelta.
- Cerrar reparte con `repartirProducto` (`allocation.ts`, regla fija) y cierra cada pedido con
  `cerrarPedido`, igual que el surtido por pedido: lo que no hubo se quita y se avisa a la vendedora.
- Surtir abre siempre en **Sucursal** (antes recordaba Telemarketing y el surtidor no veía las rutas).

### Por qué se hizo así

Una vuelta por producto en vez de una por pedido, y nada se mezcla con lo que ya se está surtiendo: la tanda
«fuera de la ruta» se cierra cuando el surtidor empieza a recolectarla.

---

## La lista de pedidos del surtidor: sólo folio y cliente (MCP.3.2, 2026-10-19)

### El problema

El surtidor no podía ver la lista de pedidos: el Tablero de pedidos (`/almacen/pedidos`) es de otros 15 roles
(encargados, telemarketing, facturación, compras…) y trae estatus, periodos, filtros, totales e importes que al
surtidor no le sirven.

### La solución

El surtidor abre el mismo Tablero, pero en una vista reducida: **Pedido** y **Cliente / destino** de lo que está
autorizado por surtir en su sucursal. Desde Surtir › Telemarketing llega con «Ver la lista de pedidos». En Surtir,
**Sucursal** va primero.

### Cómo se implementó

- La ruta `/almacen/pedidos` acepta también `COMMERCIAL_PICKING_GESTIONAR`. Sin `ALMACEN_PEDIDOS_VER`, la pantalla
  muestra sólo la tabla de dos columnas (sin pestañas, estatus, botones, periodos, rango, filtros ni totales) y no
  abre el detalle.
- Pide lo `AUTORIZADO` de los últimos 30 días; el alcance por sucursal lo pone `ScopeService` (el surtidor ve la suya).
- `GET /warehouse/orders` acepta al surtidor y le responde **sin importes** (`sinImportes`); `totales.importe` pasa
  a `number | null`.

### Por qué así

- **No se le cambia la pantalla a nadie más**: quien tiene el permiso del tablero lo sigue viendo completo.
- **El dinero se quita en el servidor**, no sólo en la pantalla: no tiene por qué viajar al celular del surtidor.
- **30 días y no "el mes"**: el día 1 no deben desaparecer los autorizados del mes anterior.

### Pendiente

- Confirmar si el surtidor debe ver sólo lo autorizado (decisión provisional) o todos los estatus.

---

## Los pedidos de las vendedoras no le llegaban al surtidor (MCP.3.1, 2026-10-19)

### El problema

Los pedidos que levantan vendedoras y preventa en la app nunca llegaban al surtidor. Medido en prod: 12 avisos de
pedido creados, **ninguno visto**, y **cero** surtidos de preventa empezados. Eran dos fallas encadenadas:

1. El surtidor aterriza en Surtir, cuyo «Tomar siguiente» sólo arma trabajo desde Kepler. Ahí el botón «Sucursal»
   leía pedidos **de Kepler** con origen sucursal, así que veía «No hay pedidos por surtir». La bandeja de preventa
   (MCP.3) vivía en otra pantalla a la que nada lo llevaba.
2. Aun llegando, **abrir un pedido daba error 500**: el detalle y el cierre pedían la columna `name` del catálogo y
   se llama `nombre`.

### La solución

En la misma pantalla de Surtir: **Sucursal** lista los pedidos de la app de su almacén por Hoy / Mañana / Próximos,
el surtidor elige cuál, y lo surte con los mismos renglones de siempre. **Telemarketing** sigue con «Tomar siguiente».

### Cómo se implementó

- Surtir ofrece sólo dos orígenes (sale «Todos», que mezclaba). «Tomar siguiente» siempre pide `TELEMARK`.
- Por detrás usa el surtido de MCP.3 (`/warehouse/presale-picking`): «Surtir este» registra quién y a qué hora; al
  terminar, lo que no hubo se quita del pedido, se recalcula el total y se le avisa a la vendedora.
- Lo marcado se guarda en el celular hasta cerrar (si se cierra la app, al «Continuar» sigue marcado).
- El aviso de la campana abre el pedido en Surtir (`?pedido=`).
- El detalle trae el código de barras para el escáner; `p.name` → `p.nombre`.

### Por qué así

- **Una sola pantalla para el surtidor**: brincar a otra pantalla fue justo lo que hizo que nadie viera los pedidos.
- **El surtidor elige por fecha**: decisión de David; Telemarketing sigue sin elección.
- **No se mezclan los orígenes**: Sucursal no pasa por Kepler antes de surtirse; Telemarketing sí.
- **No se duplicó lógica**: el cierre (quitar faltantes, recalcular, avisar) ya existía en MCP.3.

### Pendiente

- Confirmar cómo captura la caja el cobro en Kepler: si lo captura como *pedido* (`U-D-40`) y no como venta, al
  surtidor le aparecería otra vez en Telemarketing.
- Los pedidos de Kepler con origen SUCURSAL (almacén 08) ya no se toman desde Surtir: confirmar con Edgar.
- `commercial-tickets` (línea 684) tiene el mismo error de `p.name`.
