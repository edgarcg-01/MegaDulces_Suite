import type {
  CobroAsientoCajaGeneral, CobroLlegada, CobroLlegadaEstado, CobroRenglonBanco, CorteMedioCobro,
} from '@megadulces/contracts';
import { PASES_DEBILES } from '../bank/estado-de-cuenta/motor-de-categoria';

/**
 * `[CSU.26]` **Cada depósito aplicado a un corte dice dónde está**: el renglón del banco, el asiento de Caja
 * General, o por qué todavía no se puede decir. Anexo FB (`FASE_CSU_ANEXO_FACTURA_AL_BANCO_2026-11-26.md`).
 *
 * ⭐ **El testigo es la conciliación de Bancos** (`finance.bank_recon_matches`, el motor de tesorería), no un
 * pareo propio de esta pantalla. Medido el 2026-11-26 (1–25 nov, 707 cortes, $27,672,286.79 aplicados): un
 * cruce hecho a mano por importe encontraba $5.56 M más, casi todo de Santander 1604, cuyo libro en Bancos
 * termina el 10-nov porque es la única cuenta que no se ha pasado al estado de cuenta del banco. Pegarle aquí un
 * segundo buscador taparía ese hueco con otra regla (ADR-056): la pantalla dice «Bancos todavía no tiene el
 * banco de esa fecha» y el arreglo vive en Bancos (BFU).
 *
 * La clase la decide la cuenta que Kepler registró (`kdm1.c45`), con la misma clasificación de CSU.8
 * (`analytics.erp_collections.medio_cobro`):
 *  · `en_banco`          la conciliación casó el depósito con uno o más renglones del banco. Si el pase es de los
 *                        que el motor de categoría trata como débiles (`PASES_DEBILES`), el renglón va `debil`.
 *  · `en_caja_general`   el depósito a la cuenta de caja tiene su entrada en el libro de Caja General
 *                        (`cash_ledger.origen_ref = '<suc>|U-A-<tipo>|<folio>|<cuenta>'`).
 *  · `caja_sin_asiento`  cuenta de caja, sin entrada en el libro de Caja General.
 *  · `banco_sin_libro`   cuenta de banco, sin pareo, y el libro de Bancos de esa cuenta termina ANTES de la fecha
 *                        del depósito: todavía no se puede saber. ⛔ Nunca se pinta como «no llegó».
 *  · `sin_conciliar`     cuenta de banco, el libro ya cubre esa fecha y la conciliación no lo casó (o Bancos no
 *                        tiene una cuenta que concilie esa cuenta de Kepler).
 *  · `puente`            devoluciones, ajuste a saldo, traspasos: no es dinero que viaje a un banco.
 *  · `sin_cuenta`        el depósito no trae cuenta de tesorería, o la cuenta no existe en el catálogo.
 *
 * ⛔ Kepler liga el depósito al CORTE, no al ticket: esto dice dónde está el depósito, no qué ticket pagó.
 */

/** Pareo de la conciliación tal como lo escribe el motor: «U-A-5» para un `UA0501`. */
export function tipoDeConciliacion(docPrefix: string): string | null {
  const m = /^U([AD])(\d{2})(\d{2})$/.exec(String(docPrefix ?? '').trim());
  return m ? `U-${m[1]}-${Number(m[2])}` : null;
}

/** `UA0501` → `{ c4: 5, c5: 1 }`, la llave del documento en `kdm1`. */
export function llaveDeDocumento(docPrefix: string): { c4: number; c5: number } | null {
  const m = /^U[AD](\d{2})(\d{2})$/.exec(String(docPrefix ?? '').trim());
  return m ? { c4: Number(m[1]), c5: Number(m[2]) } : null;
}

/**
 * La evidencia de cada depósito. Parámetros (`parametrosLlegada`): los depósitos como cuatro listas paralelas
 * (sucursal, c4, c5, folio) —llave exacta, sin producto cartesiano—, el tenant, los folios sin repetir y el tenant
 * dos veces más.
 *  · `h`  la cabecera del depósito en kdm1, por la forma EXACTA de `ix_kdm1_abono_doc`.
 *  · `rm` los renglones del banco que la conciliación casó con el depósito.
 *  · `cg` las entradas del libro de Caja General que nacieron del depósito.
 *  · `mp` la cuenta de Bancos que concilia cada cuenta de Kepler de la sucursal: la que más pareos tiene
 *         (`bank_accounts.kepler_link` está vacío en las 20 cuentas al 2026-11-26), y hasta qué día llega su libro.
 */
export const SQL_LLEGADA = `
WITH d AS MATERIALIZED (
  SELECT DISTINCT x.sucursal, x.c4, x.c5, x.folio
    FROM unnest(?::text[], ?::int[], ?::int[], ?::text[]) AS x(sucursal, c4, c5, folio)
),
h AS MATERIALIZED (
  SELECT d.sucursal, d.c4, d.c5, d.folio, 'U-A-' || d.c4 AS tipo,
         to_char(k.c9::date, 'YYYY-MM-DD') AS fecha, round(k.c16::numeric, 2) AS total, nullif(btrim(k.c45), '') AS cuenta
    FROM d
    LEFT JOIN LATERAL (
      SELECT k.c9, k.c16, k.c45 FROM kepler_ods.kdm1 k
       WHERE k.c2 = 'U' AND k.c3 = 'A'
         AND btrim(k.sucursal) = d.sucursal AND btrim(k.c1) = d.sucursal
         AND (k.c4)::integer = d.c4 AND (k.c5)::integer = d.c5 AND btrim(k.c6) = d.folio
       ORDER BY coalesce(k.c43, '') = 'C'
       LIMIT 1
    ) k ON true
),
rk AS MATERIALIZED (
  -- UNA pasada por la conciliación, filtrada por la lista de folios. Medido en prod (2026-11-26): con el
  -- casado por (sucursal, tipo, folio) IN (SELECT … FROM h) el planner estimaba 1 depósito y recorría la
  -- tabla entera (26 MB, sin índice por documento) UNA VEZ POR DEPÓSITO: 1,298 depósitos pasaban de 90 s.
  SELECT r.kepler_sucursal AS sucursal, r.kepler_doc_tipo AS tipo, r.kepler_doc_folio AS folio, r.bank_movement_id, r.matched_by
    FROM finance.bank_recon_matches r
   WHERE r.tenant_id = ?::uuid AND r.kepler_doc_folio = ANY(?::text[]) AND r.kepler_doc_tipo LIKE 'U-A-%'
),
rm AS MATERIALIZED (
  SELECT rk.sucursal, rk.tipo, rk.folio,
         jsonb_agg(jsonb_build_object(
           'cuenta', a.alias, 'fecha', to_char(m.movement_date, 'YYYY-MM-DD'), 'monto', m.amount_in,
           'concepto', nullif(btrim(m.concept), ''), 'pareo', rk.matched_by) ORDER BY m.movement_date, m.amount_in) AS renglones
    FROM rk
    JOIN h ON h.sucursal = rk.sucursal AND h.tipo = rk.tipo AND h.folio = rk.folio
    JOIN finance.bank_movements m ON m.id = rk.bank_movement_id AND m.deleted_at IS NULL
    JOIN finance.bank_accounts a ON a.id = m.bank_account_id
   GROUP BY 1, 2, 3
),
cg AS MATERIALIZED (
  SELECT l.origen_ref,
         jsonb_agg(jsonb_build_object(
           'entrada', l.folio, 'fecha', to_char(l.fecha::date, 'YYYY-MM-DD'), 'monto', l.monto, 'estado', l.estado,
           'corte', c.folio, 'corte_estado', c.estado) ORDER BY l.folio) AS asientos
    FROM finance.cash_ledger l
    LEFT JOIN finance.cash_ledger_cuts c ON c.id = l.corte_id
   WHERE l.tenant_id = ?::uuid AND l.deleted_at IS NULL AND l.estado <> 'cancelado'  -- [CSU.31] revisión: un asiento cancelado no es testigo
     AND l.origen_ref IN (SELECT h.sucursal || '|' || h.tipo || '|' || h.folio || '|' || h.cuenta FROM h WHERE h.cuenta IS NOT NULL)
   GROUP BY 1
),
mp AS MATERIALIZED (
  SELECT DISTINCT ON (r.kepler_sucursal, r.kepler_cuenta) r.kepler_sucursal AS sucursal, r.kepler_cuenta AS cuenta, m.bank_account_id
    FROM finance.bank_recon_matches r
    JOIN finance.bank_movements m ON m.id = r.bank_movement_id AND m.deleted_at IS NULL
   WHERE r.tenant_id = ?::uuid AND r.kepler_sucursal IN (SELECT DISTINCT sucursal FROM d)
   GROUP BY 1, 2, 3
   ORDER BY 1, 2, count(*) DESC
),
lh AS MATERIALIZED (
  SELECT mp.sucursal, mp.cuenta, a.alias,
         (SELECT max(m.movement_date) FROM finance.bank_movements m
           WHERE m.bank_account_id = mp.bank_account_id AND m.deleted_at IS NULL) AS libro_hasta
    FROM mp JOIN finance.bank_accounts a ON a.id = mp.bank_account_id
)
SELECT h.sucursal, h.c4, h.c5, h.folio, h.fecha, h.total, h.cuenta,
       coalesce(rm.renglones, '[]'::jsonb) AS renglones,
       coalesce(cg.asientos, '[]'::jsonb) AS asientos,
       lh.alias AS cuenta_bancos, to_char(lh.libro_hasta, 'YYYY-MM-DD') AS libro_hasta
  FROM h
  LEFT JOIN rm ON rm.sucursal = h.sucursal AND rm.tipo = h.tipo AND rm.folio = h.folio
  LEFT JOIN cg ON cg.origen_ref = h.sucursal || '|' || h.tipo || '|' || h.folio || '|' || h.cuenta
  LEFT JOIN lh ON lh.sucursal = h.sucursal AND lh.cuenta = h.cuenta`;

/** `[CSU.29]` Los tipos públicos viven en el contrato (una sola definición); aquí se nombran como los usa el motor. */
export type LlegadaEstado = CobroLlegadaEstado;
export type RenglonDelBanco = CobroRenglonBanco;
export type AsientoDeCajaGeneral = CobroAsientoCajaGeneral;
export type LlegadaDeposito = CobroLlegada;

/** Las clases en las que el dinero está, con testigo. */
export const LLEGO: ReadonlySet<LlegadaEstado> = new Set(['en_banco', 'en_caja_general']);

/** Una fila de `SQL_LLEGADA`, con los `numeric` todavía como texto (así llegan de pg). */
export interface EvidenciaCruda {
  sucursal: string;
  c4: number;
  c5: number;
  folio: string;
  fecha: string | null;
  total: number | string | null;
  cuenta: string | null;
  renglones: Array<{ cuenta: string; fecha: string; monto: number | string; concepto: string | null; pareo: string }>;
  asientos: Array<{ entrada: string; fecha: string; monto: number | string; estado: string; corte: string | null; corte_estado: string | null }>;
  cuenta_bancos: string | null;
  libro_hasta: string | null;
}

export const llaveDeposito = (sucursal: string, c4: number, c5: number, folio: string): string => `${sucursal}|${c4}|${c5}|${folio}`;

const num = (x: number | string | null | undefined): number => Math.round(Number(x ?? 0) * 100) / 100;

/**
 * La clase de UN depósito. `medio` es la clase de su cuenta (CSU.8); `fecha` la del depósito en Kepler.
 * Sin evidencia (el depósito no está en kdm1) → `sin_cuenta`, nunca «llegó».
 */
export function clasificarLlegada(medio: CorteMedioCobro | null, ev: EvidenciaCruda | null): LlegadaDeposito {
  const renglones: RenglonDelBanco[] = (ev?.renglones ?? []).map((r) => ({
    cuenta: r.cuenta, fecha: r.fecha, monto: num(r.monto), concepto: r.concepto ?? null, pareo: r.pareo,
    debil: PASES_DEBILES.has(r.pareo),
  }));
  const caja_general: AsientoDeCajaGeneral[] = (ev?.asientos ?? []).map((a) => ({
    entrada: a.entrada, fecha: a.fecha, monto: num(a.monto), estado: a.estado, corte: a.corte ?? null, corte_estado: a.corte_estado ?? null,
  }));
  const base = {
    cuenta: ev?.cuenta ?? null, renglones, caja_general, cuenta_bancos: ev?.cuenta_bancos ?? null, libro_hasta: ev?.libro_hasta ?? null,
  };
  if (!ev) return { estado: 'sin_cuenta', ...base };
  if (medio === 'puente') return { estado: 'puente', ...base };
  if (medio === 'caja') {
    if (caja_general.length) return { estado: 'en_caja_general', ...base };
    // Un depósito a caja que la conciliación casó con el banco (pasó de caja al banco en un solo documento).
    if (renglones.length) return { estado: 'en_banco', ...base };
    return { estado: 'caja_sin_asiento', ...base };
  }
  if (renglones.length) return { estado: 'en_banco', ...base };
  if (medio !== 'banco') return { estado: 'sin_cuenta', ...base };
  // [CSU.31] revisión: el ÚLTIMO día del libro tampoco cuenta como cubierto. Medido en prod el 2026-11-27: en 7 de 16
  // cuentas ese día trae menos de la mitad de los abonos de un día hábil (el estado de cuenta se bajó a media jornada:
  // BBVA 4176, 9 contra 23.8), y el banco asienta el 99 % a más tardar al día siguiente. Un depósito de ese día todavía
  // no se puede juzgar: «por saber», no «sin conciliar» (eran 29 depósitos, $1,056,681.22, del 1 al 25-nov).
  if (base.libro_hasta && ev.fecha && base.libro_hasta <= ev.fecha) return { estado: 'banco_sin_libro', ...base };
  return { estado: 'sin_conciliar', ...base };
}

/** Los parámetros de `SQL_LLEGADA` para una lista de depósitos `{ sucursal, doc_prefix, folio }`. */
export function parametrosLlegada(
  depositos: ReadonlyArray<{ sucursal: string; doc_prefix: string; folio: string }>, tenantId: string,
): Array<string | string[] | number[]> {
  const s: string[] = [], c4: number[] = [], c5: number[] = [], f: string[] = [];
  for (const d of depositos) {
    const k = llaveDeDocumento(d.doc_prefix);
    if (!k) continue;
    s.push(d.sucursal); c4.push(k.c4); c5.push(k.c5); f.push(d.folio);
  }
  return [s, c4, c5, f, tenantId, [...new Set(f)], tenantId, tenantId];
}
