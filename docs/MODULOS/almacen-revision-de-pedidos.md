# Almacén › Revisión de pedidos (caja)

La pantalla donde la cajera revisa cada pedido de preventa que terminó el surtidor, antes de cobrarlo
(`/almacen/pedidos/revision`, pestaña junto a «Guías de carga»). Las entradas más nuevas van arriba.

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
