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
  /** `[BFU.7.5]` El periodo (`YYYY-MM`) de la corrida que lo casó. Sin él, la reclamación alcanza siempre. */
  period?: string | null;
}

/** El documento de la bolsa de tesorería que se quiere juzgar. */
export interface ClaimDoc {
  sucursal?: string | null;
  doc_tipo?: string | null;
  folio?: string | null;
  /** La clave de banco del documento (`clave_banco` en la vista). */
  clave?: string | null;
  /** `[BFU.7.5]` La fecha efectiva del documento. Sin ella, cualquier reclamación con su llave lo bloquea. */
  fecha?: string | Date | null;
}

/** [desde, hasta) en días desde 1970. */
type Ventana = readonly [number, number];

export interface ClaimIndex {
  /** Llave completa: la sucursal estaba escrita, así que identifica. Cada llave, con la ventana de cada corrida que la reclamó. */
  exacta: Map<string, Array<Ventana | null>>;
  /** Llave degradada: la fila venía sin sucursal y no se puede desambiguar. */
  parcial: Map<string, Array<Ventana | null>>;
}

const norm = (v: unknown): string => (v == null ? '' : String(v).trim());

/** Llave que SÍ identifica un documento de tesorería. */
export const claimKeyExacta = (suc: unknown, dt: unknown, folio: unknown, cuenta: unknown): string =>
  `${norm(suc)}|${norm(dt)}|${norm(folio)}|${norm(cuenta)}`;

/** Llave degradada, sin sucursal — la única posible sobre filas históricas. */
export const claimKeyParcial = (dt: unknown, folio: unknown, cuenta: unknown): string =>
  `${norm(dt)}|${norm(folio)}|${norm(cuenta)}`;

/**
 * `[BFU.7.5]` El alcance de una corrida: `runMatchTreasury` sólo casa documentos fechados dentro del mes ±45 días
 * (`OVERLAP_DAYS`). Medido en prod el 2026-11-23: de 50,993 pareos guardados, el 100 % cae dentro de esa ventana
 * (con y sin sucursal); ninguno fuera.
 */
export const ALCANCE_DE_UNA_CORRIDA_DIAS = 45;

/** Un día como entero (días desde 1970), para comparar fechas sin zona horaria. */
const diaDe = (v: unknown): number | null => {
  let s: string;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    s = `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  } else s = norm(v).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null;
};

/** La ventana de la corrida del periodo `YYYY-MM`: [día 1 − alcance, día 1 del mes siguiente + alcance). */
const ventanaDe = (period: unknown, alcanceDias: number): Ventana | null => {
  const m = /^(\d{4})-(\d{2})$/.exec(norm(period));
  if (!m) return null;
  const y = +m[1], mes = +m[2] - 1;
  return [Date.UTC(y, mes, 1) / 86400000 - alcanceDias, Date.UTC(y, mes + 1, 1) / 86400000 + alcanceDias];
};

const agregar = (idx: Map<string, Array<Ventana | null>>, k: string, v: Ventana | null) => {
  const a = idx.get(k); if (a) a.push(v); else idx.set(k, [v]);
};

/** Una reclamación sin periodo (o un documento sin fecha) alcanza siempre: ante la duda, se bloquea. */
const alcanza = (ventanas: ReadonlyArray<Ventana | null> | undefined, dia: number | null): boolean =>
  !!ventanas && ventanas.some((w) => w === null || dia === null || (dia >= w[0] && dia < w[1]));

/** Parte las reclamaciones en las que identifican y las que no, cada una con la ventana de su corrida. */
export function buildClaimIndex(rows: ClaimRow[], alcanceDias: number = ALCANCE_DE_UNA_CORRIDA_DIAS): ClaimIndex {
  const exacta = new Map<string, Array<Ventana | null>>(), parcial = new Map<string, Array<Ventana | null>>();
  for (const r of rows || []) {
    if (!r) continue;
    const w = ventanaDe(r.period, alcanceDias);
    if (norm(r.suc)) agregar(exacta, claimKeyExacta(r.suc, r.dt, r.folio, r.cuenta), w);
    else agregar(parcial, claimKeyParcial(r.dt, r.folio, r.cuenta), w);
  }
  return { exacta, parcial };
}

/**
 * ¿Este documento ya se lo quedó otra corrida?
 * Devuelve `'exacta'` (certeza: es el mismo documento), `'parcial'` (sospecha: una fila vieja
 * sin sucursal podría ser éste o un homónimo → se bloquea y se declara) o `null` (libre).
 *
 * `[BFU.7.5]` ⛔ **Sólo bloquea dentro del alcance de la corrida que reclamó.** Un pareo de enero no puede ser un
 * documento fechado en noviembre: esa corrida no lo veía. Sin esto, el corte del 1-oct-2026 (cada sucursal reinició
 * sus folios en 1, números que la 00 ya había usado en enero) dejaba apartados por filas viejas sin sucursal a 465
 * documentos de octubre y 206 de noviembre — los cheques de nómina entre ellos.
 */
export function claimVerdict(idx: ClaimIndex, doc: ClaimDoc): 'exacta' | 'parcial' | null {
  const dia = diaDe(doc.fecha);
  if (alcanza(idx.exacta.get(claimKeyExacta(doc.sucursal, doc.doc_tipo, doc.folio, doc.clave)), dia)) return 'exacta';
  if (alcanza(idx.parcial.get(claimKeyParcial(doc.doc_tipo, doc.folio, doc.clave)), dia)) return 'parcial';
  return null;
}

/** El documento tiene un homónimo reclamado por otra corrida, pero FUERA de su alcance: se libera y se declara. */
export function claimFueraDeAlcance(idx: ClaimIndex, doc: ClaimDoc): boolean {
  if (claimVerdict(idx, doc)) return false;
  return idx.exacta.has(claimKeyExacta(doc.sucursal, doc.doc_tipo, doc.folio, doc.clave))
    || idx.parcial.has(claimKeyParcial(doc.doc_tipo, doc.folio, doc.clave));
}
