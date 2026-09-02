/**
 * Impresión en formato TICKET (impresora térmica convencional).
 *
 * El ancho es 80 mm de papel, pero el área imprimible real ronda los **72 mm**:
 * los cabezales dejan margen físico a los lados y si uno maquetea a 80 el texto
 * sale cortado. Todo va en monoespaciada y alineado por columnas de caracteres,
 * porque es como se ve bien en 203 dpi y porque así el ticket sigue siendo legible
 * si alguien lo manda a una impresora de 58 mm.
 *
 * No se usa `window.print()` sobre la página: abre una ventana propia con su
 * `@page`, para no arrastrar el layout de la app ni pelear con los estilos del
 * shell.
 */

export interface TicketDenominacion { denominacion: number; cantidad: number; subtotal: number }

export interface TicketArqueo {
  sucursal: string;
  caja: string;
  fecha: string;
  folio?: string | null;
  cajera: string;
  hora_apertura?: string | null;
  hora_cierre?: string | null;
  denominaciones: TicketDenominacion[];
  total_contado: number;
  /** Solo se imprimen si quien imprime puede verlos (la cajera no). */
  esperado?: number | null;
  diff_real?: number | null;
  kepler_contado?: number | null;
  kepler_billetes?: number | null;
  kepler_monedas?: number | null;
  kepler_retirado?: number | null;
  capturado_por?: string | null;
  validado_por?: string | null;
  validado_at?: string | null;
}

const ANCHO = 32; // caracteres por línea a 80 mm / fuente 11px monoespaciada

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

/** Arma el cuerpo del ticket. Separado del render para poder probarlo. */
export function cuerpoTicket(a: TicketArqueo, opts: { revela: boolean }): string {
  const L: string[] = [];
  L.push('MEGA DULCES');
  L.push('ARQUEO DE CAJA');
  L.push(linea('='));
  L.push(fila('Sucursal', a.sucursal));
  L.push(fila('Caja', a.caja));
  L.push(fila('Fecha', a.fecha));
  if (a.folio) L.push(fila('Turno Kepler', '#' + a.folio));
  L.push(fila('Cajera', a.cajera.length > 20 ? a.cajera.slice(0, 20) : a.cajera));
  if (a.hora_apertura || a.hora_cierre) {
    L.push(fila('Horario', `${(a.hora_apertura || '--').slice(0, 5)}-${(a.hora_cierre || '--').slice(0, 5)}`));
  }
  L.push(linea());

  // Sin conteo físico el ticket no se queda vacío: Kepler siempre declara su
  // arqueo (total + billetes + monedas), aunque no lo desglose por pieza. Se
  // imprime como lo que es —declarado, no verificado— para que el papel no
  // pueda usarse como comprobante de un conteo que nadie hizo.
  if (!a.denominaciones.length) {
    L.push('ARQUEO DECLARADO EN KEPLER');
    L.push(linea());
    if (a.kepler_billetes != null) L.push(fila('Billetes', money(a.kepler_billetes)));
    if (a.kepler_monedas != null) L.push(fila('Monedas', money(a.kepler_monedas)));
    if (a.kepler_retirado != null) L.push(fila('Retirado', money(a.kepler_retirado)));
    L.push(linea());
    L.push(fila('TOTAL KEPLER', money(a.kepler_contado)));
    L.push('');
    L.push('* Cifra declarada al cerrar el');
    L.push('  corte. SIN conteo fisico a');
    L.push('  ciegas. Kepler no guarda el');
    L.push('  detalle por denominacion.');
  } else {
    L.push('CONTEO POR DENOMINACION');
    L.push(linea());
    for (const d of a.denominaciones) {
      const et = d.denominacion >= 1 ? `$${d.denominacion}` : `${d.denominacion * 100}c`;
      L.push(fila(`${et.padEnd(7)}x ${String(d.cantidad).padStart(3)}`, money(d.subtotal)));
    }
    L.push(linea());
    L.push(fila('TOTAL CONTADO', money(a.total_contado)));
  }

  if (opts.revela && a.denominaciones.length) {
    L.push('');
    L.push(linea());
    L.push('CONTRA KEPLER');
    L.push(linea());
    L.push(fila('Esperado', money(a.esperado)));
    L.push(fila('Kepler contado', money(a.kepler_contado)));
    if (a.kepler_billetes != null) L.push(fila('  billetes', money(a.kepler_billetes)));
    if (a.kepler_monedas != null) L.push(fila('  monedas', money(a.kepler_monedas)));
    if (a.kepler_retirado != null) L.push(fila('  retirado', money(a.kepler_retirado)));
    L.push(linea());
    const d = Number(a.diff_real ?? 0);
    const etiqueta = d > 0 ? 'FALTANTE' : d < 0 ? 'SOBRANTE' : 'CUADRA';
    L.push(fila(etiqueta, money(Math.abs(d))));
  }

  L.push('');
  L.push(linea());
  L.push(fila('Capturo', (a.capturado_por || (a.denominaciones.length ? '-' : 'KEPLER')).slice(0, 18)));
  L.push(fila('Valido', (a.validado_por || 'PENDIENTE').slice(0, 18)));
  L.push('');
  L.push('');
  // Dos firmas: el ticket es el respaldo físico de que ambas contaron lo mismo.
  L.push('___________  ___________');
  L.push('  Cajera       Encargada');
  L.push('');
  L.push(esc(new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })));
  return L.join('\n');
}

/**
 * Abre la ventana de impresión. Devuelve `false` si el navegador la bloqueó —
 * el llamador debe avisarlo en vez de dejar al usuario esperando un diálogo que
 * nunca aparece.
 */
export function imprimirTicket(a: TicketArqueo, opts: { revela: boolean }): boolean {
  const w = window.open('', '_blank', 'width=380,height=640');
  if (!w) return false;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Arqueo ${esc(a.fecha)} caja ${esc(a.caja)}</title>
<style>
  /* 80 mm de papel; el alto lo pone el contenido (rollo continuo). */
  @page { size: 80mm auto; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { width: 72mm; padding: 3mm; color: #000;
         font-family: "Courier New", ui-monospace, monospace; font-size: 11px; line-height: 1.35; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
  @media print { .no-print { display: none; } }
  .no-print { margin-top: 8px; font-family: system-ui, sans-serif; }
</style></head><body>
<pre>${cuerpoTicket(a, opts)}</pre>
<div class="no-print"><button onclick="window.print()">Imprimir</button></div>
</body></html>`);
  w.document.close();
  w.focus();
  // Deja pintar antes de disparar el diálogo; si no, algunas impresoras salen en blanco.
  setTimeout(() => { try { w.print(); } catch { /* el usuario tiene el botón */ } }, 250);
  return true;
}
