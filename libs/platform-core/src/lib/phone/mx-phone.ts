/**
 * Normalización canónica de teléfonos MX (Fase FIQ.0 / ADR-036).
 *
 * Un solo formato canónico para TODO el pipeline de WhatsApp: inbound (Meta
 * entrega `521XXXXXXXXXX`, 13 díg con el '1' de móvil), outbound (Meta ESPERA
 * `52XXXXXXXXXX`, 12 díg sin el '1'), lookup de cliente (`commercial.customers.
 * whatsapp` guarda `+52...`) y dedup de casual. Sin un formato único, un cliente
 * recurrente jamás matchea y se duplica en cada pedido.
 *
 * CANÓNICO = MSISDN dígitos, `52` + 10 dígitos = `52XXXXXXXXXX` (lo que acepta
 * la API de envío de Meta). Debe coincidir EXACTAMENTE con la función SQL
 * `public.mx_normalize_phone(text)` (migración 20260727 FIQ.0) — cualquier cambio
 * acá se replica allá y viceversa. Números no-MX se devuelven como dígitos crudos
 * (sin corromper), y el caller decide.
 */

/** Normaliza a MSISDN canónico `52XXXXXXXXXX` (dígitos, sin '+'). null si vacío. */
export function normalizeMxPhone(input?: string | null): string | null {
  let d = String(input ?? '').replace(/\D/g, '');
  d = d.replace(/^00/, ''); // prefijo internacional 00
  if (!d) return null;
  if (d.length === 10) return '52' + d; // local 10 díg → +52
  if (d.length === 12 && d.startsWith('52')) return d; // ya canónico
  if (d.length === 13 && d.startsWith('521')) return '52' + d.slice(3); // 52 + 1 móvil + 10
  return d; // no-MX / desconocido: dígitos sin tocar
}

/** Forma E.164 con `+` (`+52XXXXXXXXXX`) para guardar en `customers.whatsapp`. null si vacío. */
export function toE164Mx(input?: string | null): string | null {
  const n = normalizeMxPhone(input);
  return n ? '+' + n : null;
}
