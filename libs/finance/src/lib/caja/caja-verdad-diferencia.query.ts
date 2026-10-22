import type { Knex } from 'knex';
import { SUCURSAL_CAJA_GENERAL } from '@megadulces/contracts';
import type { ArqueoControlHecho, HechosVerdad, MovimientoControlHecho, TotalesLibro } from './caja-verdad-diferencia.engine';

/**
 * `[CGS.36]` Lee los hechos con que se arbitra la diferencia de varios cortes, en SEIS consultas
 * para todos (no cinco por corte: es la pantalla que la supervisora abre cada mañana).
 *
 * Testigos y de dónde salen:
 *   · arqueos y movimientos de Control → `analytics.v_caja_control_movimientos` (una sola lectura;
 *     el último conteo del día es el mismo criterio que `v_caja_control_cortes`);
 *   · la máquina → `analytics.caos_cash_movements` por `occurred_at`, entre dos arqueos de Control;
 *   · el libro de hoy → `finance.cash_ledger` por `corte_id`.
 *
 * ⛔ Un movimiento de Control «casa» con el libro si ese día hay un movimiento del libro o de la
 * máquina con el MISMO importe al centavo. Control del instrumento, medido el 2026-10-21 sobre
 * 12–21 oct: casan 20 de 59; corriendo el día ±3 y ±7 (placebo), casan **0**. No es azar.
 *
 * Tolera que Control o CAOS no existan en el entorno: sus testigos salen `sin_testigo`, no en cero.
 * ⚠️ RLS: quien llama tiene que haber fijado `app.tenant_id` en esta transacción.
 */
export async function leerHechosVerdad(
  trx: Knex.Transaction, tenantId: string, sucursal: string, cortes: Array<Record<string, unknown>>,
): Promise<Map<string, HechosVerdad>> {
  const out = new Map<string, HechosVerdad>();
  const ids = cortes.map((c) => String(c['id']));
  if (!ids.length) return out;
  const n = (v: unknown): number => (v == null ? 0 : Number(v));

  // ── 1. La cadena: el día del corte anterior y el día en que se cerró cada uno ────────────
  const cadena = (await trx.raw(`
    SELECT id, dia, cerrado_dia, dia_anterior, id_anterior FROM (
      SELECT id, to_char(fecha, 'YYYY-MM-DD') AS dia, lag(id) OVER (ORDER BY fecha, folio) AS id_anterior,
             to_char(closed_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS cerrado_dia,
             to_char(lag(fecha) OVER (ORDER BY fecha, folio), 'YYYY-MM-DD') AS dia_anterior
        FROM finance.cash_ledger_cuts
       WHERE tenant_id = ? AND sucursal = ? AND estado <> 'borrador') x
     WHERE id = ANY(?::uuid[])`, [tenantId, sucursal, ids])).rows as Array<{ id: string; dia: string; cerrado_dia: string | null; dia_anterior: string | null; id_anterior: string | null }>;
  const porId = new Map(cadena.map((r) => [r.id, r]));

  // ── 2. El libro de HOY de cada corte, y los importes de cada día para casar a Control ────
  const hoy = (await trx.raw(`
    SELECT corte_id,
           coalesce(sum(monto) FILTER (WHERE tipo = 'ingreso'), 0)::numeric AS ingresos,
           coalesce(sum(monto) FILTER (WHERE tipo = 'gasto'), 0)::numeric AS gastos,
           coalesce(sum(monto) FILTER (WHERE tipo = 'deposito'), 0)::numeric AS depositos
      FROM finance.cash_ledger
     WHERE tenant_id = ? AND corte_id = ANY(?::uuid[]) AND deleted_at IS NULL AND estado <> 'cancelado'
     GROUP BY corte_id`, [tenantId, ids])).rows as Array<{ corte_id: string; ingresos: string; gastos: string; depositos: string }>;
  const hoyDe = new Map<string, TotalesLibro>(hoy.map((r) => [r.corte_id, { ingresos: n(r.ingresos), gastos: n(r.gastos), depositos: n(r.depositos) }]));

  const dias = [...new Set(cadena.map((r) => r.dia))];
  const importes = new Map<string, Set<number>>();
  const anota = (dia: string, monto: unknown) => {
    const s = importes.get(dia) ?? new Set<number>();
    s.add(Math.round(Math.abs(Number(monto)) * 100));
    importes.set(dia, s);
  };
  const delLibro = (await trx.raw(`
    SELECT to_char(l.created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS dia_captura,
           to_char(c.fecha, 'YYYY-MM-DD') AS dia_corte, l.monto
      FROM finance.cash_ledger l
      LEFT JOIN finance.cash_ledger_cuts c ON c.id = l.corte_id AND c.tenant_id = l.tenant_id
     WHERE l.tenant_id = ? AND l.deleted_at IS NULL AND l.estado <> 'cancelado'
       AND ((l.created_at AT TIME ZONE 'America/Mexico_City')::date = ANY(?::date[]) OR l.corte_id = ANY(?::uuid[]))`,
  [tenantId, dias, ids])).rows as Array<{ dia_captura: string; dia_corte: string | null; monto: string }>;
  for (const r of delLibro) {
    anota(r.dia_captura, r.monto);
    if (r.dia_corte) anota(r.dia_corte, r.monto);
  }

  // ── 3. Control: arqueos y movimientos, una sola lectura ─────────────────────────────────
  const hayControl = sucursal === SUCURSAL_CAJA_GENERAL
    && (await trx.raw(`SELECT to_regclass('analytics.v_caja_control_movimientos') IS NOT NULL AS t`)).rows[0]?.t === true;
  type FilaControl = { folio: string; dia: string; hora: string | null; at: string; conteo: boolean; efectivo: string; tarjeta: string; cheques: string; papeles: string; nota: string | null };
  const conteos: Array<ArqueoControlHecho & { at: number }> = [];
  const movsPorDia = new Map<string, MovimientoControlHecho[]>();
  if (hayControl) {
    const desde = [...cadena.map((r) => r.dia_anterior ?? r.dia), ...dias].sort()[0];
    const hasta = [...dias].sort().reverse()[0];
    const filas = (await trx.raw(`
      SELECT folio, to_char(fecha, 'YYYY-MM-DD') AS dia, substr(hora, 1, 5) AS hora, naturaleza = 'conteo' AS conteo,
             ((fecha + coalesce(nullif(hora, '')::time, '23:59:59'::time)) AT TIME ZONE 'America/Mexico_City') AS at,
             total_efectivo AS efectivo, total_tarjeta AS tarjeta, total_cheques AS cheques, total_papeles AS papeles,
             observaciones AS nota
        FROM analytics.v_caja_control_movimientos
       WHERE NOT cancelado AND fecha BETWEEN (?::date - 10) AND ?::date
       ORDER BY fecha, hora`, [desde, hasta])).rows as FilaControl[];
    for (const f of filas) {
      if (f.conteo) {
        conteos.push({
          folio: f.folio, dia: f.dia, hora: f.hora, at: new Date(f.at).getTime(),
          efectivo: n(f.efectivo), caja_fuerte: n(f.tarjeta), documentos: n(f.cheques) + n(f.papeles),
        });
      } else {
        const l = movsPorDia.get(f.dia) ?? [];
        l.push({ folio: f.folio, hora: f.hora, monto: n(f.efectivo) + n(f.tarjeta) + n(f.cheques) + n(f.papeles), nota: f.nota });
        movsPorDia.set(f.dia, l);
      }
    }
  }
  // ── 3b. ⭐ `[CGS.44]` La Suite: el recuento de cada corte y los arqueos con caja fuerte ────
  // Control está jubilado desde el 2026-10-22 (Edgar). El testigo del conteo de un corte es el
  // RECUENTO que otra persona hizo de ese corte; Control queda para los días anteriores.
  const recuentoDe = new Map<string, ArqueoControlHecho & { at: number }>();
  const conteosCF: Array<ArqueoControlHecho & { at: number }> = [...conteos];
  const haySuite = (await trx.raw(`SELECT to_regclass('finance.cash_arqueos') IS NOT NULL AS t`)).rows[0]?.t === true;
  if (haySuite) {
    const corteIds = [...new Set([...ids, ...cadena.map((r) => r.id_anterior).filter((x): x is string => !!x)])];
    type FilaSuite = { id: string; tipo: string; corte_id: string | null; at: string; dia: string; hora: string; efectivo: string; caja_fuerte: string | null; cheques: string | null; papeles: string | null; quien: string | null };
    const filas = (await trx.raw(`
      SELECT id, tipo, corte_id, counted_at AS at, created_by_username AS quien,
             to_char(counted_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS dia,
             to_char(counted_at AT TIME ZONE 'America/Mexico_City', 'HH24:MI') AS hora,
             efectivo, caja_fuerte, cheques, papeles
        FROM finance.cash_arqueos
       WHERE tenant_id = ? AND (corte_id = ANY(?::uuid[]) OR (caja_fuerte IS NOT NULL AND counted_at >= ((?::date - 10)::timestamp AT TIME ZONE 'America/Mexico_City')))
       ORDER BY counted_at`, [tenantId, corteIds, [...dias].sort()[0]])).rows as FilaSuite[];
    for (const f of filas) {
      const a = {
        folio: `recuento ${f.id.slice(0, 8)}`, dia: f.dia, hora: f.hora, at: new Date(f.at).getTime(),
        efectivo: n(f.efectivo), caja_fuerte: f.caja_fuerte == null ? NaN : n(f.caja_fuerte),
        documentos: f.cheques == null || f.papeles == null ? NaN : n(f.cheques) + n(f.papeles),
        origen: 'suite' as const, quien: f.quien,
      };
      if (f.tipo === 'recuento' && f.corte_id) recuentoDe.set(f.corte_id, a);
      if (f.caja_fuerte != null) conteosCF.push(a);
    }
    conteosCF.sort((x, y) => x.at - y.at);
  }
  const ultimoDelDia = (dia: string | null) => {
    if (!dia) return null;
    const d = conteos.filter((c) => c.dia === dia);
    return d.length ? d[d.length - 1] : null;
  };
  const ultimoCFDelDia = (dia: string) => {
    const d = conteosCF.filter((c) => c.dia === dia);
    return d.length ? d[d.length - 1] : null;
  };
  const anteriorA = (c: { at: number }) => {
    const prev = conteosCF.filter((x) => x.at < c.at);
    return prev.length ? prev[prev.length - 1] : null;
  };

  // ── 4. La máquina, entre el primer arqueo que haga falta y el último ───────────────────
  const hayCaos = (await trx.raw(`SELECT to_regclass('analytics.caos_cash_movements') IS NOT NULL AS t`)).rows[0]?.t === true;
  type FilaCaos = { at: string; dia: string; tipo: string; total: string };
  let caos: Array<{ at: number; dia: string; tipo: string; total: number }> = [];
  if (hayCaos && conteosCF.length) {
    const filas = (await trx.raw(`
      SELECT occurred_at AS at, to_char(accounting_date, 'YYYY-MM-DD') AS dia, type_label AS tipo, abs(total) AS total
        FROM analytics.caos_cash_movements
       WHERE tenant_id = ? AND occurred_at > ? AND occurred_at <= ?`,
    [tenantId, new Date(conteosCF[0].at).toISOString(), new Date(conteosCF[conteosCF.length - 1].at).toISOString()])).rows as FilaCaos[];
    caos = filas.map((f) => ({ at: new Date(f.at).getTime(), dia: f.dia, tipo: f.tipo, total: n(f.total) }));
    for (const k of caos) anota(k.dia, k.total);
  }

  // ── 5. Armar los hechos de cada corte ───────────────────────────────────────────────────
  for (const c of cortes) {
    const id = String(c['id']);
    const ch = porId.get(id);
    if (!ch) continue;
    const sellado: TotalesLibro = { ingresos: n(c['total_ingresos']), gastos: n(c['total_gastos']), depositos: n(c['total_depositos']) };
    // El testigo del conteo: el recuento de ESTE corte; sin él, el último arqueo de Control del día.
    const controlDia = recuentoDe.get(id) ?? ultimoDelDia(ch.dia);
    const controlFondo = (ch.id_anterior ? recuentoDe.get(ch.id_anterior) : undefined) ?? ultimoDelDia(ch.dia_anterior);
    // La caja fuerte: entre el último arqueo con caja fuerte del día y el anterior a él.
    const hasta = ultimoCFDelDia(ch.dia);
    const desde = hasta ? anteriorA(hasta) : null;
    let caja_fuerte: HechosVerdad['caja_fuerte'] = null;
    if (hayCaos && hasta && desde) {
      const en = caos.filter((k) => k.at > desde.at && k.at <= hasta.at);
      const suma = (t: string) => en.filter((k) => k.tipo === t).reduce((a, k) => a + k.total, 0);
      caja_fuerte = { desde, hasta, depositado: suma('Deposito'), dispensado: suma('Dispensar'), vaciado: suma('Vaciar Stocks'), dotado: suma('Dotar') };
    }
    const casan = importes.get(ch.dia) ?? new Set<number>();
    out.set(id, {
      fecha: ch.dia,
      cerrado_dia: ch.cerrado_dia,
      contado: c['contado'] == null ? null : Number(c['contado']),
      fondo_inicial: c['fondo_inicial'] == null ? null : Number(c['fondo_inicial']),
      diferencia: c['diferencia'] == null ? null : Number(c['diferencia']),
      sellado,
      hoy: hoyDe.get(id) ?? { ingresos: 0, gastos: 0, depositos: 0 },
      dia_anterior: ch.dia_anterior,
      control_dia: controlDia,
      control_fondo: controlFondo,
      caja_fuerte,
      control_sin_libro: (movsPorDia.get(ch.dia) ?? []).filter((m) => m.monto > 0 && !casan.has(Math.round(m.monto * 100))),
    });
  }
  return out;
}
