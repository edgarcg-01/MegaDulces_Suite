/**
 * Fase TK.2 — Reimpresión de un ticket de venta en formato TICKET (impresora térmica).
 *
 * Calca deliberadamente `apps/view/src/app/modules/tienda/ticket-arqueo.ts`, que ya está en
 * producción en las cajas: **32 caracteres por renglón**, monoespaciada, iframe oculto y
 * `@page 80mm auto`. No se re-deduce nada de eso acá; lo que sigue es por qué esos números
 * son los que son, copiado de allá porque vuelve a aplicar tal cual:
 *
 *   El papel es de 80 mm pero el área imprimible ronda los **72 mm**, y el ticket no se maqueta
 *   con CSS: se maqueta CONTANDO CARACTERES. Medido en el navegador que imprime, lo que ocupa
 *   una línea de 32 caracteres sobre esos 72 mm: 11px → 78% · 13px → 92% · **14px → 99%** ·
 *   15px → 106% (SE PARTE). Estamos en 14px. **No subirlo sin volver a medir**, y si se sube,
 *   bajar `ANCHO` en el mismo cambio. Courier New es la más ancha del stack: es el peor caso.
 *
 *   Se imprime desde un **iframe oculto** con su propio `@page`, no con `window.print()` sobre
 *   la página ni con `window.open` — la ventana emergente la bloquea el navegador por default.
 *
 *   ⚠️ El diálogo de impresión NO se puede saltar desde la web: es una restricción de
 *   seguridad, no algo que falte programar. Para que salga solo, la máquina de la caja abre el
 *   navegador en modo kiosco (`--kiosk-printing`).
 *
 * ── LO PROPIO DE ESTE TICKET ────────────────────────────────────────────────────────────
 *
 * Es una REIMPRESIÓN con el descuento desglosado, y eso impone tres cosas:
 *
 * 1. **Cada producto ocupa DOS o TRES renglones, no uno.** En 32 columnas no caben nombre +
 *    cantidad + precio de lista + precio pagado + importe en una sola línea sin cortar el
 *    nombre a la mitad, y un nombre cortado en un papel que se le entrega al cliente se lee
 *    como un error del sistema. Así que: nombre completo arriba, y debajo la aritmética.
 *
 * 2. **El descuento se imprime SÓLO donde existe.** Medido sobre 30 días de tickets de
 *    mostrador: el 70% no trae ninguno. Imprimir "Descuento: $0.00" en esos invita a buscar
 *    un descuento que no hubo, y alarga el papel sin decir nada.
 *
 * 3. ⚠️ **NO SE IMPRIME HORA.** Kepler no la guarda (medido: sus 10 columnas de fecha están en
 *    00:00:00). Poner el reloj del navegador ahí sería presentar la hora de la REIMPRESIÓN
 *    como la hora de la venta — exactamente la falla que la Fase VP midió en 21 de 24 píldoras
 *    de frescura. La fecha de reimpresión va al pie, rotulada como tal.
 */

export interface TicketVentaLinea {
  linea: number;
  sku: string | null;
  descripcion: string | null;
  unidad: string | null;
  cantidad: number;
  precio_lista: number;
  /**
   * false => el ERP no guarda con que precio se comparaba este renglon (Kepler empezo a
   * escribirlo el 2026-08-13). NO es lo mismo que "no hubo descuento".
   */
  lista_conocida: boolean;
  precio_pagado: number;
  descuento_unitario: number;
  descuento_linea: number;
  importe: number;
  equivalencia: string | null;
}

export interface TicketVentaCascada {
  importe_lista: number;
  descuento_precio: number;
  subtotal: number;
  descuento_documento: number;
  descuento_documento_pct_erp: number | null;
  iva: number | null;
  ieps: number | null;
  total: number;
  descuento_total: number;
  descuento_total_pct: number;
  /** Cobertura del precio de lista, declarada: sin ella el descuento es un piso, no la cifra. */
  lineas_con_lista: number;
  lineas_sin_lista: number;
}

export interface TicketVenta {
  id: string;
  origen: string;
  origen_label: string;
  doc_label: string | null;
  sucursal: string | null;
  sucursal_nombre: string | null;
  caja: number | null;
  folio: string;
  fecha: string | null;
  /**
   * Siempre `null` cuando el documento viene del ERP: Kepler no guarda la hora. `hora_motivo`
   * trae por qué, y la pantalla lo DECLARA en vez de dejar el hueco mudo (ADR-056).
   */
  hora: string | null;
  hora_motivo: string | null;
  cliente_nombre: string | null;
  cliente_rfc: string | null;
  atendio: string | null;
  atendio_rol: string | null;
  impuestos_incluidos: boolean;
  lineas: TicketVentaLinea[];
  cascada: TicketVentaCascada;
  cuadra: boolean;
  aviso: string | null;
}

const ANCHO = 32; // caracteres por línea a 80 mm / fuente 14px monoespaciada

const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const money = (v: number | null | undefined) =>
  (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });

/** Cantidades: enteras se ven enteras; a granel conservan decimales (0.6 KG es una venta real). */
const cant = (n: number) => Number.isInteger(n) ? String(n) : String(Number(Number(n).toFixed(3)));

/** `izq .......... der` ocupando el ancho exacto del ticket. */
function fila(izq: string, der: string): string {
  const espacio = Math.max(1, ANCHO - izq.length - der.length);
  return esc(izq + ' '.repeat(espacio) + der);
}

const linea = (ch = '-') => ch.repeat(ANCHO);

/** Centra en las 32 columnas. Si no cabe, se deja pegado a la izquierda en vez de recortarlo. */
function centro(t: string): string {
  const s = String(t ?? '');
  if (s.length >= ANCHO) return esc(s);
  return esc(' '.repeat(Math.floor((ANCHO - s.length) / 2)) + s);
}

/** Texto libre en varias líneas: en 32 columnas un nombre se corta solo si no. */
function envolver(texto: string, ancho = ANCHO): string[] {
  const out: string[] = [];
  let ln = '';
  for (const palabra of String(texto ?? '').split(/\s+/).filter(Boolean)) {
    if ((ln + ' ' + palabra).trim().length > ancho) {
      if (ln) out.push(ln);
      // Una palabra sola más larga que el renglón (códigos, "SUPERDESCUENTO...") se parte a la
      // fuerza: sin esto la línea desborda y arrastra la alineación de todo lo que sigue.
      let p = palabra;
      while (p.length > ancho) { out.push(p.slice(0, ancho)); p = p.slice(ancho); }
      ln = p;
    } else ln = (ln ? ln + ' ' : '') + palabra;
  }
  if (ln) out.push(ln);
  return out.length ? out : [''];
}

/** `Etiqueta   valor`, y si el valor no cabe en la misma línea baja completo a la siguiente. */
function etiquetado(etiqueta: string, valor: string | null | undefined): string[] {
  const v = String(valor ?? '').trim();
  if (!v) return [];
  if (etiqueta.length + 1 + v.length <= ANCHO) return [fila(etiqueta, v)];
  return [esc(etiqueta + ':'), ...envolver(v, ANCHO - 2).map((l) => '  ' + esc(l))];
}

const fechaLarga = (iso: string | null): string => {
  if (!iso) return 'sin fecha';
  // Se parte el string, NO `new Date(iso)`: un `date` de Postgres leído como UTC y renderizado
  // en hora de México sale con el día ANTERIOR. Ya costó una entrega en la Fase LC.
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}/${m}/${y.slice(2)}` : iso;
};

/**
 * Arma el cuerpo del ticket. Separado del render para poder probarlo sin un navegador
 * (igual que `cuerpoTicket` del arqueo, que tiene su spec).
 */
export function cuerpoTicketVenta(t: TicketVenta): string {
  const L: string[] = [];
  const c = t.cascada;

  L.push(centro('MEGA DULCES'));
  L.push(centro('COPIA DE TICKET'));
  L.push(linea('='));
  L.push(...etiquetado('Sucursal', t.sucursal_nombre || t.sucursal));
  if (t.caja != null) L.push(fila('Caja', String(t.caja)));
  L.push(fila('Folio', t.folio));
  L.push(fila('Fecha', fechaLarga(t.fecha)));
  L.push(...etiquetado('Tipo', t.doc_label || t.origen_label));
  if (t.atendio) L.push(...etiquetado(t.atendio_rol || 'Atendio', t.atendio));
  if (t.cliente_nombre) L.push(...etiquetado('Cliente', t.cliente_nombre));
  if (t.cliente_rfc) L.push(fila('RFC', t.cliente_rfc));
  L.push(linea());

  if (!t.lineas.length) {
    L.push(centro('SIN RENGLONES'));
    L.push('');
    L.push(...envolver('Este documento no tiene detalle de productos en el sistema.'));
    L.push(linea());
  }

  for (const l of t.lineas) {
    // Renglón 1: el nombre completo, envuelto. Nunca cortado.
    for (const ln of envolver(l.descripcion || l.sku || 'PRODUCTO')) L.push(esc(ln));
    // Renglón 2: la aritmética que el cliente comprueba — cantidad x precio = importe.
    const uni = l.unidad ? ' ' + l.unidad : '';
    L.push(fila(`  ${cant(l.cantidad)}${uni} x ${money(l.precio_pagado)}`, money(l.importe)));
    // Renglón 3, SÓLO si hubo descuento: antes costaba, ahorraste.
    if (l.descuento_linea > 0) {
      L.push(fila(`  antes ${money(l.precio_lista)}`, `-${money(l.descuento_linea)}`));
    }
    // El peldaño cobrado, cuando dice algo distinto de lo que ya está impreso ("5 CJA").
    if (l.equivalencia) L.push(esc(`  (equivale a ${l.equivalencia})`));
  }

  L.push(linea());
  // La cascada: cada resta cierra exacto contra la siguiente línea, que es lo único que un
  // cliente puede comprobar con una calculadora.
  //
  // El renglón "Precio de lista" se imprime SÓLO si hay algo que restarle. Sin descuento es el
  // total repetido dos veces con dos nombres distintos, que en un papel de 32 columnas se lee
  // como si el segundo corrigiera al primero.
  const hayQueRestar = c.descuento_precio > 0 || c.descuento_documento !== 0;
  if (hayQueRestar) L.push(fila('Precio de lista', money(c.importe_lista)));
  if (c.descuento_precio > 0) L.push(fila('Descuento en precio', `-${money(c.descuento_precio)}`));
  if (c.descuento_documento > 0) {
    L.push(fila('Descuento documento', `-${money(c.descuento_documento)}`));
  } else if (c.descuento_documento < 0) {
    // Hay documentos donde el total es MAYOR que la suma de renglones (redondeo a favor).
    // Llamarlo "descuento negativo" confundiria; se nombra por lo que es.
    L.push(fila('Ajuste de redondeo', money(-c.descuento_documento)));
  }
  if (!t.impuestos_incluidos && c.iva) L.push(fila('IVA', money(c.iva)));
  L.push(linea('='));
  L.push(fila('TOTAL PAGADO', money(c.total)));
  L.push(linea('='));

  if (c.descuento_total > 0) {
    L.push('');
    L.push(centro('*** AHORRASTE ***'));
    L.push(centro(`${money(c.descuento_total)}  (${c.descuento_total_pct}%)`));
    L.push('');
  }

  if (t.impuestos_incluidos) {
    const imp: string[] = [];
    if (c.iva) imp.push(`IVA ${money(c.iva)}`);
    if (c.ieps) imp.push(`IEPS ${money(c.ieps)}`);
    L.push(...envolver(`Precios con impuestos incluidos${imp.length ? '. ' + imp.join(' - ') : '.'}`));
  }

  // ⚠️ El aviso viaja del backend y es lo que separa un papel honesto de uno que miente por
  // omision. La peor de las tres ausencias que trae se ve IGUAL que "todo bien": un ticket
  // anterior al 13-ago-2026, con su total correcto y sin descuento, que parece decir "no hubo
  // descuento" cuando en realidad el ERP no guarda con que precio comparar. Por eso se imprime
  // en el papel y no solo en la pantalla: el papel es lo que se lleva el cliente.
  if (t.aviso) { L.push(''); L.push(...envolver('* ' + t.aviso)); }

  L.push('');
  // Dos renglones y no una frase envuelta: 'COPIA INFORMATIVA. No es comprobante fiscal.' son
  // 43 caracteres y `envolver` la partia por donde cayera. En un papel que se le entrega al
  // cliente la leyenda legal se lee de corrido o no se lee.
  L.push(centro('COPIA INFORMATIVA'));
  L.push(centro('No es comprobante fiscal'));
  L.push('');
  // La fecha de REIMPRESION, rotulada como tal: no es la hora de la venta, que Kepler no
  // guarda. Ver la cabecera de este archivo.
  // Formato COMPACTO a proposito: `toLocaleString` sin opciones da '18/9/2026, 8:45:55 a.m.',
  // que con el prefijo son 33 caracteres — uno mas de los que entran, y el renglon se parte.
  // Lo atrapo el candado de 32 columnas; sin el, se descubria en el papel de la caja.
  L.push(esc('Reimpreso ' + new Date().toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })));
  L.push(esc(t.id));
  return L.join('\n');
}

/**
 * Abre la ventana de impresión. Devuelve `false` si el navegador la bloqueó — el llamador debe
 * avisarlo en vez de dejar al usuario esperando un diálogo que nunca aparece.
 */
export function imprimirTicketVenta(t: TicketVenta): boolean {
  const marco = document.createElement('iframe');
  marco.setAttribute('aria-hidden', 'true');
  marco.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(marco);

  const doc = marco.contentDocument;
  const win = marco.contentWindow;
  if (!doc || !win) { marco.remove(); return false; }

  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>Ticket ${esc(t.id)}</title>
<style>
  /* 80 mm de papel; el alto lo pone el contenido (rollo continuo). */
  @page { size: 80mm auto; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { width: 72mm; padding: 3mm; color: #000;
         font-family: "Courier New", ui-monospace, monospace; font-size: 14px; line-height: 1.35; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
</style></head><body><pre>${cuerpoTicketVenta(t)}</pre></body></html>`);
  doc.close();

  const lanzar = () => {
    try { win.focus(); win.print(); } catch { /* si el navegador lo niega, queda el boton manual */ }
    // El iframe se retira DESPUES de imprimir: quitarlo antes cancela el trabajo en algunos
    // navegadores. 1.5 s alcanza incluso con el dialogo abierto, porque para entonces el
    // documento ya se mando a la cola.
    setTimeout(() => marco.remove(), 1500);
  };
  // Deja pintar antes de disparar; si no, algunas termicas sacan la hoja en blanco.
  if (doc.readyState === 'complete') setTimeout(lanzar, 120);
  else marco.onload = () => setTimeout(lanzar, 120);
  return true;
}
