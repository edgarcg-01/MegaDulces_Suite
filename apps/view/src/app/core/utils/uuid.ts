/**
 * `[CGP-V.10]` UUID v4 que no depende de un contexto seguro.
 *
 * `crypto.randomUUID` sólo existe en HTTPS o en localhost. Las sucursales abren la Suite por
 * `http://` en la LAN, donde es `undefined`, y una llave de idempotencia armada con él revienta
 * antes de que salga la petición. `getRandomValues` sí existe fuera de contexto seguro: es el
 * respaldo, y `Math.random` sólo queda para un entorno sin `crypto` (pruebas, un navegador muy viejo).
 *
 * ⚠️ Antes había dos copias de este respaldo (`nuevoUuid` en Caja General, `nuevaLlave` en andén) y
 * una ausencia (`confirmarLote`, que llamaba `randomUUID` directo). Código nuevo usa ésta.
 */
export function uuidV4(): string {
  const c = (globalThis as { crypto?: Partial<Crypto> }).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;   // versión 4
  b[8] = (b[8] & 0x3f) | 0x80;   // variante RFC 4122
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
