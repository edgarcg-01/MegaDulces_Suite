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
 *
 * ── `[PGP.147]` Afinada: el importe solo no dice que sea copia (2026-11-18) ───────────────────────
 * Tres facturas sin pagar se quedaban bloqueadas por dos falsos positivos de la regla de arriba:
 *  - **Mismo importe, otra factura.** Un proveedor surte el MISMO pedido a varias sucursales el mismo
 *    día: tres facturas por el mismo importe exacto (una de Padre Hidalgo, una de otra sucursal y otra
 *    que Oficinas registró para una tercera). La regla 1 leía el cargo de Oficinas como «copia» de
 *    las tres. Pero la referencia lo dice: la copia de una factura de sucursal lleva la serie de esa
 *    sucursal y su número (`10-1234` en la sucursal → `10-F1234` o `10-<folio>` en Oficinas); el cargo
 *    que las bloqueaba decía `30-…` (la serie de OTRA sucursal, ver `SUCURSAL_DE_SERIE`) con OTRO número.
 *  - **Lo aplicado era de la propia sucursal.** Una factura llevaba unos pesos aplicados de un pago de
 *    la misma sucursal (el sobrante de un pago que cubrió otras). La regla 3 bloqueaba por cualquier
 *    cosa aplicada; lo que delata que Oficinas la pagó es la NOTA del corte, no un pago de la sucursal.
 *
 * Por eso, desde `[PGP.147]`:
 *  1. Un cargo de Oficinas por el importe o por lo pendiente (±$1) es copia **salvo** que sea la factura
 *     de OTRA sucursal (`esDeOtraFactura`): referencia legible (`NN-1234` / `NN-F1234`), serie de una
 *     sucursal conocida y distinta (`SUCURSAL_DE_SERIE`), y número que no coincide —ni como terminación—
 *     con el folio ni con el número de factura. Ante cualquier duda, sigue siendo copia.
 *  2. El pago o anticipo de Oficinas se busca por el importe **o por lo pendiente** (±$1): si la
 *     sucursal pagó una parte y Oficinas el resto, el resto se ve. Lo mismo la copia (regla 1).
 *  3. Bloquea lo que se le aplicó y **no** es un pago ni un anticipo declarado de la propia sucursal
 *     (`X-D-25/26/60`): notas de crédito, devoluciones, ajustes, o sin tipo (`nota_aplicada`), con la
 *     misma llave con la que la vista calcula lo aplicado.
 *
 * Medido en prod (sólo lectura, 2026-11-18, con este módulo): **208 bloqueadas**; se soltaban **66**
 * ($1,137,347.09 pendientes) → se sueltan **73** ($1,471,894.74 pendientes). Las 7 nuevas: 5 que sólo
 * coincidían en importe con la factura de OTRA sucursal en Oficinas (dos del pedido repetido; una de otro
 * proveedor cuya copia en Oficinas quedó en $0.00, como la de sus dos hermanas ya sueltas; dos de $467 y
 * $528 contra cargos de otra sucursal de enero y mayo), la del sobrante y una con un anticipo de su
 * sucursal. **Ninguna** de las 66 se vuelve a bloquear. Control: la de $150,387.87 sigue suelta. Prueba
 * negativa: las 4 del mismo pedido que Oficinas SÍ copió (`10-F…`) las cerró la nota de su sucursal y ya
 * no deben nada. Lo que NO se agregó: (a) tomar como copia un cargo que sólo CITA el número a otro importe
 * (5 de 5 casos eran copias en $0.00 o de otro mes); (b) exigir que «la otra factura» exista en otra
 * sucursal (Oficinas registra compras que la sucursal no tiene: ver `SUCURSAL_DE_SERIE`).
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

/**
 * `[PGP.147]` Una referencia de Kepler con forma de factura de sucursal: serie de dos dígitos, guion,
 * una `F` opcional y el número (`10-1234`, `10-F1234`, `30-5678`). El número va sin ceros a la izquierda.
 * Cualquier otra forma (`SUGERIDO`, `0-F-1234`, `40-S/N`, vacía) no se lee: `null`.
 */
export function leerReferencia(ref: string | null | undefined): { serie: string; numero: string } | null {
  const m = /^(\d{2})-F?(\d+)$/i.exec((ref ?? '').trim());
  if (!m) return null;
  return { serie: m[1], numero: m[2].replace(/^0+(?=\d)/, '') };
}

/**
 * `[PGP.147]` **La serie de la referencia ES la sucursal.** Medido en prod (sólo lectura, 2026-11-18,
 * facturas de compra de ago–sep): cada sucursal captura su referencia con una serie, y Oficinas registra
 * las compras de cada sucursal con esa MISMA serie y un concepto propio por sucursal.
 *
 * | serie | sucursal | concepto en Oficinas | en la sucursal | en Oficinas |
 * |---|---|---|---:|---:|
 * | `10` | `01` | `C-002` | 292 | 156 |
 * | `40` | `03` | `C-003` | 101 |  62 |
 * | `50` | `06` | `C-020` | 121 |  80 |
 * | `32` | `07` | `C-011` |  42 |  97 |
 * | `30` | `08` | `C-010` | 104 | 480 |
 *
 * ⚠️ Oficinas registra compras de una sucursal que esa sucursal NO tiene (480 contra 104 en la `08`): por
 * eso no se exige que «la otra factura» exista en otra sucursal — con esa exigencia, las facturas del
 * caso que motivó `[PGP.147]` seguían bloqueadas sin razón. Una serie que no está aquí NO es de ninguna
 * sucursal conocida: ante la duda, el cargo cuenta como copia.
 */
export const SUCURSAL_DE_SERIE: Readonly<Record<string, string>> = Object.freeze({
  '10': '01', '40': '03', '50': '06', '32': '07', '30': '08',
});

/** La factura de sucursal contra la que se compara un cargo de Oficinas. */
export interface FacturaDeSucursal {
  sucursal: string;
  folio: string;
  referencia?: string | null;
}

/** Dos números de factura que podrían ser el mismo: iguales, o uno es la terminación del otro (`961549` / `1549`). */
function mismoNumero(a: string, b: string): boolean {
  return !!a && !!b && (a === b || a.endsWith(b) || b.endsWith(a));
}

/**
 * `[PGP.147]` ¿El cargo de Oficinas es, por su referencia, la factura de OTRA sucursal? Sólo cuando su
 * referencia se lee, su serie es de una sucursal conocida (`SUCURSAL_DE_SERIE`) distinta de la de la
 * factura, y su número no coincide —ni como terminación— con el folio de la factura ni con su número de
 * factura. Ante cualquier duda (referencia ilegible, serie desconocida o de la misma sucursal, número que
 * podría ser el mismo) dice `false`: el cargo sigue contando como copia.
 */
export function esDeOtraFactura(refOficinas: string | null | undefined, f: FacturaDeSucursal): boolean {
  const o = leerReferencia(refOficinas);
  if (!o) return false;
  const deOtra = SUCURSAL_DE_SERIE[o.serie];
  const suya = (f.sucursal ?? '').trim();
  if (!deOtra || !suya || deOtra === suya) return false;
  const folio = (f.folio ?? '').trim().replace(/^0+(?=\d)/, '');
  if (mismoNumero(o.numero, folio)) return false;
  const propia = leerReferencia(f.referencia);
  if (propia && mismoNumero(o.numero, propia.numero)) return false;
  return true;
}

/**
 * `[PGP.147]` ¿Oficinas tiene copia? Hay al menos un cargo suyo por el importe o por lo pendiente (±$1)
 * que NO es la factura de otra sucursal. La consulta trae las referencias de esos cargos; esto decide.
 */
export function copiaEnOficinas(refsMismoImporte: ReadonlyArray<string | null> | null | undefined, f: FacturaDeSucursal): boolean {
  return (refsMismoImporte ?? []).some((ref) => !esDeOtraFactura(ref, f));
}

/** Lo que la consulta mide de cada factura bloqueada. */
export interface EvidenciaCorte {
  /** Oficinas tiene un cargo del mismo acreedor por el importe o lo pendiente (±$1) que no es de otra sucursal (`copiaEnOficinas`). */
  copia_en_oficinas: boolean;
  /** Oficinas tiene un pago o anticipo del mismo acreedor por el importe o por lo pendiente (±$1). */
  pago_en_oficinas: boolean;
  /** `[PGP.147]` Se le aplicó algo que NO es pago ni anticipo de su propia sucursal (nota, devolución, ajuste). */
  nota_aplicada: boolean;
  importe: number;
  pendiente: number;
}

/**
 * `[PGP.113]` La regla: se suelta sólo sin copia, sin pago de Oficinas y —desde `[PGP.147]`— sin nota
 * aplicada. Un pago de la propia sucursal ya no la bloquea: se programa lo pendiente.
 */
export function sueltaPorCorte(e: EvidenciaCorte): boolean {
  if (e.copia_en_oficinas || e.pago_en_oficinas || e.nota_aplicada) return false;
  const importe = Number(e.importe);
  const pendiente = Number(e.pendiente);
  if (!Number.isFinite(importe) || !Number.isFinite(pendiente) || importe <= 0) return false;
  return pendiente > 0.005 && pendiente <= importe + 0.005;
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
