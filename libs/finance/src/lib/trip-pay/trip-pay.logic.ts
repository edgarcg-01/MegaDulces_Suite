/**
 * `[EMB.29]` — Reglas puras del vale de comisiones y viáticos de logística (ADR-091).
 *
 * El corte es CATORCENAL de jueves a miércoles, anclado en el jueves 1-ene-2026 (el calendario
 * que ya siembra `logistics_baseline.js`). Se paga el viernes siguiente: medido en Kepler, los
 * gastos por persona de 075/128 se ejercen en viernes (17-jul, 31-jul, 14-ago, 28-ago, 11-sep,
 * 25-sep), justo dos días después de cada cierre.
 */
import type { ConceptoPago, PagoViaje } from '@megadulces/contracts';
import { CONCEPTO_KEPLER, totalesPorConcepto } from '@megadulces/contracts';

const ANCLA = Date.UTC(2026, 0, 1); // jueves 1-ene-2026
const DIA = 86_400_000;

export interface Corte {
  desde: string; // jueves
  hasta: string; // miércoles
  pago: string;  // viernes
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** El corte de 14 días que contiene `fecha` (YYYY-MM-DD). */
export function corteDe(fecha: string): Corte {
  const t = Date.parse(fecha + 'T00:00:00Z');
  if (Number.isNaN(t)) throw new Error(`fecha inválida: ${fecha}`);
  const n = Math.floor((t - ANCLA) / (14 * DIA));
  const desde = ANCLA + n * 14 * DIA;
  return { desde: iso(desde), hasta: iso(desde + 13 * DIA), pago: iso(desde + 15 * DIA) };
}

/** El último corte que ya cerró (el que se paga ahora) visto desde `hoy`. */
export function corteAPagar(hoy: string): Corte {
  const actual = corteDe(hoy);
  return corteDe(iso(Date.parse(actual.desde + 'T00:00:00Z') - DIA));
}

export function esFecha(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
}

export interface ResumenPersona {
  driver_id: string;
  persona: string;
  roles: string[];
  viajes: number;
  cargas: number;
  liberado: Record<ConceptoPago, number>;
  liberado_total: number;
  retenido_total: number;
  retenidos: number;
  en_vale_total: number;
  vales: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Agrupa los renglones por persona: lo que se puede pagar, lo retenido y lo que ya está en vale. */
export function resumenPorPersona(items: PagoViaje[]): ResumenPersona[] {
  const by = new Map<string, PagoViaje[]>();
  for (const i of items) {
    if (i.estado_viaje === 'cancelado') continue;
    const l = by.get(i.driver_id) ?? [];
    l.push(i);
    by.set(i.driver_id, l);
  }
  const out: ResumenPersona[] = [];
  for (const [driver_id, l] of by) {
    const pagable = l.filter((i) => i.liberado && !i.en_vale);
    const retenido = l.filter((i) => !i.liberado);
    const enVale = l.filter((i) => i.en_vale);
    const liberado = totalesPorConcepto(pagable);
    out.push({
      driver_id,
      persona: l[0].persona,
      roles: [...new Set(l.map((i) => i.rol))].sort(),
      viajes: new Set(pagable.filter((i) => i.source === 'guia').map((i) => i.source_id)).size,
      cargas: new Set(pagable.filter((i) => i.source === 'carga').map((i) => i.source_id)).size,
      liberado,
      liberado_total: r2(liberado.comision + liberado.viatico + liberado.maniobra_carga),
      retenido_total: r2(retenido.reduce((s, i) => s + Number(i.amount), 0)),
      retenidos: new Set(retenido.map((i) => i.source_id)).size,
      en_vale_total: r2(enVale.reduce((s, i) => s + Number(i.amount), 0)),
      vales: [...new Set(enVale.map((i) => i.expense_proof_id).filter((v): v is string => !!v))],
    });
  }
  return out.sort((a, b) => b.liberado_total - a.liberado_total || a.persona.localeCompare(b.persona));
}

/** El texto del vale (va en «concepto» y en la nota de comprobación que pide la aprobación). */
export function conceptoDelVale(persona: string, corte: { desde: string; hasta: string }, items: PagoViaje[]): string {
  const t = totalesPorConcepto(items);
  const viajes = new Set(items.filter((i) => i.source === 'guia').map((i) => i.source_id)).size;
  const cargas = new Set(items.filter((i) => i.source === 'carga').map((i) => i.source_id)).size;
  const partes = (Object.keys(t) as ConceptoPago[])
    .filter((c) => t[c] > 0)
    .map((c) => `${CONCEPTO_KEPLER[c].codigo} ${CONCEPTO_KEPLER[c].nombre} $${t[c].toFixed(2)}`);
  const que = [viajes ? `${viajes} viaje${viajes === 1 ? '' : 's'} cerrado${viajes === 1 ? '' : 's'}` : '',
    cargas ? `${cargas} carga${cargas === 1 ? '' : 's'}` : ''].filter(Boolean).join(' y ');
  return `Comisiones y viáticos de logística de ${persona}, corte ${corte.desde} a ${corte.hasta}: ${que}. ${partes.join(' · ')}.`;
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n: number) => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** La hoja de respaldo del vale: qué viajes y cargas se pagan, con lo que los cerró. */
export function htmlHojaDeViajes(persona: string, corte: Corte, items: PagoViaje[], preparo: string, generado: string): string {
  const t = totalesPorConcepto(items);
  const total = r2(t.comision + t.viatico + t.maniobra_carga);
  const filas = [...items]
    .sort((a, b) => a.shipment_date.localeCompare(b.shipment_date) || a.shipment_folio.localeCompare(b.shipment_folio))
    .map((i) => `<tr>
      <td>${esc(i.shipment_date)}</td>
      <td>${esc(i.shipment_folio)}${i.kepler_guia ? `<br><span class="m">Guía Kepler ${esc(i.kepler_sucursal)}-${esc(i.kepler_guia)}</span>` : ''}</td>
      <td>${esc(i.rol)}</td>
      <td>${esc(CONCEPTO_KEPLER[i.concept].codigo)} ${esc(CONCEPTO_KEPLER[i.concept].nombre)}</td>
      <td>${esc(i.motivo)}</td>
      <td class="r">${money(i.amount)}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
    body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#111;margin:28px}
    h1{font-size:16px;margin:0 0 4px} .m{color:#555;font-size:10px}
    table{width:100%;border-collapse:collapse;margin-top:12px} th,td{border-bottom:1px solid #ddd;padding:5px;text-align:left;vertical-align:top}
    th{background:#f4f4f5;font-size:10px} .r{text-align:right} .tot td{font-weight:bold;border-top:2px solid #111}
    .firmas{display:flex;gap:24px;margin-top:48px} .firmas div{flex:1;border-top:1px solid #111;padding-top:4px;text-align:center}
  </style></head><body>
    <h1>Comisiones y viáticos de logística</h1>
    <div><b>${esc(persona)}</b> · corte ${esc(corte.desde)} a ${esc(corte.hasta)} · pago ${esc(corte.pago)}</div>
    <div class="m">Sólo incluye viajes cerrados (cada parada con su recepción en Kepler o su remisión firmada) y cargas registradas en Kepler. Cada viaje se paga una sola vez.</div>
    <table><thead><tr><th>Fecha</th><th>Embarque</th><th>Papel</th><th>Concepto Kepler</th><th>Cierre</th><th class="r">Importe</th></tr></thead>
    <tbody>${filas}
      <tr class="tot"><td colspan="5">075 ${money(t.comision)} · 128 ${money(t.viatico)} · 186 ${money(t.maniobra_carga)}</td><td class="r">${money(total)}</td></tr>
    </tbody></table>
    <div class="firmas"><div>Preparó: ${esc(preparo)}</div><div>Autorizó</div><div>Recibí: ${esc(persona)}</div></div>
    <div class="m" style="margin-top:16px">Generado ${esc(generado)} en la Suite.</div>
  </body></html>`;
}
