import { Injectable, Logger, BadRequestException, Inject, Optional } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { RECON_NOTIFIER_PORT, ReconNotifierPort } from '@megadulces/contracts';
import { MovementReconcileService, RawDiscrepancy } from './movement-reconcile.service';

/**
 * SM.8 / P1 — Arqueo ciego. El cajero captura el conteo físico por denominación
 * ANTES de ver el esperado; recién al guardar el motor revela la diferencia REAL
 * (total ciego vs efectivo esperado de Kepler), independiente del c25 contaminado.
 *
 * SM.9 — Autolineado: al capturar un cierre divergente, el arqueo se convierte al
 * INSTANTE en un descuadre `arqueo_ciego_divergente` en la bandeja del supervisor
 * (/almacen/cuadre), sin esperar al scan nocturno, + alerta WS best-effort.
 *
 * `reconciliation.blind_counts` tiene RLS forzado → TenantKnexService.run().
 */

/** Denominaciones MXN válidas (billetes + monedas). */
const DENOMS = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5];
/** Motivos tipificados de incidencia (opcional, alineado al CHECK de la migración SM.9). */
const INCIDENCIAS = ['faltante_justificado', 'billete_falso', 'robo', 'error_cobro', 'otro'];
/** Umbrales del descuadre autolineado (espejan la regla `arqueo_ciego_divergente`). */
const ARQ_UMBRAL = 50;
const ARQ_CRITICO = 1000;
/** Ventana de turnos por arquear. 2 días cubre el cierre de ayer capturado hoy temprano. */
const TURNOS_DIAS = 2;

/** Un turno de caja abierto/cerrado por Kepler — lo que toca arquear. Sin montos. */
export interface TurnoPendiente {
  warehouse_code: string;
  warehouse_name?: string | null;
  caja: string;
  folio: string;
  business_date: string;
  hora_apertura: string | null;
  hora_cierre: string | null;
  cajero_code: string | null;
  turno: string | null;
  abierto: boolean;
  abierto_at?: string | null;
  /**
   * Minutos desde que Kepler cerró el turno. `null` mientras sigue abierto.
   * Es lo que convierte la lista en una PETICIÓN: en cuanto el ERP cierra la
   * caja, el arqueo se vuelve exigible y la pantalla lo pide sola.
   */
  cerrado_hace_min?: number | null;
}
const money = (n: number) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

export interface BlindCountDto {
  warehouse_code: string;
  caja: string;
  business_date: string;          // 'YYYY-MM-DD'
  turno?: string;
  cajero_code?: string;           // cierre: cajero que cierra · relevo: cajero SALIENTE
  cajero_entrante?: string;       // solo relevo: quién recibe la caja
  tipo?: 'cierre' | 'relevo';     // default 'cierre'
  denominations: Record<string, number>;  // {"1000":2,"0.5":10,…}
  nota?: string;
  photo_url?: string;
  incidencia_tipo?: string;       // SM.9: motivo cualitativo del descuadre (opcional)
  cash_cut_folio?: string;        // SM.12: folio del turno de Kepler que se está arqueando
  caja_kepler?: string;           // SM.12: la caja tal como la reporta Kepler en ese turno
  turno_abierto_at?: string | Date | null; // SM.12: cuándo abrió el turno (c5 + c6)
}

@Injectable()
export class BlindCountService {
  private readonly logger = new Logger(BlindCountService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly engine: MovementReconcileService,
    @Optional() @Inject(RECON_NOTIFIER_PORT) private readonly notifier?: ReconNotifierPort,
  ) {}

  private computeTotal(denoms: Record<string, number>): number {
    let total = 0;
    for (const [d, n] of Object.entries(denoms || {})) {
      const denom = Number(d); const count = Number(n);
      if (!DENOMS.includes(denom)) throw new BadRequestException(`Denominación inválida: ${d}`);
      if (!Number.isFinite(count) || count < 0) throw new BadRequestException(`Conteo inválido para ${d}`);
      total += denom * count;
    }
    return Math.round(total * 100) / 100;
  }

  /**
   * SM.12 — Los TURNOS de Kepler que a esta persona le toca arquear.
   *
   * Kepler ya dice cuándo y en qué caja: abre un renglón en `kdpv_folio_caja` con
   * la caja (`c2`), la cajera asignada (`c8`), la hora de apertura (`c6`) y el
   * folio (`c3`). Mientras el turno está abierto `c10` viene en `1800-01-01` y los
   * montos en cero. Eso es la señal: **no se arquea a mano, se arquea el turno que
   * el ERP abrió** — así la caja no se elige (es la que te tocó) y no se inventan
   * arqueos de turnos que no existieron.
   *
   * Se lee del ODS EN VIVO (`kepler_ods`, mismo Postgres, replicado por el CDC) y no
   * de `analytics.cash_cuts`: esa tabla guarda solo cortes CERRADOS y la leen 12
   * lugares que no filtran `cerrado` — meterle los turnos abiertos (esperado 0,
   * diff 0) ensuciaría KPIs, focos y el propio `compare()`.
   *
   * **No devuelve montos.** Es la lista de qué contar, no de cuánto debería haber.
   */
  async turnosPendientes(q: { cajeroCode?: string; warehouseCodes?: string[] | null; dias?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const cajero = (q.cajeroCode || '').trim().toUpperCase();
    if (!cajero) return [];
    if (q.warehouseCodes && !q.warehouseCodes.length) return []; // alcance vacío → nada
    const dias = Math.min(30, Math.max(0, Number(q.dias) || TURNOS_DIAS));
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT k.sucursal                          AS warehouse_code,
                w.name                              AS warehouse_name,
                k.c2                                AS caja,
                k.c3::bigint::text                  AS folio,
                k.c5::date::text                    AS business_date,
                NULLIF(btrim(k.c6), '')             AS hora_apertura,
                NULLIF(btrim(k.c11), '')            AS hora_cierre,
                NULLIF(btrim(k.c8), '')             AS cajero_code,
                NULLIF(btrim(k.c13), '')            AS turno,
                (k.c10::date = DATE '1800-01-01')   AS abierto,
                CASE WHEN k.c10::date = DATE '1800-01-01' THEN NULL ELSE
                  GREATEST(0, floor(EXTRACT(EPOCH FROM (
                    (now() AT TIME ZONE 'America/Mexico_City')
                    - (k.c10::date + COALESCE(NULLIF(btrim(k.c11), ''), '00:00:00')::time)
                  )) / 60))::int
                END                                  AS cerrado_hace_min
           FROM kepler_ods.kdpv_folio_caja k
           LEFT JOIN commercial.warehouses w
             ON w.tenant_id = ? AND w.code = k.sucursal AND w.deleted_at IS NULL
          WHERE upper(btrim(k.c8)) = ?
            AND k.c5::date >= (current_date - ?::int)
            AND (?::text[] IS NULL OR k.sucursal = ANY(?::text[]))
            AND NOT EXISTS (
                  SELECT 1 FROM reconciliation.blind_counts b
                   WHERE b.tenant_id = ?
                     AND b.warehouse_code = k.sucursal
                     AND b.tipo = 'cierre'
                     AND b.cash_cut_folio = k.c3::bigint::text)
          ORDER BY k.c5 DESC, k.c2
          LIMIT 50`,
        [tenantId, cajero, dias, q.warehouseCodes ?? null, q.warehouseCodes ?? null, tenantId],
      );
      return rows as TurnoPendiente[];
    });
  }

  /** Un turno concreto de Kepler, para validar que existe y es de quien dice ser. */
  async buscarTurno(warehouseCode: string, folio: string, cajero?: string): Promise<TurnoPendiente | null> {
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT k.sucursal AS warehouse_code, k.c2 AS caja, k.c3::bigint::text AS folio,
                k.c5::date::text AS business_date, NULLIF(btrim(k.c6), '') AS hora_apertura,
                NULLIF(btrim(k.c11), '') AS hora_cierre, NULLIF(btrim(k.c8), '') AS cajero_code,
                NULLIF(btrim(k.c13), '') AS turno, (k.c10::date = DATE '1800-01-01') AS abierto,
                (k.c5 + COALESCE(btrim(k.c6), '00:00:00')::time) AS abierto_at
           FROM kepler_ods.kdpv_folio_caja k
          WHERE k.sucursal = ? AND k.c3::bigint::text = ?
            AND (?::text IS NULL OR upper(btrim(k.c8)) = ?::text)
          LIMIT 1`,
        [warehouseCode, String(folio), cajero ? cajero.toUpperCase() : null, cajero ? cajero.toUpperCase() : null],
      );
      return (rows[0] as TurnoPendiente) || null;
    });
  }

  /** Captura (o re-captura) un arqueo ciego y devuelve la comparación contra el corte de Kepler. */
  async submit(dto: BlindCountDto, username?: string) {
    if (!dto?.warehouse_code || !dto?.caja || !dto?.business_date) {
      throw new BadRequestException('warehouse_code, caja y business_date son obligatorios');
    }
    const tenantId = this.tenantCtx.requireTenantId();
    const total = this.computeTotal(dto.denominations || {});
    const tipo = dto.tipo === 'relevo' ? 'relevo' : 'cierre';
    const incidencia = dto.incidencia_tipo && INCIDENCIAS.includes(dto.incidencia_tipo) ? dto.incidencia_tipo : null;
    if (dto.incidencia_tipo && !incidencia) throw new BadRequestException(`incidencia_tipo inválido (${INCIDENCIAS.join('|')})`);

    const { result, badCut } = await this.tk.run(async (trx) => {
      const row = {
        tenant_id: tenantId, tipo,
        warehouse_code: dto.warehouse_code, caja: dto.caja, business_date: dto.business_date,
        turno: dto.turno || null, cajero_code: dto.cajero_code || null, cajero_entrante: dto.cajero_entrante || null,
        denominations: JSON.stringify(dto.denominations || {}), total_contado: total,
        nota: dto.nota || null, photo_url: dto.photo_url || null, captured_by: username || null,
        incidencia_tipo: incidencia,
        // SM.12 — de qué turno de Kepler es este conteo.
        cash_cut_folio: dto.cash_cut_folio ? String(dto.cash_cut_folio) : null,
        caja_kepler: dto.caja_kepler ? String(dto.caja_kepler) : null,
        turno_abierto_at: dto.turno_abierto_at || null,
      };
      await trx('reconciliation.blind_counts')
        .insert(row)
        .onConflict(trx.raw("(tenant_id, warehouse_code, caja, business_date, COALESCE(cajero_code,''), tipo)"))
        // Re-capturar NO borra la validación por accidente: si la encargada ya firmó
        // y el conteo cambia, se limpia la firma a propósito — un arqueo distinto es
        // un arqueo sin validar.
        .merge({
          denominations: row.denominations, total_contado: total, cajero_entrante: row.cajero_entrante,
          nota: row.nota, photo_url: row.photo_url, captured_by: row.captured_by, incidencia_tipo: incidencia,
          cash_cut_folio: row.cash_cut_folio, caja_kepler: row.caja_kepler, turno_abierto_at: row.turno_abierto_at,
          validado_por: null, validado_at: null, validado_nota: null,
          captured_at: trx.fn.now(),
        });
      // El relevo no se compara contra el corte del día (es intra-turno): solo sella el traspaso.
      if (tipo === 'relevo') {
        this.logger.log(`arqueo relevo suc${dto.warehouse_code} caja${dto.caja} ${dto.business_date}: ${dto.cajero_code || '?'}→${dto.cajero_entrante || '?'} entregó ${total}`);
        return { result: { tipo, total_contado: total, matched: false, ambiguous: false, esperado: null, kepler_contado: null, kepler_diff: null, diff_real: null, kepler_enmascaro: false }, badCut: null as any };
      }
      const cmp = await this.compare(trx, tenantId, dto, total);
      this.logger.log(`arqueo cierre suc${dto.warehouse_code} caja${dto.caja} ${dto.business_date}: contado ${total} vs esperado ${cmp.esperado ?? '?'}`);
      // SM.9 — Autolineado: cierre divergente → descuadre al instante en la bandeja del supervisor.
      const badCut = await this.raiseIfDivergent(trx, tenantId, dto, total, cmp, incidencia, username);
      return { result: { tipo, total_contado: total, ...cmp }, badCut };
    });

    // WS best-effort FUERA de la transacción (no bloquea ni revierte la captura).
    if (badCut && this.notifier) {
      this.notifier.notifyBadCut(tenantId, badCut).catch((e) => this.logger.warn(`notifyBadCut falló: ${e?.message || e}`));
    }
    return result;
  }

  /**
   * SM.9 — Si el cierre matchea corte y diverge ≥ umbral, levanta (UPSERT idempotente)
   * el descuadre `arqueo_ciego_divergente` al instante y devuelve el payload de la alerta
   * cuando es crítico (Kepler enmascaró o supera el crítico). Espeja el detector homónimo.
   */
  private async raiseIfDivergent(trx: any, tenantId: string, dto: BlindCountDto, total: number, cmp: any, incidencia: string | null, username?: string) {
    if (!cmp?.matched || cmp.diff_real == null) return null;
    const diffReal = Number(cmp.diff_real);
    if (Math.abs(diffReal) < ARQ_UMBRAL) return null;
    const abs = Math.abs(diffReal);
    const esperado = Number(cmp.esperado);
    const keplerDiff = Number(cmp.kepler_diff || 0);
    const enmascaro = !!cmp.kepler_enmascaro;
    const faltante = diffReal > 0;
    const critical = enmascaro || abs >= ARQ_CRITICO;
    const fecha = dto.business_date; // ya 'YYYY-MM-DD' (sin corrimiento TZ)
    const cajero = dto.cajero_code || '?';
    const incTxt = incidencia ? ` Incidencia: ${incidencia.replace(/_/g, ' ')}.` : '';
    const d: RawDiscrepancy = {
      rule_key: 'arqueo_ciego_divergente', plano: 'caja',
      severity: critical ? 'critical' : 'warn',
      score: Math.min(1, abs / (ARQ_CRITICO * 2)),
      titulo: `Arqueo ciego: ${faltante ? 'faltan' : 'sobran'} ${money(abs)} — suc ${dto.warehouse_code} caja ${dto.caja}${enmascaro ? ' (Kepler lo dio por cuadrado)' : ''}`,
      resumen: `Corte ${fecha} (${cajero}): conteo ciego ${money(total)} vs esperado ${money(esperado)} = ${faltante ? 'faltante' : 'sobrante'} real ${money(abs)}.${enmascaro ? ` Kepler reportó diff ${money(keplerDiff)} — el arqueo ciego destapa lo que el corte ocultó.` : ''}${incTxt}`,
      entity: { sucursal: dto.warehouse_code, caja: dto.caja, cajero: dto.cajero_code || null, folio: cmp.folio || null, fecha, incidencia_tipo: incidencia },
      periodo: fecha,
      esperado, observado: total, diferencia: diffReal,
      importe: abs,
      causa_probable: enmascaro ? 'arqueo_no_ciego' : (faltante ? 'faltante_caja' : 'sobrante_caja'),
      evidencia: { params: { umbral: ARQ_UMBRAL, critico: ARQ_CRITICO }, contado_ciego: total, esperado, kepler_diff: keplerDiff, kepler_enmascaro: enmascaro, incidencia_tipo: incidencia, origen: 'arqueo_captura' },
      dedup_key: `arqueo_ciego_divergente:${dto.warehouse_code}:${dto.caja}:${fecha}:${cmp.folio || 's-folio'}`,
    };
    await this.engine.ensureRule(trx, tenantId, 'arqueo_ciego_divergente');
    await this.engine.upsertDiscrepancy(trx, tenantId, d);
    this.logger.log(`autolineado: descuadre ${d.severity} suc${dto.warehouse_code} caja${dto.caja} ${fecha} = ${money(abs)}`);
    return critical
      ? { warehouse_code: dto.warehouse_code, caja: dto.caja, business_date: fecha, cajero: dto.cajero_code || null, diff_real: diffReal, kepler_enmascaro: enmascaro, captured_by: username || null, incidencia_tipo: incidencia }
      : null;
  }

  /** Compara el total ciego vs el corte de Kepler (matchea por suc/caja/fecha[/cajero]). */
  private async compare(trx: any, tenantId: string, dto: BlindCountDto, total: number) {
    // SM.12 — Con el folio del turno el match es exacto y se acabó la ambigüedad:
    // el arqueo cuenta ESE corte, no "alguno de los de esa caja ese día" (el ~4.5%
    // de caja-días con 2+ cortes era justo lo que obligaba a devolver `ambiguous`).
    if (dto.cash_cut_folio) {
      const cut = await trx('analytics.cash_cuts')
        .where({ tenant_id: tenantId, warehouse_code: dto.warehouse_code, folio: String(dto.cash_cut_folio) })
        .first();
      if (cut) return this.armarComparacion(cut, total);
      // El turno existe en Kepler pero todavía no cerró (o el feed no lo trajo):
      // se guarda el conteo y la diferencia aparece cuando el corte llegue.
      return { matched: false, ambiguous: false, esperado: null, kepler_contado: null, kepler_diff: null, diff_real: null, kepler_enmascaro: false };
    }
    const q = trx('analytics.cash_cuts').where({ tenant_id: tenantId, warehouse_code: dto.warehouse_code, caja: dto.caja, business_date: dto.business_date });
    if (dto.cajero_code) q.where('cajero_cierre', dto.cajero_code);
    const cuts: any[] = await q.orderBy('efectivo_esperado', 'desc');
    if (!cuts.length) return { matched: false, ambiguous: false, esperado: null, kepler_contado: null, kepler_diff: null, diff_real: null, kepler_enmascaro: false };
    // Varios cortes en la caja/día y no se especificó cajero: NO elegir el mayor
    // arbitrariamente (revelaría un "faltante" de otro turno). Se pide desambiguar.
    if (!dto.cajero_code && cuts.length > 1) {
      return { matched: false, ambiguous: true, esperado: null, kepler_contado: null, kepler_diff: null, diff_real: null, kepler_enmascaro: false };
    }
    return this.armarComparacion(cuts[0], total);
  }

  /** Contado ciego vs el corte de Kepler. `+` faltante · `−` sobrante. */
  private armarComparacion(cut: any, total: number) {
    const esperado = Number(cut.efectivo_esperado);
    const keplerContado = Number(cut.efectivo_contado);
    const keplerDiff = Number(cut.efectivo_diff);
    const diffReal = Math.round((esperado - total) * 100) / 100;
    // Kepler dijo "cuadrado" (|diff|<50) pero el arqueo ciego revela ≥$50 → enmascaró.
    const keplerEnmascaro = Math.abs(keplerDiff) < 50 && Math.abs(diffReal) >= 50;
    return { matched: true, ambiguous: false, folio: cut.folio, esperado, kepler_contado: keplerContado, kepler_diff: keplerDiff, diff_real: diffReal, kepler_enmascaro: keplerEnmascaro };
  }

  /**
   * SM.12 — La encargada va al lugar, cuenta con la cajera y **firma**.
   *
   * `validado_at IS NULL` es el estado inicial y lo que alimenta la bandeja de
   * "por validar". No se puede validar en nombre de otro: el username lo pone el
   * controller desde el JWT, igual que la captura.
   */
  async validar(id: string, username?: string, nota?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('reconciliation.blind_counts')
        .where({ tenant_id: trx.raw('current_tenant_id()') as any, id })
        .update({ validado_por: username || null, validado_at: trx.fn.now(), validado_nota: nota || null })
        .returning(['id', 'warehouse_code', 'caja', 'business_date', 'cajero_code', 'total_contado', 'validado_por', 'validado_at']);
      if (!row) throw new BadRequestException('Arqueo no encontrado');
      this.logger.log(`arqueo ${id} validado por ${username || '?'} (suc${row.warehouse_code} caja${row.caja})`);
      return row;
    });
  }

  /**
   * SM.14 — Historial de arqueos: el detalle más el acumulado **por cajera**.
   *
   * El agregado contesta la pregunta que el detalle no: no "qué pasó el martes"
   * sino "a quién le pasa seguido". Por eso separa faltantes de sobrantes en vez
   * de sumarlos — una cajera con +$500 y −$500 no cuadra en promedio, tiene dos
   * errores; netearlos la haría ver perfecta.
   *
   * `sin_validar` sale acá para que la encargada vea de un vistazo qué le falta
   * firmar, sin recorrer el detalle.
   */
  async historial(q: {
    from?: string; to?: string; warehouse_codes?: string[] | null;
    cajero_code?: string; solo_sin_validar?: boolean; limit?: number;
  }) {
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
    const arqueos = await this.list({ ...q, limit });
    const filtrados = q.solo_sin_validar ? arqueos.filter((a: any) => !a.validado_at) : arqueos;

    const acc = new Map<string, any>();
    for (const a of filtrados as any[]) {
      const key = (a.cajero_code || '—').toUpperCase();
      let g = acc.get(key);
      if (!g) {
        g = {
          cajero_code: a.cajero_code || null, cajero_nombre: a.cajero_nombre || null,
          warehouse_code: a.warehouse_code, arqueos: 0, total_contado: 0,
          con_diferencia: 0, faltante_total: 0, sobrante_total: 0,
          sin_validar: 0, ultima_fecha: null as string | null,
        };
        acc.set(key, g);
      }
      g.arqueos++;
      g.total_contado = Math.round((g.total_contado + Number(a.total_contado || 0)) * 100) / 100;
      if (!a.validado_at) g.sin_validar++;
      const f = String(a.business_date).slice(0, 10);
      if (!g.ultima_fecha || f > g.ultima_fecha) g.ultima_fecha = f;
      const d = a.diff_real;
      if (d != null && Math.abs(Number(d)) >= ARQ_UMBRAL) {
        g.con_diferencia++;
        // Faltante y sobrante NO se netean: son dos errores distintos.
        if (Number(d) > 0) g.faltante_total = Math.round((g.faltante_total + Number(d)) * 100) / 100;
        else g.sobrante_total = Math.round((g.sobrante_total - Number(d)) * 100) / 100;
      }
    }
    // `Array.from`, NO `[...acc.values()]`: con el target de compilación de la lib
    // el helper de spread no reconoce el iterador de Map y lo mete como ÚNICO
    // elemento — y un iterador serializa a `{}`, así que la respuesta salía con
    // una fila vacía y los totales en NaN, sin romperse. Mismo landmine que ya
    // estaba anotado para el spread de Set en `[ID.5]`.
    const por_cajera = Array.from(acc.values()).sort(
      (a, b) => (b.faltante_total + b.sobrante_total) - (a.faltante_total + a.sobrante_total) || b.arqueos - a.arqueos,
    );

    return {
      arqueos: filtrados,
      por_cajera,
      totales: {
        arqueos: filtrados.length,
        sin_validar: filtrados.filter((a: any) => !a.validado_at).length,
        faltante_total: Math.round(por_cajera.reduce((s, g) => s + g.faltante_total, 0) * 100) / 100,
        sobrante_total: Math.round(por_cajera.reduce((s, g) => s + g.sobrante_total, 0) * 100) / 100,
      },
    };
  }

  /**
   * Lista arqueos ciegos con su comparación (para la consola).
   *
   * `warehouse_codes` es el alcance ya resuelto por `ScopeService` (`[ID.4]`):
   * `null` = sin filtro (alcance `all`), `[]` = no ve ninguna sucursal → cero
   * filas, no un 403 (un historial vacío es una respuesta legítima; un error
   * rompe la pantalla). `warehouse_code` (singular) queda para los llamadores
   * que todavía filtran a mano — la consola del supervisor.
   */
  async list(q: { from?: string; to?: string; warehouse_code?: string; warehouse_codes?: string[] | null; cajero_code?: string; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    return this.tk.run(async (trx) => {
      const b = trx('reconciliation.blind_counts as bc')
        .where('bc.tenant_id', trx.raw('current_tenant_id()'))
        .leftJoin('analytics.cash_cuts as cc', function (this: any) {
          this.on('cc.tenant_id', '=', 'bc.tenant_id').andOn('cc.warehouse_code', '=', 'bc.warehouse_code')
            .andOn('cc.caja', '=', 'bc.caja').andOn('cc.business_date', '=', 'bc.business_date')
            .andOn(trx.raw('cc.cajero_cierre IS NOT DISTINCT FROM bc.cajero_code'));
        })
        .leftJoin('analytics.pos_cashiers as pc', function (this: any) {
          this.on('pc.tenant_id', '=', 'bc.tenant_id').andOn('pc.warehouse_code', '=', 'bc.warehouse_code').andOn('pc.cajero_code', '=', 'bc.cajero_code');
        })
        .select('bc.id', 'bc.tipo', 'bc.warehouse_code', 'bc.caja', 'bc.business_date', 'bc.turno', 'bc.cajero_code', 'bc.cajero_entrante',
          'bc.cash_cut_folio', 'bc.caja_kepler', 'bc.turno_abierto_at',
          'bc.validado_por', 'bc.validado_at', 'bc.validado_nota',
          trx.raw('pc.nombre AS cajero_nombre'), trx.raw('bc.total_contado::numeric AS total_contado'),
          'bc.captured_by', 'bc.captured_at', 'bc.nota', 'bc.incidencia_tipo',
          trx.raw('cc.efectivo_esperado::numeric AS esperado'),
          trx.raw('cc.efectivo_contado::numeric AS kepler_contado'),
          trx.raw('cc.efectivo_diff::numeric AS kepler_diff'))
        .orderBy('bc.captured_at', 'desc').limit(limit);
      if (q.warehouse_code) b.where('bc.warehouse_code', q.warehouse_code);
      if (q.warehouse_codes) {
        if (!q.warehouse_codes.length) b.whereRaw('false');
        else b.whereIn('bc.warehouse_code', q.warehouse_codes);
      }
      // La cajera ve SUS arqueos, no los de la caja de al lado. La sucursal sola no
      // alcanza: en una tienda con 5 cajas le mostraría el conteo de sus compañeras.
      if (q.cajero_code) b.whereRaw('upper(bc.cajero_code) = ?', [q.cajero_code.toUpperCase()]);
      if (q.from) b.where('bc.business_date', '>=', q.from);
      if (q.to) b.where('bc.business_date', '<=', q.to);
      const rows = await b;
      return rows.map((r: any) => {
        const total = Number(r.total_contado);
        // El relevo es intra-turno: no compara contra el corte del día.
        const esperado = r.tipo === 'relevo' ? null : (r.esperado != null ? Number(r.esperado) : null);
        const diffReal = esperado != null ? Math.round((esperado - total) * 100) / 100 : null;
        const keplerDiff = r.tipo === 'relevo' ? null : (r.kepler_diff != null ? Number(r.kepler_diff) : null);
        // El arqueo que DECLARÓ Kepler (c25), al lado del nuestro. Es la
        // comparación que valida la encargada: los dos dicen contar el mismo
        // cajón y casi nunca coinciden.
        const keplerContado = r.tipo === 'relevo' ? null : (r.kepler_contado != null ? Number(r.kepler_contado) : null);
        return {
          id: r.id, tipo: r.tipo, warehouse_code: r.warehouse_code, caja: r.caja, business_date: r.business_date, turno: r.turno,
          cajero_code: r.cajero_code, cajero_entrante: r.cajero_entrante || null, cajero_nombre: r.cajero_nombre || null, total_contado: total,
          cash_cut_folio: r.cash_cut_folio || null, caja_kepler: r.caja_kepler || null, turno_abierto_at: r.turno_abierto_at || null,
          validado_por: r.validado_por || null, validado_at: r.validado_at || null, validado_nota: r.validado_nota || null,
          captured_by: r.captured_by, captured_at: r.captured_at, nota: r.nota, incidencia_tipo: r.incidencia_tipo || null,
          esperado, kepler_contado: keplerContado, kepler_diff: keplerDiff, diff_real: diffReal,
          kepler_enmascaro: keplerDiff != null && diffReal != null && Math.abs(keplerDiff) < 50 && Math.abs(diffReal) >= 50,
        };
      });
    });
  }
}
