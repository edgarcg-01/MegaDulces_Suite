/**
 * `[DN.8]` La versión de esta app que AGENDA, en el cuerpo de `POST commercial/orders/:id/place`
 * (`client_build`). El servidor la guarda en lo que registra para Compras
 * (`commercial.order_stock_notices.client_build`) para medir POR VERSIÓN: la PWA vieja vive en la
 * caché de los teléfonos, todavía bloquea en el teléfono los productos sin existencia y no manda esta
 * marca, así que su hueco se ve en vez de mezclarse con lo nuevo (anexo A de la fase DN, R8).
 *
 * Se cambia cuando cambia algo que importa para esa medición (la captura, el aviso o la hoja al
 * agendar). Sólo letras, dígitos y `@ . _ : -`, hasta 60 (el servidor descarta cualquier otra cosa).
 */
export const VENDOR_CLIENT_BUILD = 'vendor@2026-11-07.dn11a';
