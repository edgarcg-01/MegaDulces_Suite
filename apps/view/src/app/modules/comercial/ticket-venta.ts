/**
 * Fase TK.5 — Reimpresión de un ticket de venta, **rollo de 80 mm**.
 *
 * ── LA MEDIDA, Y DE DÓNDE SALE ──────────────────────────────────────────────────────────
 *
 * **80 mm de ancho**, alto continuo (`@page { size: 80mm auto }`) — el rollo estándar de punto
 * de venta. Reemplaza al formato departamental de 139.7 × 50.8 mm de TK.2: era ancho y bajo, y
 * eso cambia la maqueta entera (ver más abajo por qué el producto ya no cabe en un renglón).
 *
 * **Medido en el navegador que imprime**, con el mismo método del ticket de arqueo y del
 * formato anterior, así que los números son comparables. Courier New, `line-height` 1.25,
 * 72 mm útiles tras 4 mm de margen por lado:
 *
 *       7px → 64 caracteres · 2.32 mm por renglón
 *       8px → 56            · 2.65
 *       9px → 50            · 2.98
 *   ⭐ 10px → 45            · 3.31
 *      11px → 41            · 3.64
 *      12px → 37            · 3.97
 *
 * **Se eligió 10px / `ANCHO = 45`**: el tamaño más grande que deja pasar un nombre de producto
 * completo (medido en el anexo, su p95 es 41 caracteres).
 *
 * ⚠️ **45 caracteres es lo que obliga a partir el producto en varios renglones.** En 82 cabían
 * las siete columnas del desglose (nombre, cantidad, lista, pagado, descuento, impuesto,
 * importe); en 45 no caben ni de cerca. Por eso cada producto ocupa hasta **tres renglones**
 * —nombre / operación / desglose— que es como se lee cualquier ticket de rollo. En un rollo el
 * alto es gratis: el papel se corta donde termina.
 *
 * ⚠️ **El tamaño de letra tiene techo aritmético, no estético.** El ticket no se maqueta con
 * CSS: se maqueta CONTANDO CARACTERES, y cada renglón se rellena hasta `ANCHO` exacto. Si la
 * letra crece, los 45 caracteres dejan de entrar en los 72 mm, el renglón se parte en dos y se
 * rompe la alineación de los montos. **No subirla sin volver a medir**, y si se sube, bajar
 * `ANCHO` en el mismo cambio. Courier New es la más ancha del stack: es el peor caso.
 *
 * ── LO QUE SE CONSERVA DEL DISEÑO ANTERIOR ──────────────────────────────────────────────
 *
 * Se imprime desde un **iframe oculto** con su propio `@page`, no con `window.print()` sobre la
 * página ni con `window.open` — la ventana emergente la bloquea el navegador por default.
 * ⚠️ El diálogo de impresión NO se puede saltar desde la web: es una restricción de seguridad.
 * Para que salga solo, la máquina abre el navegador en modo kiosco (`--kiosk-printing`).
 *
 * ⚠️ **NO SE IMPRIME HORA DE VENTA.** Kepler no la guarda (medido: sus 10 columnas `timestamp`
 * están en 00:00:00). Poner el reloj del navegador ahí sería presentar la hora de la
 * REIMPRESIÓN como la de la venta — la falla que la Fase VP midió en 21 de 24 píldoras.
 *
 * ⚠️ **El descuento y el impuesto se imprimen sólo donde existen.** Medido sobre 30 días: el
 * 70% de los tickets de mostrador no trae descuento, y los anteriores al 2026-08-13 no tienen
 * precio de lista en el ERP. Cuando un producto no tiene nada que declarar, su tercer renglón
 * **no se imprime** — ni en blanco ni en cero.
 *
 * ── LO QUE YA NO SE IMPRIME (TK.5, decisión del usuario) ────────────────────────────────
 *
 * Se quitaron del papel el sello «No es comprobante fiscal · Reimpreso …» y el aviso de que
 * Kepler no guarda el precio de lista antes del 2026-08-13.
 *
 * ⚠️ El aviso **sigue saliendo en pantalla**, en `/comercial/tickets`. No es adorno: en un
 * documento viejo un descuento en $0.00 significa «no se sabe», no «no hubo», y quien reimprime
 * tiene que poder distinguirlo. Lo que cambió es a quién se le dice: al operador sí, al cliente
 * no. Si algún día se quita también de la pantalla, esa diferencia deja de ser visible para
 * nadie (ADR-056).
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
  /** Impuesto ya descompuesto del precio. IVA e IEPS nunca vienen juntos (0 de 123,203). */
  iva: number;
  ieps: number;
  impuesto_tipo: 'iva' | 'ieps' | null;
  iva_tasa: number;
  ieps_tasa: number;
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
  /** true => la suma del impuesto de los renglones reproduce la que declara el documento. */
  impuesto_desglosado: boolean;
  iva_lineas: number;
  ieps_lineas: number;
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

/** Caracteres por renglón a 80 mm / 10px monoespaciada. Ver la cabecera: está MEDIDO. */
const ANCHO = 45;

const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Dinero SIN símbolo: la columna ya dice que es dinero y el `$` cuesta un carácter por celda. */
const money = (v: number | null | undefined) =>
  (Number(v ?? 0) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Con símbolo, para los totales y el ahorro — ahí sí se lee como dinero suelto. */
const pesos = (v: number | null | undefined) => '$' + money(v);

/** Enteras se ven enteras; a granel conservan decimales (0.605 KG es una venta real). */
const cant = (n: number) => Number.isInteger(n) ? String(n) : String(Number(Number(n).toFixed(3)));

const linea = (ch = '-') => ch.repeat(ANCHO);

/** Recorta con puntos suspensivos. Sólo para el nombre, y sólo cuando no hay de otra. */
const corta = (t: string, n: number) => t.length <= n ? t : t.slice(0, n - 1) + '…';

/**
 * `izq .......... der` ocupando el ancho EXACTO del ticket.
 *
 * ⚠️ Recorta si no cabe, y termina con un `slice` duro. La versión anterior no lo hacía y
 * devolvía renglones de 92 caracteres en cuanto el nombre del cliente y el del cajero eran
 * largos — que es el caso normal, no el raro. Un helper de maquetación que puede devolver algo
 * más ancho que el papel no es un helper: es el bug esperando. Se recorta primero el lado
 * IZQUIERDO (texto libre: nombres) y sólo si aún no cabe el derecho (identidad del documento).
 */
function fila(izq: string, der: string): string {
  let a = String(izq ?? '');
  let b = String(der ?? '');
  const sep = a && b ? 1 : 0;
  if (b.length + sep > ANCHO) b = corta(b, ANCHO - sep);
  if (a.length + b.length + sep > ANCHO) a = corta(a, Math.max(0, ANCHO - b.length - sep));
  const espacio = Math.max(sep, ANCHO - a.length - b.length);
  return esc((a + ' '.repeat(espacio) + b).slice(0, ANCHO));
}

/** Centra en el ancho del ticket. Si no cabe, se deja a la izquierda en vez de recortarlo. */
function centro(t: string): string {
  const s = String(t ?? '');
  if (s.length >= ANCHO) return esc(s);
  return esc(' '.repeat(Math.floor((ANCHO - s.length) / 2)) + s);
}

/** Texto libre en varias líneas (avisos). Una palabra más larga que el renglón se parte. */
function envolver(texto: string, ancho = ANCHO): string[] {
  const out: string[] = [];
  let ln = '';
  for (const palabra of String(texto ?? '').split(/\s+/).filter(Boolean)) {
    if ((ln + ' ' + palabra).trim().length > ancho) {
      if (ln) out.push(ln);
      let p = palabra;
      while (p.length > ancho) { out.push(p.slice(0, ancho)); p = p.slice(ancho); }
      ln = p;
    } else ln = (ln ? ln + ' ' : '') + palabra;
  }
  if (ln) out.push(ln);
  return out.length ? out : [''];
}

/**
 * Un producto, en hasta TRES renglones (ver la cabecera: en 45 caracteres no hay columnas).
 *
 *     PALETA PAYASO CHICO 20G
 *       12 PZA x 5.00                        60.00
 *       Lista 6.00 · Desc -12.00 · IVA 8.28
 *
 *   1. **Nombre**, con el renglón entero para él. Es lo único de ancho variable y su p95 medido
 *      en el anexo es 41 caracteres, así que a 45 casi nunca se recorta.
 *   2. **La operación**: cuánto, por cuánto, igual a cuánto. Se lee sola, sin encabezado de
 *      columnas — que a este ancho costaría un renglón por ticket y no cabría igual.
 *   3. **Lo que hay que declarar**: precio de lista, descuento e impuesto. ⚠️ Si no hay nada
 *      que declarar, este renglón NO se imprime: un `Desc 0.00` se leería como «te descontamos
 *      cero», y un `IVA 0.00` como «no causó», cuando puede ser que no se sepa.
 *
 * ⭐ IVA e IEPS se escriben con su nombre y no con una letra clave. En el formato anterior iban
 * en una celda de 11 caracteres y había que rotular `V=IVA I=IEPS` en el encabezado; acá el
 * renglón es libre, así que la palabra entra y la leyenda sobra. Sigue valiendo el hecho que lo
 * permite: **nunca coinciden** en el mismo renglón (0 de 123,203, en los tres doctipos).
 */
function producto(nombre: string, operacion: string, importe: string, declara: string[]): string[] {
  const out = [esc(corta(nombre, ANCHO))];
  out.push(fila('  ' + operacion, importe));

  // ⚠️ Se empaca por CONCEPTO, no por palabra. `envolver()` parte por `\s+`, y con montos
  // grandes ("Lista 58.88 · Desc -2,381.40 · IEPS 1,655.42" son 44 y no caben en los 43 útiles)
  // eso dejaba `IEPS` al final de un renglón y `1,655.42` al principio del siguiente: una
  // etiqueta separada de su monto, que es exactamente lo que un desglose no puede hacer.
  // ⚠️ Y el sangrado se agrega DESPUÉS de componer cada renglón: anteponerlo al texto lo pierde,
  // porque el envoltorio rejunta con un solo espacio.
  const util = ANCHO - 2;
  let ln = '';
  for (const item of declara) {
    if (!ln) ln = item;
    else if ((ln + ' · ' + item).length <= util) ln += ' · ' + item;
    else { out.push(esc('  ' + ln)); ln = item; }
  }
  if (ln) out.push(esc('  ' + corta(ln, util)));
  return out;
}

const fechaCorta = (iso: string | null): string => {
  if (!iso) return 'sin fecha';
  // Se parte el string, NO `new Date(iso)`: un `date` de Postgres leído como UTC y renderizado
  // en hora de México sale con el día ANTERIOR. Ya costó una entrega en la Fase LC.
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}/${m}/${y.slice(2)}` : iso;
};

/**
 * Arma el cuerpo del ticket. Separado del render para poder probarlo sin un navegador
 * (igual que `cuerpoTicket` del arqueo, que tiene su propia spec).
 */
export function cuerpoTicketVenta(t: TicketVenta): string {
  const L: string[] = [];
  const c = t.cascada;
  // El precio de lista sólo se imprime si algún renglón tiene con qué compararse.
  const conLista = c.lineas_con_lista > 0;
  // El desglose de impuesto por producto sale SOLO si la suma de los renglones reproduce la que
  // declara el documento (lo verifica el backend contra la cabecera de Kepler). Unos importes
  // que no suman lo declarado son peores que no tenerlos (ADR-056).
  const conImp = c.impuesto_desglosado;

  // ── Encabezado. A 45 caracteres ya no caben dos columnas, así que va centrado y apilado,
  //    como cualquier ticket de rollo.
  L.push(centro('MEGA DULCES'));
  const plaza = t.sucursal_nombre || t.sucursal;
  if (plaza) L.push(centro(plaza));
  // La identidad COMPLETA (`05UD1005-0006440`) va arriba y no al pie: es lo que se vuelve a
  // teclear en la pantalla para encontrar este mismo documento.
  L.push(fila((t.caja != null ? 'Caja ' + t.caja : ''), fechaCorta(t.fecha)));
  L.push(fila('Folio', t.id));
  // El tipo de documento sólo se imprime cuando NO hay caja: con caja, `doc_label` es
  // "Ticket Contado Caja 5" y repite lo que ya dice el renglón de arriba. Sin caja
  // (telemarketing, crédito) sí informa: "Factura Telemarketing".
  if (t.caja == null) L.push(...envolver(t.doc_label || t.origen_label).map(esc));
  if (t.cliente_nombre) L.push(...envolver('Cliente: ' + t.cliente_nombre).map(esc));
  if (t.cliente_rfc) L.push(...envolver('RFC: ' + t.cliente_rfc).map(esc));
  if (t.atendio) L.push(...envolver((t.atendio_rol || 'Atendió') + ': ' + t.atendio).map(esc));

  L.push(linea());

  if (!t.lineas.length) {
    L.push(centro('SIN RENGLONES'));
    L.push(...envolver('Este documento no tiene detalle de productos en el sistema.').map(esc));
  } else {
    for (const l of t.lineas) {
      const base = l.descripcion || l.sku || 'PRODUCTO';
      // La equivalencia de peldaño ("35 CJA") va pegada al nombre si cabe. Es DESCRIPTIVA, no
      // entra en la aritmética, y sigue estando en la carta y en la pantalla.
      const conEq = l.equivalencia ? `${base} (${l.equivalencia})` : base;
      const nombre = conEq.length <= ANCHO ? conEq : base;
      const unidad = l.unidad ? ' ' + l.unidad : '';
      const operacion = `${cant(l.cantidad)}${unidad} x ${money(l.precio_pagado)}`;

      // Lo que hay que declarar de este producto. Vacío ⇒ el renglón no se imprime.
      const declara: string[] = [];
      if (conLista && l.lista_conocida && l.descuento_linea > 0) {
        declara.push('Lista ' + money(l.precio_lista));
      }
      if (l.descuento_linea > 0) declara.push('Desc -' + money(l.descuento_linea));
      // IVA e IEPS con su nombre, no con una letra clave: acá el renglón es libre y la palabra
      // entra. Nunca vienen los dos (0 de 123,203 renglones medidos).
      if (conImp && l.iva > 0) declara.push('IVA ' + money(l.iva));
      if (conImp && l.ieps > 0) declara.push('IEPS ' + money(l.ieps));

      L.push(...producto(nombre, operacion, money(l.importe), declara));
    }
  }

  L.push(linea());

  // ── Totales, uno por renglón: a 45 caracteres no caben en línea como en el formato ancho.
  if (c.descuento_precio > 0 || c.descuento_documento !== 0) {
    L.push(fila('Lista', pesos(c.importe_lista)));
  }
  if (c.descuento_precio > 0) L.push(fila('Descuento', '-' + pesos(c.descuento_precio)));
  if (c.descuento_documento > 0) L.push(fila('Desc. documento', '-' + pesos(c.descuento_documento)));
  // Hay documentos donde el total es MAYOR que la suma de renglones (redondeo a favor del
  // cliente). Llamarlo "descuento negativo" confundiría; se nombra por lo que es.
  else if (c.descuento_documento < 0) L.push(fila('Ajuste', pesos(-c.descuento_documento)));
  if (!t.impuestos_incluidos && c.iva) L.push(fila('IVA', pesos(c.iva)));
  L.push(fila('TOTAL', pesos(c.total)));

  if (c.descuento_total > 0) {
    L.push(centro(`AHORRASTE ${pesos(c.descuento_total)} (${c.descuento_total_pct}%)`));
  }

  // ⚠️ Acá iban el sello «No es comprobante fiscal · Reimpreso …» y el aviso del backend. Los
  // dos se quitaron del PAPEL por decisión del usuario (TK.5). El aviso sigue saliendo en
  // `/comercial/tickets`: ver la cabecera del archivo para por qué eso no es lo mismo que
  // borrarlo.

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
  /* Rollo de 80 mm con alto continuo. Los 72 mm útiles (80 menos 4 de margen por lado) son
     los que dan los 45 caracteres de ANCHO — está medido, ver la cabecera de ticket-venta.ts.
     ⚠️ Si se toca el ancho, el margen o el font-size, hay que volver a medir y ajustar ANCHO
     en el mismo cambio: la maqueta cuenta caracteres, no usa CSS para alinear. */
  @page { size: 80mm auto; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { width: 72mm; padding: 3mm 4mm; color: #000;
         font-family: "Courier New", ui-monospace, monospace; font-size: 10px; line-height: 1.25; }
  pre { margin: 0; white-space: pre; }
</style></head><body><pre>${cuerpoTicketVenta(t)}</pre></body></html>`);
  doc.close();

  const lanzar = () => {
    try { win.focus(); win.print(); } catch { /* si el navegador lo niega, queda el boton manual */ }
    // El iframe se retira DESPUES de imprimir: quitarlo antes cancela el trabajo en algunos
    // navegadores. 1.5 s alcanza incluso con el dialogo abierto.
    setTimeout(() => marco.remove(), 1500);
  };
  // Deja pintar antes de disparar; si no, algunas termicas sacan la hoja en blanco.
  if (doc.readyState === 'complete') setTimeout(lanzar, 120);
  else marco.onload = () => setTimeout(lanzar, 120);
  return true;
}
