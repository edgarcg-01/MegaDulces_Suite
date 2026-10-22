# Cliente nuevo: alta en la Suite y liga con Kepler (`[MCP.3.8]`, 2026-10-21)

## Problema
El vendedor da de alta clientes en la app (código provisional `V-…`). Se les levanta y se les surte
el pedido, pero **sin clave de Kepler no se cobran en Kepler ni entran en guía**. Medido antes de
este cambio: ~491 clientes `V-` sin liga y ~25 duplicados. Nadie en la sucursal tenía dónde ligar la
clave, y el surtidor no tiene permiso de clientes.

## Solución
1. **App del vendedor** (`/vendor/search`, botón «Nuevo»; desde «Mi ruta» el botón de agregar cliente
   lleva al mismo formulario): «Alta de cliente nuevo» con nombre, teléfono, dirección y la ubicación
   del celular. Antes de crear pregunta **«¿Es este?»** con los clientes de su sucursal de nombre
   parecido. «Es este» le levanta el pedido al que ya existía; «No, es otro» lo da de alta.
2. **Bandeja de la sucursal** (`/almacen/clientes-nuevos`): cada cliente nuevo sin clave, quién lo
   dio de alta y cuándo, sus pedidos pendientes, el campo «Clave que le diste en Kepler» (se busca en
   el ODS y muestra el nombre que tiene en Kepler) y «Ligar con Kepler».
3. **Aviso en Surtir**: «N clientes nuevos sin clave de Kepler» lleva a la bandeja; sus pedidos se
   marcan «Cliente nuevo · sin clave de Kepler».

## Cómo está implementada
- Backend `libs/commercial/src/lib/new-customers-kepler/` (motor puro + servicio + controladores).
  - `GET /api/commercial/new-customers/similar?name=` — `COMMERCIAL_CARTERA_VER` (mismo que el alta).
  - `GET /api/warehouse/new-customers` · `GET …/summary` · `GET …/:id/kepler?code=` —
    `COMMERCIAL_PICKING_VER` o `_GESTIONAR`.
  - `POST /api/warehouse/new-customers/:id/link` — `COMMERCIAL_PICKING_GESTIONAR`.
- Kepler se **lee** de `analytics.v_customer_master` (vista sobre `kepler_ods.kdud`, llave
  `(sucursal, clave)`). Ligar = `UPDATE` de la **misma** fila de `commercial.customers`
  (`erp_source_branch`, `erp_customer_code`, nombre, crédito, plazo y domicilio de Kepler; código
  `K<sucursal>-<clave>` si está libre). Sin migración, sin importer, sin copia.
- Sucursal de un cliente: ligado → su sucursal; si no, la que surte su ruta
  (`commercial.route_warehouses`); si no, el almacén de su último pedido. Sin ninguna, se declara y
  no se puede ligar.
- El alta del vendedor ahora guarda `created_by` (antes no; las altas viejas dicen «Alta sin
  registro de quién»).

## Por qué así
- Permisos del surtido y no uno nuevo: el surtidor ya los tiene (decisión del usuario).
- `[VK.4]` **sigue**: en una ruta gobernada por Kepler el servidor rechaza el alta («dalo de alta en
  Kepler y aparecerá solo en tu ruta»). Quitarlo exige la conciliación de `[VK.7]`, que no está
  decidida.

## Lo que no cubre / pendiente
- La caja (rol `cajero`) **no** tiene `COMMERCIAL_PICKING_*` según `docs/MATRIZ_ACCESOS.md`: no ve la
  bandeja hasta que se le reparta (decisión pendiente).
- Si la clave ya la tiene un ancla creada por la sincronización `[VK.4]`, la bandeja lo reporta como
  duplicado; fusionar dos fichas no se hace aquí.
- Los pedidos dentro de una ruta global (`[MCP.3.6]`) no llevan la marca «sin clave».
- SQL sin ejecutar contra una base real (pruebas con dobles).
