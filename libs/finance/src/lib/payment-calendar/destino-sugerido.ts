import { clabeValida } from '@megadulces/contracts/finance/clabe';

/**
 * `[PGP.75]` — **La CLABE destino de un proveedor, sacada de sus propios comprobantes de pago.**
 *
 * El catálogo de cuentas de proveedor (`commercial.supplier_payment_accounts`) está vacío (medido
 * el 2026-11-04: 0 filas) y Kepler no guarda CLABEs de proveedor en ninguna tabla replicada. Pero
 * los comprobantes de transferencia que ya se suben y se leen con OCR
 * (`finance.supplier_payment_proofs.ocr_cuenta_dest`) sí la traen, y cada uno está ligado al pago de
 * Kepler que lo originó (sucursal, folio, prefijo), o sea a su acreedor. Medido ese día:
 *
 * - 1,350 comprobantes, 845 con una CLABE de 18 dígitos, de **140 acreedores**;
 * - **126 de los 140 tienen UNA sola CLABE** en todos sus comprobantes, 13 tienen dos y 1 tiene cuatro;
 * - de paso, los últimos dígitos de esa CLABE son los que Kepler guarda en `kdm1.c86` en 746 de 815
 *   pagos: la fuente es la misma que usa quien captura.
 *
 * ⛔ Sólo se propone cuando la CLABE es **única** y su dígito de control cuadra: dos CLABEs para el
 * mismo proveedor es una decisión de persona, no del sistema (¿cambió de banco? ¿paga a una
 * filial?). Lo que no se propone se DICE (`varias`), no se calla.
 */
export interface FilaComprobanteClabe {
  proveedor_code: string;
  clabe: string;
  comprobantes: number;
  ultima: string | null;
  banco: string | null;
}

export interface DestinoSugerido {
  clabe_estado: 'unica' | 'varias';
  /** La CLABE a proponer; `null` cuando son varias. */
  clabe_sugerida: string | null;
  /** El banco como lo leyó el OCR del comprobante (texto, no resolución del código). */
  clabe_banco: string | null;
  /** En cuántos comprobantes aparece la propuesta (o, si son varias, cuántos suman). */
  clabe_comprobantes: number;
  clabe_ultima_vez: string | null;
  /** Cuántas CLABEs distintas y válidas aparecieron. */
  clabes_distintas: number;
}

/** Agrupa por proveedor las CLABEs de sus comprobantes y decide si hay UNA que proponer. */
export function destinosSugeridos(filas: readonly FilaComprobanteClabe[]): Map<string, DestinoSugerido> {
  const por = new Map<string, FilaComprobanteClabe[]>();
  for (const f of filas) {
    const code = (f.proveedor_code ?? '').trim();
    if (!code || !clabeValida(f.clabe)) continue; // el OCR también lee mal: el dígito de control lo caza
    const l = por.get(code) ?? [];
    l.push(f);
    por.set(code, l);
  }
  const out = new Map<string, DestinoSugerido>();
  for (const [code, l] of por) {
    const distintas = new Set(l.map((f) => f.clabe));
    const total = l.reduce((s, f) => s + Number(f.comprobantes || 0), 0);
    const ultima = l.map((f) => f.ultima).filter((u): u is string => !!u).sort().pop() ?? null;
    if (distintas.size === 1) {
      out.set(code, { clabe_estado: 'unica', clabe_sugerida: l[0].clabe, clabe_banco: l[0].banco ?? null,
        clabe_comprobantes: total, clabe_ultima_vez: ultima, clabes_distintas: 1 });
    } else {
      out.set(code, { clabe_estado: 'varias', clabe_sugerida: null, clabe_banco: null,
        clabe_comprobantes: total, clabe_ultima_vez: ultima, clabes_distintas: distintas.size });
    }
  }
  return out;
}

/** El texto de destino que espera `/preparar` (el mismo formato que teclea Tesorería: «BANCO · CLABE …»). */
export function textoDeDestino(d: Pick<DestinoSugerido, 'clabe_sugerida' | 'clabe_banco'>): string | null {
  if (!d.clabe_sugerida) return null;
  const banco = (d.clabe_banco ?? '').trim();
  return banco ? `${banco} · CLABE ${d.clabe_sugerida}` : `CLABE ${d.clabe_sugerida}`;
}
