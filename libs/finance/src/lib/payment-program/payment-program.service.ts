import { Injectable } from '@nestjs/common';
import {
  TenantKnexService, TenantContextService, applySmartSearch,
  evalInput, composeFreshness, FRESHNESS_UNKNOWN,
} from '@megadulces/platform-core';
import type { Freshness } from '@megadulces/contracts';
import { coberturaLibro, type CoberturaLibro } from './payment-program.engine';

export interface PaymentProgramQuery {
  month?: string;      // '2026-08'
  bank?: string;       // BBVA/BANORTE/…
  method?: string;     // transfer/cheque/factoraje/anticipo/…
  tipo?: string;       // compra/gasto/otro
  kepler?: string;     // 'si' | 'no' | 'na'
  search?: string;     // proveedor
  limit?: number;
}

/**
 * Fase PP.2 — Programa de Pagos (Tesorería). Lee `finance.payment_program` (espejo del Excel,
 * cargado por import-payment-program.js). Read-only: lista pagos + KPIs + facetas para filtros.
 * RLS forzado → SIEMPRE vía TenantKnexService.run(). Une a catalog.suppliers para el nombre canónico.
 */
@Injectable()
export class PaymentProgramService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * [PP.7] La frescura del espejo. Esta pantalla publica la ejecución de pagos de Tesorería y
   * hasta hoy NO decía de cuándo son — medido el 2026-10-05: el último mes cargado era
   * **2026-08** y el último write del importer el **2026-08-08**, o sea dos meses de silencio
   * publicados con total aplomo.
   *
   * No es un descuido del operador: `import-payment-program.js` lee un `.xlsx` desde una ruta
   * local (`C:/Users/Sistemas/Downloads/…`), a mano, sin agenda y sin latido. O sea que el
   * estado normal de este espejo es "congelado", y la pantalla no tenía forma de decirlo.
   *
   * Dos eslabones, y gana el PEOR (`composeFreshness`) — son preguntas distintas y las dos
   * pueden fallar solas:
   *   · `pp_cobertura` — hasta qué mes de NEGOCIO llega el Excel. Es el que de verdad importa:
   *     aunque el importer corriera hoy, si el libro llega a agosto el dato es de agosto.
   *   · `pp_import`    — cuándo ESCRIBIÓ el importer (entrega, no "corrió").
   *
   * Tolerancia 30 días: es un libro MENSUAL. Se mide desde el último día del mes cubierto, así
   * que "tengo agosto completo" aguanta hasta el 30-sep y recién ahí pide septiembre. Una
   * tolerancia en horas (la de un feed diario) marcaría rojo permanente y enseñaría a ignorarla.
   *
   * Si la medición falla devuelve `unknown` con `stale: true` — nunca silencio (ADR-056: lo que
   * no se pudo medir se DECLARA, y un booleano no puede expresar "no sé").
   *
   * ⚠️ Va partido en `frescuraTx(trx)` + `frescura()` a propósito. El hermano `CajaGeneralService`
   * (CG.8) llama a su `frescura()` DESDE DENTRO de su propio `tk.run`, y como `run()` abre una
   * transacción nueva cada vez, eso gasta dos conexiones del pool y dos transacciones por request.
   * Acá es lectura pura, así que no dispara el bug de escritura invisible de
   * [[feedback_no_nested_tenant_knex_run]] — pero la regla de esa lección es justamente ésta:
   * dentro de un `tk.run`, para reusar lógica se pasa el `trx`, no se abre otro.
   */
  private async frescuraTx(trx: any): Promise<Freshness> {
    const [r] = await trx('finance.payment_program').select(trx.raw(`
      max(updated_at) AS escrito_at,
      CASE WHEN max(source_month) IS NULL THEN NULL
           ELSE ((max(source_month) || '-01')::date + interval '1 month' - interval '1 day')
      END AS cubierto_at`));
    return composeFreshness([
      evalInput('pp_cobertura', 'Mes cubierto por el libro de Tesorería', r?.cubierto_at ?? null, 24 * 30),
      evalInput('pp_import', 'Carga del Excel (importer manual)', r?.escrito_at ?? null, 24 * 30),
    ]);
  }

  async frescura(): Promise<Freshness> {
    this.tenantCtx.requireTenantId();
    try {
      return await this.tk.run((trx) => this.frescuraTx(trx));
    } catch {
      // Una medición que falla NO puede verse como un dato al día.
      return FRESHNESS_UNKNOWN;
    }
  }

  /**
   * [PP.7] Qué meses FALTAN, enumerados. La frescura dice "esto está viejo"; esto dice
   * exactamente qué no está — que es lo accionable (ADR-056: lo que falta se enumera, porque un
   * mes ausente llega como cero y un cero se lee como "no se pagó nada").
   *
   * El universo va del primer mes cargado al mes ANTERIOR al corriente: el mes en curso todavía
   * se está ejecutando y marcarlo como faltante sería un rojo permanente y falso.
   */
  async cobertura(): Promise<CoberturaLibro> {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const cargados: string[] = (await trx('finance.payment_program')
        .distinct('source_month').orderBy('source_month'))
        .map((r: any) => r.source_month).filter(Boolean);
      // El cálculo vive en una función pura y probada (`payment-program.engine.ts`): es
      // aritmética de calendario, que es donde los bordes (el mes -1 de enero) se equivocan en
      // silencio y nadie lo nota hasta enero.
      return coberturaLibro(cargados);
    });
  }

  private applyFilters(b: any, q: PaymentProgramQuery) {
    if (q.month) b.where('pp.source_month', q.month);
    if (q.bank) b.where('pp.bank_text', q.bank);
    if (q.method) b.where('pp.method', q.method);
    if (q.tipo) b.where('pp.tipo', q.tipo);
    if (q.kepler === 'si') b.where('pp.kepler_flag', true);
    else if (q.kepler === 'no') b.where('pp.kepler_flag', false);
    else if (q.kepler === 'na') b.whereNull('pp.kepler_flag');
    if (q.search && q.search.trim()) applySmartSearch(b, q.search.trim(), { columns: ['pp.supplier_text', 's.name'] });
    return b;
  }

  async list(q: PaymentProgramQuery) {
    this.tenantCtx.requireTenantId();
    const limit = Math.min(2000, Math.max(1, Number(q.limit) || 500));
    return this.tk.run(async (trx) => {
      const rows = await this.applyFilters(
        trx('finance.payment_program as pp')
          .leftJoin('catalog.suppliers as s', 's.id', 'pp.supplier_id'), q)
        .select('pp.id', 'pp.source_month', 'pp.pay_date', 'pp.clearing_date', 'pp.supplier_text',
          'pp.sucursal_code', 'pp.tipo', 'pp.method', 'pp.method_ref', 'pp.bank_text',
          'pp.amount', 'pp.invoice_folios', 'pp.kepler_flag',
          trx.raw('s.name AS supplier_name'), trx.raw('s.credit_days AS credit_days'))
        .orderByRaw('pp.pay_date desc nulls last, pp.amount desc')
        .limit(limit);

      // Totales + KEPLER sobre el set filtrado (sin limit).
      const [tot] = await this.applyFilters(trx('finance.payment_program as pp').leftJoin('catalog.suppliers as s', 's.id', 'pp.supplier_id'), q)
        .select(
          trx.raw('count(*)::int AS n'),
          trx.raw('coalesce(sum(pp.amount),0)::numeric AS monto'),
          trx.raw("count(*) FILTER (WHERE pp.kepler_flag IS TRUE)::int AS kep_si"),
          trx.raw("count(*) FILTER (WHERE pp.kepler_flag IS FALSE)::int AS kep_no"),
          trx.raw("count(*) FILTER (WHERE pp.supplier_id IS NULL)::int AS sin_resolver"));

      // Desglose por banco y por método (sobre el set filtrado).
      const byBank = await this.applyFilters(trx('finance.payment_program as pp').leftJoin('catalog.suppliers as s', 's.id', 'pp.supplier_id'), q)
        .select('pp.bank_text').sum({ monto: 'pp.amount' }).count({ n: '*' }).groupBy('pp.bank_text').orderBy('monto', 'desc');
      const byMethod = await this.applyFilters(trx('finance.payment_program as pp').leftJoin('catalog.suppliers as s', 's.id', 'pp.supplier_id'), q)
        .select('pp.method').sum({ monto: 'pp.amount' }).count({ n: '*' }).groupBy('pp.method').orderBy('monto', 'desc');

      return {
        rows,
        // [PP.7] De cuándo son estos números. Un `generated_at` diría cuándo respondió el
        // servidor, que es otra cosa: contesta en 200 ms sobre un libro cerrado en agosto.
        freshness: await this.frescuraTx(trx),
        totals: {
          n: Number(tot.n), monto: Number(tot.monto),
          kep_si: Number(tot.kep_si), kep_no: Number(tot.kep_no), sin_resolver: Number(tot.sin_resolver),
        },
        by_bank: byBank.map((r: any) => ({ bank: r.bank_text, n: Number(r.n), monto: Number(r.monto) })),
        by_method: byMethod.map((r: any) => ({ method: r.method, n: Number(r.n), monto: Number(r.monto) })),
      };
    });
  }

  /**
   * PP.4 — Conciliación por mes (control 3-vías + flag de Tesorería).
   * OJO honesto: los tres universos NO son idénticos → el "gap" es informativo, no un descuadre:
   *   · programa    = pagos curados de Tesorería (proveedor + gasto).
   *   · kepler_201  = TODOS los cargos de pago de la 201 (XD2601/XD2501): incluye nómina,
   *                   inter-sucursal, etc. → SUPERSET del programa.
   *   · bancos_cb   = egresos del estado de cuenta (CB), donde haya periodo cargado → SUPERSET.
   * La señal CONFIABLE de "pagado pero no asentado" es la columna KEPLER de Tesorería (flag_no),
   * disponible sólo donde el Excel la trae (jul/ago).
   */
  async recon() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const prog = await trx('finance.payment_program')
        .select(trx.raw(`source_month,
          count(*)::int AS n, coalesce(sum(amount),0)::numeric AS monto,
          count(*) FILTER (WHERE kepler_flag IS TRUE)::int AS flag_si,
          count(*) FILTER (WHERE kepler_flag IS FALSE)::int AS flag_no,
          coalesce(sum(amount) FILTER (WHERE kepler_flag IS FALSE),0)::numeric AS monto_no,
          count(*) FILTER (WHERE kepler_flag IS NULL)::int AS flag_na`))
        .groupBy('source_month').orderBy('source_month');
      const kep = await trx('analytics.gl_poliza_lines')
        .where({ tenant_id: tenantId, source: 'kepler', cuenta_mayor: '201' })
        .whereIn('tipo_pol', ['XD2601', 'XD2501']).where('anio_mes', '>=', '2026-01')
        .select('anio_mes').sum({ monto: 'importe' }).groupBy('anio_mes');
      let bank: any[] = [];
      try {
        bank = await trx('finance.bank_movements').where('tenant_id', tenantId).where('amount_out', '>', 0)
          .select(trx.raw(`to_char(movement_date,'YYYY-MM') AS ym`)).sum({ monto: 'amount_out' })
          .groupByRaw(`to_char(movement_date,'YYYY-MM')`);
      } catch { bank = []; }
      const kByM = new Map(kep.map((r: any) => [r.anio_mes, Number(r.monto)]));
      const bByM = new Map(bank.map((r: any) => [r.ym, Number(r.monto)]));
      return {
        months: prog.map((p: any) => ({
          month: p.source_month, program: Number(p.monto), program_n: Number(p.n),
          flag_si: Number(p.flag_si), flag_no: Number(p.flag_no), flag_na: Number(p.flag_na), monto_no: Number(p.monto_no),
          kepler201: kByM.get(p.source_month) || 0,
          bank_cb: bByM.has(p.source_month) ? bByM.get(p.source_month) : null,
        })),
      };
    });
  }

  /** Facetas para los filtros (meses, bancos, métodos, tipos). */
  async facets() {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const months = (await trx('finance.payment_program').distinct('source_month').orderBy('source_month', 'desc')).map((r: any) => r.source_month);
      const banks = (await trx('finance.payment_program').distinct('bank_text').whereNotNull('bank_text').orderBy('bank_text')).map((r: any) => r.bank_text);
      const methods = (await trx('finance.payment_program').distinct('method').whereNotNull('method').orderBy('method')).map((r: any) => r.method);
      const tipos = (await trx('finance.payment_program').distinct('tipo').whereNotNull('tipo').orderBy('tipo')).map((r: any) => r.tipo);
      return { months, banks, methods, tipos };
    });
  }
}
