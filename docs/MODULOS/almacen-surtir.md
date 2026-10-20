# Almacén › Surtir

La pantalla del surtidor (`/almacen/surtir`): toma un pedido, marca renglón por renglón lo que levantó
(Completo / Faltante / No había) y lo cierra. Hay dos orígenes que no se mezclan: **Sucursal** (lo que levantan
vendedoras y preventa en la app) y **Telemarketing** (lo que llega de Kepler). Las entradas más nuevas van arriba.

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
