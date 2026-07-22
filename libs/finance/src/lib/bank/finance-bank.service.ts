import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * CB.2 — Conciliación bancaria (ADR-033). Servicio de lectura + reclasificación
 * sobre `finance.bank_*`. Reemplaza el workbook Excel: cuentas, catálogo de
 * categorías, estados de cuenta por periodo, movimientos (filtrables) y el
 * tablero CONCENTRADO (pivote cuenta × grupo). NO escribe a Kepler.
 *
 * finance.* tiene RLS forzado → todo va por TenantKnexService.run() (el tenant
 * lo pone el contexto; los WHERE no repiten tenant_id).
 */

const n = (v: any) => Number(v) || 0;

export interface ListMovementsQuery {
  period?: string;
  account_id?: string;
  category_id?: string;
  group_key?: string;
  uncategorized?: string;   // 'true' → solo sin categoría
  recon_status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

@Injectable()
export class FinanceBankService {
  private readonly logger = new Logger(FinanceBankService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Cuentas de banco/caja/factoraje. */
  async accounts() {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      return trx('finance.bank_accounts')
        .select('id', 'bank', 'account_label', 'alias', 'kind', 'kepler_link', 'active')
        .orderBy([{ column: 'kind' }, { column: 'bank' }, { column: 'account_label' }]);
    });
  }

  /** Catálogo de categorías limpias (alineado a Kepler). */
  async categories() {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      return trx('finance.movement_categories')
        .select('id', 'code', 'name', 'flow', 'kepler_account', 'group_key', 'kepler_note', 'sort_order', 'active')
        .orderBy('sort_order');
    });
  }

  /** Periodos con estados de cuenta cargados (más reciente primero). */
  async periods(): Promise<string[]> {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const rows = await trx('finance.bank_statements').distinct('period').orderBy('period', 'desc');
      return rows.map((r: any) => r.period);
    });
  }

  /** Estados de cuenta de un periodo (por cuenta) con totales. */
  async statements(period?: string) {
    this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    return this.tk.run(async (trx) => {
      const rows = await trx('finance.bank_statements as st')
        .join('finance.bank_accounts as ba', 'ba.id', 'st.bank_account_id')
        .where('st.period', period)
        .select('st.id', 'st.bank_account_id', 'ba.bank', 'ba.account_label', 'ba.alias', 'ba.kind',
          'st.opening_balance', 'st.closing_balance', 'st.total_in', 'st.total_out',
          'st.source_file', 'st.status', 'st.imported_at')
        .orderBy([{ column: 'ba.kind' }, { column: 'ba.bank' }, { column: 'ba.account_label' }]);
      return rows.map((r: any) => ({
        ...r,
        opening_balance: n(r.opening_balance), closing_balance: n(r.closing_balance),
        total_in: n(r.total_in), total_out: n(r.total_out),
      }));
    });
  }

  /** Movimientos filtrados (grid). Pagina; devuelve total para el contador. */
  async movements(q: ListMovementsQuery) {
    this.tenantCtx.requireTenantId();
    if (!q.period && !q.account_id) throw new BadRequestException('period o account_id requerido');
    const limit = Math.min(1000, Math.max(1, Number(q.limit) || 200));
    const offset = Math.max(0, Number(q.offset) || 0);
    return this.tk.run(async (trx) => {
      const base = () => {
        const b = trx('finance.bank_movements as bm')
          .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
          .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
          .leftJoin('finance.bank_statements as st', 'st.id', 'bm.statement_id');
        if (q.period) b.where('st.period', q.period);
        if (q.account_id) b.where('bm.bank_account_id', q.account_id);
        if (q.category_id) b.where('bm.category_id', q.category_id);
        if (q.group_key) b.where('mc.group_key', q.group_key);
        if (q.uncategorized === 'true') b.whereNull('bm.category_id');
        if (q.recon_status) b.where('bm.recon_status', q.recon_status);
        if (q.search) {
          const s = `%${q.search.trim()}%`;
          b.where((w) => w.whereILike('bm.concept', s).orWhereILike('bm.raw_code', s).orWhereILike('bm.sucursal', s));
        }
        return b;
      };
      const [{ count }] = await base().count({ count: '*' });
      const rows = await base()
        .select('bm.id', 'bm.movement_date', 'ba.bank', 'ba.account_label', 'bm.bank_account_id',
          'bm.category_id', 'mc.code as category_code', 'mc.name as category_name', 'mc.group_key',
          'mc.kepler_account', 'bm.raw_type', 'bm.raw_code', 'bm.sucursal', 'bm.concept',
          'bm.amount_in', 'bm.amount_out', 'bm.running_balance', 'bm.recon_status')
        .orderBy([{ column: 'bm.movement_date' }, { column: 'bm.id' }])
        .limit(limit).offset(offset);
      return {
        total: Number(count),
        rows: rows.map((r: any) => ({
          ...r,
          amount_in: n(r.amount_in), amount_out: n(r.amount_out),
          running_balance: r.running_balance === null ? null : n(r.running_balance),
        })),
      };
    });
  }

  /**
   * Tablero CONCENTRADO: pivote cuenta × grupo (ingreso/compra/gasto/factoraje/
   * financiero/traspaso/devolucion/sin_clasificar) con depósitos/retiros, más
   * fila de totales. Es la vista que reemplaza la hoja CONCENTRADO del Excel.
   */
  async concentrado(period?: string) {
    this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    return this.tk.run(async (trx) => {
      const rows = await trx('finance.bank_movements as bm')
        .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
        .where('st.period', period)
        .groupBy('ba.id', 'ba.bank', 'ba.account_label', 'ba.alias', 'ba.kind')
        .groupByRaw('COALESCE(mc.group_key, ?)', ['sin_clasificar'])
        .select('ba.id as account_id', 'ba.bank', 'ba.account_label', 'ba.alias', 'ba.kind',
          trx.raw(`COALESCE(mc.group_key, 'sin_clasificar') AS group_key`),
          trx.raw('SUM(bm.amount_in)::numeric AS deposits'),
          trx.raw('SUM(bm.amount_out)::numeric AS withdrawals'),
          trx.raw('COUNT(*)::int AS movs'));

      const byAccount = new Map<string, any>();
      const groupTotals: Record<string, { deposits: number; withdrawals: number; movs: number }> = {};
      for (const r of rows as any[]) {
        const acc = byAccount.get(r.account_id) || {
          account_id: r.account_id, bank: r.bank, account_label: r.account_label, alias: r.alias, kind: r.kind,
          groups: {}, deposits: 0, withdrawals: 0, movs: 0,
        };
        const dep = n(r.deposits), wd = n(r.withdrawals), mv = Number(r.movs) || 0;
        acc.groups[r.group_key] = { deposits: dep, withdrawals: wd, movs: mv };
        acc.deposits += dep; acc.withdrawals += wd; acc.movs += mv;
        byAccount.set(r.account_id, acc);
        const g = groupTotals[r.group_key] || { deposits: 0, withdrawals: 0, movs: 0 };
        g.deposits += dep; g.withdrawals += wd; g.movs += mv;
        groupTotals[r.group_key] = g;
      }
      const accounts = [...byAccount.values()].sort((a, b) =>
        a.kind.localeCompare(b.kind) || a.bank.localeCompare(b.bank) || a.account_label.localeCompare(b.account_label));
      const grand = {
        deposits: accounts.reduce((s, a) => s + a.deposits, 0),
        withdrawals: accounts.reduce((s, a) => s + a.withdrawals, 0),
        movs: accounts.reduce((s, a) => s + a.movs, 0),
      };
      return { period, accounts, groupTotals, grand };
    });
  }

  /** Reclasifica un movimiento (asigna categoría). null/'' → deja sin clasificar. */
  async reclassify(id: string, categoryId: string | null, actor?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      let catId: string | null = null;
      if (categoryId) {
        const cat = await trx('finance.movement_categories').where({ id: categoryId }).first('id');
        if (!cat) throw new BadRequestException('categoría inválida');
        catId = cat.id;
      }
      const [row] = await trx('finance.bank_movements').where({ id })
        .update({ category_id: catId, updated_at: trx.fn.now() })
        .returning(['id', 'category_id']);
      if (!row) throw new BadRequestException('movimiento no encontrado');
      this.logger.log(`movimiento ${id} reclasificado → ${catId || 'sin_clasificar'} por ${actor || '?'}`);
      return row;
    });
  }
}
