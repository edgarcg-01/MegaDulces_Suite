/**
 * Fase TK.2 — Reimpresión de un ticket de venta, formato **departamental**.
 *
 * ── LA MEDIDA, Y DE DÓNDE SALE ──────────────────────────────────────────────────────────
 *
 * **139.7 × 50.8 mm** (5.5 × 2 pulgadas), especificada por diseño. NO es un rollo térmico de
 * 80 mm: es un formato **ancho y bajo**, y eso cambia la maqueta entera. El ancho se fija y el
 * alto crece con los productos (`@page { size: 139.7mm auto }`), igual que cualquier rollo:
 * los 50.8 mm son lo que mide un ticket típico, no un techo.
 *
 * **Medido en el navegador que imprime** (Courier New, 131.7 mm útiles tras 4 mm de margen por
 * lado), que es como se midió el ticket de arqueo y por eso los números son comparables:
 *
 *      8px → 103 caracteres · 2.98 mm por renglón → 15 renglones en 50.8 mm
 *      9px →  92            · 3.31                → 13
 *   ⭐ 10px →  82            · 3.64                → 12
 *     11px →  75            · 3.97                → 11
 *     12px →  69            · 4.63                →  9
 *     14px →  59            · 5.29                →  8
 *
 * **Se eligió 10px / `ANCHO = 82`.** A ese ancho **cada producto entra en UN renglón** —que es
 * lo que hace que un ticket departamental se vea así— y la cuenta cierra con la medida dada:
 * encabezado + columnas + 2 reglas + totales + leyenda ≈ 7 renglones fijos, así que **5
 * productos dan ~50 mm**, exactamente los 50.8 del diseño.
 *
 * ⚠️ **El tamaño de letra tiene techo aritmético, no estético.** El ticket no se maqueta con
 * CSS: se maqueta CONTANDO CARACTERES, y cada renglón se rellena hasta `ANCHO` exacto. Si la
 * letra crece, los 82 caracteres dejan de entrar en los 131.7 mm, el renglón se parte en dos y
 * se rompe la alineación de las columnas. **No subirla sin volver a medir**, y si se sube, bajar
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
 * ⚠️ **El descuento se imprime sólo donde existe.** Medido sobre 30 días: el 70% de los tickets
 * de mostrador no trae ninguno, y los anteriores al 2026-08-13 no tienen precio de lista en el
 * ERP. En esos casos la columna LISTA **desaparece entera** y su ancho se lo queda el nombre
 * del producto — no se imprime en blanco ni en cero.
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

/** Caracteres por renglón a 139.7 mm / 10px monoespaciada. Ver la cabecera: está MEDIDO. */
const ANCHO = 82;

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
 * Compone un renglón de la tabla en columnas de ancho fijo que suman **exactamente** `ANCHO`.
 *
 * Con precio de lista:   nombre 38 · cant 11 · lista 10 · pagado 11 · importe 12  = 82
 * Sin precio de lista:   nombre 49 · cant 11 · precio 10 ·            importe 12  = 82
 *
 * El nombre se queda con todo el sobrante porque es lo único de ancho variable — medido en el
 * anexo, su p95 es 41 caracteres y el máximo 70, así que a 38 se recorta uno de cada cinco y a
 * 49 casi ninguno.
 */
function renglon(cols: string[], conLista: boolean): string {
  const w = conLista ? [38, 11, 10, 11, 12] : [49, 11, 10, 12];
  const partes = cols.map((c, i) => i === 0 ? corta(c, w[0]).padEnd(w[0]) : corta(c, w[i]).padStart(w[i]));
  return esc(partes.join('').slice(0, ANCHO));
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
  // La columna LISTA sólo existe si algún renglón tiene con qué compararse. Sin ella, su ancho
  // se lo queda el nombre del producto — ver la cabecera del archivo.
  const conLista = c.lineas_con_lista > 0;

  // ── Encabezado: DOS renglones. El formato ancho permite poner de un lado quién vende y del
  //    otro la identidad del documento, en vez de una etiqueta por línea como en 80 mm.
  const plaza = t.sucursal_nombre || t.sucursal;
  // La identidad COMPLETA va acá arriba (`05UD1005-0006440`), no al pie: es lo que se vuelve a
  // teclear en la pantalla para encontrar este mismo documento, y así el pie se ahorra un
  // renglón — que a 50.8 mm de alto es la diferencia entre caber y no caber.
  L.push(fila(
    'MEGA DULCES' + (plaza ? ' · ' + plaza : ''),
    (t.caja != null ? 'Caja ' + t.caja + ' · ' : '') + fechaCorta(t.fecha) + ' · ' + t.id,
  ));
  const izq = t.cliente_nombre
    ? 'Cliente: ' + t.cliente_nombre + (t.cliente_rfc ? ' · ' + t.cliente_rfc : '') : '';
  // El tipo de documento sólo se imprime cuando NO hay caja: con caja, `doc_label` es
  // "Ticket Contado Caja 5" y repite palabra por palabra lo que ya dice el renglón de arriba.
  // Sin caja (telemarketing, crédito) sí informa: "Factura Telemarketing".
  const tipo = t.caja != null ? '' : (t.doc_label || t.origen_label);
  const der = (t.atendio ? (t.atendio_rol || 'Atendió') + ': ' + t.atendio : '')
    + (t.atendio && tipo ? ' · ' : '') + tipo;
  if (izq || der) L.push(fila(izq, der));

  L.push(linea());

  if (!t.lineas.length) {
    L.push(centro('SIN RENGLONES'));
    L.push(...envolver('Este documento no tiene detalle de productos en el sistema.'));
  } else {
    L.push(conLista
      ? renglon(['PRODUCTO', 'CANTIDAD', 'LISTA', 'PAGADO', 'IMPORTE'], true)
      : renglon(['PRODUCTO', 'CANTIDAD', 'PRECIO', 'IMPORTE'], false));
    const anchoNombre = conLista ? 38 : 49;
    for (const l of t.lineas) {
      const base = l.descripcion || l.sku || 'PRODUCTO';
      // La equivalencia de peldaño ("35 CJA") va PEGADA AL NOMBRE, no en un renglón propio: a
      // 50.8 mm de alto, un renglón por producto es la diferencia entre caber y no caber. Si no
      // cabe en la columna se omite — es DESCRIPTIVA, no entra en la aritmética, y sigue estando
      // en la carta y en la pantalla, que no tienen esa restricción de espacio.
      const conEq = l.equivalencia ? `${base} (${l.equivalencia})` : base;
      const nombre = conEq.length <= anchoNombre ? conEq : base;
      const cantidad = cant(l.cantidad) + (l.unidad ? ' ' + l.unidad : '');
      L.push(conLista
        ? renglon([nombre, cantidad, l.lista_conocida ? money(l.precio_lista) : '-',
            money(l.precio_pagado), money(l.importe)], true)
        : renglon([nombre, cantidad, money(l.precio_pagado), money(l.importe)], false));
    }
  }

  L.push(linea());

  // ── Totales en UN renglón cuando caben: es lo que distingue un ticket ancho de uno de rollo.
  const piezas: string[] = [];
  if (c.descuento_precio > 0 || c.descuento_documento !== 0) {
    piezas.push('Lista ' + pesos(c.importe_lista));
  }
  if (c.descuento_precio > 0) piezas.push('Descuento -' + pesos(c.descuento_precio));
  if (c.descuento_documento > 0) piezas.push('Desc. documento -' + pesos(c.descuento_documento));
  // Hay documentos donde el total es MAYOR que la suma de renglones (redondeo a favor del
  // cliente). Llamarlo "descuento negativo" confundiría; se nombra por lo que es.
  else if (c.descuento_documento < 0) piezas.push('Ajuste ' + pesos(-c.descuento_documento));
  if (!t.impuestos_incluidos && c.iva) piezas.push('IVA ' + pesos(c.iva));

  const total = 'TOTAL ' + pesos(c.total);
  const izqTot = piezas.join('   ');
  // Si no cabe todo en un renglón, los conceptos bajan y el TOTAL se queda solo — nunca se
  // recorta una cifra para que entre.
  if (izqTot && izqTot.length + total.length + 3 <= ANCHO) L.push(fila(izqTot, total));
  else { if (izqTot) L.push(fila('', izqTot)); L.push(fila('', total)); }

  // ── Cierre en UN solo renglón: ahorro a la izquierda, leyenda + sello de reimpresión a la
  //    derecha. La fecha va rotulada como "Reimpreso" porque NO es la hora de la venta, que
  //    Kepler no guarda (ver la cabecera). Antes esto eran dos renglones y a 50.8 mm de alto
  //    eso es justo lo que hacía que un ticket de 5 productos no cupiera.
  const sello = 'No es comprobante fiscal · Reimpreso ' + new Date().toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  L.push(fila(
    c.descuento_total > 0 ? `AHORRASTE ${pesos(c.descuento_total)} (${c.descuento_total_pct}%)` : '',
    sello,
  ));

  // ⚠️ El aviso viaja del backend y es lo que separa un papel honesto de uno que miente por
  // omisión. La peor de las ausencias que trae se ve IGUAL que "todo bien": un ticket anterior
  // al 13-ago-2026, con su total correcto y sin descuento, que parece decir "no hubo descuento"
  // cuando en realidad el ERP no guarda con qué precio comparar.
  if (t.aviso) L.push(...envolver('* ' + t.aviso));

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
  /* 139.7 mm de ancho (5.5") con alto continuo: los 50.8 mm del diseño son lo que mide un
     ticket típico de 5 productos, no un techo. Ver la cabecera de ticket-venta.ts. */
  @page { size: 139.7mm auto; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { width: 131.7mm; padding: 3mm 4mm; color: #000;
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
