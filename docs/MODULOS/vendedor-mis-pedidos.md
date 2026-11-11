# App del vendedor › Mis pedidos

La pestaña «Pedidos» de la app de vendedores (`/vendor/mis-pedidos`): el avance de cada pedido de preventa (agendado,
lo tomó el surtidor, surtido, revisado en caja, cobrado en Kepler, entregado) y lo que cambió. Las entradas más
nuevas van arriba.

---

## Corregir y cancelar en la tarjeta, y «Más» en la barra (MCP.21, 2026-11-11)

- **Problema (auditoría, nivel C + B):** corregir costaba ~10 toques y sólo se llegaba desde Mi ruta → cliente → «Ver
  pedido pendiente» → Por entregar; cancelar pedía reabrir (un motivo) y luego cancelar (otro motivo); «Por entregar» y
  «Pedidos» eran dos listas del mismo pedido, una con las acciones y otra con el avance. En prod (30 días): 41
  correcciones, 5 cancelaciones, 0 «Aprobar» y 1 «Marcar entregado» desde «Por entregar».
- **Solución:** cada tarjeta de «Pedidos» trae «Corregir» y «Cancelar» mientras el surtidor no la toma (después ya no
  se puede, y el botón no aparece). Cancelar es directo, con un motivo. La hoja del cliente en Mi ruta abre su pedido
  aquí. «Terminar mi día» (Finalizar ruta) está aquí mientras la ruta está iniciada. En la barra, Cierre y Rutas pasan
  a «Más», junto con «Por entregar (pedidos de campo)».
- **Por qué así:** la tarjeta del pedido es donde el vendedor ya está mirando; los nombres se conservan («Mi ruta»,
  «Pedidos»). Cancelar directo sigue la regla de «Corregir» (D1) en el servidor: si no, sería la puerta trasera.
- **Las cinco preguntas:** (1) primero el pedido y su estado, luego qué puedo hacerle; (2) no van «Aprobar» ni
  «Marcar entregado» en la tarjeta (casi no se usan; siguen en «Más»); (3) botones de 44 px con texto e icono, el rojo
  de «Cancelar» a 4.83:1 (claro) y 6.40:1 (oscuro); (4) ligado al surtido (D1), al motivo obligatorio (MCP.18) y a
  la captura de pedido; (5) lo ve la vendedora; el supervisor no corrige desde «Equipo».
- **Ajuste de David (mismo día), viendo la tarjeta:** «esto me es innecesario, lo que queremos es modificar el pedido:
  quitar, poner, modificar cantidades, productos». Ahora la tarjeta abierta trae sus productos con − / + en su unidad
  y «Quitar» (con «Deshacer»), y UN «Guardar cambios» con el motivo ya sugerido por lo que cambió; el servidor reabre,
  cambia y vuelve a agendar en una transacción (`POST commercial/orders/:id/modify`): o todo o nada. «Agregar otro
  producto» guarda lo cambiado y abre la captura de ese pedido (ahí se eligen presentación y precio: no se duplica esa
  lógica). Los seis pasos pasan a una línea: lo último que pasó, con quién y a qué hora, y qué sigue.
- **Mi ruta, cada renglón dice cómo va el cliente (mismo día; David: «no veo las mejoras»):** la lista de la ruta no
  había cambiado. Medido en prod (30 días, 780 visitas): 54 % terminó con pedido, 6 % con «no pidió» y 40 % se abrió y
  nunca se cerró; y ningún cliente visitado tiene orden de visita (475 de 475), así que el círculo mostraba «·» en todos.
  Ahora dice «Pedido hoy $X», «No pidió · motivo», «Visitado, sin cerrar» o «Sin visita», con su icono (el palomeado,
  sólo con pedido). El pedido de hoy ya no se repite como «1 por entregar»: esa etiqueta cuenta sólo lo de días
  anteriores. «Preventa $X» suma sólo las preventas (antes sumaba también los pedidos del vendedor: rótulo falso).
  «Capturar exhibición» (17 usos en 30 días) baja a la fila de Llamar y WhatsApp. El servidor manda el motivo de hoy
  (`no_sale_reason_today` en `vendor-routes/home`). Lógica pura en `ruta-estado.ts`.
- **«Pedidos» más simple (mismo día; David: «esto lo quiero más simplificado»):** el recuento repetía el día (chip y
  título), la hora (encabezado y tarjeta), los clientes sin visita (ya en «Mi ruta») y el estado de cada pedido (ya en
  la lista de abajo). Ahora son tres renglones: cuánto levantó, el surtido en una línea y a quién visitó; si hay un
  borrador sin mandar, un aviso que lo abre. Todo lo demás sigue en «Ver detalle». El supervisor lo ve completo, como
  antes. «Terminar mi día» y «Llevar pedidos» quedan en una fila de dos botones.
- **No hecho:** agendar en un toque con «Deshacer» (deshacer es reabrir, y reabrir pide motivo: decisión pendiente).
- ⚠️ **Sin validación visual** todavía.

---

## Un día a la vez, con calendario (MCP.20, 2026-11-11)

- **Problema:** David, viendo `vendedor.megadulcessuite.com/vendor/mis-pedidos`: «haz un calendario para que no se vea
  tan feo, o sólo ten los del día; los pasados que se vean con un filtro, en una misma sección». Medido en prod (sólo
  lectura, control: 433 en bloque = suma por vendedor): la lista juntaba todo lo agendado de cualquier fecha; una
  vendedora tenía **145 pedidos** (72 de hace más de 7 días, el más viejo del 26-ago), otra 122. Casi ningún pedido
  llega a «entregado» (1 de 416), así que nada salía de la lista.
- **Solución:** arriba de «Pedidos», una fila de días: **Hoy · Ayer · los 5 anteriores** y **«Otro día»** (abre el
  calendario del celular). El recuento y la lista son del día elegido: los pedidos que se **levantaron** ese día (el
  mismo universo del recuento). Un día con un reporte de surtido sin ver lleva un punto (y lo dice en voz); si el
  reporte es de hace más de una semana, sale un aviso con la liga a ese día.
- **Implementada:** `GET vendor/presale-status?date=YYYY-MM-DD` (sin `date`, como antes: las apps viejas no cambian;
  día futuro o que no existe = 400) con `unseen_days`; `POST vendor/presale-status/seen { order_ids }` marca vistos
  sólo los reportes de los pedidos del día en pantalla (sin cuerpo, como antes). El «hoy» lo dice el servidor; si el
  reloj del celular va mal y nadie eligió otro día, la pantalla se mueve a ese hoy.
- **Por qué así:** el vendedor trabaja por día (92 % se entrega el mismo día) y el recuento ya era del día; ahora la
  lista habla del mismo día que el recuento. Calendario del celular y no `p-datepicker`: en la app de vendedores no
  hay ninguno y el selector nativo del teléfono es el que la gente ya sabe usar.
- **Las cinco preguntas antes de la pantalla:** (1) primero qué día estoy viendo, luego su recuento y sus pedidos;
  (2) no van rangos de fechas ni la lista de todo lo agendado; (3) celular: botones de 44 px en una fila que se
  desliza, el punto de «nuevo» también se dice en voz, el día elegido con `aria-pressed`; (4) ligado al recuento
  (`MCP.19`), a los reportes de surtido sin ver y al globito de «Pedidos»; (5) lo ve la vendedora (su supervisor
  sigue viendo el recuento en «Equipo › vendedor»).
- **Diferencia que se declara:** un pedido levantado ayer para entregar hoy sale en «Ayer», no en «Hoy».
- Base real: `test-newdb-recuento-dia.js` [7] pasa (hoy = recuento, ayer no, 400 en día futuro o inexistente, «visto» con [A]
  deja B nuevo, firma `status(date)`/`seen(body)`). ⚠️ **Sin validación visual** todavía.

---

## Recuento del día, arriba de la lista (MCP.19, 2026-11-10)

- **Problema:** al cerrar su día el vendedor no tenía dónde ver cuánto levantó, qué pasó con eso en el almacén y qué
  le quedó pendiente. «Mi día» lo intentaba y contaba mal: «Entregados» salía siempre en 0 (medía un estado al que
  llega 1 de 416 pedidos) y «Pedidos» sumaba cancelados y borradores que «Vendido» no.
- **Solución:** el recuento vive arriba de «Pedidos» y «Mi día» sale de la barra (decisión de David). Contesta, en
  este orden: lo que se quedó en el celular sin enviar; cuánto levantó y a cuántos clientes de su ruta visitó; cómo
  van al surtir (completos, con faltantes y cuánto bajó, surtiéndose, esperando, cobrados); y lo pendiente
  (borradores sin mandar, por aprobar, clientes sin visita, cancelados con su motivo). Cada número abre sus pedidos.
  Su supervisor ve el mismo recuento en «Equipo › vendedor».
- **Implementada:** `GET vendor/day-recap` (el día propio, o con `user_id` el de alguien del equipo: la regla del
  monitoreo de visitas decide, y si no es del equipo responde 403 sin leer nada más). Lo levantado = ni borrador ni
  cancelado, por día de creación; el surtido y el cobro, con el mismo armado que esta lista; las visitas, del
  monitoreo. «Llevar pedidos» y la cola del celular se mudaron aquí; `/vendor/today` redirige a «Pedidos».
- **Por qué así:** un solo lugar con los números del día (antes eran tres, y no cuadraban) y la misma respuesta para
  el vendedor y su supervisor. Se reusa todo: el armado de «Mis pedidos» y el monitoreo de visitas; no hay tabla
  ni proceso al cierre.
- **Las cinco preguntas antes de la pantalla:** (1) primero lo que no se envió (urgente), luego cuánto levantó,
  cómo va eso y lo que falta; (2) no van gráficas, metas ni el detalle del pedido (ya está en la lista); (3) es un
  celular en la calle: toques de 44 px, números en fuente fija, nada sólo por color (texto e icono), estados con
  `aria-expanded`; (4) ligado al surtido, la revisión en caja, el cobro de Kepler, las visitas, la cola del
  celular y «Llevar pedidos»; (5) lo ven el vendedor y su supervisor; lo que está en el celular sólo el vendedor.
- **Diferencias que se declaran:** «Finalizar ruta» cuenta sólo lo mandado dentro de la ruta (en prod, 19 de 386
  pedidos se mandaron fuera); el monitoreo cuenta «con pedido» a un cliente cuyo único pedido se canceló.
- ⚠️ **Sin validación visual** todavía.

---

## Cotizaciones, en su propia pestaña (MCP.16, 2026-11-10)

- **Problema:** se cotizaba «una caja» como si fuera pedido; el surtidor la separaba y al final el cliente compraba
  paquetes y la caja quedaba abierta. Cotizar existía (MCP.12) pero escondido en un botón de Tomar pedido.
- **Solución:** «Pedidos | Cotizaciones». Mis cotizaciones de la app, por vigencia, y «Nueva cotización» desde aquí.
  Una cotización no aparta mercancía ni llega al surtidor.
- **Implementada:** sólo pantalla; el servidor de cotizaciones ya listaba «mías» (`mine=true`, `origin=route_visit`).
- ⚠️ **Bloqueo medido en prod:** `vendedor_ruta` y `promotor_ruta` no tienen `COMMERCIAL_QUOTES_VER` ni `_GESTIONAR`
  (sólo 3 de 19 vendedores pueden cotizar), y a 12 de 19 les falta la sucursal en su ficha. Hasta que Edgar o el PM
  repartan el permiso, la pestaña les dice «no tienes permiso» o «no tienes sucursal»; no se entrega antes (regla 20).
- **Por qué pestaña y no ícono:** un supervisor ya tiene 7 íconos en la barra; decisión de David.
- **Y a la mano en todas las pantallas:** botón «Cotizar» en el encabezado, junto al checador de precios (David: «disponible y
  a la mano 24/7»). Abre bajo el encabezado el elegir cliente y «Ver mis cotizaciones». Sólo lo ve quien tiene permiso de
  cotizar; si se reparte el permiso, aparece al volver a entrar a la app.

---
## En orden de captura y con lo que pediste contra lo que surtieron (MCP.15, 2026-11-10)

- **Problema:** la operación de rutas vecinales pidió «mostrar los reportes en orden de pedidos capturados y pedidos
  surtidos, y al seleccionar al cliente mostrar qué artículos pidió y qué surtieron». La lista no seguía el orden de
  captura y, al abrir un pedido, sólo se veía lo que CAMBIÓ: para comprobar un pedido completo no había dónde.
- **Solución:** la lista va por día de entrega y folio (el orden en que se capturaron), con un filtro «Todos · Por
  surtir · Surtidos» que dice cuántos hay de cada uno. Al abrir un pedido aparece la tabla «Lo que pediste y lo que
  surtieron» con todos los artículos; lo que no llegó como se pidió va resaltado, y si la caja lo cambió o el surtidor
  lo puso en lugar de otro, se dice en el renglón.
- **Cómo:** sólo en la app. Si el pedido ya se revisó en caja, los números salen de la revisión; si no, de las líneas
  del pedido (el mismo endpoint que usa Tomar pedido) y del reporte del surtido. Lo que todavía no se surte dice
  «pendiente», nunca 0. Si las líneas no se pudieron leer, lo dice y deja reintentar.
- **Por qué:** el vendedor tiene que poder contestarle al cliente qué le llega y qué no, sin preguntarle al surtidor.

### ¿Cuándo está «100 % terminado» un pedido? (punto 5 de la misma solicitud)

El último paso es **Entregado**, y lo marca el repartidor en *Llevar pedidos* cuando entrega un pedido de una guía de
carga impresa; ese mismo paso liga el ticket de Kepler (*Cobrado*). Medido el 2026-11-10 (14 días de vecinal): 291
pedidos surtidos, 269 revisados en caja, **1** en guía de carga y **1** entregado. En vecinal casi no se usa la guía,
por eso los pedidos se quedan en «Revisado en caja» o «Cobrado». Queda por decidir si vecinal usa la guía y la entrega,
o si su final es otro.
