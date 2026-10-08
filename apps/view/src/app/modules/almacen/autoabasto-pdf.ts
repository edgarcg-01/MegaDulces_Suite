/**
 * `[AB.13]` PDF del **reporte de necesidades** de Autoabasto: lo que un almacén va a ocupar, con
 * la fecha, la hora y el almacén impresos.
 *
 * Reusa las piezas comunes de los PDF de Compras (logo, encabezado, recuadros, pies) para que
 * todos los documentos de la suite se vean igual sin copiar código.
 *
 * ── De dónde sale cada cosa ─────────────────────────────────────────────────────────────────
 *  · Fecha y hora: del SERVIDOR, en hora de México (`fecha_mx`/`hora_mx`). No se usa el reloj de
 *    la computadora: el papel dice cuándo se consultó el dato, y ese reloj puede estar mal.
 *  · Filas y resumen: los MISMOS que la mesa — un solo motor, una sola cifra.
 *
 * ⚠️ Sólo Latin-1: la Helvetica de jsPDF no trae flechas, rayas largas ni el signo menos. Por eso
 * el origen dice «De 03» y no «← 03», y las restas usan el guion común.
 */
import type jsPDFType from 'jspdf';
import {
  loadLibs, loadLogo, dibujarEncabezado, dibujarRecuadro, dibujarNotas, dibujarPies,
  tablaBase, alinearTitulos, lastY, money, textoParaArchivo, M, MUTED, HEAD, INK,
} from '../compras/compras-pdf-comun';
import type { AutoabastoReporte, AutoabastoRow, AutoabastoAccion } from './autoabasto.service';
import { qty, cuandoTexto } from './porques.util';

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** `2026-10-07` → `07 oct 2026`, sin pasar por la zona horaria del navegador. */
export function fechaLarga(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd ?? '');
  if (!m) return ymd ?? '';
  return `${m[3]} ${MESES[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

const ACCION: Record<AutoabastoAccion, string> = {
  traspaso: 'Traspaso',
  traspaso_parcial: 'Traspaso parcial',
  comprar: 'Comprar',
  sobrante: 'Sobrante',
  ok: 'Cubierto',
};

/** A quién se le pide, en Latin-1 (sin la flecha de la pantalla). */
export function origenPdf(r: Pick<AutoabastoRow, 'replenish_via' | 'source_warehouse_code' | 'supplier_name'>): string {
  if (r.replenish_via === 'transfer') return r.source_warehouse_code ? `De ${r.source_warehouse_code}` : 'Traspaso';
  if (r.replenish_via === 'purchase') return r.supplier_name || 'Compra';
  return r.supplier_name ? `${r.supplier_name} (sin ruta)` : 'Sin ruta';
}

/** Lo que el reporte necesita además de los datos del servidor. */
export interface AutoabastoPdfOpts {
  /** Los filtros aplicados, ya en palabras ("Proveedor: Bimbo", "Acción: Comprar"…). */
  filtros: string[];
  /** Filas a imprimir: las del servidor, ya recortadas por el filtro de acción si lo hay. */
  rows: AutoabastoRow[];
}

/** Arma el PDF y lo descarga. Devuelve el nombre del archivo. */
export async function descargarPdfAutoabasto(rep: AutoabastoReporte, opts: AutoabastoPdfOpts): Promise<string> {
  const [{ jsPDF, autoTable }, logo] = await Promise.all([loadLibs(), loadLogo()]);
  // `compress`: sin él, 3,000 renglones pesan 7 MB (medido: 144 páginas, 7,041 KB).
  const doc: jsPDFType = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter', compress: true });
  const W = doc.internal.pageSize.getWidth();
  const { almacen, resumen: r } = rep;

  let y = dibujarEncabezado(doc, logo, {
    titulo: 'Reporte de necesidades - Autoabasto',
    cajaTitulo: `ALMACÉN ${almacen.code} · ${almacen.name}`,
    cajaLineas: [
      `Fecha: ${fechaLarga(rep.fecha_mx)}`,
      `Hora: ${rep.hora_mx} (hora de México)`,
      `Generó: ${rep.generado_por || 'sin usuario'}`,
    ],
  });

  // ── Recuadros: la posición del almacén y el dinero, separando lo que se mueve de lo que se compra.
  // Un importe que el motor no pudo medir viaja null y se imprime "sin medir", nunca $0.
  const pesos = (v: number | null) => (v == null ? 'sin medir' : money(v));
  const cajas: [string, string][] = [
    ['Agotado', String(r.agotado ?? 0)],
    ['Bajo mínimo', String(r.bajo_minimo ?? 0)],
    ['Bajo reorden', String(r.bajo_reorden ?? 0)],
    ['Se cubre con la red', pesos(r.traspasable_valor)],
    ['Hay que comprar', pesos(r.compra_real_valor)],
  ];
  const gap = 10;
  const bw = (W - 2 * M - gap * (cajas.length - 1)) / cajas.length;
  cajas.forEach(([t, v], i) => dibujarRecuadro(doc, M + i * (bw + gap), y, bw, 40, t, v));
  y += 52;

  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
  const filtros = opts.filtros.length ? `Filtros: ${opts.filtros.join(' · ')}` : 'Sin filtros: todo lo que está en su punto de reorden o por debajo.';
  const faltan = opts.rows.filter((x) => Number(x.suggested_qty) > 0).length;
  doc.text(doc.splitTextToSize(`${filtros} · ${faltan} producto(s) con faltante`, W - 2 * M), M, y);
  y += 12;

  // ── La tabla ────────────────────────────────────────────────────────────────────────────
  // Sólo lo que FALTA: un producto en su punto de reorden pero cubierto por lo que viene en
  // camino no es «lo que va a ocupar». Se cuenta en las notas, no se imprime.
  const conFalta = opts.rows.filter((x) => Number(x.suggested_qty) > 0);
  const cubiertos = opts.rows.length - conFalta.length;
  // Lo que no tiene venta medida va APARTE, al final: no se esconde (la política dice que hay que
  // tenerlo), pero pedirlo es una decisión que hay que revisar, no una necesidad demostrada.
  //
  // ⚠️ Se decide por `sales_rank` (sólo existe si el producto vendió algo), NO por
  // `avg_daily_units`: ése llega en CAJAS y redondeado a 2 decimales, así que un producto que vende
  // 0.004 cajas al día sale 0.00. Medido en Padre Hidalgo: con el redondeado salían 1,440 «sin
  // venta»; los que de verdad no vendieron son 1,011.
  const vende = (x: AutoabastoRow) => x.sales_rank != null;
  const conVenta = conFalta.filter(vende);
  const sinVenta = conFalta.filter((x) => !vende(x));

  const COLS = 12;
  const n = (v: number | null | undefined) => (Number(v) > 0 ? qty(v) : '-');
  const suma = (rs: AutoabastoRow[], k: 'suggested_qty' | 'transfer_in' | 'buy_qty') =>
    rs.reduce((a, x) => a + (Number(x[k]) || 0), 0);
  const fila = (x: AutoabastoRow) => [
    x.sku, x.nombre,
    qty(x.on_hand), qty(x.min_stock), qty(x.reorder_point), qty(x.max_stock),
    n(x.in_transit), qty(x.suggested_qty), n(x.transfer_in), n(x.buy_qty),
    ACCION[x.accion] ?? x.accion, cuandoTexto(x),
  ];
  const titulo = (texto: string, fill: [number, number, number], color: [number, number, number]) =>
    [{ content: texto, colSpan: COLS, styles: { fillColor: fill, textColor: color, fontStyle: 'bold', fontSize: 8 } }];

  /**
   * Agrupado por A QUIÉN se le pide (proveedor o sucursal de origen): así el almacenista tiene
   * cada pedido junto, que es como lo va a hacer. Los grupos van por cajas, de mayor a menor;
   * «sin ruta» al final porque ahí el origen todavía no está decidido.
   */
  const porOrigen = (rs: AutoabastoRow[]) => {
    const g = new Map<string, AutoabastoRow[]>();
    for (const x of rs) g.set(origenPdf(x), [...(g.get(origenPdf(x)) ?? []), x]);
    return [...g.entries()]
      .map(([k, v]) => ({ k, v: v.sort((a, b) => Number(b.suggested_qty) - Number(a.suggested_qty)) }))
      .sort((a, b) => Number(/sin ruta/i.test(a.k)) - Number(/sin ruta/i.test(b.k))
        || suma(b.v, 'suggested_qty') - suma(a.v, 'suggested_qty'));
  };
  const bloque = (rs: AutoabastoRow[]) => porOrigen(rs).flatMap(({ k, v }) => [
    titulo(`${k}  ·  ${v.length} producto(s)  ·  falta ${qty(suma(v, 'suggested_qty'))} caja(s)`, [231, 229, 228], INK),
    ...v.map(fila),
  ]);

  const body: unknown[] = [...bloque(conVenta)];
  if (sinVenta.length) {
    body.push(titulo(`SIN VENTA MEDIDA - revisar antes de pedir  ·  ${sinVenta.length} producto(s): la política pide tenerlos, pero no se vendieron en el periodo medido`, [254, 243, 199], [146, 64, 14]));
    body.push(...bloque(sinVenta));
  }
  const tot = (k: 'suggested_qty' | 'transfer_in' | 'buy_qty') => qty(suma(conFalta, k));

  autoTable(doc, {
    ...tablaBase,
    startY: y,
    head: [['SKU', 'Producto', 'Exist.', 'Mín', 'Reorden', 'Máx', 'En camino', 'Falta', 'De la red', 'A comprar', 'Acción', 'Entrega']],
    body: body.length ? body : [[{ content: 'Nada que abastecer con estos filtros.', colSpan: COLS, styles: { halign: 'center', textColor: MUTED } }]],
    foot: body.length ? [['', 'Total (cajas)', '', '', '', '', '', tot('suggested_qty'), tot('transfer_in'), tot('buy_qty'), '', '']] : undefined,
    showFoot: 'lastPage',
    footStyles: { fillColor: [245, 245, 244], textColor: INK, fontStyle: 'bold' },
    styles: { ...tablaBase.styles, fontSize: 7.5, cellPadding: 3 },
    headStyles: { ...tablaBase.headStyles, fontSize: 7.5 },
    columnStyles: {
      0: { cellWidth: 52 },
      1: { cellWidth: 'auto' },
      ...Object.fromEntries([2, 3, 4, 5, 6, 7, 8, 9].map((i) => [i, { halign: 'right', cellWidth: 46 }])),
      7: { halign: 'right', cellWidth: 46, fontStyle: 'bold' },
      10: { cellWidth: 66 },
      11: { cellWidth: 52 },
    },
    didParseCell: alinearTitulos([2, 3, 4, 5, 6, 7, 8, 9]),
  });

  // ── Notas: cómo se lee cada columna ────────────────────────────────────────────────────
  const notas = [
    'Cantidades en cajas. Falta = objetivo - existencia - en camino: lo que ya viene se descuenta.',
    'De la red: la parte del sobrante de otras sucursales que le toca a este almacén. Cuando varias sucursales necesitan el mismo producto, el sobrante se reparte en proporción a lo que le falta a cada una.',
    'A comprar: lo que falta después de descontar lo que se cubre con la red.',
  ];
  if (cubiertos > 0) {
    notas.push(`${cubiertos} producto(s) están en su punto de reorden o por debajo, pero lo que ya viene en camino los cubre: no se imprimen.`);
  }
  if (r.sin_valuar_politicas > 0) {
    notas.push(`${r.sin_valuar_politicas} producto(s) no entran en los importes de arriba: su costo de compra no coincide con su unidad, así que el dinero no se está midiendo. Las cantidades sí son válidas.`);
  }
  notas.push('Documento informativo: no es un pedido ni una requisición.');
  y = dibujarNotas(doc, lastY(doc, y) + 16, notas);

  // ── Firmas ───────────────────────────────────────────────────────────────────────────────
  const H = doc.internal.pageSize.getHeight();
  if (y > H - 90) { doc.addPage(); y = M; }
  const fy = Math.max(y + 34, H - 78);
  const firmas = [`Elaboró (Almacén) · ${rep.generado_por || ''}`, 'Revisó (Encargado de sucursal)'];
  const fw = (W - 2 * M - 40) / 3;
  firmas.forEach((f, i) => {
    const fx = M + i * (fw + 20);
    doc.setDrawColor(...HEAD); doc.line(fx, fy, fx + fw, fy);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
    doc.text(f, fx, fy + 11);
  });

  // La hora ya va en el encabezado (la del servidor): el pie no repite una segunda, del navegador.
  dibujarPies(doc, `Autoabasto ${almacen.code} · ${fechaLarga(rep.fecha_mx)} ${rep.hora_mx}`, null, 'Almacén > Autoabasto');

  const archivo = `AUTOABASTO-${textoParaArchivo(almacen.code)}-${textoParaArchivo(almacen.name, 24)}-${rep.fecha_mx}-${rep.hora_mx.replace(':', '-')}.pdf`;
  doc.save(archivo);
  return archivo;
}
