import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * RD.6 — Motor de comisiones de Ruta Directa.
 *
 * Reemplaza las hojas `COMISIONES`, `FORMATO DE PAGO` y `FORMATO DE SUPERVISOR` de
 * `INDICADORES RD 2026.xlsx`, que es con lo que hoy se paga cada quincena.
 *
 * TODO lo que decide sale de la DB (`commission_scales` + `_tiers` + `_bonuses` +
 * `_route_config`), nunca de un `if` acá: cambiar el tabulador es un INSERT con
 * `valid_from`, y una corrida vieja se sigue explicando con la escala que le tocaba.
 *
 * La base es la venta que ya derivamos del ERP (`analytics.v_rd_route_daily`). Medido
 * contra el workbook: SUBTOTAL casa 98.0% exacto en el tramo Wincaja, y la cadena de pago
 * se reproduce al centavo. Por eso este motor NO depende de los dos huecos de FASE_RD
 * §2.3 (el costo no es estable) ni §2.4 (falta línea diaria de Canindo): la comisión se
 * calcula sobre SUBTOTAL.
 *
 * Motor decide / humano aprueba (ADR-016): la corrida nace `borrador`, se cuadra contra el
 * Excel del periodo y sólo entonces pasa a `aprobado` y `pagado`. Sin auto-pago.
 */

export interface ComputeRunOptions {
  /** No persiste: devuelve el cálculo para poder cuadrarlo antes de crear la corrida. */
  dryRun?: boolean;
  /** Reemplaza la corrida viva del periodo (sólo si está en `borrador`). */
  replace?: boolean;
}

interface Tier { min_amount: string; max_amount: string | null; pct: string }
interface Bonus {
  beneficiario: 'chofer' | 'supervisor';
  nombre: string;
  metrica: 'venta' | 'margen_pct';
  comparador: 'gt' | 'gte';
  umbral: string;
  monto: string;
  route_code: string | null;
  gate_venta_min: string | null;
}
interface RouteCfg {
  route_code: string;
  nomina_banco: string;
  zona: string | null;
  chofer_nombre: string | null;
  supervisor_nombre: string | null;
}
interface VentaRuta {
  route_code: string;
  subtotal: number;
  venta: number;
  costo: number | null;
  subtotal_origen: string;
  costo_status: string;
  dias: number;
}

export interface CommissionLine {
  route_code: string;
  beneficiario: 'chofer' | 'supervisor';
  chofer_nombre?: string | null;
  supervisor_nombre?: string | null;
  subtotal: number | null;
  venta: number | null;
  costo: number | null;
  margen_pct: number | null;
  subtotal_origen: string | null;
  costo_status: string | null;
  pct_aplicado: number | null;
  comision: number;
  bonos: number;
  bonos_detalle: { nombre: string; monto: number; metrica: string; umbral: number }[];
  nomina_banco: number;
  a_pagar: number;
  motivo_no_pago: string | null;
}

/** Redondeo a 2 decimales, una sola vez y al final de cada monto que se persiste. */
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

@Injectable()
export class CommercialCommissionsService {
  private readonly logger = new Logger(CommercialCommissionsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  // ── Catálogo ─────────────────────────────────────────────────────────────────────────

  async listPeriods(anio?: number) {
    return this.tk.run(async (trx) => {
      const q = trx('commercial.commission_periods')
        .whereNull('deleted_at')
        .orderBy([{ column: 'anio' }, { column: 'period_no' }]);
      if (anio) q.where({ anio });
      const periods = await q.select('*');
      // Cada periodo dice si ya tiene corrida viva y en qué estado, para que la UI no
      // tenga que preguntarlo N veces.
      const runs = await trx('commercial.commission_runs')
        .whereNull('deleted_at').whereNot('status', 'anulado')
        .select('period_id', 'id as run_id', 'status', 'total_a_pagar', 'rutas_sin_dato');
      const byPeriod = new Map(runs.map((x) => [x.period_id, x]));
      return periods.map((p) => ({ ...p, run: byPeriod.get(p.id) ?? null }));
    });
  }

  async getScale(onDate: string) {
    return this.tk.run(async (trx) => this.loadScale(trx, onDate));
  }

  // ── El cálculo ───────────────────────────────────────────────────────────────────────

  async computeRun(periodId: string, opts: ComputeRunOptions = {}) {
    if (!periodId) throw new BadRequestException('periodId requerido');
    const tenantId = this.tenantCtx.requireTenantId();

    return this.tk.run(async (trx) => {
      const period = await trx('commercial.commission_periods')
        .where({ id: periodId }).whereNull('deleted_at').first();
      if (!period) throw new NotFoundException(`Periodo ${periodId} no existe`);

      const from = String(period.date_from).slice(0, 10);
      const to = String(period.date_to).slice(0, 10);

      const scale = await this.loadScale(trx, to);
      const [tiers, bonuses, routes, ventas] = await Promise.all([
        trx('commercial.commission_scale_tiers')
          .where({ scale_id: scale.id }).whereNull('deleted_at')
          .orderBy('min_amount').select<Tier[]>('min_amount', 'max_amount', 'pct'),
        trx('commercial.commission_bonuses')
          .where({ scale_id: scale.id }).whereNull('deleted_at')
          .select<Bonus[]>('beneficiario', 'nombre', 'metrica', 'comparador', 'umbral', 'monto', 'route_code', 'gate_venta_min'),
        trx('commercial.commission_route_config')
          .where({ scale_id: scale.id, activo: true }).whereNull('deleted_at')
          .orderBy('route_code').select<RouteCfg[]>('route_code', 'nomina_banco', 'zona', 'chofer_nombre', 'supervisor_nombre'),
        this.ventaPorRuta(trx, tenantId, from, to),
      ]);

      if (!tiers.length) throw new ConflictException(`La escala ${scale.code} no tiene escalones`);
      if (!routes.length) throw new ConflictException(`La escala ${scale.code} no tiene rutas configuradas`);

      const ventaMap = new Map(ventas.map((v) => [v.route_code, v]));
      const lines: CommissionLine[] = [];

      for (const cfg of routes) {
        const v = ventaMap.get(cfg.route_code) ?? null;

        // Sin fuente NO es cero: es un hueco declarado. Si publicáramos $0 el chofer
        // aparecería con venta cero y sin comisión "legítimamente", que es peor que
        // decir que no sabemos (FASE_RD §2.4).
        if (!v) {
          lines.push(this.emptyLine(cfg, 'chofer', 'sin_dato_en_la_fuente'));
          lines.push(this.emptyLine(cfg, 'supervisor', 'sin_dato_en_la_fuente'));
          continue;
        }

        const gate = scale.gate_field === 'subtotal' ? v.subtotal : v.venta;
        const base = scale.base_field === 'subtotal' ? v.subtotal : v.venta;
        const tier = this.pickTier(tiers, gate);
        // El margen sale del costo, y el costo hoy se re-expresa cada corrida. Si no hay
        // costo, el margen es null y el bono del supervisor NO se paga por defecto — no
        // se asume que alcanzó.
        const margen = v.costo && v.costo > 0 ? (v.subtotal / v.costo - 1) * 100 : null;

        if (!tier) {
          lines.push(this.emptyLine(cfg, 'chofer', 'bajo_umbral', v, margen));
          lines.push(this.emptyLine(cfg, 'supervisor', 'bajo_umbral', v, margen));
          continue;
        }

        const pct = Number(tier.pct);
        const comisionTotal = base * (pct / 100);
        const comisionSupervisor = comisionTotal * (Number(scale.share_supervisor_pct) / 100);
        const comisionChofer = comisionTotal - comisionSupervisor;

        const bonosChofer = this.matchBonuses(bonuses, 'chofer', cfg.route_code, v.venta, margen);
        const bonosSuper = this.matchBonuses(bonuses, 'supervisor', cfg.route_code, v.venta, margen);
        const sum = (bs: { monto: number }[]) => bs.reduce((s, b) => s + b.monto, 0);

        const commonBase = {
          subtotal: r2(v.subtotal), venta: r2(v.venta),
          costo: v.costo === null ? null : r2(v.costo),
          margen_pct: margen === null ? null : r2(margen),
          subtotal_origen: v.subtotal_origen, costo_status: v.costo_status,
          pct_aplicado: pct, motivo_no_pago: null,
        };

        lines.push({
          ...commonBase,
          route_code: cfg.route_code, beneficiario: 'chofer', chofer_nombre: cfg.chofer_nombre,
          comision: r2(comisionChofer), bonos: r2(sum(bonosChofer)), bonos_detalle: bonosChofer,
          nomina_banco: r2(Number(cfg.nomina_banco)),
          a_pagar: r2(comisionChofer + sum(bonosChofer) - Number(cfg.nomina_banco)),
        });

        // ⚠️ La deducción del supervisor es POR PERSONA y agregada sobre sus rutas
        // (`COMISIONES!K95 = 4260`, otro de los seis valores de nómina del libro), no por
        // ruta. Acá la línea trae la CONTRIBUCIÓN de esta ruta a su supervisor, con
        // `nomina_banco = 0`; el neto por supervisor lo arma quien consuma sumando sus
        // rutas y restando su deducción. No se reparte la deducción entre rutas para no
        // inventar una regla que el Excel no tiene.
        lines.push({
          ...commonBase,
          route_code: cfg.route_code, beneficiario: 'supervisor', supervisor_nombre: cfg.supervisor_nombre,
          comision: r2(comisionSupervisor), bonos: r2(sum(bonosSuper)), bonos_detalle: bonosSuper,
          nomina_banco: 0,
          a_pagar: r2(comisionSupervisor + sum(bonosSuper)),
        });
      }

      const chofer = lines.filter((l) => l.beneficiario === 'chofer');
      const totals = {
        total_subtotal: r2(chofer.reduce((s, l) => s + (l.subtotal ?? 0), 0)),
        total_venta: r2(chofer.reduce((s, l) => s + (l.venta ?? 0), 0)),
        total_comision: r2(lines.reduce((s, l) => s + l.comision, 0)),
        total_a_pagar: r2(lines.reduce((s, l) => s + l.a_pagar, 0)),
        rutas_con_dato: chofer.filter((l) => l.motivo_no_pago !== 'sin_dato_en_la_fuente').length,
        rutas_sin_dato: chofer.filter((l) => l.motivo_no_pago === 'sin_dato_en_la_fuente').length,
      };

      const payload = {
        period: { id: period.id, anio: period.anio, period_no: period.period_no, date_from: from, date_to: to, pay_date: period.pay_date },
        scale: { id: scale.id, code: scale.code, base_field: scale.base_field, gate_field: scale.gate_field, share_supervisor_pct: Number(scale.share_supervisor_pct) },
        ...totals,
        lines,
      };
      if (opts.dryRun) return { ...payload, run_id: null, status: 'dry-run' as const };

      const runId = await this.persist(trx, tenantId, period, scale, totals, lines, opts.replace === true);
      this.logger.log(
        `Corrida ${runId} · periodo ${period.anio}-${period.period_no} · ` +
        `${totals.rutas_con_dato} rutas con dato, ${totals.rutas_sin_dato} sin · a pagar $${totals.total_a_pagar}`,
      );
      return { ...payload, run_id: runId, status: 'borrador' as const };
    });
  }

  async getRun(runId: string) {
    return this.tk.run(async (trx) => {
      const run = await trx('commercial.commission_runs').where({ id: runId }).whereNull('deleted_at').first();
      if (!run) throw new NotFoundException(`Corrida ${runId} no existe`);
      const [period, lines] = await Promise.all([
        trx('commercial.commission_periods').where({ id: run.period_id }).first(),
        trx('commercial.commission_run_lines').where({ run_id: runId }).whereNull('deleted_at')
          .orderBy([{ column: 'route_code' }, { column: 'beneficiario' }]).select('*'),
      ]);
      return { ...run, period, lines };
    });
  }

  /** borrador → aprobado → pagado. No se salta pasos y no se revive lo anulado. */
  async setStatus(runId: string, status: 'aprobado' | 'pagado' | 'anulado') {
    const userId = this.tenantCtx.get()?.userId ?? null;
    return this.tk.run(async (trx) => {
      const run = await trx('commercial.commission_runs').where({ id: runId }).whereNull('deleted_at').first();
      if (!run) throw new NotFoundException(`Corrida ${runId} no existe`);
      const permitido: Record<string, string[]> = {
        borrador: ['aprobado', 'anulado'],
        aprobado: ['pagado', 'anulado'],
        pagado: [],
        anulado: [],
      };
      if (!permitido[run.status]?.includes(status)) {
        throw new ConflictException(`No se puede pasar de "${run.status}" a "${status}"`);
      }
      const patch: Record<string, unknown> = { status, updated_at: trx.fn.now(), updated_by: userId };
      if (status === 'aprobado') { patch.approved_at = trx.fn.now(); patch.approved_by = userId; }
      if (status === 'pagado') { patch.paid_at = trx.fn.now(); patch.paid_by = userId; }
      await trx('commercial.commission_runs').where({ id: runId }).update(patch);
      return this.getRunInTrx(trx, runId);
    });
  }

  // ── Internos ─────────────────────────────────────────────────────────────────────────

  private async loadScale(trx: any, onDate: string) {
    const scale = await trx('commercial.commission_scales')
      .whereNull('deleted_at')
      .where('valid_from', '<=', onDate)
      .andWhere((b: any) => b.whereNull('valid_to').orWhere('valid_to', '>', onDate))
      .orderBy('valid_from', 'desc')
      .first();
    if (!scale) throw new NotFoundException(`No hay escala de comisión vigente al ${onDate}`);
    return scale;
  }

  /**
   * La venta del periodo por ruta, de `analytics.v_rd_route_daily`.
   * `analytics.*` no lleva RLS → el filtro de tenant va EXPLÍCITO.
   * `subtotal_origen` y `costo_status` se agregan con `min()` para que si el periodo cruza
   * el cutover (Wincaja → push) la línea declare el caso menos bueno de los dos y no
   * presuma que todo vino del ERP.
   */
  private async ventaPorRuta(trx: any, tenantId: string, from: string, to: string): Promise<VentaRuta[]> {
    const { rows } = await trx.raw(
      `SELECT route_code,
              sum(subtotal)::float8            AS subtotal,
              sum(venta)::float8               AS venta,
              CASE WHEN count(costo) = 0 THEN NULL ELSE sum(costo)::float8 END AS costo,
              min(subtotal_origen)             AS subtotal_origen,
              min(costo_status)                AS costo_status,
              count(*)::int                    AS dias
         FROM analytics.v_rd_route_daily
        WHERE tenant_id = ? AND business_date >= ? AND business_date <= ?
        GROUP BY route_code`,
      [tenantId, from, to],
    );
    return rows as VentaRuta[];
  }

  /** min inclusivo, max exclusivo, `max IS NULL` = sin techo (FASE_RD §4.6). */
  private pickTier(tiers: Tier[], gate: number): Tier | null {
    for (const t of tiers) {
      const min = Number(t.min_amount);
      const max = t.max_amount === null ? Infinity : Number(t.max_amount);
      if (gate >= min && gate < max) return t;
    }
    return null;
  }

  private matchBonuses(
    all: Bonus[], beneficiario: 'chofer' | 'supervisor', routeCode: string,
    venta: number, margen: number | null,
  ) {
    const out: { nombre: string; monto: number; metrica: string; umbral: number }[] = [];
    for (const b of all) {
      if (b.beneficiario !== beneficiario) continue;
      if (b.route_code !== null && b.route_code !== routeCode) continue;
      if (b.gate_venta_min !== null && !(venta > Number(b.gate_venta_min))) continue;
      const valor = b.metrica === 'venta' ? venta : margen;
      if (valor === null) continue; // sin métrica no se paga: no se asume que alcanzó
      const umbral = Number(b.umbral);
      const pasa = b.comparador === 'gt' ? valor > umbral : valor >= umbral;
      if (pasa) out.push({ nombre: b.nombre, monto: Number(b.monto), metrica: b.metrica, umbral });
    }
    return out;
  }

  private emptyLine(
    cfg: RouteCfg, beneficiario: 'chofer' | 'supervisor', motivo: string,
    v?: VentaRuta, margen?: number | null,
  ): CommissionLine {
    return {
      route_code: cfg.route_code, beneficiario,
      chofer_nombre: beneficiario === 'chofer' ? cfg.chofer_nombre : undefined,
      supervisor_nombre: beneficiario === 'supervisor' ? cfg.supervisor_nombre : undefined,
      subtotal: v ? r2(v.subtotal) : null,
      venta: v ? r2(v.venta) : null,
      costo: v && v.costo !== null ? r2(v.costo) : null,
      margen_pct: margen === null || margen === undefined ? null : r2(margen),
      subtotal_origen: v ? v.subtotal_origen : null,
      costo_status: v ? v.costo_status : null,
      pct_aplicado: null, comision: 0, bonos: 0, bonos_detalle: [],
      nomina_banco: 0, a_pagar: 0, motivo_no_pago: motivo,
    };
  }

  private async persist(
    trx: any, tenantId: string, period: any, scale: any,
    totals: Record<string, number>, lines: CommissionLine[], replace: boolean,
  ): Promise<string> {
    const userId = this.tenantCtx.get()?.userId ?? null;
    const viva = await trx('commercial.commission_runs')
      .where({ period_id: period.id }).whereNull('deleted_at').whereNot('status', 'anulado').first();
    if (viva) {
      if (!replace) {
        throw new ConflictException(
          `El periodo ${period.anio}-${period.period_no} ya tiene una corrida ${viva.status}. ` +
          `Usá replace=true (sólo si está en borrador).`,
        );
      }
      if (viva.status !== 'borrador') {
        throw new ConflictException(`No se reemplaza una corrida "${viva.status}": anulala primero.`);
      }
      await trx('commercial.commission_run_lines').where({ run_id: viva.id }).del();
      await trx('commercial.commission_runs').where({ id: viva.id }).del();
    }

    const [ins] = await trx('commercial.commission_runs')
      .insert({
        tenant_id: tenantId, period_id: period.id, scale_id: scale.id, status: 'borrador',
        ...totals, created_by: userId, updated_by: userId,
        notes: 'La linea de supervisor trae la CONTRIBUCION de cada ruta (nomina_banco=0). '
             + 'Su deduccion es por persona y agregada sobre sus rutas, no por ruta.',
      })
      .returning('id');
    const runId = ins.id || ins;

    await trx('commercial.commission_run_lines').insert(
      lines.map((l) => ({
        tenant_id: tenantId, run_id: runId, route_code: l.route_code, beneficiario: l.beneficiario,
        subtotal: l.subtotal, venta: l.venta, costo: l.costo, margen_pct: l.margen_pct,
        subtotal_origen: l.subtotal_origen, costo_status: l.costo_status,
        pct_aplicado: l.pct_aplicado, comision: l.comision, bonos: l.bonos,
        bonos_detalle: JSON.stringify(l.bonos_detalle), nomina_banco: l.nomina_banco,
        a_pagar: l.a_pagar, motivo_no_pago: l.motivo_no_pago,
        created_by: userId, updated_by: userId,
      })),
    );
    return runId;
  }

  private async getRunInTrx(trx: any, runId: string) {
    const run = await trx('commercial.commission_runs').where({ id: runId }).first();
    const lines = await trx('commercial.commission_run_lines').where({ run_id: runId })
      .orderBy([{ column: 'route_code' }, { column: 'beneficiario' }]).select('*');
    return { ...run, lines };
  }
}
