/**
 * `[CB.51]` — **La identidad de un documento de Kepler dentro de la conciliación bancaria.**
 *
 * El candado anti doble-cobro de `runMatchTreasury` marca como ya usados los documentos que
 * otra corrida (de otro periodo) se quedó. Para eso necesita saber *qué documento es cuál*, y
 * ahí estaba el error: la llave era `(doc_tipo, folio)`.
 *
 * Esa llave viene del motor viejo, que leía `analytics.bank_postings` — el 102 contable, un
 * ledger CONCENTRADOR donde el folio sí es único. La bolsa de hoy es tesorería (`kdm1`), donde
 * **el folio reinicia por sucursal y por año**. Caso real medido en prod el 2026-10-14:
 *
 *   · `X-D-26 | 0000119` = comisión de **$126.68**, sucursal **08**, cuenta `4176`, 28-sep-2026
 *   · `X-D-26 | 0000119` = pago de **$2,070.00**, sucursal **00**, cuenta `0011`,  8-ene-2026
 *
 * Casado el de enero, el de septiembre llegaba marcado `used` y no tenía oportunidad de casar,
 * aunque su contraparte exacta estuviera en el estado de cuenta el mismo día. Efecto medido:
 * **1,336 documentos de jul-sep** entraban bloqueados, **331 de ellos ($4,919,101) falsos
 * demostrables**.
 *
 * Es la misma familia de trampa que `[CC.13]` ya había diagnosticado para el cruce banco↔cobro:
 * *el folio no identifica un documento por sí solo*. Allá faltaba la sucursal, en Kepler ya
 * había faltado el doctype.
 *
 * ⚠️ **La llave parcial se conserva a propósito.** Las filas escritas antes de esta entrega
 * tienen `kepler_sucursal` en NULL (medido: 0 de 20,926 la tenían). De una fila así no se puede
 * saber si reclama *este* documento o un homónimo de otra plaza, así que se bloquea —
 * conservador, porque aflojar reabre el doble-cobro que el candado existe para cerrar— y el
 * motor lo DECLARA en su resultado (`claimed_llave_parcial`) en vez de que desaparezca. El
 * residuo se vacía solo conforme cada periodo se re-concilia escribiendo la sucursal.
 *
 * Vive en su propio archivo, y no dentro del servicio, para poder MUTARLO en el candado:
 * un gate sin prueba negativa es una intención.
 */

/** Una reclamación leída de `finance.bank_recon_matches` (de OTRO periodo). */
export interface ClaimRow {
  /** `kepler_sucursal`. NULL en las filas anteriores a [CB.51]. */
  suc?: string | null;
  dt?: string | null;
  folio?: string | null;
  /** `kepler_cuenta` = la clave de banco en Kepler (`kdm1.c45`). */
  cuenta?: string | null;
}

/** El documento de la bolsa de tesorería que se quiere juzgar. */
export interface ClaimDoc {
  sucursal?: string | null;
  doc_tipo?: string | null;
  folio?: string | null;
  /** La clave de banco del documento (`clave_banco` en la vista). */
  clave?: string | null;
}

export interface ClaimIndex {
  /** Llave completa: la sucursal estaba escrita, así que identifica. */
  exacta: Set<string>;
  /** Llave degradada: la fila venía sin sucursal y no se puede desambiguar. */
  parcial: Set<string>;
}

const norm = (v: unknown): string => (v == null ? '' : String(v).trim());

/** Llave que SÍ identifica un documento de tesorería. */
export const claimKeyExacta = (suc: unknown, dt: unknown, folio: unknown, cuenta: unknown): string =>
  `${norm(suc)}|${norm(dt)}|${norm(folio)}|${norm(cuenta)}`;

/** Llave degradada, sin sucursal — la única posible sobre filas históricas. */
export const claimKeyParcial = (dt: unknown, folio: unknown, cuenta: unknown): string =>
  `${norm(dt)}|${norm(folio)}|${norm(cuenta)}`;

/** Parte las reclamaciones en las que identifican y las que no. */
export function buildClaimIndex(rows: ClaimRow[]): ClaimIndex {
  const exacta = new Set<string>(), parcial = new Set<string>();
  for (const r of rows || []) {
    if (!r) continue;
    if (norm(r.suc)) exacta.add(claimKeyExacta(r.suc, r.dt, r.folio, r.cuenta));
    else parcial.add(claimKeyParcial(r.dt, r.folio, r.cuenta));
  }
  return { exacta, parcial };
}

/**
 * ¿Este documento ya se lo quedó otra corrida?
 * Devuelve `'exacta'` (certeza: es el mismo documento), `'parcial'` (sospecha: una fila vieja
 * sin sucursal podría ser éste o un homónimo → se bloquea y se declara) o `null` (libre).
 */
export function claimVerdict(idx: ClaimIndex, doc: ClaimDoc): 'exacta' | 'parcial' | null {
  if (idx.exacta.has(claimKeyExacta(doc.sucursal, doc.doc_tipo, doc.folio, doc.clave))) return 'exacta';
  if (idx.parcial.has(claimKeyParcial(doc.doc_tipo, doc.folio, doc.clave))) return 'parcial';
  return null;
}
