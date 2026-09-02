import { Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService, applySmartSearch } from '@megadulces/platform-core';

/**
 * Apartado "Documentos cancelados" — los docs Kepler con `kdm1.c43='C'` que las vistas
 * derive-no-copy (erp_supplier_payments / erp_goods_receipts / erp_collections) EXCLUYEN
 * de los cuadres, aquí se pueden auditar. Read-only sobre `analytics.kepler_cancelled_docs`.
 *
 * analytics.* NO tiene RLS → filtro tenant EXPLÍCITO dentro de tk.run() (igual que Caja).
 * OJO decode: Kepler pone `c16` en cero al cancelar → el `monto` suele venir en $0; lo que
 * importa del apartado es la IDENTIDAD del doc cancelado (folio/proveedor/fecha/concepto).
 */
export interface CancelledQuery { month?: string; categoria?: string; search?: string }

@Injectable()
export class CancelledDocsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Deriva [from,to] desde month; default = mes en curso. */
  private range(month?: string): [string, string] {
    const m = month && /^\d{4}-\d{2}$/.test(month) ? month : new Date().toISOString().slice(0, 7);
    const [y, mo] = m.split('-').map(Number);
    const last = new Date(y, mo, 0).getDate();
    return [`${m}-01`, `${m}-${String(last).padStart(2, '0')}`];
  }

  async list(q: CancelledQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q.month);
    const n = (x: any) => Number(x) || 0;
    return this.tk.run(async (trx) => {
      const T = 'analytics.kepler_cancelled_docs';
      const base = () => {
        const b = trx(T).where('tenant_id', tenantId).whereBetween('fecha', [from, to]);
        if (q.categoria) b.where('categoria', q.categoria);
        if (q.search && q.search.trim()) applySmartSearch(b, q.search.trim(), { columns: ['folio', 'contraparte_nombre', 'contraparte_code', 'concepto'] });
        return b;
      };
      const rows = await base()
        .select('sucursal', 'doc_tipo', 'doc_prefix', 'categoria', 'folio', 'fecha', 'monto',
          'contraparte_code', 'contraparte_nombre', 'concepto', 'metodo')
        .orderBy([{ column: 'fecha', order: 'desc' }, { column: 'folio', order: 'desc' }])
        .limit(1000);
      const byCat = await base()
        .select('categoria').count({ n: '*' }).sum({ monto: 'monto' }).groupBy('categoria');
      const cats: Record<string, { n: number; monto: number }> = {};
      for (const r of byCat as any[]) cats[r.categoria || 'otro'] = { n: n(r.n), monto: Math.round(n(r.monto) * 100) / 100 };
      return {
        period: { from, to },
        totals: { n: (rows as any[]).length },
        by_categoria: cats,
        rows: (rows as any[]).map((r) => ({ ...r, monto: n(r.monto) })),
      };
    });
  }

  /** Meses con documentos cancelados, para el selector. */
  async facets() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const meses = (await trx('analytics.kepler_cancelled_docs').where('tenant_id', tenantId).whereNotNull('fecha')
        .select(trx.raw(`distinct to_char(fecha,'YYYY-MM') AS m`)))
        .map((r: any) => r.m).sort((a: string, b: string) => b.localeCompare(a));
      return { meses, categorias: ['pago', 'entrada', 'cobro'] };
    });
  }
}
