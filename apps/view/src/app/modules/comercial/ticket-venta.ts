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
  /** [TK.10] Precio de lista SIN impuestos. `null` = no se puede publicar; nunca 0. */
  precio_neto: number | null;
  /** [TK.10] Precio pagado SIN impuestos. `null` = el desglose no cuadra. */
  precio_neto_desc: number | null;
  ieps_tasa: number;
  /** [TK.13] Lo que se imprime: por pieza y por partida. Ver `DesgloseMonto`. */
  desglose: { unitario: DesgloseMonto; partida: DesgloseMonto; descuento_cliente: number };
}

/**
 * `[TK.13]` Un juego de valores del desglose: lista − descuento = c/desc → sin imp + IVA + IEPS = neto.
 * El descuento ya incluye el del CLIENTE repartido en la partida. `null` = no se puede publicar
 * (sin lista contra qué comparar, o el impuesto no reproduce la cabecera del ERP), nunca 0.
 */
export interface DesgloseMonto {
  lista: number | null;
  descuento: number;
  con_descuento: number;
  sin_impuestos: number | null;
  iva: number | null;
  ieps: number | null;
  neto: number;
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
  /** [TK.10] Σ sin impuestos. Cierra: importe_neto + IEPS + IVA = total. `null` si no cuadra. */
  importe_neto: number | null;
  /** [TK.13] Σ de las partidas, columna por columna: la fila de totales del desglose. */
  desglose_total: DesgloseMonto;
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
  /**
   * `[TK.13]` Razón social del EMISOR (de `fiscal.issuer_config`, la agrega el controller).
   * `null`/ausente = no hay identidad configurada: el ticket omite el renglón, no lo inventa.
   */
  emisor_nombre?: string | null;
  lineas: TicketVentaLinea[];
  cascada: TicketVentaCascada;
  cuadra: boolean;
  aviso: string | null;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * `[TK.13]` El desglose de una partida. Lo manda el backend; si no viene —una API desplegada
 * ANTES de este cambio— se deriva de los campos que ya existían, para que el papel no truene.
 *
 * ⚠️ El derivado NO puede repartir el descuento de cliente (para eso hace falta el documento
 * completo, y lo hace el backend): en ese caso la partida muestra sólo el descuento por
 * producto. No inventa: donde no hay lista, `null`; sin cuadre fiscal, impuestos en `null`.
 */
export function desgloseDe(l: TicketVentaLinea, desglosado: boolean): TicketVentaLinea['desglose'] {
  if (l.desglose) return l.desglose;
  const q = l.cantidad > 0 ? l.cantidad : 1;
  const sin = desglosado ? r2(l.importe - l.iva - l.ieps) : null;
  const partida: DesgloseMonto = {
    lista: l.lista_conocida ? r2(l.precio_lista * l.cantidad) : null,
    descuento: l.lista_conocida ? l.descuento_linea : 0,
    con_descuento: l.importe, sin_impuestos: sin,
    iva: desglosado ? l.iva : null, ieps: desglosado ? l.ieps : null, neto: l.importe,
  };
  const netoU = r2(l.importe / q);
  const sinU = sin != null ? r2(sin / q) : null;
  const impU = sinU != null ? r2(netoU - sinU) : null;
  const unitario: DesgloseMonto = {
    lista: l.lista_conocida ? l.precio_lista : null,
    descuento: l.lista_conocida ? l.descuento_unitario : 0,
    con_descuento: netoU, sin_impuestos: sinU,
    iva: impU == null ? null : (l.impuesto_tipo === 'iva' ? impU : 0),
    ieps: impU == null ? null : (l.impuesto_tipo === 'ieps' ? impU : 0),
    neto: netoU,
  };
  return { unitario, partida, descuento_cliente: 0 };
}

/** `[TK.13]` La fila de totales: la del backend, o la suma de las partidas si no vino. */
export function desgloseTotalDe(t: TicketVenta): DesgloseMonto {
  if (t.cascada.desglose_total) return t.cascada.desglose_total;
  const ps = t.lineas.map((l) => desgloseDe(l, t.cascada.impuesto_desglosado).partida);
  const suma = (k: 'sin_impuestos' | 'iva' | 'ieps') =>
    ps.some((p) => p[k] == null) ? null : r2(ps.reduce((a, p) => a + (p[k] as number), 0));
  return {
    lista: ps.some((p) => p.lista != null) ? t.cascada.importe_lista : null,
    descuento: r2(ps.reduce((a, p) => a + p.descuento, 0)),
    con_descuento: r2(ps.reduce((a, p) => a + p.con_descuento, 0)),
    sin_impuestos: suma('sin_impuestos'), iva: suma('iva'), ieps: suma('ieps'),
    neto: r2(ps.reduce((a, p) => a + p.neto, 0)),
  };
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
 * `[TK.13]` Cuánto se separa del borde derecho el renglón de impuestos de la PARTIDA: 12 mm,
 * pedido por el usuario. A 10px Courier cada carácter mide 6px = 1.5875 mm → 12 mm son 7.56
 * caracteres; se redondea a 8 (12.7 mm). ⚠️ Si cambia `ANCHO` o el font-size, se recalcula.
 */
const SANGRIA_IMP_PARTIDA = 8;

/**
 * Un renglón pegado al borde DERECHO, dejando `hueco` caracteres libres al final. Si no cabe
 * con el hueco, se pega al borde; si ni así cabe, se recorta — un renglón del rollo nunca pasa
 * de `ANCHO` (se partiría en el papel y lo que se parte es el importe).
 */
function aLaDerecha(t: string, hueco = 0): string {
  const h = t.length + hueco <= ANCHO ? hueco : 0;
  const s = t.length + h <= ANCHO ? t : corta(t, ANCHO - h);
  return esc(' '.repeat(ANCHO - h - s.length) + s + ' '.repeat(h));
}

/**
 * `[TK.13]` Una partida en el rollo, en el acomodo que eligió el usuario (maqueta «C»):
 *
 *     PALOMITA JUMBO QUESO 800GR FROCKITAS    00038   ← 1 · nombre · código
 *       c/u 75.31 -9.08 = 66.23                       ← 2 · valor unitario
 *       s/imp 57.10 + IVA 16% 9.13                    ← 3 · impuestos del unitario
 *                   x4 PZA 301.24 -36.32 = 264.92     ← 4 · la partida, TODA a la derecha
 *               s/imp 228.38 + IVA 36.54              ← 5 · sus impuestos, 12 mm antes del borde
 *
 * ⭐ La columna derecha trae SIEMPRE el importe de la partida, y su suma es el TOTAL del ticket.
 * Por eso, con UNA pieza (donde unitario = partida y no hay renglones 2–3), el único renglón de
 * la cuenta va a la derecha y el de impuestos con la misma sangría de 12 mm.
 *
 *   · Sin descuento no se imprime `-0.00` (se leería «te descontamos cero»).
 *   · El renglón `s/imp` sólo va si el impuesto cuadra con la cabecera del ERP y el producto lo
 *     causa: si no causa ninguno, «sin impuestos» es el mismo número que el neto.
 *   · IVA e IEPS nunca coinciden en un renglón (0 de 123,203), así que va uno u otro.
 */
function partidaTermica(l: TicketVentaLinea, desglosado: boolean): string[] {
  const d = desgloseDe(l, desglosado);
  const out: string[] = [];
  const base = l.descripcion || l.sku || 'PRODUCTO';
  // La equivalencia de peldaño ("35 CJA") va pegada al nombre si cabe: es descriptiva.
  const conEq = l.equivalencia ? `${base} (${l.equivalencia})` : base;
  out.push(fila(conEq.length + (l.sku?.length ?? 0) + 1 <= ANCHO ? conEq : base, l.sku || ''));

  const unidad = l.unidad ? ' ' + l.unidad : '';
  /** `c/u 75.31 -9.08 = 66.23` — lista − descuento = precio con descuento. */
  const cuenta = (etiqueta: string, m: DesgloseMonto) => (m.descuento > 0 && m.lista != null
    ? `${etiqueta} ${money(m.lista)} -${money(m.descuento)} = ${money(m.con_descuento)}`
    : `${etiqueta} ${money(m.con_descuento)}`);
  /** `s/imp 57.10 + IVA 16% 9.13`. En pedidos (sin impuesto adentro) cierra con `= neto`. */
  const impuestos = (m: DesgloseMonto, conTasa: boolean): string | null => {
    const iva = m.iva ?? 0;
    const ieps = m.ieps ?? 0;
    if (m.sin_impuestos == null || (iva <= 0 && ieps <= 0)) return null;
    const tasa = (v: number) => (conTasa && v > 0 ? ` ${Math.round(v * 100)}%` : '');
    const imp = iva > 0 ? `IVA${tasa(l.iva_tasa)} ${money(iva)}` : `IEPS${tasa(l.ieps_tasa)} ${money(ieps)}`;
    const cierre = m.con_descuento !== m.neto ? ` = ${money(m.neto)}` : '';
    return `s/imp ${money(m.sin_impuestos)} + ${imp}${cierre}`;
  };

  if (l.cantidad !== 1) {
    out.push(esc('  ' + cuenta('c/u', d.unitario)));
    const iu = impuestos(d.unitario, true);
    if (iu) out.push(esc('  ' + iu));
  }
  // La partida: toda a la derecha, y sus impuestos 12 mm antes del borde.
  const etiquetaPartida = l.cantidad === 1 ? `1${unidad}` : `x${cant(l.cantidad)}${unidad}`;
  out.push(aLaDerecha(cuenta(etiquetaPartida, d.partida)));
  const ip = impuestos(d.partida, l.cantidad === 1);
  if (ip) out.push(aLaDerecha(ip, SANGRIA_IMP_PARTIDA));
  return out;
}

/** `dd/MM/yy HH:mm` en hora de México — la del momento de reimprimir. */
const ahoraMx = (d: Date): string => {
  const p = new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce<Record<string, string>>((a, x) => ({ ...a, [x.type]: x.value }), {});
  return `${p['day']}/${p['month']}/${p['year']} ${p['hour']}:${p['minute']}`;
};

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
export function cuerpoTicketVenta(t: TicketVenta, ahora: Date = new Date()): string {
  const L: string[] = [];
  const c = t.cascada;

  // ── Encabezado. A 45 caracteres ya no caben dos columnas, así que va centrado y apilado,
  //    como cualquier ticket de rollo. `[TK.13]` Orden pedido por el usuario: marca, razón
  //    social del emisor, sucursal y la marca de REIMPRESIÓN con su fecha y hora.
  L.push(centro('MEGA DULCES'));
  if (t.emisor_nombre) L.push(...envolver(t.emisor_nombre).map(centro));
  const plaza = t.sucursal_nombre || t.sucursal;
  if (plaza) L.push(centro(plaza));
  // ⚠️ La hora que se imprime es la de la REIMPRESIÓN, y va rotulada como tal. La de la venta
  // no existe: Kepler no la guarda (sus 10 columnas timestamp están en 00:00:00). Por eso la
  // fecha de abajo dice «Venta»: son dos fechas distintas y el papel no puede mezclarlas.
  L.push(centro('REIMPRESIÓN ' + ahoraMx(ahora)));
  // La identidad COMPLETA (`05UD1005-0006440`) va arriba y no al pie: es lo que se vuelve a
  // teclear en la pantalla para encontrar este mismo documento.
  L.push(fila((t.caja != null ? 'Caja ' + t.caja : ''), 'Venta ' + fechaCorta(t.fecha)));
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
    for (const l of t.lineas) L.push(...partidaTermica(l, c.impuesto_desglosado));
  }

  L.push(linea());

  // ── Totales, uno por renglón. Salen del MISMO desglose que las partidas (`desglose_total`):
  //    si salieran de la cabecera del ERP, el papel podría decir dos IVA distintos por centavos.
  const tot = desgloseTotalDe(t);
  if (tot.descuento > 0 && tot.lista != null) L.push(fila('Precio de lista', pesos(tot.lista)));
  if (c.descuento_precio > 0) L.push(fila('Descuento en precio', '-' + pesos(c.descuento_precio)));
  // `[TK.d2]` El mismo nombre que la carta y la pantalla, y CON el porcentaje. El importe es el
  // MEDIDO (Σ renglones − total), nunca `kdm1.c13`: ése viaja sin impuesto y subdeclara (TK.d3b).
  if (c.descuento_documento > 0) {
    const pct = c.descuento_documento_pct_erp ? ` (${c.descuento_documento_pct_erp}%)` : '';
    L.push(fila(`Descuento de cliente${pct}`, '-' + pesos(c.descuento_documento)));
  }
  // Hay documentos cuyo total queda ARRIBA de sus renglones (redondeo a favor del cliente).
  // Llamarlo "descuento negativo" confundiría; se nombra por lo que es.
  if (c.descuento_documento < 0) L.push(fila('Ajuste', pesos(-c.descuento_documento)));
  if (tot.sin_impuestos != null) {
    L.push(fila('Sin impuestos', pesos(tot.sin_impuestos)));
    if (tot.iva) L.push(fila('IVA', pesos(tot.iva)));
    if (tot.ieps) L.push(fila('IEPS', pesos(tot.ieps)));
  }
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
