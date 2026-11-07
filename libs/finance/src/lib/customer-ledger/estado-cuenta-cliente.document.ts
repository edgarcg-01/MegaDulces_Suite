import * as fs from 'fs';
import * as path from 'path';
import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { esc, htmlAPdf, money } from '../shared/chromium-pdf';
import { CustomerLedgerService } from './customer-ledger.service';

/** RFCs genéricos del SAT: no son el RFC del cliente y no se imprimen como si lo fueran. */
const RFC_GENERICOS = new Set(['XAXX010101000', 'XEXX010101000']);
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** Lo que este documento lee del auxiliar (`CustomerLedgerService.detalle`). */
interface PartidaEC {
  doc_label: string; folio_digital: string; fecha: string | null; vencimiento: string | null;
  importe: number; saldo_documento: number; dias_vencido: number | null; vencida: boolean; saldada: boolean;
}
export interface DetalleEC {
  hoy: string;
  cliente: {
    sucursal: string; cliente_code: string; cliente_nombre: string; rfc: string | null;
    vendedor: string | null; vendedor_nombre: string | null; limite_credito: number | null; dias_credito: number | null;
  };
  saldo: number; vencido: number; saldo_a_favor: number; sin_documento: number;
  partidas: PartidaEC[];
}
export interface EmisorEC { nombre: string; rfc: string }

/** Antigüedad del saldo abierto, en los cortes que usa Cobranza. */
export function antiguedad(partidas: PartidaEC[]): { etiqueta: string; monto: number }[] {
  const t = [
    { etiqueta: 'Por vencer', monto: 0 }, { etiqueta: '1 a 30 días', monto: 0 },
    { etiqueta: '31 a 60 días', monto: 0 }, { etiqueta: '61 a 90 días', monto: 0 },
    { etiqueta: 'Más de 90 días', monto: 0 },
  ];
  for (const p of partidas) {
    if (p.saldada) continue;
    const d = p.vencida ? p.dias_vencido ?? 0 : 0;
    const i = !p.vencida ? 0 : d <= 30 ? 1 : d <= 60 ? 2 : d <= 90 ? 3 : 4;
    t[i].monto = Math.round((t[i].monto + p.saldo_documento) * 100) / 100;
  }
  return t;
}

const fechaCorta = (f: string | null) => (f ? `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}` : '—');
const fechaLarga = (f: string) => `${Number(f.slice(8, 10))} de ${MESES[Number(f.slice(5, 7)) - 1]} de ${f.slice(0, 4)}`;

/**
 * `[CXC.40]` Estado de cuenta del cliente en PDF — el documento que se le ENTREGA.
 *
 * Sale del MISMO auxiliar que el diálogo de `/finanzas/cartera` (`CustomerLedgerService.detalle`):
 * lo que el operador ve en pantalla es lo que el cliente recibe, sin una segunda consulta que
 * pueda contar distinto. El saldo es el del cliente en la cartera (`kdue`); las facturas abiertas
 * suman `saldo − sin_documento`, y esa diferencia se imprime como renglón propio para que la
 * tabla cuadre al centavo con el total (cada peso, una explicación).
 *
 * Qué NO lleva: notas internas (de dónde sale el dato, `kdm5`, Kepler), compromisos de pago ni
 * datos de cobranza — es un documento para el cliente, no el expediente de Cobranza.
 *
 * Usa el Chromium compartido (`shared/chromium-pdf` → `platform-core`). ⬜ Deuda nombrada: el
 * cargador del logo repite el de `AnexoVentaService.logo()` (commercial); debe subir junto al
 * Chromium compartido cuando lo pida un tercer documento.
 */
@Injectable()
export class EstadoCuentaClienteDocument {
  private logoCache?: string;

  constructor(
    private readonly ledger: CustomerLedgerService,
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async render(sucursal: string, cliente: string): Promise<{ pdf: Buffer; nombre: string }> {
    const det = (await this.ledger.detalle(sucursal, cliente)) as unknown as DetalleEC;
    if (!det?.cliente) throw new NotFoundException(`No hay cartera del cliente ${cliente} en esa sucursal.`);
    const emisor = await this.emisor();
    const pdf = await htmlAPdf(this.html(det, emisor, this.logo()), { footer: this.pie(det, emisor) });
    return { pdf, nombre: `estado-de-cuenta-${det.cliente.cliente_code}-${det.hoy}.pdf` };
  }

  /** Identidad fiscal del emisor: sin RFC y razón social verificados no se emite un documento al cliente. */
  private async emisor(): Promise<EmisorEC> {
    const tenantId = this.tenantCtx.requireTenantId();
    const row = await this.tk.run((trx) => trx('fiscal.issuer_config')
      .where({ tenant_id: tenantId, active: true })
      .orderBy('is_default', 'desc')
      .first('rfc', 'tax_name'));
    if (!row?.rfc || !row?.tax_name) {
      throw new NotFoundException('No hay identidad fiscal configurada (fiscal.issuer_config): el estado de cuenta no se emite sin RFC y razón social.');
    }
    return { nombre: String(row.tax_name).trim(), rfc: String(row.rfc).trim().toUpperCase() };
  }

  private logo(): string {
    if (this.logoCache !== undefined) return this.logoCache;
    for (const f of ['mega-dulces-logo-print.png', 'mega-dulces-logo.png']) {
      try {
        const p = path.join(process.cwd(), 'apps', 'view', 'src', 'assets', 'logos', f);
        this.logoCache = `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
        return this.logoCache;
      } catch { /* siguiente */ }
    }
    this.logoCache = '';
    return this.logoCache;
  }

  private pie(det: DetalleEC, emisor: EmisorEC): string {
    const t = esc(`Estado de cuenta · ${det.cliente.cliente_nombre} (${det.cliente.cliente_code}) · corte al ${fechaCorta(det.hoy)} · ${emisor.nombre}`);
    return `<div style="width:100%;font-family:'Segoe UI',Arial,sans-serif;font-size:7pt;color:#8a8078;
      padding:0 12mm;display:flex;justify-content:space-between;align-items:center;">
      <span>${t}</span><span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>`;
  }

  /** `public` para probarlo sin Chromium: es el documento entero, menos la conversión. */
  html(det: DetalleEC, emisor: EmisorEC, logo = ''): string {
    const c = det.cliente;
    const abiertas = det.partidas
      .filter((p) => !p.saldada)
      .sort((a, b) => String(a.fecha ?? '').localeCompare(String(b.fecha ?? '')) || a.folio_digital.localeCompare(b.folio_digital));
    // Lo que NO está vencido y SÍ tiene factura. No es `saldo − vencido`: eso mete en «por vencer»
    // lo que ninguna factura explica, y la tarjeta dejaba de coincidir con la antigüedad de abajo.
    // Ese resto se declara en el saldo total y tiene su renglón en la tabla.
    const porVencer = Math.round(abiertas.filter((p) => !p.vencida).reduce((s, p) => s + p.saldo_documento, 0) * 100) / 100;
    const nVencidas = abiertas.filter((p) => p.vencida).length;
    const totImporte = abiertas.reduce((s, p) => s + p.importe, 0);
    const totSaldo = abiertas.reduce((s, p) => s + p.saldo_documento, 0);
    const rfc = c.rfc && !RFC_GENERICOS.has(c.rfc.trim().toUpperCase()) ? c.rfc.trim() : null;
    const vendedor = c.vendedor_nombre || c.vendedor;
    const aging = antiguedad(det.partidas);
    const maxAging = Math.max(...aging.map((a) => a.monto), 1);

    const filas = abiertas.map((p) => {
      const abonos = Math.round((p.importe - p.saldo_documento) * 100) / 100;
      const situ = p.vencida
        ? `<span class="venc">Vencida · ${p.dias_vencido} día${p.dias_vencido === 1 ? '' : 's'}</span>`
        : `<span class="ok">Al corriente</span>`;
      return `<tr>
        <td>${esc(p.doc_label)}</td><td class="mono">${esc(p.folio_digital)}</td>
        <td class="mono">${fechaCorta(p.fecha)}</td><td class="mono">${fechaCorta(p.vencimiento)}</td>
        <td class="r mono">${money(p.importe)}</td><td class="r mono">${abonos > 0.005 ? money(abonos) : '—'}</td>
        <td class="r mono b">${money(p.saldo_documento)}</td><td>${situ}</td></tr>`;
    }).join('');
    // Lo que el saldo del cliente tiene y ninguna factura explica: renglón propio, nunca escondido.
    const ajuste = Math.abs(det.sin_documento) > 0.005
      ? `<tr class="ajuste"><td colspan="6">${det.sin_documento > 0 ? 'Saldo no asignado a una factura' : 'Pagos no asignados a una factura'}</td>
          <td class="r mono b">${det.sin_documento > 0 ? '' : '−'}${money(Math.abs(det.sin_documento))}</td><td></td></tr>`
      : '';

    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
:root{--ink:#1c1917;--ink-2:#44403c;--muted:#78716c;--line:#e7e5e4;--soft:#f5f5f4;--accent:#c2410c;--bad:#b91c1c;--good:#15803d}
*{box-sizing:border-box}
body{margin:0;padding:0 3mm;font-family:'Segoe UI',Arial,sans-serif;font-size:8.5pt;color:var(--ink);font-variant-numeric:tabular-nums}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:8mm;padding-bottom:4mm;border-bottom:2px solid var(--accent)}
.marca{display:flex;align-items:center;gap:4mm}
.marca img{height:16mm}
.emisor b{display:block;font-size:10pt}
.emisor{font-size:7.5pt;color:var(--ink-2);line-height:1.35}
.titulo{text-align:right}
.titulo h1{margin:0;font-size:17pt;letter-spacing:-.01em}
.titulo .corte{font-size:8.5pt;color:var(--ink-2);margin-top:1mm}
.cli{display:grid;grid-template-columns:1.4fr 1fr;gap:6mm;margin:5mm 0 4mm}
.cli .nom{font-size:12pt;font-weight:700;margin-bottom:1mm}
.kv{display:grid;grid-template-columns:auto 1fr;gap:.6mm 3mm;font-size:8pt}
.kv dt{color:var(--muted)}.kv dd{margin:0;font-weight:600}
.res{display:grid;grid-template-columns:repeat(${det.saldo_a_favor > 0 ? 4 : 3},1fr);border:1px solid var(--line);border-radius:2mm;overflow:hidden;margin-bottom:4mm}
.res>div{padding:3mm 4mm;border-right:1px solid var(--line)}
.res>div:last-child{border-right:0}
.res .l{font-size:7pt;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}
.res .v{font-size:14pt;font-weight:700;margin-top:1mm}
.res .s{font-size:7.5pt;color:var(--muted)}
.res .total{background:var(--soft)}
.res .bad .v{color:var(--bad)}
h2{font-size:9pt;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-2);margin:4mm 0 2mm}
.aging{display:grid;grid-template-columns:repeat(5,1fr);gap:2mm;margin-bottom:4mm}
.aging .l{font-size:7pt;color:var(--muted)}
.aging .v{font-weight:700;font-size:9pt;margin:.5mm 0 1mm}
.aging .bar{height:1.6mm;background:var(--soft);border-radius:1mm;overflow:hidden}
.aging .bar i{display:block;height:100%;background:var(--accent)}
.aging .bar i.p{background:var(--good)}
table{width:100%;border-collapse:collapse}
thead th{font-size:7pt;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);text-align:left;padding:1.6mm 1.5mm;border-bottom:1.5px solid var(--ink)}
tbody td{padding:1.5mm;border-bottom:1px solid var(--line);vertical-align:top}
tr{page-break-inside:avoid}
thead{display:table-header-group}
tr.total td{padding:2mm 1.5mm;border-top:1.5px solid var(--ink);border-bottom:0;font-weight:700}
.r{text-align:right}.mono{font-family:Consolas,'Courier New',monospace;font-size:8pt}.b{font-weight:700}
.venc{color:var(--bad);font-weight:600}.ok{color:var(--good)}
.ajuste td{font-style:italic;color:var(--ink-2)}
.nota{margin-top:5mm;padding:3mm 4mm;background:var(--soft);border-radius:2mm;font-size:8pt;color:var(--ink-2);line-height:1.45}
.vacio{padding:6mm;text-align:center;color:var(--muted)}
</style></head><body>
<div class="head">
  <div class="marca">${logo ? `<img src="${logo}" alt="">` : ''}
    <div class="emisor"><b>${esc(emisor.nombre)}</b>RFC ${esc(emisor.rfc)}</div></div>
  <div class="titulo"><h1>Estado de cuenta</h1><div class="corte">Corte al ${fechaLarga(det.hoy)}</div></div>
</div>
<div class="cli">
  <div><div class="nom">${esc(c.cliente_nombre)}</div>
    <dl class="kv"><dt>Cliente</dt><dd>${esc(c.cliente_code)}</dd>
      ${rfc ? `<dt>RFC</dt><dd>${esc(rfc)}</dd>` : ''}
      ${vendedor ? `<dt>Vendedor</dt><dd>${esc(vendedor)}</dd>` : ''}</dl></div>
  <div><dl class="kv">
      ${c.dias_credito ? `<dt>Plazo de crédito</dt><dd>${c.dias_credito} días</dd>` : ''}
      ${c.limite_credito ? `<dt>Línea de crédito</dt><dd>${money(c.limite_credito)}</dd>` : ''}
      <dt>Facturas abiertas</dt><dd>${abiertas.length}${nVencidas ? ` (${nVencidas} vencida${nVencidas === 1 ? '' : 's'})` : ''}</dd></dl></div>
</div>
<div class="res">
  <div class="total"><div class="l">Saldo total</div><div class="v">${money(det.saldo)}</div>
    ${Math.abs(det.sin_documento) > 0.005 ? `<div class="s">${det.sin_documento > 0 ? 'Incluye' : 'Descuenta'} ${money(Math.abs(det.sin_documento))} no asignado a una factura</div>` : ''}</div>
  <div class="${det.vencido > 0 ? 'bad' : ''}"><div class="l">Vencido</div><div class="v">${money(det.vencido)}</div>
    <div class="s">${nVencidas} factura${nVencidas === 1 ? '' : 's'}</div></div>
  <div><div class="l">Por vencer</div><div class="v">${money(porVencer)}</div></div>
  ${det.saldo_a_favor > 0 ? `<div><div class="l">Saldo a su favor</div><div class="v">${money(det.saldo_a_favor)}</div></div>` : ''}
</div>
${abiertas.length ? `<h2>Antigüedad del saldo</h2>
<div class="aging">${aging.map((a, i) => `<div><div class="l">${a.etiqueta}</div><div class="v">${money(a.monto)}</div>
  <div class="bar"><i class="${i === 0 ? 'p' : ''}" style="width:${Math.round((a.monto / maxAging) * 100)}%"></i></div></div>`).join('')}</div>` : ''}
<h2>Detalle de facturas abiertas</h2>
${abiertas.length ? `<table>
  <thead><tr><th>Documento</th><th>Folio</th><th>Fecha</th><th>Vence</th><th class="r">Importe</th><th class="r">Abonos</th><th class="r">Saldo</th><th>Situación</th></tr></thead>
  <tbody>${filas}${ajuste}
  <!-- El total es un renglón del cuerpo y no un tfoot: Chromium repite el tfoot al pie de CADA
       página, y en papel un «Total» antes de que terminen las facturas se lee como el total. -->
  <tr class="total"><td colspan="4">Total</td><td class="r mono">${money(totImporte)}</td><td class="r mono">${money(totImporte - totSaldo)}</td><td class="r mono">${money(det.saldo)}</td><td></td></tr></tbody>
</table>` : `<div class="vacio">Sin facturas pendientes a la fecha de corte.</div>`}
<div class="nota">Este estado de cuenta refleja los movimientos registrados al ${fechaLarga(det.hoy)}.
  Si ya realizó su pago, le pedimos enviarnos su comprobante para aplicarlo a su cuenta; si tiene
  alguna aclaración, con gusto la atendemos${vendedor ? ` con su vendedor, ${esc(vendedor)},` : ''} o en nuestra área de Crédito y Cobranza.</div>
</body></html>`;
  }
}
