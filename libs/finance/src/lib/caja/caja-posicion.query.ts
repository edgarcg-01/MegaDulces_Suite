import type { Knex } from 'knex';
import { SUCURSAL_CAJA_GENERAL, type PosicionCajaDto } from '@megadulces/contracts';
import { posicionDeCaja, type HechosPosicion } from './caja-posicion.engine';

/**
 * `[CGS.35]` Lee los hechos de la posición de caja y la arma con el motor puro.
 *
 * ⛔ **Arqueo ciego**: con `revela = false` el esperado del cajón NO viaja (quien captura cuenta sin
 * verlo, CG.19). Se declara oculto; no se manda en cero ni se omite en silencio.
 *
 * ⚠️ RLS: quien llama tiene que haber fijado `app.tenant_id` en esta transacción.
 */
export async function leerPosicion(trx: Knex.Transaction, tenantId: string, revela: boolean): Promise<PosicionCajaDto> {
  const ahora = new Date().toISOString();
  const n = (v: unknown): number | null => (v == null ? null : Number(v));

  // ── El último corte de la Suite ──────────────────────────────────────────────────────
  const c = await trx('finance.cash_ledger_cuts')
    .where({ tenant_id: tenantId, sucursal: SUCURSAL_CAJA_GENERAL })
    .whereNot('estado', 'borrador').whereNotNull('contado')
    .orderBy([{ column: 'fecha', order: 'desc' }, { column: 'folio', order: 'desc' }])
    .first('folio', 'contado', 'closed_at', trx.raw(`to_char(fecha, 'YYYY-MM-DD') AS dia`));

  let libro: HechosPosicion['libro'] = null;
  let caosCajon: HechosPosicion['caosCajon'] = null;
  if (c) {
    // La jornada del libro es el día en que se movió el efectivo (`created_at`, CGP-L.12): lo
    // posterior al día del último corte. El cajón 00 cubre todo el libro (`aplicarAlcanceCaja`).
    const l = await trx.raw(`
      SELECT count(*)::int AS movimientos,
             coalesce(sum(monto) FILTER (WHERE tipo = 'ingreso'), 0)::numeric AS ingresos,
             coalesce(sum(monto) FILTER (WHERE tipo = 'gasto'), 0)::numeric AS gastos,
             coalesce(sum(monto) FILTER (WHERE tipo = 'deposito'), 0)::numeric AS depositos
        FROM finance.cash_ledger
       WHERE tenant_id = ? AND deleted_at IS NULL AND estado <> 'cancelado'
         AND created_at >= ((?::date + 1)::timestamp AT TIME ZONE 'America/Mexico_City')`, [tenantId, c.dia]);
    const f = l.rows[0];
    libro = { movimientos: Number(f.movimientos), ingresos: Number(f.ingresos), gastos: Number(f.gastos), depositos: Number(f.depositos) };
    // Las piernas del cajero por `accounting_date`, el mismo eje que usa el esperado del corte.
    const k = await trx.raw(`
      SELECT coalesce(sum(total) FILTER (WHERE type_label = 'Deposito'), 0)::numeric AS depositado,
             coalesce(sum(total) FILTER (WHERE type_label = 'Dispensar'), 0)::numeric AS dispensado
        FROM analytics.caos_cash_movements
       WHERE tenant_id = ? AND accounting_date > ?::date`, [tenantId, c.dia]);
    caosCajon = { depositado: Number(k.rows[0].depositado), dispensado: Number(k.rows[0].dispensado) };
  }

  // ── El último arqueo completo (dólares, cheques, papeles y la caja fuerte) ───────────
  // ⭐ `[CGS.44]` Control está jubilado desde el 2026-10-22: se lee la vista única
  // (`analytics.v_caja_arqueos`, Control congelado + Suite). Sin ella en el entorno (la migración
  // `[CGS.41]` todavía no aplicada), la lectura anterior directa de Control.
  let control: HechosPosicion['control'] = null;
  let caosDesdeControl: HechosPosicion['caosDesdeControl'] = null;
  const hayUnica = (await trx.raw(`SELECT to_regclass('analytics.v_caja_arqueos') IS NOT NULL AS t`)).rows[0]?.t === true;
  const hayControl = !hayUnica && (await trx.raw(`SELECT to_regclass('analytics.v_caja_control_cortes') IS NOT NULL AS t`)).rows[0]?.t === true;
  if (hayUnica) {
    const x = (await trx.raw(`
      SELECT origen, folio, at, efectivo, caja_fuerte, usd, tipo_cambio, cheques, papeles, quien
        FROM analytics.v_caja_arqueos WHERE completo ORDER BY at DESC LIMIT 1`)).rows[0];
    if (x) {
      control = {
        folio: String(x.folio), at: new Date(x.at).toISOString(),
        caja_fuerte: n(x.caja_fuerte), efectivo: n(x.efectivo), usd: n(x.usd),
        tipo_cambio: n(x.tipo_cambio), cheques: n(x.cheques), papeles: n(x.papeles),
        origen: x.origen === 'suite' ? 'suite' : 'control', quien: x.quien ?? null,
      };
    }
  } else if (hayControl) {
    const r = await trx.raw(`
      SELECT corte_folio, total_tarjeta, total_efectivo, dolares_usd, tipo_cambio, total_cheques, total_papeles,
             ((fecha::date + corte_hora::time) AT TIME ZONE 'America/Mexico_City') AS at
        FROM analytics.v_caja_control_cortes
       WHERE tiene_corte
       ORDER BY fecha DESC, corte_hora DESC
       LIMIT 1`);
    const x = r.rows[0];
    if (x) {
      control = {
        folio: String(x.corte_folio ?? '—'), at: new Date(x.at).toISOString(),
        caja_fuerte: n(x.total_tarjeta), efectivo: n(x.total_efectivo), usd: n(x.dolares_usd),
        tipo_cambio: n(x.tipo_cambio), cheques: n(x.total_cheques), papeles: n(x.total_papeles),
      };
    }
  }
  // Lo que se movió en la máquina después de ese arqueo, venga de donde venga.
  if (control) {
    const m = await trx.raw(`
      SELECT coalesce(sum(total) FILTER (WHERE type_label = 'Deposito'), 0)::numeric AS depositado,
             coalesce(sum(total) FILTER (WHERE type_label = 'Dispensar'), 0)::numeric AS dispensado,
             coalesce(array_agg(DISTINCT type_label) FILTER (WHERE type_label NOT IN ('Deposito', 'Dispensar')), '{}') AS otros
        FROM analytics.caos_cash_movements
       WHERE tenant_id = ? AND occurred_at > ?`, [tenantId, control.at]);
    caosDesdeControl = {
      depositado: Number(m.rows[0].depositado), dispensado: Number(m.rows[0].dispensado),
      otros: (m.rows[0].otros ?? []) as string[],
    };
  }

  const p = posicionDeCaja({
    ahora,
    corte: c ? { folio: String(c.folio), fecha: String(c.dia), contado: Number(c.contado), cerrado_at: c.closed_at ? new Date(c.closed_at).toISOString() : null } : null,
    libro, caosCajon, control, caosDesdeControl,
  });

  if (!revela) {
    const e = p.rubros.find((x) => x.rubro === 'efectivo');
    if (e) {
      e.desde = null;
      e.ahora = { monto: null, estado: 'no_medido', nota: 'Oculto: lo que debería haber en el cajón sólo lo ve quien autoriza (arqueo ciego).' };
      p.total.fuera = Array.from(new Set([...p.total.fuera, 'efectivo' as const]));
      p.total.completo = false;
      p.total.monto = Math.round(p.rubros.reduce((a, r) => a + (r.ahora.monto ?? 0), 0) * 100) / 100;
    }
  }
  return p;
}
