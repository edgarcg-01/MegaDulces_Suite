/**
 * `[PGP.147]` **La factura ya debe menos de lo que el pago le lleva.** El caso que lo pidió (Edgar, 2026-11-18):
 * Mondelez, factura 20-1-0010007 de la 00, programada el 26-oct para pagarse el 13-nov por $469,071.93. El 12-nov
 * Kepler le aplicó dos notas de crédito (55-0001512 por $120,000 y 55-0001513 por $2,142.69) y su saldo bajó a
 * $346,929.24. El pago siguió en $469,071.93 y así salió del banco el 13-nov: **$122,142.69 de más**.
 *
 * El importe de un pago se fija al armarlo y nada lo volvía a comparar con lo que la factura debe. Aquí se compara,
 * al leer, cada factura de un pago PENDIENTE contra su saldo de hoy en Kepler (`v_supplier_payables.pendiente`, que
 * ya llega en la misma consulta de su etiqueta), y se dice qué documentos de Kepler lo bajaron.
 *
 * Medido en prod el 2026-11-18 (sólo lectura): además de Mondelez, 3 pagos pendientes llevaban $78,047 de más por
 * notas que Kepler ya había aplicado (CD015 en diciembre, CE012 del 17-nov); y 4 ya pagados del Calendario llevaban
 * $161,744 sobre lo que se debía (lo que de verdad salió de esos 4 no está MEDIDO: pudo pagarlos Tesorería por el neto).
 *
 * ⛔ La factura saldada por completo no entra aquí: ésa ya la dice `[PGP.35]` (`kepler_saldada`).
 * Sólo lee: no cambia el importe del pago (eso es `[PGP.148]`, con su decisión).
 */
import type { AbonoQueBajoElSaldo, DebeMenosDelPago } from '@megadulces/contracts';

/** Pesos de tolerancia: redondeos de Kepler. */
export const TOLERANCIA_DEBE_MENOS = 1;

/** Lo que la regla lee de una factura del pago. */
export interface FacturaParaDebeMenos {
  id: string;
  applied_amount: number;
  /** Saldo de hoy en Kepler; null = no es factura de Kepler o no se midió. */
  kepler_debe: number | null;
  kepler_saldada: boolean;
  /** `oblig:sucursal|tipo|sub|folio`, la llave natural de la factura (`[PGP.58]`). */
  entity_ref: string | null;
  /** El acreedor en Kepler (`[PGP.120]`). */
  payee_code: string | null;
  /**
   * `[PGP.190]` La factura también está en otro pago vivo ANTERIOR (se partió en transferencias): su `kepler_debe` ya es
   * lo que le toca a este renglón, y en cero quiere decir «las otras transferencias ya cubren lo que se debe».
   */
  partida?: boolean;
}

/** La factura en Kepler, para buscar quién le bajó el saldo. */
export interface CargoKepler {
  llave: string;
  sucursal: string;
  acreedor: string;
  tipo: number;
  sub: number;
  folio: string;
}

/** `oblig:00|20|1|0010007` + acreedor → la llave del cargo en `kdxf`. Null si no se puede leer. */
export function cargoDeLaFactura(f: Pick<FacturaParaDebeMenos, 'entity_ref' | 'payee_code'>): CargoKepler | null {
  const m = /^oblig:([^|]+)\|(\d+)\|(\d+)\|(.+)$/.exec(f.entity_ref ?? '');
  const acreedor = (f.payee_code ?? '').trim();
  if (!m || !acreedor) return null;
  const folio = m[4].trim();
  return { llave: `${m[1]}|${Number(m[2])}|${Number(m[3])}|${folio}`, sucursal: m[1], acreedor, tipo: Number(m[2]), sub: Number(m[3]), folio };
}

/** Las facturas de un pago que hoy deben menos de lo que el pago les lleva (sin las ya saldadas). */
export function facturasQueDebenMenos<T extends FacturaParaDebeMenos>(items: readonly T[]): T[] {
  // `[PGP.190]` En cero, una factura partida sí lleva de más (la cubren las otras transferencias); una sin partir en
  // cero es la saldada, que dice `[PGP.35]`.
  return items.filter((it) => !it.kepler_saldada && it.kepler_debe !== null && (it.kepler_debe > 0.005 || it.partida === true)
    && it.applied_amount > it.kepler_debe + TOLERANCIA_DEBE_MENOS);
}

/**
 * `[PGP.190]` **Una factura partida entre varios pagos vivos no puede llevar, sumada, más de lo que debe.** Antes cada
 * pago se comparaba contra el saldo COMPLETO de la factura: partida en $1,000,000 + $150,000 y con una nota de $100,000,
 * ninguna parte pasaba del saldo nuevo ($1,050,000) y juntas sí — se pagaba de más sin aviso. Ahora cada renglón ve el
 * saldo menos lo que cubren los renglones vivos ANTERIORES de la misma factura (por día, alta e id): la última
 * transferencia, la del resto, absorbe primero la nota. Medido el 2026-11-20: ninguna factura estaba en dos pagos
 * pendientes, así que esto no cambia ningún número de hoy.
 */
export interface RenglonVivoDeLaFactura {
  item_id: string;
  obligation_id: string;
  /** Neto + descuento al pagar (lo que el renglón cubre de la factura, como `SQL_CUBIERTO`). */
  cubierto: number;
}

/**
 * Lo que cubren los renglones vivos anteriores, por renglón. `filas` viene en el orden de `SQL_RENGLONES_VIVOS_DE_LAS_FACTURAS`.
 */
export function cubiertoAntesPorRenglon(filas: readonly RenglonVivoDeLaFactura[]): Map<string, number> {
  const acumulado = new Map<string, number>();
  const antes = new Map<string, number>();
  for (const f of filas) {
    const a = acumulado.get(f.obligation_id) ?? 0;
    antes.set(f.item_id, Math.round(a * 100) / 100);
    acumulado.set(f.obligation_id, a + Number(f.cubierto));
  }
  return antes;
}

/** Lo que la factura debe para ESTE renglón: su saldo menos lo que ya cubren los anteriores (nunca negativo). */
export function debeParaEsteRenglon(debe: number | null, antes: number): number | null {
  if (debe === null) return null;
  return Math.round(Math.max(0, debe - antes) * 100) / 100;
}

/** Parámetros: `[tenant_id, obligation_ids (uuid[])]`. Los renglones de facturas de Kepler en pagos PENDIENTES, en orden. */
export const SQL_RENGLONES_VIVOS_DE_LAS_FACTURAS = `
SELECT i.id::text AS item_id, i.obligation_id::text AS obligation_id, (i.applied_amount + i.discount_amount)::float8 AS cubierto
  FROM finance.payment_allocation_items i
  JOIN finance.payment_allocations a ON a.id = i.allocation_id
  JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
 WHERE i.tenant_id = ? AND a.status = 'pending' AND i.obligation_source = 'kepler_payable' AND i.obligation_id = ANY(?::uuid[])
 ORDER BY i.obligation_id, l.lot_date, a.created_at, a.id, i.id`;

/** `[PGP.190]` La parte que las otras transferencias ya cubren no baja a cero (un renglón paga algo): se quita del pago. */
export const MOTIVO_CUBIERTA_POR_OTRA_PARTE = 'las otras transferencias de esta factura ya cubren lo que debe hoy: quítala de este pago';

const CLASE: Record<number, string> = {
  25: 'Cheque', 26: 'Transferencia', 60: 'Anticipo', 55: 'Nota de crédito', 56: 'Nota de crédito CFDI',
  40: 'Devolución de compra', 45: 'Bonificación', 50: 'Ajuste de abono', 30: 'Salida por devolución', 35: 'Aplica devolución',
};
export const claseDeAbono = (tipo: number): string => CLASE[tipo] ?? `Abono tipo ${tipo}`;

/**
 * Arma lo que se dice del pago: cuánto lleva de más y, por factura, qué abonos de Kepler explican el saldo.
 * `abonos` viene por llave de cargo, el más nuevo primero. Null si ninguna factura debe menos.
 */
export function debeMenosDelPago(items: readonly FacturaParaDebeMenos[], abonos: ReadonlyMap<string, AbonoQueBajoElSaldo[]>): DebeMenosDelPago | null {
  const malas = facturasQueDebenMenos(items);
  if (!malas.length) return null;
  const facturas = malas.map((it) => {
    const c = cargoDeLaFactura(it);
    const debe = it.kepler_debe as number;
    return {
      item_id: it.id,
      factura: c ? `${c.tipo}-${c.sub}-${c.folio}` : (it.entity_ref ?? '—'),
      programado: it.applied_amount,
      debe,
      de_mas: Math.round((it.applied_amount - debe) * 100) / 100,
      abonos: c ? abonos.get(c.llave) ?? [] : [],
    };
  });
  return { de_mas: Math.round(facturas.reduce((s, f) => s + f.de_mas, 0) * 100) / 100, facturas };
}

/**
 * Los abonos VIVOS que Kepler aplicó a esas facturas (pagos, notas, devoluciones, anticipos), por llave de cargo.
 * Parámetros: `[sucursales, acreedores, tipos, subs, folios]`, arreglos paralelos.
 */
export const SQL_ABONOS_DE_LAS_FACTURAS = `
SELECT k.suc || '|' || k.tipo || '|' || k.sub || '|' || k.folio AS llave,
       x.c4::int AS tipo, btrim(x.c6) AS folio, to_char(min(x.c3), 'YYYY-MM-DD') AS fecha, sum(x.c10)::float8 AS monto
  FROM unnest(?::text[], ?::text[], ?::int[], ?::int[], ?::text[]) AS k(suc, acr, tipo, sub, folio)
  JOIN kepler_ods.kdxf x ON x.sucursal = k.suc AND btrim(x.c1) = x.sucursal AND btrim(x.c2) = k.acr
                        AND x.c7 = k.tipo AND x.c8 = k.sub AND btrim(x.c9) = k.folio
  LEFT JOIN kepler_ods.kdm1 m ON m.sucursal = x.sucursal AND m.c1 = x.c1 AND m.c2 = 'X' AND m.c3 = 'D'
                             AND m.c4 = x.c4 AND m.c5 = x.c5 AND m.c6 = x.c6
 WHERE coalesce(m.c43, '') <> 'C'
 GROUP BY 1, 2, 3
 ORDER BY 1, 4 DESC`;

// ── [PGP.148] Ajustar el pago al saldo de Kepler ───────────────────────────────────────────────────────────────
/**
 * `[PGP.148]` **Bajar el pago a lo que la factura debe hoy.** D19 firmada (b) por Edgar el 2026-11-18: el pago SIN
 * autorizar se ajusta solo; en el autorizado sólo se avisa (Tesorería pudo haber cargado ya la transferencia). Nunca
 * sube. Lo hace una persona con un clic (`POST allocations/:id/ajustar-al-saldo`) o el worker con cada aviso de Kepler.
 */
export const EVENTO_AJUSTADO_AL_SALDO = 'ajustado_al_saldo';
export const AUTOR_AJUSTE_AL_SALDO = 'sistema:ajuste-al-saldo';

/**
 * Quién pide el ajuste: una persona con «Bajar a $X» (`manual`), el worker con cada aviso de Kepler (`automatico`) o
 * `[PGP.184]` el pago que nace al reprogramar (`reprogramar`). Los dos últimos sólo ajustan lo que `seAjustaSolo` permite.
 */
export type ModoAjusteAlSaldo = 'manual' | 'automatico' | 'reprogramar';

/**
 * `[PGP.184]` Por qué el pago que nace al reprogramar NO baja solo aunque lleve de más (D19 b, igual que el worker): se
 * dice en el aviso de «Movido» para que quien lo movió lo baje con «Bajar a» si procede.
 * · A hoy o a un día pasado: pudo ya salir del banco por su importe esta mañana y la descarga todavía no lo trae;
 *   bajarlo dejaría esa salida sin un pago que case con ella (`[PGP.121]` casa por importe ±$1) y el pago, «sin pagar».
 * · Venía autorizado: Tesorería pudo haber cargado ya la transferencia en el portal.
 */
export const MOTIVO_NO_AJUSTA_HOY_O_PASADO = 'va a hoy o a un día pasado y pudo ya salir del banco por su importe: si no ha salido, usa «Bajar a» en su renglón';
export const MOTIVO_NO_AJUSTA_AUTORIZADO = 'venía autorizado y Tesorería pudo haber cargado ya la transferencia: si no, usa «Bajar a» en su renglón';

/** `[PGP.184]` Lo que pide quien reprograma: desde qué día mirar el banco y, si no debe bajarse solo, por qué. */
export interface OpcionesAjusteAlSaldo {
  /** El banco se mira desde 3 días antes de este día (el más temprano entre el día original y el nuevo). */
  diaBancoDesde?: string;
  /** Si viene, no se escribe nada: cada factura que lleva de más sale en `omitidas` con este motivo. */
  soloAvisar?: string;
}

/** Abonos que son DINERO: cheque (25), transferencia (26), anticipo (60). */
export const TIPOS_ABONO_DINERO: ReadonlySet<number> = new Set([25, 26, 60]);

/** `55-0001512` → 55. El folio del abono lo arma `debeMenosDelPago` como `${tipo}-${folio}`. */
export const tipoDeAbono = (doc: string): number => Number(String(doc).split('-')[0]);

/**
 * ¿El worker lo ajusta SOLO? Sólo si (1) entre lo que bajó el saldo hay alguna nota, devolución, bonificación o ajuste
 * —no paga nada— y (2) desde que se armó el pago (`armadoEl`, AAAA-MM-DD) no entró DINERO a la factura (cheque,
 * transferencia, anticipo): ése puede ser ESTE mismo pago capturado a mano en Kepler, y ahí lo decide una persona.
 * Un abono sin fecha no se puede ubicar: cuenta como dinero. ⭐ La nota puede ser ANTERIOR a armarlo: medido en prod
 * el 2026-11-18, un pago reprogramado nace con el importe viejo (el de `d0bc010a`, $1.22 M, dos notas del 10-nov).
 * Bajar a lo que Kepler debe nunca paga de más; lo que se protege es no esconder un pago ya hecho.
 */
export function seAjustaSolo(abonos: readonly AbonoQueBajoElSaldo[], armadoEl: string): boolean {
  const dinero = (a: AbonoQueBajoElSaldo) => TIPOS_ABONO_DINERO.has(tipoDeAbono(a.doc));
  const dineroDespues = abonos.some((a) => !a.fecha || (a.fecha >= armadoEl && dinero(a)));
  return !dineroDespues && abonos.some((a) => !dinero(a));
}

/**
 * ¿Ya salió del banco un importe igual al del pago (±$1) desde 3 días antes de su día hasta hoy, en el libro o en la
 * descarga? Si sí, el pago NO se ajusta: lo que salió, salió, y bajarlo dejaría a la salida sin su pago (el banco ya
 * no casaría por importe). Mismo criterio que `[PGP.149]`: el ruido sólo conserva. Parámetros:
 * `[tenant, monto, día, hoy, tenant, monto, día, hoy]`.
 */
export const SQL_YA_SALIO_DEL_BANCO = `
SELECT EXISTS (
         SELECT 1 FROM finance.bank_movements b
          WHERE b.tenant_id = ? AND b.deleted_at IS NULL AND abs(coalesce(b.amount_out, 0) - ?::numeric) < 1
            AND b.movement_date BETWEEN ?::date - 3 AND ?::date
       ) OR EXISTS (
         SELECT 1 FROM finance.bank_statement_lines s
           JOIN finance.bank_accounts ba ON ba.id = s.bank_account_id AND ba.kind = 'bank'
          WHERE s.tenant_id = ? AND abs(coalesce(s.amount_out, 0) - ?::numeric) < 1
            AND s.movement_date BETWEEN ?::date - 3 AND ?::date
       ) AS salio`;

/**
 * `[PGP.184]` **El día en que se armó el pago ORIGINAL**, siguiendo la cadena de reprogramaciones (`reprogrammed_from_id`)
 * hasta el primero. Reprogramar no arma un pago nuevo: es el mismo pago en otro día, así que «desde que se armó» (la
 * regla de `seAjustaSolo`) cuenta desde el original. Con la fecha del reprogramado, una transferencia capturada en Kepler
 * entre armarlo y moverlo —que puede ser ESTE pago— quedaba «antes de armarlo» y el pago se ajustaba solo, escondiéndola.
 * Parámetros: `[allocation_id]`. Devuelve `armado` (AAAA-MM-DD, hora de México) o null si el pago no existe.
 */
export const SQL_ARMADO_ORIGINAL = `
WITH RECURSIVE cadena AS (
  SELECT id, reprogrammed_from_id, created_at, 0 AS paso FROM finance.payment_allocations WHERE id = ?::uuid
  UNION ALL
  SELECT p.id, p.reprogrammed_from_id, p.created_at, c.paso + 1
    FROM finance.payment_allocations p JOIN cadena c ON p.id = c.reprogrammed_from_id
   WHERE c.paso < 50
)
SELECT to_char(min(created_at) AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS armado FROM cadena`;

/**
 * Los pagos que el worker revisa: pendientes, sin autorizar, de un día POR VENIR (el de hoy o uno pasado pudo ya
 * salir del banco), en un día sin autorizar completo, con alguna factura de Kepler. Parámetros: `[tenant, hoy]`.
 */
export const SQL_CANDIDATOS_AJUSTE = `
SELECT a.id::text AS id, to_char(l.lot_date, 'YYYY-MM-DD') AS dia, a.amount_assigned::float8 AS monto,
       i.id::text AS item_id, i.obligation_id::text AS obligation_id, i.applied_amount::float8 AS applied_amount,
       coalesce(i.discount_amount, 0)::float8 AS discount_amount
  FROM finance.payment_allocations a
  JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
  JOIN finance.payment_allocation_items i ON i.allocation_id = a.id AND i.obligation_source = 'kepler_payable'
 WHERE a.tenant_id = ? AND a.status = 'pending' AND a.authorized_at IS NULL
   AND coalesce(l.status, '') NOT IN ('released', 'executing', 'closed')
   AND l.lot_date > ?::date
 ORDER BY l.lot_date, a.id`;
