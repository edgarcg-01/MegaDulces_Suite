/**
 * `[CE.2.1]` **El vale no cierra con mercancía sin fecha** (Anexo CE, decisión D3).
 *
 * Antes sólo la pantalla del Andén lo exigía: el servidor cerraba y lo no fechado entraba al lote
 * `NA`, invisible. Así quedaron 16 de los 32 renglones de los vales cerrados en prod (2026-11-11),
 * y la estación vieja (`recepcion-sesiones`) cerraba vales enteros sin pedir una sola fecha.
 *
 * Un renglón queda **sin fecha** cuando:
 *  - recibió mercancía (`received_qty > 0`) de un producto del catálogo, y
 *  - lo declarado (capturas `accepted` o `authorized`, incluido «sin caducidad») no alcanza lo
 *    recibido, y
 *  - el catálogo NO dice que el producto no caduca (`tracks_expiry !== false`).
 *
 * Lo retenido por un rojo no cuenta aquí: el cierre ya lo bloquea antes, con su propio mensaje.
 * Pura, para probarla sin base.
 */

export interface RenglonParaFecha {
  line_id: string;
  product_id: string | null;
  sku: string | null;
  product_name: string | null;
  received_qty: number;
  /** Σ capturas `accepted` + `authorized` del renglón. */
  declared_qty: number;
  tracks_expiry: boolean | null;
}

export interface RenglonSinFecha {
  line_id: string;
  sku: string | null;
  product_name: string | null;
  received_qty: number;
  declared_qty: number;
  missing_qty: number;
}

export function renglonesSinFecha(renglones: RenglonParaFecha[]): RenglonSinFecha[] {
  const out: RenglonSinFecha[] = [];
  for (const r of renglones) {
    if (!r.product_id) continue; // sin catálogo no entra a inventario: lo avisa el cierre aparte
    if (r.tracks_expiry === false) continue;
    const recibido = Number(r.received_qty) || 0;
    const declarado = Number(r.declared_qty) || 0;
    if (recibido <= 0 || declarado >= recibido) continue;
    out.push({
      line_id: r.line_id,
      sku: r.sku,
      product_name: r.product_name,
      received_qty: recibido,
      declared_qty: declarado,
      missing_qty: recibido - declarado,
    });
  }
  return out;
}

/** El motivo para cerrar con fecha pendiente: texto real, no un espacio. */
export function motivoValido(motivo: unknown): string | null {
  const m = typeof motivo === 'string' ? motivo.trim() : '';
  return m.length >= 5 ? m.slice(0, 500) : null;
}
