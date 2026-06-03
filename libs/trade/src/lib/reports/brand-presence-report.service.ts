import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import * as fs from 'fs';
import * as path from 'path';
import { KNEX_CONNECTION, TenantContextService, toMxDateKey } from '@megadulces/platform-core';
import { PdfService } from './pdf.service';
import { ReportsService } from './reports.service';
import { BrandPresenceFilterDto } from './dto/reports-filter.dto';

export type Rag = 'green' | 'amber' | 'red';

interface KpiCard {
  label: string;
  value: string;
  sublabel?: string;
  rag?: Rag;
}

interface ZoneRow {
  zone: string;
  visits: number;
  exhibitors: number;
  presence: number;
  coverage: number;
  rag: Rag;
}

interface SkuRow {
  name: string;
  appearances: number;
  coverageRate: number;
  rag: Rag;
}

interface BrandPresenceReportData {
  tenant: { name: string; logoDataUri?: string };
  brand: { name: string; productCount: number; productsWithPresence: number };
  period: { startDate: string; endDate: string; label: string; days: number };
  preparedFor?: string;
  preparedBy: { name: string; email: string };
  generatedAt: string;
  kpis: KpiCard[];
  coverage: {
    visits: number;
    visitsWithBrand: number;
    coverageRate: number;
    exhibitors: number;
    exhibitorsWithBrand: number;
    presenceRate: number;
    coverageRag: Rag;
    presenceRag: Rag;
  };
  execution: {
    total: number;
    optimo: number;
    regular: number;
    critico: number;
    optimoPct: number;
    regularPct: number;
    criticoPct: number;
  };
  topSkus: SkuRow[];
  bottomSkus: SkuRow[];
  byZone: ZoneRow[];
  dailyTrend: Array<{ date: string; label: string; presence: number }>;
  trendChartData: { labels: string[]; data: number[] };
  methodology: {
    dataSource: string;
    captureMethod: string;
    inScope: string[];
    notInScope: string[];
    limitations: string;
  };
  hasData: boolean;
}

@Injectable()
export class BrandPresenceReportService {
  private readonly logger = new Logger(BrandPresenceReportService.name);
  private logoDataUriCache?: string;

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly reportsService: ReportsService,
    private readonly pdfService: PdfService,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

  async generatePdf(filters: BrandPresenceFilterDto, user: any): Promise<{ buffer: Buffer; filename: string }> {
    const data = await this.buildReportData(filters, user);
    const buffer = await this.pdfService.render({
      template: 'brand-presence',
      data,
      waitForChartsMs: 400,
      pageOptions: {
        format: 'A4',
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
      },
    });
    const safeBrand = String(filters.brand).replace(/[^a-zA-Z0-9_-]/g, '_');
    const period = `${filters.startDate || 'inicio'}_${filters.endDate || 'hoy'}`;
    return { buffer, filename: `presencia_marca_${safeBrand}_${period}.pdf` };
  }

  private async buildReportData(filters: BrandPresenceFilterDto, user: any): Promise<BrandPresenceReportData> {
    const tenantId: string | undefined = user?.tenant_id || this.tenantContext?.get()?.tenantId;
    const tenant = await this.loadTenant(tenantId);
    const brandName = filters.brand;

    const reportsData = await this.reportsService.getFilteredData(
      {
        startDate: filters.startDate,
        endDate: filters.endDate,
        zone: filters.zone,
        include: 'products',
        pageSize: '500',
      },
      user,
    );

    const productMap: Record<string, { name: string; brandName: string }> = reportsData.productMap || {};
    const productStats: Record<string, { total: number; exhibidores: Record<string, number> }> =
      reportsData.productStats || {};

    const brandPids = Object.keys(productMap).filter(pid => productMap[pid].brandName === brandName);
    const brandPidSet = new Set(brandPids);

    const productCountOfBrand = await this.countBrandSkus(brandName, tenantId);

    const rows = (reportsData.rows || []) as any[];

    let exhibitorsTotal = 0;
    let exhibitorsWithBrand = 0;
    let visitsTotal = 0;
    let visitsWithBrand = 0;
    const execution = { optimo: 0, regular: 0, critico: 0 };
    const dailyPresence: Record<string, number> = {};
    const byZoneMap: Record<string, { visits: number; exhibitors: number; presence: number; storesWithBrand: Set<string>; stores: Set<string> }> = {};

    for (const row of rows) {
      visitsTotal++;
      const ex = Array.isArray(row.exhibiciones) ? row.exhibiciones : [];
      let rowHasBrand = false;
      const zoneKey = row.zona_captura || 'Sin zona';
      const storeKey = row.store_id || row.cliente_nombre || '__';
      if (!byZoneMap[zoneKey]) {
        byZoneMap[zoneKey] = { visits: 0, exhibitors: 0, presence: 0, storesWithBrand: new Set(), stores: new Set() };
      }
      byZoneMap[zoneKey].visits++;
      byZoneMap[zoneKey].stores.add(storeKey);

      const dateKey = toMxDateKey(row.fecha) || toMxDateKey(row.hora_inicio);

      for (const e of ex) {
        exhibitorsTotal++;
        byZoneMap[zoneKey].exhibitors++;
        const pids: string[] = e.productosMarcados || [];
        const hasBrand = pids.some(pid => brandPidSet.has(pid));
        if (hasBrand) {
          exhibitorsWithBrand++;
          byZoneMap[zoneKey].presence++;
          byZoneMap[zoneKey].storesWithBrand.add(storeKey);
          rowHasBrand = true;

          const lvl = String(e.nivelEjecucion || '').toLowerCase();
          if (lvl === 'alto' || lvl === 'excelente' || lvl === 'optimo') execution.optimo++;
          else if (lvl === 'medio' || lvl === 'regular') execution.regular++;
          else execution.critico++;

          if (dateKey) dailyPresence[dateKey] = (dailyPresence[dateKey] || 0) + 1;
        }
      }
      if (rowHasBrand) visitsWithBrand++;
    }

    const coverageRate = visitsTotal > 0 ? (visitsWithBrand / visitsTotal) * 100 : 0;
    const presenceRate = exhibitorsTotal > 0 ? (exhibitorsWithBrand / exhibitorsTotal) * 100 : 0;
    const productsWithPresence = brandPids.filter(pid => (productStats[pid]?.total || 0) > 0).length;

    const executionTotal = execution.optimo + execution.regular + execution.critico;
    const optimoPct = executionTotal > 0 ? (execution.optimo / executionTotal) * 100 : 0;
    const regularPct = executionTotal > 0 ? (execution.regular / executionTotal) * 100 : 0;
    const criticoPct = executionTotal > 0 ? (execution.critico / executionTotal) * 100 : 0;

    const topSkus: SkuRow[] = brandPids
      .map(pid => {
        const total = productStats[pid]?.total || 0;
        return {
          name: productMap[pid]?.name || pid,
          appearances: total,
          coverageRate: exhibitorsTotal > 0 ? (total / exhibitorsTotal) * 100 : 0,
          rag: this.ragForSkuCoverage(exhibitorsTotal > 0 ? (total / exhibitorsTotal) * 100 : 0),
        };
      })
      .sort((a, b) => b.appearances - a.appearances)
      .slice(0, 10);

    const bottomSkus: SkuRow[] = brandPids
      .map(pid => {
        const total = productStats[pid]?.total || 0;
        return {
          name: productMap[pid]?.name || pid,
          appearances: total,
          coverageRate: exhibitorsTotal > 0 ? (total / exhibitorsTotal) * 100 : 0,
          rag: this.ragForSkuCoverage(exhibitorsTotal > 0 ? (total / exhibitorsTotal) * 100 : 0),
        };
      })
      .sort((a, b) => a.appearances - b.appearances)
      .slice(0, 10);

    const byZone: ZoneRow[] = Object.keys(byZoneMap)
      .map(z => {
        const r = byZoneMap[z];
        const presence = r.exhibitors > 0 ? (r.presence / r.exhibitors) * 100 : 0;
        const coverage = r.stores.size > 0 ? (r.storesWithBrand.size / r.stores.size) * 100 : 0;
        return {
          zone: z,
          visits: r.visits,
          exhibitors: r.exhibitors,
          presence: Number(presence.toFixed(1)),
          coverage: Number(coverage.toFixed(1)),
          rag: this.ragForCoverage(coverage),
        };
      })
      .sort((a, b) => b.coverage - a.coverage);

    const dailyTrend = Object.keys(dailyPresence)
      .sort()
      .map(date => ({
        date,
        label: this.shortDate(date),
        presence: dailyPresence[date],
      }));

    const days = filters.startDate && filters.endDate
      ? Math.max(1, Math.round((new Date(filters.endDate).getTime() - new Date(filters.startDate).getTime()) / 86400000) + 1)
      : (dailyTrend.length || 0);

    const kpis: KpiCard[] = [
      {
        label: 'Cobertura de tiendas',
        value: `${coverageRate.toFixed(1)}%`,
        sublabel: `${visitsWithBrand} de ${visitsTotal} visitas`,
        rag: this.ragForCoverage(coverageRate),
      },
      {
        label: 'Presencia en exhibidores',
        value: `${presenceRate.toFixed(1)}%`,
        sublabel: `${exhibitorsWithBrand} de ${exhibitorsTotal} exhibidores`,
        rag: this.ragForCoverage(presenceRate),
      },
      {
        label: 'SKUs con presencia',
        value: `${productsWithPresence} / ${productCountOfBrand}`,
        sublabel: 'Productos del catálogo capturados',
        rag: this.ragForCatalogPresence(productsWithPresence, productCountOfBrand),
      },
      {
        label: 'Ejecución óptima',
        value: `${optimoPct.toFixed(1)}%`,
        sublabel: `${execution.optimo} exhibidores nivel alto`,
        rag: this.ragForOptimo(optimoPct),
      },
    ];

    const data: BrandPresenceReportData = {
      tenant: { name: tenant.name, logoDataUri: await this.getLogoDataUri() },
      brand: { name: brandName, productCount: productCountOfBrand, productsWithPresence },
      period: {
        startDate: filters.startDate || '',
        endDate: filters.endDate || '',
        label: this.periodLabel(filters.startDate, filters.endDate),
        days,
      },
      preparedFor: filters.preparedFor,
      preparedBy: { name: user?.name || user?.username || 'Equipo Trade Marketing', email: user?.email || '' },
      generatedAt: new Date().toISOString(),
      kpis,
      coverage: {
        visits: visitsTotal,
        visitsWithBrand,
        coverageRate: Number(coverageRate.toFixed(1)),
        exhibitors: exhibitorsTotal,
        exhibitorsWithBrand,
        presenceRate: Number(presenceRate.toFixed(1)),
        coverageRag: this.ragForCoverage(coverageRate),
        presenceRag: this.ragForCoverage(presenceRate),
      },
      execution: {
        total: executionTotal,
        optimo: execution.optimo,
        regular: execution.regular,
        critico: execution.critico,
        optimoPct: Number(optimoPct.toFixed(1)),
        regularPct: Number(regularPct.toFixed(1)),
        criticoPct: Number(criticoPct.toFixed(1)),
      },
      topSkus,
      bottomSkus,
      byZone,
      dailyTrend,
      trendChartData: {
        labels: dailyTrend.map(t => t.label),
        data: dailyTrend.map(t => t.presence),
      },
      methodology: this.buildMethodology(),
      hasData: visitsTotal > 0,
    };

    return data;
  }

  private async countBrandSkus(brandName: string, tenantId?: string): Promise<number> {
    const q = this.knex('products as p')
      .innerJoin('brands as b', 'b.id', 'p.brand_id')
      .where('b.nombre', brandName)
      .count<{ count: string }[]>('p.id as count');
    if (tenantId) q.where('p.tenant_id', tenantId).andWhere('b.tenant_id', tenantId);
    const [row] = await q;
    return Number(row?.count || 0);
  }

  private async loadTenant(tenantId?: string): Promise<{ name: string }> {
    if (!tenantId) return { name: 'Mega Dulces' };
    try {
      const t = await this.knex('tenants').where({ id: tenantId }).first();
      return { name: t?.name || t?.slug || 'Mega Dulces' };
    } catch {
      return { name: 'Mega Dulces' };
    }
  }

  private async getLogoDataUri(): Promise<string | undefined> {
    if (this.logoDataUriCache !== undefined) return this.logoDataUriCache || undefined;
    const candidates = [
      path.join(process.cwd(), 'apps', 'view', 'src', 'assets', 'logos', 'mega-dulces-logo.png'),
      path.join(process.cwd(), 'apps', 'view', 'public', 'MDDL Logo 3D.png'),
    ];
    for (const p of candidates) {
      try {
        const buf = fs.readFileSync(p);
        const b64 = buf.toString('base64');
        this.logoDataUriCache = `data:image/png;base64,${b64}`;
        return this.logoDataUriCache;
      } catch {
        // try next
      }
    }
    this.logoDataUriCache = '';
    return undefined;
  }

  private ragForCoverage(pct: number): Rag {
    if (pct >= 75) return 'green';
    if (pct >= 40) return 'amber';
    return 'red';
  }

  private ragForOptimo(pct: number): Rag {
    if (pct >= 60) return 'green';
    if (pct >= 35) return 'amber';
    return 'red';
  }

  private ragForCatalogPresence(present: number, total: number): Rag {
    if (total === 0) return 'amber';
    const r = present / total;
    if (r >= 0.6) return 'green';
    if (r >= 0.3) return 'amber';
    return 'red';
  }

  private ragForSkuCoverage(pct: number): Rag {
    if (pct >= 30) return 'green';
    if (pct >= 10) return 'amber';
    return 'red';
  }

  private shortDate(yyyyMmDd: string): string {
    if (!yyyyMmDd) return '';
    const parts = yyyyMmDd.split('-');
    if (parts.length !== 3) return yyyyMmDd;
    const m = Number(parts[1]);
    const meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    return `${parts[2]} ${meses[m - 1] || ''}`;
  }

  private periodLabel(start?: string, end?: string): string {
    if (!start && !end) return 'Periodo completo';
    if (start && end && start === end) return this.fullDate(start);
    return `${start ? this.fullDate(start) : 'inicio'} — ${end ? this.fullDate(end) : 'hoy'}`;
  }

  private fullDate(s: string): string {
    try {
      const d = new Date(s);
      return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
    } catch {
      return s;
    }
  }

  private buildMethodology() {
    return {
      dataSource: 'Capturas en punto de venta realizadas por personal de campo de Mega Dulces.',
      captureMethod: 'Cada visita registra los exhibidores presentes en la tienda, el nivel de ejecución observado (alto / medio / bajo) y el conjunto de SKUs identificados dentro de cada exhibidor mediante marcado manual.',
      inScope: [
        'Cobertura: porcentaje de visitas donde la marca aparece al menos una vez.',
        'Presencia en exhibidores: porcentaje de exhibidores capturados que contienen al menos un SKU de la marca.',
        'SKUs con presencia: cuántos productos del catálogo de la marca fueron observados en el período.',
        'Distribución de ejecución: nivel de ejecución (alto/medio/bajo) de los exhibidores donde aparece la marca.',
        'Desglose por zona y tendencia temporal de presencia.',
      ],
      notInScope: [
        'Conteo de facings (caras de producto en anaquel) — la captura actual no lo registra.',
        'Espacio lineal en centímetros — sin metrología en campo.',
        'Share of Shelf competitivo — el sistema no captura SKUs de otras marcas.',
        'Cumplimiento de planograma — sin planograma de referencia.',
        'Precios y promociones — fuera del alcance de captura actual.',
      ],
      limitations:
        'Los indicadores de presencia reflejan la frecuencia con la que la marca aparece en las capturas del período. No deben interpretarse como Share of Shelf en sentido estricto (definición basada en facings o espacio lineal). La cobertura está limitada por el plan de visitas vigente.',
    };
  }
}
