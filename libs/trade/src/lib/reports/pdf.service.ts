import { Injectable, Logger } from '@nestjs/common';
import * as puppeteer from 'puppeteer';
import * as hbs from 'handlebars';
import * as fs from 'fs';
import * as path from 'path';

export interface RenderOptions {
  template: string;
  data: any;
  pageOptions?: Partial<puppeteer.PDFOptions>;
  waitForChartsMs?: number;
}

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);
  private templateCache: Record<string, HandlebarsTemplateDelegate> = {};

  constructor() {
    this.registerHelpers();
  }

  async generarReporte(datos: any): Promise<Buffer> {
    return this.render({ template: 'reporte', data: datos });
  }

  async render(opts: RenderOptions): Promise<Buffer> {
    const html = this.compile(opts.template)(opts.data);

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 2 });
      // puppeteer 24 angostó waitUntil de setContent a load/domcontentloaded;
      // el equivalente de networkidle0 ahora es waitForNetworkIdle aparte.
      await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 30000 }).catch(() => undefined);
      if (opts.waitForChartsMs && opts.waitForChartsMs > 0) {
        await new Promise(r => setTimeout(r, opts.waitForChartsMs));
      }
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
        preferCSSPageSize: true,
        ...(opts.pageOptions || {}),
      });
      return Buffer.from(pdfBuffer);
    } finally {
      await browser.close();
    }
  }

  private compile(templateName: string): HandlebarsTemplateDelegate {
    if (this.templateCache[templateName]) return this.templateCache[templateName];
    const templatePath = path.join(process.cwd(), 'apps', 'api', 'templates', `${templateName}.hbs`);
    const templateHtml = fs.readFileSync(templatePath, 'utf8');
    const compiled = hbs.compile(templateHtml);
    this.templateCache[templateName] = compiled;
    return compiled;
  }

  private registerHelpers() {
    hbs.registerHelper('fmtPct', (n: any, digits = 1) => {
      const v = Number(n);
      if (!Number.isFinite(v)) return '0.0%';
      return `${v.toFixed(typeof digits === 'number' ? digits : 1)}%`;
    });

    hbs.registerHelper('fmtNum', (n: any, digits = 0) => {
      const v = Number(n);
      if (!Number.isFinite(v)) return '0';
      const d = typeof digits === 'number' ? digits : 0;
      return v.toLocaleString('es-MX', { minimumFractionDigits: d, maximumFractionDigits: d });
    });

    hbs.registerHelper('fmtMoney', (n: any) => {
      const v = Number(n);
      if (!Number.isFinite(v)) return '$0.00';
      return v.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
    });

    hbs.registerHelper('fmtDate', (s: any) => {
      if (!s) return '';
      try {
        const d = new Date(s);
        if (isNaN(d.getTime())) return String(s);
        return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
      } catch {
        return String(s);
      }
    });

    hbs.registerHelper('ragClass', (rag: string) => {
      switch ((rag || '').toLowerCase()) {
        case 'green': return 'rag-green';
        case 'amber': return 'rag-amber';
        case 'red':   return 'rag-red';
        default:      return 'rag-neutral';
      }
    });

    hbs.registerHelper('ragHex', (rag: string) => {
      switch ((rag || '').toLowerCase()) {
        case 'green': return '#16a34a';
        case 'amber': return '#f59e0b';
        case 'red':   return '#dc2626';
        default:      return '#71717a';
      }
    });

    hbs.registerHelper('json', (obj: any) => new hbs.SafeString(JSON.stringify(obj || null)));

    hbs.registerHelper('inc', (i: any) => Number(i) + 1);

    hbs.registerHelper('eq', (a: any, b: any) => a === b);

    hbs.registerHelper('gt', (a: any, b: any) => Number(a) > Number(b));

    hbs.registerHelper('truncate', (s: any, n = 60) => {
      const str = String(s ?? '');
      const max = typeof n === 'number' ? n : 60;
      return str.length > max ? str.slice(0, max - 1) + '…' : str;
    });
  }
}
