# App del vendedor › Mis pedidos

La pestaña «Pedidos» de la app de vendedores (`/vendor/mis-pedidos`): el avance de cada pedido de preventa (agendado,
lo tomó el surtidor, surtido, revisado en caja, cobrado en Kepler, entregado) y lo que cambió. Las entradas más
nuevas van arriba.

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
