/**
 * Impresión en formato TICKET (impresora térmica convencional).
 *
 * El ancho es 80 mm de papel, pero el área imprimible real ronda los **72 mm**:
 * los cabezales dejan margen físico a los lados y si uno maquetea a 80 el texto
 * sale cortado. Todo va en monoespaciada y alineado por columnas de caracteres,
 * porque es como se ve bien en 203 dpi y porque así el ticket sigue siendo legible
 * si alguien lo manda a una impresora de 58 mm.
 *
 * No se usa `window.print()` sobre la página: se imprime desde un **iframe oculto**
 * con su propio `@page`, para no arrastrar el layout de la app ni pelear con los
 * estilos del shell — y sin la ventana emergente, que el navegador bloquea por
 * default y obligaba a autorizarla con las manos en el efectivo.
 *
 * ⚠️ **El diálogo de impresión no se puede saltar desde la web.** Ningún navegador
 * permite mandar a la impresora sin confirmación: es una restricción de seguridad,
 * no algo que falte programar. Para que salga solo, la máquina de la caja debe
 * abrir el navegador en modo kiosco de impresión —Chrome/Edge con
 * `--kiosk-printing`— y ahí `print()` imprime directo a la impresora default.
 * Es configuración de una vez por equipo, el patrón estándar en punto de venta.
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
  /** `cierre` (corte del día) o `relevo` (cambio de turno). Cambia qué es el papel. */
  tipo?: string | null;
  /** Relevo: a quién se le entregó la caja. */
  cajero_entrante?: string | null;
  /** Turno de Kepler, y cuánto duró. */
  turno?: string | null;
  duracion_horas?: number | null;
  /** Kepler marca cuando abre y cierra distinta persona. */
  handoff?: boolean | null;
  /** Id del arqueo: es la llave para encontrarlo después de que el papel viajó. */
  arqueo_id?: string | null;
  /** Motivo tipificado y texto libre — lo que EXPLICA un descuadre. */
  incidencia_tipo?: string | null;
  nota?: string | null;
  validado_nota?: string | null;
  capturado_at?: string | null;
  /** Solo se imprimen si quien imprime puede verlos (la cajera no). */
  esperado?: number | null;
  diff_real?: number | null;
  kepler_contado?: number | null;
  kepler_billetes?: number | null;
  kepler_monedas?: number | null;
  kepler_retirado?: number | null;
  kepler_tarjeta?: number | null;
  kepler_transfer?: number | null;
  venta?: number | null;
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

const corta = (t: string, n: number) => (t || '').length > n ? (t || '').slice(0, n) : (t || '');

/**
 * `Etiqueta                valor`, y si el valor no cabe en la misma línea baja
 * completo a la siguiente.
 *
 * Cortarlo era peor que bajarlo: con el nombre real de una cajera salía
 * "Rosa María Tinoco Ve", que en un papel que se firma se lee como un error del
 * sistema. A 32 columnas caben los nombres completos si tienen su propio renglón.
 */
function etiquetado(etiqueta: string, valor: string | null | undefined): string[] {
  const v = String(valor ?? '').trim();
  if (!v) return [fila(etiqueta, '-')];
  if (etiqueta.length + 1 + v.length <= ANCHO) return [fila(etiqueta, v)];
  return [esc(etiqueta + ':'), ...envolver(v).map((l) => '  ' + l)];
}

/** Texto libre en varias líneas: en 32 columnas una nota se corta sola si no. */
function envolver(texto: string): string[] {
  const out: string[] = [];
  let linea = '';
  for (const palabra of String(texto).split(/\s+/)) {
    if ((linea + ' ' + palabra).trim().length > ANCHO) { if (linea) out.push(esc(linea)); linea = palabra; }
    else linea = (linea ? linea + ' ' : '') + palabra;
  }
  if (linea) out.push(esc(linea));
  return out;
}

const fechaHora = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso).slice(0, 16)
    : d.toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
};

/** Arma el cuerpo del ticket. Separado del render para poder probarlo. */
export function cuerpoTicket(a: TicketArqueo, opts: { revela: boolean }): string {
  const L: string[] = [];
  const relevo = a.tipo === 'relevo';
  L.push('MEGA DULCES');
  L.push(relevo ? 'RELEVO DE CAJA' : 'ARQUEO DE CAJA');
  L.push(linea('='));
  L.push(fila('Sucursal', a.sucursal));
  L.push(fila('Caja', a.caja));
  L.push(fila('Fecha', a.fecha));
  if (a.folio) L.push(fila('Turno Kepler', '#' + a.folio));
  if (a.turno) L.push(fila('Turno', a.turno));
  L.push(...etiquetado('Cajera', a.cajera));
  if (relevo && a.cajero_entrante) L.push(...etiquetado('Entrega a', a.cajero_entrante));
  if (a.hora_apertura || a.hora_cierre) {
    const dur = a.duracion_horas != null ? ` (${a.duracion_horas}h)` : '';
    L.push(fila('Horario', `${(a.hora_apertura || '--').slice(0, 5)}-${(a.hora_cierre || '--').slice(0, 5)}${dur}`));
  }
  // Kepler marca cuando abre y cierra distinta persona: en un arqueo eso explica
  // la mitad de los descuadres, así que va en el papel y no solo en la pantalla.
  if (a.handoff) L.push('* Turno con CAMBIO DE CAJERA');
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
    // Si el desglose no llega al total, el papel lo dice: casi siempre es un
    // retiro que no quedó registrado, y es justo lo que hay que preguntar.
    const suma = Number(a.kepler_billetes ?? 0) + Number(a.kepler_monedas ?? 0) + Number(a.kepler_retirado ?? 0);
    const hueco = Number(a.kepler_contado ?? 0) - suma;
    if (suma && Math.abs(hueco) >= 1) L.push(fila('  sin explicar', money(hueco)));
    L.push('');
    L.push('* Cifra declarada al cerrar el');
    L.push('  corte. SIN conteo fisico a');
    L.push('  ciegas. Kepler no guarda el');
    L.push('  detalle por denominacion.');
  } else {
    L.push('CONTEO POR DENOMINACION');
    L.push(linea());
    // Formato `1000 x 17 = $17,000.00`: la denominación y la cantidad alineadas a
    // la derecha en ancho fijo, para que las columnas caigan una debajo de otra sin
    // importar si son 3 piezas o 1,250. Es como se lee un arqueo en papel — de
    // arriba a abajo comparando cantidades, no montos sueltos.
    //
    // Sin `×` ni acentos a propósito: muchas térmicas de 203 dpi no traen esos
    // glifos en su tabla de caracteres y los imprimen como basura.
    for (const d of a.denominaciones) {
      const et = d.denominacion >= 1 ? String(d.denominacion) : `${d.denominacion * 100}c`;
      const izq = `${et.padStart(5)} x ${String(d.cantidad).padStart(4)} =`;
      L.push(fila(izq, money(d.subtotal)));
    }
    L.push(linea());
    // Billetes y monedas por separado: es la única forma de comparar nuestro
    // conteo contra lo que Kepler declara, que solo trae esos dos totales.
    const bil = a.denominaciones.filter((d) => d.denominacion >= 20).reduce((t, d) => t + d.subtotal, 0);
    const mon = a.total_contado - bil;
    L.push(fila('  billetes', money(bil)));
    L.push(fila('  monedas', money(mon)));
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

    // El turno no es solo efectivo: sin tarjeta y transferencia, el papel no
    // permite reconstruir de qué venta salió ese cajón.
    if (a.kepler_tarjeta != null || a.kepler_transfer != null || a.venta != null) {
      L.push('');
      L.push('RESTO DEL TURNO');
      L.push(linea());
      if (a.kepler_tarjeta != null) L.push(fila('Tarjeta', money(a.kepler_tarjeta)));
      if (a.kepler_transfer != null) L.push(fila('Transferencia', money(a.kepler_transfer)));
      if (a.venta != null) L.push(fila('Venta del turno', money(a.venta)));
    }
  }

  // Lo que EXPLICA el número. Un arqueo con faltante y sin motivo obliga a
  // reconstruir la conversación una semana después; con el motivo en el papel,
  // la firma de la encargada respalda algo concreto.
  if (a.incidencia_tipo || a.nota) {
    L.push('');
    L.push(linea());
    L.push('OBSERVACIONES');
    L.push(linea());
    if (a.incidencia_tipo) L.push(...envolver('Motivo: ' + a.incidencia_tipo.replace(/_/g, ' ')));
    if (a.nota) L.push(...envolver('Nota: ' + a.nota));
  }

  L.push('');
  L.push(linea());
  L.push(...etiquetado('Capturo', a.capturado_por || (a.denominaciones.length ? '-' : 'KEPLER')));
  if (a.capturado_at) L.push(fila('', fechaHora(a.capturado_at)));
  L.push(...etiquetado('Valido', a.validado_por || 'PENDIENTE'));
  if (a.validado_at) L.push(fila('', fechaHora(a.validado_at)));
  if (a.validado_nota) L.push(...envolver('  ' + a.validado_nota));
  // El id hace rastreable el papel: sin él, un ticket suelto no se puede casar
  // con su registro.
  if (a.arqueo_id) L.push(fila('Folio arqueo', a.arqueo_id.slice(0, 8)));
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
  // IFRAME oculto, no `window.open`: la ventana emergente la bloquea el navegador
  // por default y obligaba a la cajera a autorizarla con las manos en el efectivo.
  // El iframe no pide permiso, no roba el foco y no deja una pestaña abierta.
  const marco = document.createElement('iframe');
  marco.setAttribute('aria-hidden', 'true');
  marco.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(marco);

  const doc = marco.contentDocument;
  const win = marco.contentWindow;
  if (!doc || !win) { marco.remove(); return false; }

  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>Arqueo ${esc(a.fecha)} caja ${esc(a.caja)}</title>
<style>
  /* 80 mm de papel; el alto lo pone el contenido (rollo continuo). */
  @page { size: 80mm auto; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { width: 72mm; padding: 3mm; color: #000;
         font-family: "Courier New", ui-monospace, monospace; font-size: 11px; line-height: 1.35; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
</style></head><body><pre>${cuerpoTicket(a, opts)}</pre></body></html>`);
  doc.close();

  const lanzar = () => {
    try { win.focus(); win.print(); } catch { /* si el navegador lo niega, queda el botón manual */ }
    // El iframe se retira DESPUÉS de imprimir. Quitarlo antes cancela el trabajo en
    // algunos navegadores; 1.5 s alcanza incluso si el diálogo sigue abierto, porque
    // para entonces el documento ya se mandó a la cola.
    setTimeout(() => marco.remove(), 1500);
  };
  // Deja pintar antes de disparar; si no, algunas térmicas sacan la hoja en blanco.
  if (doc.readyState === 'complete') setTimeout(lanzar, 120);
  else marco.onload = () => setTimeout(lanzar, 120);
  return true;
}
