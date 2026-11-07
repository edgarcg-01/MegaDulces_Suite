# Comercial › Monitoreo vecinal

`/comercial/monitoreo-vecinal` (grupo «Ruta y vendedores»). Lo que hace cada persona de la preventa
vecinal —vendedores, surtidores y cajeras—, por sucursal, ruta y periodo. Las entradas más nuevas van arriba.

---

## Primera versión (MV.1–MV.3, 2026-11-05)

### El problema

- Para saber qué hizo un vendedor, un surtidor o una cajera había que entrar a tres lugares distintos, y del
  vendedor casi todo vivía en «Cartera de ventas» (el tablero del supervisor y las visitas del día), que tuvo
  1 visita en 30 días.
- No había ninguna vista del surtido ni de la caja por persona: cuánto tardan, qué faltó, qué se cambió, qué
  ajustó la caja y cuánto se debió cobrar.

### La solución

- Una pantalla con cuatro vistas: **Resumen**, **Vendedores**, **Surtidores** y **Cajeras**. Sucursal, ruta
  vecinal y periodo arriba (atajos y calendario). En periodos de varios días, total o promedio por día.
- Cada persona se despliega:
  - **vendedor:** cada cliente que visitó, a qué hora, cuánto tiempo estuvo, si hubo pedido o por qué no, qué
    le levantó producto por producto, lo que Kepler le cobró a ese cliente ese día, su meta y su recorrido en
    el mapa;
  - **surtidor:** cada pedido, de qué cliente y vendedor, cuánto tardó, qué surtió contra lo pedido y qué
    cambió por otro producto;
  - **cajera:** cada pedido revisado, cómo quedó cada producto y cuánto debió cobrarse.

### Cómo se implementó

- Surtido y caja (`presale-picking/vecinal-monitor.*`): sólo leen `commercial.presale_picks` con su reporte y su
  revisión. La revisión en caja ahora guarda el SKU de cada producto.
- Vendedores (`commercial-vendor-routes/vecinal-vendors-monitor.*`): visitas (`vendor_visits`), pedidos de la app
  (`orders`), venta cobrada en Kepler (`v_kepler_vecinal_sales_docs`), metas (`vendor_targets`) y ubicación
  (`route_location_pings`). Reusa la ruta del día, el tipo de ruta, la atribución de la venta y la catorcena del
  tablero del supervisor, y en un día el monitoreo de visitas.
- Permiso `COMMERCIAL_MONITOREO_VECINAL_VER` para supervisores de ruta, dirección, encargados de tienda y
  superadmin. Qué sucursal ve cada quien lo decide su alcance.

### Por qué se hizo así

- **Dos ventas del vendedor:** lo levantado (lo que hizo el vendedor) y lo cobrado en Kepler (lo que cuenta para
  la meta). Si la meta se midiera contra lo levantado, este módulo y el tablero del supervisor darían avances
  distintos para la misma persona.
- **Reusar en lugar de reescribir:** la venta de la ruta y «quién visitó a quién» ya tenían una regla probada en
  prod. Una segunda versión terminaría diciendo otra cifra. Por eso la consulta de Kepler se sacó a una función
  que usan los dos.
- **Lo que no se registra se dice:** cuánto tarda la cajera en revisar (no se guarda cuándo empieza), lo cobrado si
  la vista de Kepler no responde, y los clientes de la ruta en periodos de más de un día. Se pinta «sin medir» o
  «no se registra», nunca un cero.
- **Pendiente:** la validación visual y la tarjeta del PM (la entrada del menú ya está, en «Ruta y vendedores»). Las metas casi no están
  capturadas en prod (una sola): sin ellas, la columna dice «sin meta».

## «Mi equipo» en la app del vendedor (MV.4, 2026-11-06)

### El problema

El supervisor de ruta pasa el día en campo. Para saber cómo va su gente tenía que llamar o escribir a cada
vendedor: quién no ha empezado, a qué clientes no ha pasado, cuánto lleva vendido. La pantalla web sirve en la
oficina, no en la calle.

### La solución

Una pestaña **Equipo** en la app del vendedor, sólo para quien tiene la llave del monitoreo (supervisor,
dirección, encargado de tienda). Abre con el resumen del día y su equipo ordenado por quién pide acción:
primero faltas, luego quien no ha iniciado, visitas abiertas, en ruta y al final quien terminó. Al tocar a un
vendedor salen sus clientes uno por uno (faltas y por visitar primero) y, al tocar un cliente, lo que se le
levantó y lo que Kepler le cobró. Botón «Cubrir una ruta» para cuando el supervisor sale a vender.

### Cómo se implementó

- Sin endpoint nuevo: lee `visits/monitor` (su equipo por `supervisor_id`, cada cliente del día con su estado)
  y `vecinal-monitor/vendors` (levantado, cobrado, meta).
- Reglas puras en `apps/vendor/.../supervisor-equipo.ts` (orden, resumen, etiquetas) con su prueba; dos
  pantallas: `vendor-supervisor-equipo` (lista) y `vendor-supervisor-vendedor` (detalle).

### Por qué se hizo así

- **Una sola lógica para web y app:** dos implementaciones de «quién visitó a quién» terminan dando números distintos.
- **La llave del monitoreo y no la de cartera:** `vendedor_ruta` también tiene la de cartera.
- **Si la venta no se pudo leer, el equipo se ve igual** y el dinero dice «sin dato»: nunca $0. El cobrado del equipo
  no se suma si a un vendedor no se le pudo medir (la suma saldría corta).
