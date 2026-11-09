/**
 * `[PGP.97]` La lectura de la guía «pagado en el banco, falta en Kepler».
 *
 * Vive aparte del servicio por lo mismo que `cierre-kepler.sql.ts`: el texto que corre en
 * producción es el MISMO que se mide contra prod (los scripts lo importan, no lo copian).
 *
 * ⛔ **Cero importers, cero tablas nuevas** (regla 1). Todo se deriva al momento de lo que ya existe:
 * - el workbook de bancos: `finance.bank_movements` (lo sube Tesorería);
 * - el lado Kepler: `analytics.kepler_bank_movements`, la MISMA vista que usa la conciliación, con
 *   su puente cuenta del banco ↔ cuenta de tesorería (`account_label`). Medido el 2026-11-07:
 *   octubre da 574 pagos de compra por $49,158,235.95, igual al centavo que leer `kdxe` directo, y
 *   0 cancelados (el trigger que llena `bank_movement_legs` ya los deja fuera). 47 ms el mes;
 * - qué facturas saldó cada pago: `kdxf`, por la llave de origen que guarda `bank_movement_legs`;
 * - el programa: `finance.payment_allocations` y sus renglones (directos de Kepler o por la
 *   obligación capturada, `commercial.supplier_payment_obligations.kepler_*`);
 * - a quién se le pagó, cuando Kepler todavía no lo dice: los cruces que el motor de conciliación
 *   ya hizo en 180 días (sin los que hizo por nombre, para no dar vueltas en círculo), el catálogo
 *   `kdxd` y la deuda viva `analytics.v_supplier_payables`.
 *
 * ⛔ **No se lee `bank_movements.recon_status` ni se confía en el «sin casar» del motor**: en
 * octubre dejaba 7 de 12 salidas de compra «sin casar» que sí tenían su pago (una llave parcial de
 * filas viejas bloqueaba 485 documentos). Usarlo de guía pedía capturar dos veces. Aquí se parea
 * de nuevo, contra lo que Kepler tiene hoy (`parear`, en el contrato).
 */
import type { Knex } from 'knex';
import { sqlKeplerPayableId } from '@megadulces/contracts/finance/kepler-payable-key';
import {
  armarGuia, candidatosDeNombre, normalizarConcepto, parearEntrada, salidasSinPago, sumarDias,
  type AbonoBancario, type CuentaCoberturaBanco, type EntradaGuia, type FacturaViva, type FuentesDeAtribucion,
  type GuiaFueraDePrograma, type PagoKeplerBanco, type PartidaDelPrograma, type SalidaBancaria,
} from '@megadulces/contracts';
import { frescuraCaja } from '../caja/caja-relevo';

/** Días alrededor de la ventana que se leen sólo para parear bien los bordes (la ventana del par es ±5). */
export const MARGEN_PAREO_DIAS = 5;
/** Los cruces del motor que alimentan el diccionario «concepto → acreedor». */
export const DIAS_DICCIONARIO = 180;
/** Una ventana más larga deja de ser una guía y se vuelve una auditoría: para eso está Conciliación. */
export const TOPE_VENTANA_DIAS = 92;
/** Por omisión, los últimos 30 días. */
export const VENTANA_POR_OMISION_DIAS = 30;
/** Pagos con dinero que se parean: los medidos (transferencia, cheque, anticipo). */
export const TIPOS_PAGO_BANCO = ['X-D-25', 'X-D-26', 'X-D-60'] as const;
/**
 * Pasado este tiempo sin una corrida buena del carril que trae `kdm1` (`ods_live_caja`, cierra
 * cada ~10 s), lo «sin pago en Kepler» puede ser rezago de la réplica y no un faltante: se avisa.
 */
export const KEPLER_RANCIO_MIN = 30;

const tipos = TIPOS_PAGO_BANCO.map((t) => `'${t}'`).join(', ');

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
/** La ventana pedida, ya validada. `hasta` nunca pasa de hoy: el futuro no tiene salidas. */
export function ventanaFueraDePrograma(desde: string | undefined, hasta: string | undefined, hoy: string): { desde: string; hasta: string } | { error: string } {
  const h = hasta?.trim() || hoy;
  const d = desde?.trim() || sumarDias(h > hoy ? hoy : h, -VENTANA_POR_OMISION_DIAS);
  if (!FECHA.test(d) || !FECHA.test(h) || Number.isNaN(Date.parse(d)) || Number.isNaN(Date.parse(h))) return { error: 'date_from y date_to van como AAAA-MM-DD' };
  const fin = h > hoy ? hoy : h;
  if (d > fin) return { error: 'date_from no puede ser posterior a date_to (ni a hoy)' };
  const largo = Math.round((Date.parse(fin) - Date.parse(d)) / 86_400_000);
  if (largo > TOPE_VENTANA_DIAS) return { error: `La ventana es de ${largo} días; el tope es ${TOPE_VENTANA_DIAS}` };
  return { desde: d, hasta: fin };
}

/** Los periodos (`YYYY-MM`) que toca una ventana. */
export function periodosDe(desde: string, hasta: string): string[] {
  const out: string[] = [];
  let y = Number(desde.slice(0, 4)), m = Number(desde.slice(5, 7));
  const fy = Number(hasta.slice(0, 4)), fm = Number(hasta.slice(5, 7));
  while (y < fy || (y === fy && m <= fm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// ─── Las consultas ──────────────────────────────────────────────────────────────────────────────

/**
 * Hasta dónde llega el workbook, por cuenta de banco, y si tiene estado de cuenta de algún
 * periodo de la ventana (sin estado = hueco; con estado y sin movimientos = cuenta quieta).
 * Parámetros: `[hoy, hoy, periodos (text[]), tenant]`.
 */
export const SQL_COBERTURA_CUENTAS = `
SELECT ba.id::text AS cuenta_id, coalesce(ba.alias, ba.bank || ' ' || ba.account_label) AS cuenta, ba.account_label,
       to_char(max(bm.movement_date) FILTER (WHERE bm.movement_date <= ?::date), 'YYYY-MM-DD') AS hasta,
       (count(bm.id) FILTER (WHERE bm.movement_date > ?::date))::int AS fechas_futuras,
       EXISTS (SELECT 1 FROM finance.bank_statements st WHERE st.bank_account_id = ba.id AND st.period = ANY(?::text[])) AS estado_cargado
  FROM finance.bank_accounts ba
  LEFT JOIN finance.bank_movements bm ON bm.bank_account_id = ba.id AND bm.deleted_at IS NULL
 WHERE ba.tenant_id = ? AND ba.kind = 'bank' AND ba.active
 GROUP BY ba.id, ba.alias, ba.bank, ba.account_label
 ORDER BY ba.bank, ba.account_label`;

/** Fecha imposible para su estado de cuenta: más de un mes de desvío (la regla de `[CB.46]`). */
const FECHA_INVALIDA = `CASE WHEN st.period ~ '^[0-9]{4}-[0-9]{2}$'
            THEN abs((extract(year FROM bm.movement_date)::int * 12 + extract(month FROM bm.movement_date)::int)
                   - (split_part(st.period, '-', 1)::int * 12 + split_part(st.period, '-', 2)::int)) > 1
            ELSE false END`;

/**
 * Las salidas de las cuentas de banco y sus abonos `DS` (envío devuelto). Parámetros:
 * `[tenant, desde, hasta]`. `fecha_invalida`: el año o el mes mal tecleado, no un desfase de corte.
 */
export const SQL_MOVIMIENTOS_BANCO = `
SELECT bm.id::text AS id, bm.bank_account_id::text AS cuenta_id, coalesce(ba.alias, ba.bank || ' ' || ba.account_label) AS cuenta,
       ba.account_label, to_char(bm.movement_date, 'YYYY-MM-DD') AS fecha,
       coalesce(bm.amount_out, 0)::float8 AS salida, coalesce(bm.amount_in, 0)::float8 AS entrada,
       nullif(btrim(bm.raw_type), '') AS raw_type, nullif(btrim(bm.raw_code), '') AS raw_code,
       mc.code AS categoria, bm.concept AS concepto,
       ${FECHA_INVALIDA} AS fecha_invalida
  FROM finance.bank_movements bm
  JOIN finance.bank_accounts ba ON ba.id = bm.bank_account_id AND ba.kind = 'bank'
  LEFT JOIN finance.bank_statements st ON st.id = bm.statement_id
  LEFT JOIN finance.movement_categories mc ON mc.id = bm.category_id
 WHERE bm.tenant_id = ? AND bm.deleted_at IS NULL
   AND bm.movement_date BETWEEN ?::date AND ?::date
   AND (bm.amount_out > 0 OR (bm.amount_in > 0 AND upper(btrim(coalesce(bm.raw_type, ''))) = 'DS'))`;

/**
 * Los días en que cada cuenta tiene al menos un movimiento (entrada o salida) en el workbook.
 * Un pago de Kepler en un día sin movimientos de su cuenta NO se declara «sin salida»: ese día el
 * banco no está (en jun–oct, 7 documentos por $1.5 M caían justo en el único día vacío de su
 * cuenta). Parámetros: `[tenant, desde, hasta]`.
 */
export const SQL_DIAS_CON_MOVIMIENTOS = `
SELECT DISTINCT ba.account_label || '|' || to_char(bm.movement_date, 'YYYY-MM-DD') AS dia
  FROM finance.bank_movements bm
  JOIN finance.bank_accounts ba ON ba.id = bm.bank_account_id AND ba.kind = 'bank' AND ba.account_label IS NOT NULL
  LEFT JOIN finance.bank_statements st ON st.id = bm.statement_id
 WHERE bm.tenant_id = ? AND bm.deleted_at IS NULL
   AND bm.movement_date BETWEEN ?::date AND ?::date
   AND NOT (${FECHA_INVALIDA})`;

/**
 * Los pagos con dinero de Kepler (vigentes) vistos desde tesorería, con las llaves de las
 * facturas que saldaron. Parámetros: `[tenant, desde, hasta]`.
 *
 * La factura se identifica con la llave canónica del Calendario (`sqlKeplerPayableId`) armada
 * desde `kdxf` (c7/c8/c9): medido, 8,313 de 8,313 aplicaciones dan la misma llave que la factura.
 * `kdxf.c2` es el acreedor CRUDO de `kdm1.c10` (por eso se pasa por `kdm1` y no por el código
 * recortado de la vista): con `btrim` se perdería el índice.
 */
export const SQL_PAGOS_KEPLER_BANCO = `
WITH p AS (
  SELECT v.sucursal, v.doc_tipo, v.folio, v.account_label, v.banco_nombre, v.tipo_cuenta, v.importe, v.fecha_valor, v.fecha_captura, v.entidad_code,
         l.src_sucursal, l.src_c1, l.src_c2, l.src_c3, l.src_c4, l.src_c5, l.src_c6
    FROM analytics.kepler_bank_movements v
    JOIN analytics.bank_movement_legs l
      ON l.tenant_id = v.tenant_id AND l.sucursal = v.sucursal AND l.doc_tipo = v.doc_tipo AND l.folio = v.folio AND l.pierna = v.pierna
   WHERE v.tenant_id = ? AND v.doc_tipo IN (${tipos}) AND v.signo < 0
     AND v.fecha_valor BETWEEN ?::date AND ?::date
), n AS (
  SELECT DISTINCT ON (btrim(d.c2)) btrim(d.c2) AS acreedor, nullif(btrim(d.c3), '') AS nombre
    FROM kepler_ods.kdxd d
   WHERE btrim(coalesce(d.c2, '')) <> ''
   ORDER BY btrim(d.c2), d.sucursal
)
SELECT p.sucursal || '|' || p.doc_tipo || '|' || p.folio AS id, p.sucursal, p.doc_tipo, p.folio,
       p.account_label, p.banco_nombre, p.tipo_cuenta, p.importe::float8 AS importe,
       to_char(p.fecha_valor, 'YYYY-MM-DD') AS fecha, to_char(p.fecha_captura, 'YYYY-MM-DD') AS fecha_captura,
       p.entidad_code AS acreedor, n.nombre AS acreedor_nombre,
       coalesce(f.facturas, '{}'::text[]) AS facturas
  FROM p
  LEFT JOIN n ON n.acreedor = p.entidad_code
  LEFT JOIN LATERAL (
    SELECT array_agg(DISTINCT (${sqlKeplerPayableId('k')})::text) AS facturas
      FROM kepler_ods.kdm1 m
      JOIN kepler_ods.kdxf x
        ON x.sucursal = m.sucursal AND x.c1 = m.c1 AND x.c2 = m.c10 AND x.c4 = m.c4 AND x.c5 = m.c5 AND x.c6 = m.c6
      CROSS JOIN LATERAL (SELECT x.sucursal, x.c7 AS doc_tipo, x.c8 AS doc_sub, btrim(x.c9) AS folio) k
     WHERE m.sucursal = p.src_sucursal AND m.c1 = p.src_c1 AND m.c2 = p.src_c2 AND m.c3 = p.src_c3
       AND m.c4 = p.src_c4 AND m.c5 = p.src_c5 AND m.c6 = p.src_c6
       AND x.c10 > 0
       -- Sólo los de compra: el programa y la métrica no miran el gasto, y el gasto es 4 de cada 5 pagos.
       AND p.entidad_code LIKE 'C%') f ON true`;

/**
 * Las partidas del Calendario de la ventana, y las de cualquier fecha que tengan una factura de
 * los pagos leídos (para saber si se programó otro día o se quitó). Parámetros:
 * `[tenant, desde, hasta, llaves de factura (text[])]`.
 *
 * `baja`: el día en que se canceló, de `updated_at`. Una partida cancelada ya no se puede tocar
 * (agregar, quitar, descontar, reprogramar y cancelar sólo actúan sobre `pending`), así que su
 * última modificación ES su baja. ⚠️ No hay bitácora de eventos; y un renglón QUITADO de una
 * partida se borra físicamente (`removeItem`), así que de ése no queda rastro.
 */
export const SQL_PARTIDAS_PROGRAMA = `
SELECT a.id::text AS id, a.status AS estado, to_char(l.lot_date, 'YYYY-MM-DD') AS dia,
       to_char(a.created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS alta,
       CASE WHEN a.status = 'cancelled' THEN to_char(a.updated_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') END AS baja,
       a.amount_assigned::float8 AS monto,
       coalesce(array_agg(DISTINCT k.llave) FILTER (WHERE k.llave IS NOT NULL), '{}'::text[]) AS facturas
  FROM finance.payment_allocations a
  JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
  LEFT JOIN finance.payment_allocation_items i ON i.allocation_id = a.id
  LEFT JOIN commercial.supplier_payment_obligations spo ON i.obligation_source = 'supplier_payable' AND spo.id = i.obligation_id
  LEFT JOIN LATERAL (
    SELECT CASE WHEN i.obligation_source = 'kepler_payable' THEN i.obligation_id::text
                WHEN spo.kepler_folio IS NOT NULL
                THEN md5('kepler_payable|' || spo.kepler_sucursal || '|' || spo.kepler_doc_tipo || '|' || spo.kepler_doc_sub || '|' || btrim(spo.kepler_folio))::uuid::text
           END AS llave) k ON true
 WHERE a.tenant_id = ?
   AND (l.lot_date BETWEEN ?::date AND ?::date OR k.llave = ANY(?::text[]))
 GROUP BY a.id, a.status, l.lot_date, a.created_at, a.updated_at, a.amount_assigned`;

/**
 * El diccionario «concepto del banco → acreedor», de los cruces del motor de conciliación en los
 * últimos 180 días. Sin los cruces que el motor hizo POR NOMBRE (`motor-tes-name`): si no, el
 * diccionario se confirmaría a sí mismo. Sólo los cruces con sucursal (la llave completa).
 * Medido el 2026-11-07: 705 pares, 356 conceptos, 223 acreedores. Parámetros: `[tenant, hoy]`.
 */
export const SQL_DICCIONARIO_CONCEPTOS = `
SELECT bm.concept AS concepto, l.entidad_code AS acreedor, count(*)::int AS veces
  FROM finance.bank_recon_matches r
  JOIN finance.bank_movements bm ON bm.id = r.bank_movement_id AND bm.deleted_at IS NULL AND bm.amount_out > 0
  JOIN analytics.bank_movement_legs l
    ON l.tenant_id = r.tenant_id AND l.sucursal = r.kepler_sucursal AND l.doc_tipo = r.kepler_doc_tipo AND l.folio = r.kepler_doc_folio
 WHERE r.tenant_id = ? AND r.kepler_doc_tipo IN (${tipos})
   AND coalesce(r.matched_by, '') NOT ILIKE '%name%'
   AND bm.movement_date >= ?::date - ${DIAS_DICCIONARIO}
   AND l.entidad_code IS NOT NULL AND nullif(btrim(bm.concept), '') IS NOT NULL
 GROUP BY bm.concept, l.entidad_code`;

/** Los acreedores de compra con su nombre (`kdxd`), sin los marcados «NO USAR» (códigos duplicados). */
export const SQL_CATALOGO_COMPRA = `
SELECT DISTINCT ON (btrim(d.c2)) btrim(d.c2) AS acreedor, btrim(d.c3) AS nombre
  FROM kepler_ods.kdxd d
 WHERE btrim(coalesce(d.c2, '')) LIKE 'C%' AND nullif(btrim(d.c3), '') IS NOT NULL AND btrim(d.c3) !~* 'NO USAR'
 ORDER BY btrim(d.c2), d.sucursal`;

/**
 * Facturas vivas que podrían ser las de una salida sin pago: todas las de los acreedores que el
 * nombre apunta, más las de compra cuyo pendiente es el importe de alguna salida (±1 ¢).
 * Parámetros: `[tenant, acreedores (text[]), centavos (bigint[])]`.
 */
export const SQL_FACTURAS_VIVAS = `
SELECT (${sqlKeplerPayableId('v')})::text AS id, v.proveedor AS acreedor, v.sucursal,
       v.doc_tipo::int AS doc_tipo, v.doc_sub::int AS doc_sub, v.folio,
       to_char(v.fecha, 'YYYY-MM-DD') AS fecha, v.pendiente::float8 AS pendiente
  FROM analytics.v_supplier_payables v
 WHERE v.tenant_id = ? AND v.pendiente > 0.009
   AND (v.proveedor = ANY(?::text[]) OR (v.proveedor LIKE 'C%' AND round(v.pendiente * 100)::bigint = ANY(?::bigint[])))
 ORDER BY v.proveedor, v.fecha, v.folio`;

// ─── El armado ──────────────────────────────────────────────────────────────────────────────────

interface FilaMovimiento {
  id: string; cuenta_id: string; cuenta: string; account_label: string | null; fecha: string; salida: number; entrada: number;
  raw_type: string | null; raw_code: string | null; categoria: string | null; concepto: string | null; fecha_invalida: boolean;
}
interface FilaCobertura { cuenta_id: string; cuenta: string; account_label: string | null; hasta: string | null; fechas_futuras: number; estado_cargado: boolean }

const n = (v: unknown) => Number(v ?? 0);
const fmt = (v: number) => `$${v.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (k: number, uno: string, varios: string) => `${k} ${k === 1 ? uno : varios}`;

/** Lee todo y arma la guía. Sólo lectura: no escribe nada, en ninguna tabla. */
export async function leerGuiaFueraDePrograma(trx: Knex | Knex.Transaction, tenantId: string, desde: string, hasta: string, hoy: string): Promise<GuiaFueraDePrograma> {
  const ini = sumarDias(desde, -MARGEN_PAREO_DIAS);
  const fin = sumarDias(hasta, MARGEN_PAREO_DIAS + 1);

  const cobertura = (await trx.raw(SQL_COBERTURA_CUENTAS, [hoy, hoy, periodosDe(desde, hasta), tenantId])).rows as FilaCobertura[];
  const movs = (await trx.raw(SQL_MOVIMIENTOS_BANCO, [tenantId, ini, fin])).rows as FilaMovimiento[];
  const dias = new Set(((await trx.raw(SQL_DIAS_CON_MOVIMIENTOS, [tenantId, desde, hasta])).rows as { dia: string }[]).map((r) => r.dia));
  const pagos = ((await trx.raw(SQL_PAGOS_KEPLER_BANCO, [tenantId, sumarDias(ini, -MARGEN_PAREO_DIAS), sumarDias(fin, MARGEN_PAREO_DIAS)])).rows as PagoKeplerBanco[])
    .map((p) => ({ ...p, importe: n(p.importe), facturas: p.facturas ?? [] }));
  const llaves = [...new Set(pagos.flatMap((p) => p.facturas))];
  const partidas = ((await trx.raw(SQL_PARTIDAS_PROGRAMA, [tenantId, sumarDias(desde, -10), sumarDias(hasta, 10), llaves])).rows as PartidaDelPrograma[])
    .map((p) => ({ ...p, monto: n(p.monto), facturas: p.facturas ?? [] }));
  const datosAl = await frescuraCaja(trx, tenantId);

  const salidas: SalidaBancaria[] = movs.filter((m) => n(m.salida) > 0 && !m.fecha_invalida && m.fecha <= hoy).map((m) => ({
    id: m.id, cuenta_id: m.cuenta_id, cuenta: m.cuenta, account_label: m.account_label, fecha: m.fecha, importe: n(m.salida),
    raw_type: m.raw_type, raw_code: m.raw_code, categoria: m.categoria, concepto: m.concepto,
  }));
  const abonos: AbonoBancario[] = movs.filter((m) => n(m.entrada) > 0 && !m.fecha_invalida)
    .map((m) => ({ id: m.id, cuenta_id: m.cuenta_id, fecha: m.fecha, importe: n(m.entrada), raw_type: m.raw_type }));
  const fechasInvalidas = movs.filter((m) => m.fecha_invalida && n(m.salida) > 0 && m.fecha >= desde && m.fecha <= hasta).length;

  const cubreHasta = new Map<string, string | null>();
  for (const c of cobertura) if (c.account_label) cubreHasta.set(c.account_label, c.hasta);

  const entrada: EntradaGuia = { hoy, desde, hasta, salidas, abonos, pagos, partidas, cubreHasta, diasConMovimientos: dias };
  // El pareo es lo caro: se calcula UNA vez y lo usan las dos llamadas de abajo.
  const pareo = parearEntrada(entrada);

  // A quién se le pagó: sólo si hay salidas a proveedor sin pago (lo normal es que sean pocas).
  let fuentes: FuentesDeAtribucion | null = null;
  const sinPago = salidasSinPago(entrada, pareo);
  if (sinPago.length) {
    const dic = new Map<string, Map<string, number>>();
    for (const r of (await trx.raw(SQL_DICCIONARIO_CONCEPTOS, [tenantId, hoy])).rows as { concepto: string; acreedor: string; veces: number }[]) {
      const k = normalizarConcepto(r.concepto);
      if (!k) continue;
      const m = dic.get(k) ?? new Map<string, number>();
      m.set(r.acreedor, (m.get(r.acreedor) ?? 0) + n(r.veces));
      dic.set(k, m);
    }
    const catalogo = (await trx.raw(SQL_CATALOGO_COMPRA)).rows as { acreedor: string; nombre: string }[];
    const acreedores = new Set<string>();
    for (const s of sinPago) {
      const c = candidatosDeNombre(s.concepto, { diccionario: dic, catalogo });
      for (const a of [...c.nombres, ...c.empates]) acreedores.add(a);
    }
    const centavos = [...new Set(sinPago.flatMap((s) => { const c = Math.round(s.importe * 100); return [c - 1, c, c + 1]; }))];
    const porAcreedor = new Map<string, FacturaViva[]>();
    for (const f of (await trx.raw(SQL_FACTURAS_VIVAS, [tenantId, [...acreedores], centavos])).rows as FacturaViva[]) {
      const arr = porAcreedor.get(f.acreedor) ?? [];
      arr.push({ ...f, pendiente: n(f.pendiente) });
      porAcreedor.set(f.acreedor, arr);
    }
    fuentes = { diccionario: dic, catalogo, facturasPorAcreedor: porAcreedor };
  }

  const g = armarGuia(entrada, fuentes, pareo);

  const cuentas: CuentaCoberturaBanco[] = cobertura.map((c) => ({
    cuenta_id: c.cuenta_id, cuenta: c.cuenta, account_label: c.account_label, hasta: c.hasta,
    fechas_futuras: n(c.fechas_futuras), estado_cargado: !!c.estado_cargado, cubre_ventana: !!c.hasta && c.hasta >= hasta,
  }));
  const nombreCuenta = new Map(cuentas.filter((c) => c.account_label).map((c) => [c.account_label as string, c.cuenta]));
  const noMedido: string[] = [];
  for (const c of cuentas) {
    if (c.cubre_ventana) continue;
    if (!c.estado_cargado) noMedido.push(`${c.cuenta}: no hay estado de cuenta cargado para esta ventana (el workbook llega al ${c.hasta ?? '—'}).`);
    else if (!c.hasta || c.hasta < desde) noMedido.push(`${c.cuenta}: tiene estado de cuenta, pero sin movimientos en la ventana.`);
    else noMedido.push(`${c.cuenta}: el workbook llega al ${c.hasta}; del ${sumarDias(c.hasta, 1)} al ${hasta} no se puede decir qué salió.`);
  }
  for (const c of cuentas) if (c.fechas_futuras > 0) noMedido.push(`${c.cuenta}: ${plural(c.fechas_futuras, 'movimiento', 'movimientos')} con fecha futura (año mal tecleado); no se usan.`);
  if (fechasInvalidas) noMedido.push(`${plural(fechasInvalidas, 'salida', 'salidas')} con fecha imposible para su estado de cuenta; no se usan.`);
  for (const d of g.sin_cobertura_por_dia) {
    const cuenta = (d.account_label && nombreCuenta.get(d.account_label)) || d.account_label || 'una cuenta sin puente al workbook';
    noMedido.push(`${cuenta}, ${d.fecha}: Kepler tiene ${plural(d.pagos, 'pago', 'pagos')} de compra por ${fmt(d.monto)} y ese día el workbook no tiene movimientos (o todavía no llega): no se puede decir si salieron.`);
  }
  if (g.otra_sin_contraste.pagos) {
    noMedido.push(`${plural(g.otra_sin_contraste.pagos, 'pago', 'pagos')} de compra por ${fmt(g.otra_sin_contraste.monto)} salieron en Kepler por una cuenta que no es de banco (${g.otra_sin_contraste.por_cuenta.map((c) => `${c.cuenta}: ${c.pagos}`).join(', ')}) y no casaron con ninguna salida del workbook.`);
  }
  if (g.filas.some((f) => f.programa.estado === 'no_programada')) {
    noMedido.push('Una factura que se QUITA de un pago del Calendario se borra sin dejar rastro: si después se pagó, aquí sale como «No estaba en el programa».');
  }
  const minutos = datosAl ? Math.round((Date.now() - Date.parse(datosAl)) / 60_000) : null;
  if (minutos === null) noMedido.push('No se pudo medir cuándo se leyó Kepler por última vez: lo «sin pago en Kepler» puede ser rezago de la réplica.');
  else if (minutos > KEPLER_RANCIO_MIN) noMedido.push(`Kepler se leyó por última vez hace ${minutos} min: lo capturado después no se ve todavía.`);

  return {
    desde, hasta, hoy, datos_al: datosAl, cuentas,
    filas: g.filas, kepler_sin_salida: g.kepler_sin_salida, kepler_sin_cobertura: g.kepler_sin_cobertura,
    sin_cobertura_por_dia: g.sin_cobertura_por_dia, otra_sin_contraste: g.otra_sin_contraste, kepler_fuera_sin_fila: g.kepler_fuera_sin_fila,
    metrica: g.metrica,
    fuera_del_universo: { ...g.fuera_del_universo, fechas_invalidas: fechasInvalidas },
    no_medido: noMedido,
  };
}
