/**
 * CS.3.8 — Comprobante de un movimiento de Caja General, en formato TICKET (impresora térmica).
 *
 * Se entrega firmado a quien recibe/entrega el efectivo. Trae, como pidió operación: el folio
 * NUESTRO (el de `finance.cash_ledger`, no el de Kepler), el desglose por denominación, el concepto,
 * quién recibió, el total y espacio para firma.
 *
 * Calcado de `modules/tienda/ticket-arqueo.ts` (misma térmica de 80 mm / área útil ~72 mm, misma
 * maquetación por CARACTERES en monoespaciada, misma impresión desde un iframe oculto sin
 * `window.open`). Los tickets del repo son módulos self-contained a propósito (ver la nota de
 * `shared/util/print-isolated.ts`): cada uno lleva su copia de estos helpers chicos.
 *
 * ⚠️ El tamaño de letra tiene techo ARITMÉTICO, no estético: a 14px una línea de 32 caracteres ocupa
 * el 99% de los 72 mm. NO subirlo sin bajar `ANCHO` en el mismo cambio (medido en ticket-arqueo).
 * ⚠️ El diálogo de impresión NO se puede saltar desde la web; para que salga solo, la máquina de la
 * caja abre el navegador en modo kiosco (`--kiosk-printing`). Config de una vez por equipo.
 */

export interface ComprobanteCaja {
  folio: string;                       // el NUESTRO (cash_ledger)
  tipo: 'ingreso' | 'gasto' | 'deposito' | string;
  fecha: string;
  sucursal: string;
  sucursal_nombre?: string | null;
  beneficiario?: string | null;
  kepler_cuenta?: string | null;
  kepler_concepto?: string | null;
  kepler_concepto_nombre?: string | null;
  glosa?: string | null;
  denominaciones: Array<{ denominacion: number; piezas: number }>;
  morralla?: number | null;
  monto: number;
  created_by_username?: string | null;
  created_at?: string | null;
}

const ANCHO = 32; // caracteres por línea a 80 mm / fuente 14px monoespaciada

const money = (v: number | null | undefined) =>
  (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });

const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** `izq .......... der` ocupando el ancho exacto del ticket. */
function fila(izq: string, der: string): string {
  const espacio = Math.max(1, ANCHO - izq.length - der.length);
  return esc(izq + ' '.repeat(espacio) + der);
}

const linea = (ch = '-') => ch.repeat(ANCHO);

/** Texto libre en varias líneas: en 32 columnas una nota se corta sola si no. */
function envolver(texto: string): string[] {
  const out: string[] = [];
  let ln = '';
  for (const palabra of String(texto).split(/\s+/)) {
    if ((ln + ' ' + palabra).trim().length > ANCHO) { if (ln) out.push(esc(ln)); ln = palabra; }
    else ln = (ln ? ln + ' ' : '') + palabra;
  }
  if (ln) out.push(esc(ln));
  return out;
}

const fechaHora = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso).slice(0, 16)
    : d.toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
};

/** Encabezado y etiqueta de "recibido" según el signo del movimiento. */
function titulo(tipo: string): { head: string; recibido: string } {
  if (tipo === 'gasto') return { head: 'COMPROBANTE DE EGRESO', recibido: 'Pagado a' };
  if (tipo === 'deposito') return { head: 'COMPROBANTE DE DEPOSITO', recibido: 'Depositado por' };
  return { head: 'COMPROBANTE DE INGRESO', recibido: 'Recibido de' };
}

/** Arma el cuerpo del ticket. Separado del render para poder probarlo sin DOM. */
export function cuerpoComprobante(c: ComprobanteCaja): string {
  const L: string[] = [];
  const t = titulo(c.tipo);
  L.push('MEGA DULCES');
  L.push(t.head);
  L.push(linea('='));
  L.push(fila('Folio', '#' + c.folio));
  L.push(...etiquetadoSuc(c));
  L.push(fila('Fecha', c.fecha));
  L.push(linea());

  // Concepto: la cuenta/concepto contable + su nombre, y el "qué pasó".
  if (c.kepler_cuenta || c.kepler_concepto) {
    L.push('Concepto');
    L.push('  ' + esc(`${c.kepler_cuenta ?? ''} / ${c.kepler_concepto ?? ''}`.trim()));
    if (c.kepler_concepto_nombre) L.push(...envolver(c.kepler_concepto_nombre).map((l) => '  ' + l));
  }
  if (c.glosa) L.push(...envolver(c.glosa));
  L.push(...etiqueta(t.recibido, c.beneficiario));
  L.push(linea());

  // Desglose por denominación: `500 x 16 = $8,000.00`. Sin `×` ni acentos: térmicas de 203 dpi
  // los imprimen como basura. Incluye el efectivo del cajero (CAOS) — al guardar se fusiona en uno.
  L.push('DESGLOSE');
  const dens = [...c.denominaciones].sort((a, b) => b.denominacion - a.denominacion);
  for (const d of dens) {
    const izq = `${String(d.denominacion).padStart(5)} x ${String(d.piezas).padStart(4)} =`;
    L.push(fila(izq, money(d.denominacion * d.piezas)));
  }
  if (Number(c.morralla || 0) > 0) L.push(fila('Morralla', money(c.morralla)));
  L.push(linea());
  L.push(fila('TOTAL', money(c.monto)));

  // Espacio para firma: el ticket es el respaldo físico de que se recibió/entregó ESE efectivo.
  L.push('');
  L.push('');
  L.push('______________________________');
  L.push('Recibi conforme (nombre y firma)');

  L.push('');
  L.push(linea());
  if (c.created_by_username) L.push(...etiqueta('Capturo', c.created_by_username));
  if (c.created_at) L.push(fila('', fechaHora(c.created_at)));
  L.push('');
  L.push(esc(new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })));
  return L.join('\n');
}

/** `Etiqueta                valor`, y si el valor no cabe baja completo a la siguiente. */
function etiqueta(et: string, valor: string | null | undefined): string[] {
  const v = String(valor ?? '').trim();
  if (!v) return [fila(et, '-')];
  if (et.length + 1 + v.length <= ANCHO) return [fila(et, v)];
  return [esc(et + ':'), ...envolver(v).map((l) => '  ' + l)];
}

function etiquetadoSuc(c: ComprobanteCaja): string[] {
  const nombre = c.sucursal_nombre ? `${c.sucursal} · ${c.sucursal_nombre}` : c.sucursal;
  return etiqueta('Sucursal', nombre);
}

/**
 * Imprime el comprobante desde un IFRAME oculto (no `window.open`: el navegador la bloquea por
 * default). Devuelve `false` si el navegador no dejó crear el iframe.
 */
export function imprimirComprobante(c: ComprobanteCaja): boolean {
  const marco = document.createElement('iframe');
  marco.setAttribute('aria-hidden', 'true');
  marco.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(marco);

  const doc = marco.contentDocument;
  const win = marco.contentWindow;
  if (!doc || !win) { marco.remove(); return false; }

  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>Comprobante ${esc(c.folio)}</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { width: 72mm; padding: 3mm; color: #000;
         font-family: "Courier New", ui-monospace, monospace; font-size: 14px; line-height: 1.35; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
</style></head><body><pre>${cuerpoComprobante(c)}</pre></body></html>`);
  doc.close();

  const lanzar = () => {
    try { win.focus(); win.print(); } catch { /* si el navegador lo niega, queda el botón manual */ }
    setTimeout(() => marco.remove(), 1500);
  };
  if (doc.readyState === 'complete') setTimeout(lanzar, 120);
  else marco.onload = () => setTimeout(lanzar, 120);
  return true;
}
