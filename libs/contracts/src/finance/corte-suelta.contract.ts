/**
 * `[PGP.113]` **La factura de sucursal anterior al corte que Oficinas NUNCA registró se puede programar.**
 *
 * `[PGP.13]` bloquea en `/finanzas/calendario-pagos` toda factura de sucursal (no `00`) que vence antes
 * del 1-oct-2026, porque hasta esa fecha Oficinas concentraba los pagos y muchas se pagaron desde ahí sin
 * aplicarse en la sucursal: programarlas las pagaría dos veces. Pero el candado era SÓLO de fecha, y el
 * aviso «se revisan con Finanzas» no llevaba a ningún lado: no había botón ni flujo para confirmarlas.
 *
 * ── El caso que lo destapó (2026-11-10) ─────────────────────────────────────────────────────────
 * Una factura de Padre Hidalgo (`01`) por $150,387.87, vencida el 26-sep, con saldo completo en Kepler
 * (`kdxe.c20`). El mecanismo previo al corte: cada factura de la sucursal tenía una COPIA en Oficinas
 * (referencia `10-<folio>`); Oficinas pagaba su copia y la nota de crédito de corte del 30-sep cerró en
 * la sucursal las que ya se habían pagado. Ésta no tenía copia en Oficinas, la nota de corte no la tocó y
 * ningún pago al acreedor desde agosto la cubre: **es deuda viva que la pantalla no dejaba programar.**
 *
 * ── La regla (conservadora: ante la duda, se queda bloqueada) ────────────────────────────────────
 * Se suelta SÓLO si las tres se cumplen:
 *  1. Oficinas no tiene NINGÚN cargo del mismo acreedor por el mismo importe (±$1), de cualquier fecha.
 *  2. Oficinas no tiene NINGÚN pago ni anticipo (`X-D-25/26/60`) del mismo acreedor por ese importe (±$1).
 *  3. A la factura no se le ha aplicado nada (pendiente = importe).
 *
 * Medido en prod (sólo lectura, 2026-11-10): **205 bloqueadas** ($4,327,938.80) → se sueltan **67**
 * ($1,148,347.09, 24 acreedores). Control: la de $150,387.87 se suelta. Prueba negativa: las 4 facturas
 * del mismo acreedor que Oficinas SÍ pagó (cerradas por la nota de corte) se quedan bloqueadas.
 * Coincidir por importe ±$1 tiene ruido (placebo con +$100: 8 de 103), pero el ruido sólo puede
 * DEJAR bloqueada una factura, nunca soltarla.
 *
 * ⛔ Lo que esta regla NO hace: meterlas en la propuesta automática del día. Se agregan a mano, una por
 * una, y el renglón dice por qué se pudo.
 */

/** El corte: hasta aquí Oficinas concentraba los pagos de las sucursales. */
export const CORTE_OFICINAS = '2026-10-01';

/** Lo mínimo de una obligación para saber si cae en el candado de `[PGP.13]`. */
export interface ObligacionDelCorte {
  obligation_source: string;
  branch_code?: string | null;
  original_due_date?: string | null;
}

/**
 * `[PGP.13]` ¿La factura cae en el candado? Sucursal ≠ `00`, origen Kepler y vencimiento antes del corte.
 * ⚠️ Es por VENCIMIENTO (`original_due_date`), no por la fecha del documento: así se construyó el candado
 * y así lo calcula también la consulta de `[PGP.113]`, para que las dos digan lo mismo.
 */
export function anteriorAlCorte(o: ObligacionDelCorte): boolean {
  if (o.obligation_source !== 'kepler_payable') return false;
  const suc = (o.branch_code ?? '').trim();
  if (!suc || suc === '00') return false; // Oficinas no tiene el problema: es desde donde se pagaba
  const f = (o.original_due_date ?? '').slice(0, 10);
  return !!f && f < CORTE_OFICINAS;
}

/** Lo que la consulta mide de cada factura bloqueada. */
export interface EvidenciaCorte {
  /** Oficinas tiene un cargo del mismo acreedor por el mismo importe (±$1). */
  copia_en_oficinas: boolean;
  /** Oficinas tiene un pago o anticipo del mismo acreedor por el mismo importe (±$1). */
  pago_en_oficinas: boolean;
  importe: number;
  pendiente: number;
}

/** `[PGP.113]` La regla: se suelta sólo sin copia, sin pago y sin nada aplicado. */
export function sueltaPorCorte(e: EvidenciaCorte): boolean {
  if (e.copia_en_oficinas || e.pago_en_oficinas) return false;
  const importe = Number(e.importe);
  const pendiente = Number(e.pendiente);
  if (!Number.isFinite(importe) || !Number.isFinite(pendiente) || importe <= 0) return false;
  return Math.abs(importe - pendiente) <= 0.005;
}

/** `GET /payment-calendar/corte-sueltas` — una fila por factura que se soltó. */
export interface CorteSueltaRow {
  /** La llave de la obligación (`oblig:<sucursal>|<tipo>|<subtipo>|<folio>`), la misma de la lista. */
  entity_ref: string;
  sucursal: string;
  proveedor: string;
  folio: string;
  importe: number;
}

/**
 * ¿Sigue bloqueada? Cae en el candado y NO está entre las que se soltaron. Si la lista de sueltas no
 * se pudo leer, llega `null` y **todas siguen bloqueadas**: fallar cerrado, nunca abierto.
 */
export function bloqueadaPorCorte(o: ObligacionDelCorte & { entity_ref?: string | null }, sueltas: ReadonlySet<string> | null): boolean {
  if (!anteriorAlCorte(o)) return false;
  const ref = (o.entity_ref ?? '').trim();
  return !(sueltas && ref && sueltas.has(ref));
}
