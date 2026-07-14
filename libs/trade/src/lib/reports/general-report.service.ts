import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import * as fs from 'fs';
import * as path from 'path';
import { KNEX_CONNECTION, TenantContextService, toMxDateKey } from '@megadulces/platform-core';
import { PdfService } from './pdf.service';
import { ReportsService } from './reports.service';
import { GeneralReportFilterDto, KpiRangeDto, FurnitureTargetDto } from './dto/reports-filter.dto';

export type Rag = 'green' | 'amber' | 'red';

interface KpiRow {
  id: string;
  label: string;
  value: string;
  rawNumber: number;
  meta: string;
  rag: Rag;
  pct: number;
  delta?: string;
  deltaDir?: 'up' | 'down' | 'flat';
}

interface FurnitureRow {
  id: string;
  label: string;
  current: number;
  target: number;
  progressPct: number;
  rag: Rag;
}

interface SellerRow {
  rank: number;
  username: string;
  visits: number;
  avgScore: number;
  stars: string;
  rag: Rag;
}

interface ZoneRow {
  zone: string;
  visits: number;
  avgScore: number;
  totalSales: number;
  rag: Rag;
}

interface TableRow {
  folio: string;
  date: string;
  user: string;
  zone: string;
  score: number;
  status: 'OK' | 'REGULAR' | 'BAJO';
  rag: Rag;
  sales: number;
}

interface GeneralReportData {
  tenant: { name: string; logoDataUri?: string };
  title: string;
  preparedFor?: string;
  preparedBy: { name: string; email: string };
  period: { startDate: string; endDate: string; label: string; days: number };
  generatedAt: string;
  sections: {
    metrics: boolean;
    trend: boolean;
    distribution: boolean;
    byZone: boolean;
    furniture: boolean;
    ranking: boolean;
    table: boolean;
  };
  kpis: KpiRow[];
  furniture: FurnitureRow[];
  ranking: SellerRow[];
  byZone: ZoneRow[];
  table: TableRow[];
  trend: { labels: string[]; data: number[] };
  distribution: { labels: string[]; data: number[]; colors: string[] };
  totals: { visits: number; captures: number; sales: number; avgScore: number };
  hasData: boolean;
}

@Injectable()
export class GeneralReportService {
  private readonly logger = new Logger(GeneralReportService.name);
  private logoDataUriCache?: string;

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly reportsService: ReportsService,
    private readonly pdfService: PdfService,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

  async generatePdf(filters: GeneralReportFilterDto, user: any): Promise<{ buffer: Buffer; filename: string }> {
    const data = await this.buildReportData(filters, user);
    const buffer = await this.pdfService.render({
      template: 'general-report',
      data,
      waitForChartsMs: 500,
      pageOptions: { format: 'A4', margin: { top: '0', right: '0', bottom: '0', left: '0' } },
    });
    const period = `${filters.startDate || 'inicio'}_${filters.endDate || 'hoy'}`;
    return { buffer, filename: `reporte_ejecutivo_${period}.pdf` };
  }

  private async buildReportData(filters: GeneralReportFilterDto, user: any): Promise<GeneralReportData> {
    const tenantId: string | undefined = user?.tenant_id || this.tenantContext?.get()?.tenantId;
    const tenant = await this.loadTenant(tenantId);

    const sectionsList = filters.sections && filters.sections.length > 0
      ? filters.sections
      : ['metrics', 'trend', 'distribution', 'byZone', 'furniture', 'ranking', 'table'];

    const sections = {
      metrics: sectionsList.includes('metrics'),
      trend: sectionsList.includes('trend'),
      distribution: sectionsList.includes('distribution'),
      byZone: sectionsList.includes('byZone'),
      furniture: sectionsList.includes('furniture'),
      ranking: sectionsList.includes('ranking'),
      table: sectionsList.includes('table'),
    };

    const reportsData = await this.reportsService.getFilteredData(
      {
        startDate: filters.startDate,
        endDate: filters.endDate,
        zone: filters.zone,
        supervisorId: filters.supervisorId,
        userIds: filters.userIds,
        userId: filters.userId,
        include: 'products',
        pageSize: '500',
      },
      user,
    );

    const metrics = (reportsData.metrics || {}) as any;
    const rows = (reportsData.rows || []) as any[];

    const kpiRanges = filters.kpiRanges && filters.kpiRanges.length > 0
      ? filters.kpiRanges
      : this.defaultKpiRanges();

    const kpis = this.computeKpis(metrics, kpiRanges);

    const conceptCounts = this.aggregateFurnitureFromRows(rows);
    const furnitureTargets = filters.furnitureTargets && filters.furnitureTargets.length > 0
      ? filters.furnitureTargets
      : this.defaultFurnitureTargets();
    const furniture = this.computeFurniture(conceptCounts, furnitureTargets);

    const ranking = this.computeRanking(rows, kpiRanges);
    const byZone = this.computeByZone(rows, kpiRanges);

    const trend = this.computeTrend(reportsData.trendData || []);
    const distribution = this.computeDistribution(rows);
    const table = this.computeTable(rows, kpiRanges);

    const totals = {
      visits: Number(metrics.totalVisitas || 0),
      captures: Number(metrics.count || 0),
      sales: Number(metrics.totalVentas || 0),
      avgScore: Number(metrics.avgScore || 0),
    };

    const period = this.buildPeriod(filters.startDate, filters.endDate, reportsData.trendData?.length || 0);

    return {
      tenant: { name: tenant.name, logoDataUri: await this.getLogoDataUri() },
      title: filters.title || 'Reporte Ejecutivo',
      preparedFor: filters.preparedFor,
      preparedBy: { name: user?.name || user?.username || 'Equipo Trade Marketing', email: user?.email || '' },
      period,
      generatedAt: new Date().toISOString(),
      sections,
      kpis,
      furniture,
      ranking,
      byZone,
      table,
      trend,
      distribution,
      totals,
      hasData: totals.captures > 0,
    };
  }

  private computeKpis(metrics: any, ranges: KpiRangeDto[]): KpiRow[] {
    const defs: Array<{ id: string; label: string; raw: number; fmt: (v: number) => string; unit: string }> = [
      { id: 'visitas', label: 'Visitas', raw: Number(metrics.totalVisitas || 0), fmt: v => v.toLocaleString('es-MX'), unit: '' },
      { id: 'score', label: 'Score promedio', raw: Number(metrics.avgScore || 0), fmt: v => `${Math.round(v)} pts`, unit: 'pts' },
      { id: 'venta', label: 'Impacto venta', raw: Number(metrics.totalVentas || 0), fmt: v => `$${v.toLocaleString('es-MX')}`, unit: '$' },
      { id: 'exhibiciones', label: 'Exhibiciones', raw: Number(metrics.totalExhibiciones || 0), fmt: v => v.toLocaleString('es-MX'), unit: '' },
      { id: 'avgVenta', label: 'Venta promedio', raw: Number(metrics.avgVentaPorVisita || 0), fmt: v => `$${v.toLocaleString('es-MX')}`, unit: '$' },
      { id: 'stockoutRate', label: 'Productos/visita', raw: Number(metrics.stockoutRate || 0), fmt: v => `${v}`, unit: '' },
      { id: 'healthRate', label: 'Health rate', raw: Number(metrics.healthRate || 0), fmt: v => `${v}%`, unit: '%' },
      { id: 'uniqueProducts', label: 'Productos únicos', raw: Number(metrics.uniqueProducts || 0), fmt: v => v.toLocaleString('es-MX'), unit: '' },
    ];

    const byId: Record<string, KpiRangeDto> = {};
    for (const r of ranges) byId[r.id] = r;

    return defs.map(d => {
      const range = byId[d.id];
      const status = this.statusFor(range, d.raw);
      const pct = this.progressPct(range, d.raw);
      const prevRaw = metrics['prev_' + d.id];
      const hasPrev = typeof prevRaw === 'number' && Number.isFinite(prevRaw) && prevRaw !== 0;
      const diff = hasPrev ? Math.round(((d.raw - prevRaw) / prevRaw) * 100) : null;
      const meta = range ? `${range.opt}${d.unit}` : '—';
      return {
        id: d.id,
        label: d.label,
        value: d.fmt(d.raw),
        rawNumber: d.raw,
        meta,
        rag: status,
        pct,
        delta: diff === null ? undefined : diff === 0 ? 'Sin variación' : (diff > 0 ? `+${diff}% vs anterior` : `${diff}% vs anterior`),
        deltaDir: diff === null ? 'flat' : diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
      } as KpiRow;
    });
  }

  private statusFor(range: KpiRangeDto | undefined, value: number): Rag {
    if (!range) return 'amber';
    const v = Number(value) || 0;
    if (range.inverse) {
      if (v <= range.opt) return 'green';
      if (v <= range.min) return 'amber';
      return 'red';
    }
    if (v >= range.opt) return 'green';
    if (v >= range.min) return 'amber';
    return 'red';
  }

  private progressPct(range: KpiRangeDto | undefined, value: number): number {
    if (!range || !range.opt) return 0;
    const v = Number(value) || 0;
    if (range.inverse) {
      if (v <= range.opt) return 100;
      if (v >= range.min) return 0;
      const span = range.min - range.opt;
      if (span <= 0) return 0;
      return Math.max(0, Math.round((1 - (v - range.opt) / span) * 100));
    }
    return Math.min(100, Math.round((v / range.opt) * 100));
  }

  private aggregateFurnitureFromRows(rows: any[]): Record<string, number> {
    const counts: Record<string, number> = {
      vitrina: 0, exhibidor: 0, vitrolero: 0, paletero: 0, tira: 0, otros: 0,
    };
    for (const r of rows) {
      const ex = Array.isArray(r.exhibiciones) ? r.exhibiciones : [];
      for (const e of ex) {
        const name = String(e.conceptoNombre || e.concepto || '').toLowerCase();
        if (name.includes('vitrina')) counts.vitrina++;
        else if (name.includes('exhibidor')) counts.exhibidor++;
        else if (name.includes('vitrolero')) counts.vitrolero++;
        else if (name.includes('paletero')) counts.paletero++;
        else if (name.includes('tira')) counts.tira++;
        else counts.otros++;
      }
    }
    return counts;
  }

  private computeFurniture(counts: Record<string, number>, targets: FurnitureTargetDto[]): FurnitureRow[] {
    return targets.map(t => {
      const current = counts[t.id] ?? 0;
      const progressPct = t.target > 0 ? Math.min(100, Math.round((current / t.target) * 100)) : 0;
      let rag: Rag = 'red';
      if (current >= t.target) rag = 'green';
      else if (current >= Math.round(t.target * 0.8)) rag = 'amber';
      return { id: t.id, label: t.label, current, target: t.target, progressPct, rag };
    });
  }

  private computeRanking(rows: any[], ranges: KpiRangeDto[]): SellerRow[] {
    const scoreRange = ranges.find(r => r.id === 'score');
    const byUser: Record<string, { username: string; visits: number; scoreSum: number; captures: number }> = {};
    for (const r of rows) {
      // Ranking = leaderboard de scoring. Las capturas de vendedor
      // (skip_scoring, score 0) no participan del ranking de colaboradores.
      if (r.skip_scoring) continue;
      const user = r.captured_by_username || 'desconocido';
      if (!byUser[user]) byUser[user] = { username: user, visits: 0, scoreSum: 0, captures: 0 };
      const stats = typeof r.stats === 'string' ? JSON.parse(r.stats) : r.stats || {};
      byUser[user].captures += 1;
      byUser[user].visits += Number(stats.totalExhibiciones || 0);
      byUser[user].scoreSum += Number(stats.puntuacionTotal || 0);
    }
    const list = Object.values(byUser)
      .map(u => ({ ...u, avgScore: u.captures > 0 ? Math.round(u.scoreSum / u.captures) : 0 }))
      .sort((a, b) => b.avgScore - a.avgScore || b.visits - a.visits)
      .slice(0, 15);

    return list.map((u, i) => {
      const rag = this.statusFor(scoreRange, u.avgScore);
      let stars = '★';
      if (u.avgScore >= 90) stars = '★★★★★';
      else if (u.avgScore >= 80) stars = '★★★★';
      else if (u.avgScore >= 70) stars = '★★★';
      else if (u.avgScore >= 60) stars = '★★';
      return {
        rank: i + 1,
        username: u.username,
        visits: u.visits,
        avgScore: u.avgScore,
        stars,
        rag,
      };
    });
  }

  private computeByZone(rows: any[], ranges: KpiRangeDto[]): ZoneRow[] {
    const scoreRange = ranges.find(r => r.id === 'score');
    const byZone: Record<string, { visits: number; scoreSum: number; scoredCaptures: number; sales: number }> = {};
    for (const r of rows) {
      const zone = r.zona_captura || 'Sin zona';
      if (!byZone[zone]) byZone[zone] = { visits: 0, scoreSum: 0, scoredCaptures: 0, sales: 0 };
      const stats = typeof r.stats === 'string' ? JSON.parse(r.stats) : r.stats || {};
      byZone[zone].visits += Number(stats.totalExhibiciones || 0);
      byZone[zone].sales += Number(stats.ventaTotal || stats.ventaAdicional || 0);
      // El promedio de score excluye capturas de vendedor (skip_scoring).
      if (!r.skip_scoring) {
        byZone[zone].scoreSum += Number(stats.puntuacionTotal || 0);
        byZone[zone].scoredCaptures += 1;
      }
    }
    return Object.entries(byZone)
      .map(([zone, v]) => ({
        zone,
        visits: v.visits,
        avgScore: v.scoredCaptures > 0 ? Math.round(v.scoreSum / v.scoredCaptures) : 0,
        totalSales: v.sales,
        rag: this.statusFor(scoreRange, v.scoredCaptures > 0 ? v.scoreSum / v.scoredCaptures : 0),
      }))
      .sort((a, b) => b.avgScore - a.avgScore);
  }

  private computeTrend(trendData: Array<{ date: string; visits: number; avgScore: number }>): { labels: string[]; data: number[] } {
    return {
      labels: trendData.map(d => this.shortDate(d.date)),
      data: trendData.map(d => Number(d.avgScore || 0)),
    };
  }

  private computeDistribution(rows: any[]): { labels: string[]; data: number[]; colors: string[] } {
    const buckets = { excelente: 0, bueno: 0, regular: 0, deficiente: 0 };
    for (const r of rows) {
      // Distribución de scoring: excluye capturas de vendedor (skip_scoring),
      // que caerían todas en "Deficiente" al tener score 0.
      if (r.skip_scoring) continue;
      const stats = typeof r.stats === 'string' ? JSON.parse(r.stats) : r.stats || {};
      const score = Number(stats.puntuacionTotal || 0);
      if (score >= 85) buckets.excelente++;
      else if (score >= 70) buckets.bueno++;
      else if (score >= 50) buckets.regular++;
      else buckets.deficiente++;
    }
    return {
      labels: ['Excelente (≥85)', 'Bueno (70-84)', 'Regular (50-69)', 'Deficiente (<50)'],
      data: [buckets.excelente, buckets.bueno, buckets.regular, buckets.deficiente],
      colors: ['#16a34a', '#84cc16', '#f59e0b', '#dc2626'],
    };
  }

  private computeTable(rows: any[], ranges: KpiRangeDto[]): TableRow[] {
    const scoreRange = ranges.find(r => r.id === 'score');
    return rows.slice(0, 50).map(r => {
      const stats = typeof r.stats === 'string' ? JSON.parse(r.stats) : r.stats || {};
      const score = Math.round(Number(stats.puntuacionTotal || 0));
      const rag = this.statusFor(scoreRange, score);
      const status: 'OK' | 'REGULAR' | 'BAJO' = rag === 'green' ? 'OK' : rag === 'amber' ? 'REGULAR' : 'BAJO';
      const dateKey = toMxDateKey(r.fecha) || toMxDateKey(r.hora_inicio) || '';
      return {
        folio: String(r.folio || '').slice(0, 12),
        date: dateKey,
        user: String(r.captured_by_username || '').slice(0, 25),
        zone: String(r.zona_captura || '').slice(0, 20),
        score,
        status,
        rag,
        sales: Number(stats.ventaTotal || stats.ventaAdicional || 0),
      };
    });
  }

  private defaultKpiRanges(): KpiRangeDto[] {
    return [
      { id: 'score', label: 'Score Global', unit: 'pts', min: 65, opt: 80 },
      { id: 'visitas', label: 'Visitas', unit: '', min: 20, opt: 50 },
      { id: 'venta', label: 'Impacto venta', unit: '$', min: 5000, opt: 20000 },
      { id: 'exhibiciones', label: 'Exhibiciones', unit: '', min: 50, opt: 150 },
      { id: 'avgVenta', label: 'Venta promedio', unit: '$', min: 100, opt: 300 },
      { id: 'stockoutRate', label: 'Productos/visita', unit: '', min: 1, opt: 3 },
      { id: 'healthRate', label: 'Health rate', unit: '%', min: 50, opt: 80 },
      { id: 'uniqueProducts', label: 'Productos únicos', unit: '', min: 10, opt: 30 },
    ];
  }

  private defaultFurnitureTargets(): FurnitureTargetDto[] {
    return [
      { id: 'vitrina', label: 'Vitrinas', target: 50 },
      { id: 'exhibidor', label: 'Exhibidores', target: 40 },
      { id: 'vitrolero', label: 'Vitroleros', target: 30 },
      { id: 'paletero', label: 'Paleteros', target: 25 },
      { id: 'tira', label: 'Tiras', target: 60 },
    ];
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
        this.logoDataUriCache = `data:image/png;base64,${buf.toString('base64')}`;
        return this.logoDataUriCache;
      } catch { /* try next */ }
    }
    this.logoDataUriCache = '';
    return undefined;
  }

  private shortDate(s: string): string {
    if (!s) return '';
    const parts = s.split('-');
    if (parts.length !== 3) return s;
    const m = Number(parts[1]);
    const meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    return `${parts[2]} ${meses[m - 1] || ''}`;
  }

  private buildPeriod(start?: string, end?: string, trendLen = 0): { startDate: string; endDate: string; label: string; days: number } {
    const label = !start && !end
      ? 'Periodo completo'
      : start && end && start === end
        ? this.fullDate(start)
        : `${start ? this.fullDate(start) : 'inicio'} — ${end ? this.fullDate(end) : 'hoy'}`;
    const days = start && end
      ? Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86400000) + 1)
      : trendLen;
    return { startDate: start || '', endDate: end || '', label, days };
  }

  private fullDate(s: string): string {
    try {
      const d = new Date(s);
      return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
    } catch {
      return s;
    }
  }
}
