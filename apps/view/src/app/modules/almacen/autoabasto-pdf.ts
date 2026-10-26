/**
 * `[AB.13]` → `[AB.28]` PDF del **reporte de necesidades** de Autoabasto: lo que le falta a un almacén,
 * con la fecha, la hora y el almacén impresos.
 *
 * Reusa las piezas comunes de los PDF de Compras (logo, encabezado, recuadros, pies) para que
 * todos los documentos de la suite se vean igual sin copiar código.
 *
 * ── De dónde sale cada cosa ─────────────────────────────────────────────────────────────────
 *  · Fecha y hora: del SERVIDOR, en hora de México (`fecha_mx`/`hora_mx`). No se usa el reloj de
 *    la computadora: el papel dice cuándo se consultó el dato, y ese reloj puede estar mal.
 *  · `[AB.28]` Filas y resumen: los de `GET /commercial/autoabasto/renglones`, la MISMA cuenta que
 *    la mesa y «Mi pedido». Se fue la «Acción» por sobrante de la red (FASE_AB D3): el papel dice a
 *    quién se le pide (su canal), lo que ya viene y la falta neta.
 *  · La sucursal se NOMBRA, nunca se numera: el papel lo lee alguien que no sabe qué es «07».
 *
 * ⚠️ Sólo Latin-1: la Helvetica de jsPDF no trae flechas, rayas largas ni el signo menos.
 */
import type jsPDFType from 'jspdf';
import {
  loadLibs, loadLogo, dibujarEncabezado, dibujarRecuadro, dibujarNotas, dibujarPies,
  tablaBase, alinearTitulos, lastY, money, textoParaArchivo, M, MUTED, HEAD, INK,
} from '../compras/compras-pdf-comun';
import { coberturaAutoabasto, ESTADO_RENGLON_LABEL, type AutoabastoMesaRenglon, type AutoabastoRenglonesResponse } from '@megadulces/contracts';
import { qty, cuandoTexto, surteTexto } from './porques.util';

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** `2026-10-07` → `07 oct 2026`, sin pasar por la zona horaria del navegador. */
export function fechaLarga(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd ?? '');
  if (!m) return ymd ?? '';
  return `${m[3]} ${MESES[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** A quién se le pide, para el papel. «Sin ruta» va al final del reporte. */
export function surtePdf(r: Pick<AutoabastoMesaRenglon, 'surte'>): string {
  return r.surte.tipo === 'matriz' ? `Traspaso de ${surteTexto(r.surte)}` : surteTexto(r.surte);
}

/** Lo que el reporte necesita además de los datos del servidor. */
export interface AutoabastoPdfOpts {
  /** Los filtros aplicados, ya en palabras ("Estado: Falta por pedir"…). */
  filtros: string[];
  /** Quién lo generó (el usuario de la sesión). */
  generadoPor: string | null;
}

/** Arma el PDF y lo descarga. Devuelve el nombre del archivo. */
export async function descargarPdfAutoabasto(rep: AutoabastoRenglonesResponse, opts: AutoabastoPdfOpts): Promise<string> {
  const [{ jsPDF, autoTable }, logo] = await Promise.all([loadLibs(), loadLogo()]);
  // `compress`: sin él, 3,000 renglones pesan 7 MB (medido: 144 páginas, 7,041 KB).
  const doc: jsPDFType = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter', compress: true });
  const W = doc.internal.pageSize.getWidth();
  const { almacen, resumen: r } = rep;

  let y = dibujarEncabezado(doc, logo, {
    titulo: 'Reporte de necesidades - Autoabasto',
    cajaTitulo: `ALMACÉN ${almacen.name}`,
    cajaLineas: [
      `Fecha: ${fechaLarga(rep.fecha_mx)}`,
      `Hora: ${rep.hora_mx} (hora de México)`,
      `Generó: ${opts.generadoPor || 'sin usuario'}`,
    ],
  });

  // ── Recuadros: qué hay que revisar primero y cuánto vale lo que se pide, por a quién.
  // Un importe que no se pudo medir se imprime «sin medir», nunca $0.
  const pesos = (v: number | null) => (v == null ? 'sin medir' : money(v));
  const cajas: [string, string][] = [
    ['Falta por pedir', String(r.por_estado.sin_pedir)],
    ['Lo pediste a Compras', String(r.por_estado.lo_pediste)],
    ['Compras lo planeó', String(r.por_estado.compras_lo_planeo)],
    ['Ya viene', String(r.por_estado.ya_viene)],
    ['Se pide a la matriz', pesos(r.por_surte.matriz.valor)],
    ['Se pide al proveedor', pesos(r.por_surte.proveedor.valor)],
  ];
  const gap = 10;
  const bw = (W - 2 * M - gap * (cajas.length - 1)) / cajas.length;
  cajas.forEach(([t, v], i) => dibujarRecuadro(doc, M + i * (bw + gap), y, bw, 40, t, v));
  y += 52;

  const rows = rep.renglones;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
  const filtros = opts.filtros.length ? `Filtros: ${opts.filtros.join(' · ')}` : 'Sin filtros: todo lo que le falta al almacén.';
  doc.text(doc.splitTextToSize(`${filtros} · ${rows.length} producto(s)`, W - 2 * M), M, y);
  y += 12;

  // ── La tabla ────────────────────────────────────────────────────────────────────────────
  // Lo que no vendió en el periodo medido va APARTE, al final: la política dice que hay que tenerlo,
  // pero pedirlo es una decisión que hay que revisar, no una necesidad demostrada. Se decide por
  // `sales_rank` (existe sólo si vendió algo), no por la venta diaria redondeada (AB.13).
  const vende = (x: AutoabastoMesaRenglon) => x.diagnostico.sales_rank != null;
  const conVenta = rows.filter(vende);
  const sinVenta = rows.filter((x) => !vende(x));

  const COLS = 11;
  const n = (v: number | null | undefined) => (Number(v) > 0 ? qty(v) : '-');
  const suma = (rs: AutoabastoMesaRenglon[], k: 'falta' | 'falta_neta') => rs.reduce((a, x) => a + (Number(x[k]) || 0), 0);
  const fila = (x: AutoabastoMesaRenglon) => [
    x.sku, x.nombre,
    qty(x.existencia), qty(x.diagnostico.min_stock), qty(x.diagnostico.reorder_point), qty(x.diagnostico.max_stock),
    qty(x.falta), n(x.ya_pedido + x.en_camino), qty(x.falta_neta),
    ESTADO_RENGLON_LABEL[x.estado], cuandoTexto({ next_due_date: x.diagnostico.next_due_date, cadence_days: x.diagnostico.cadence_days }),
  ];
  const titulo = (texto: string, fill: [number, number, number], color: [number, number, number]) =>
    [{ content: texto, colSpan: COLS, styles: { fillColor: fill, textColor: color, fontStyle: 'bold', fontSize: 8 } }];

  /**
   * Agrupado por A QUIÉN se le pide (su canal): así cada pedido queda junto, que es como se hace.
   * Los grupos van por falta neta, de mayor a menor; «sin ruta» al final porque ahí el origen no
   * está decidido.
   */
  const porSurte = (rs: AutoabastoMesaRenglon[]) => {
    const g = new Map<string, AutoabastoMesaRenglon[]>();
    for (const x of rs) g.set(surtePdf(x), [...(g.get(surtePdf(x)) ?? []), x]);
    return [...g.entries()]
      .map(([k, v]) => ({ k, sinRuta: v[0].surte.tipo === 'sin_ruta', v: v.sort((a, b) => b.falta_neta - a.falta_neta || a.sku.localeCompare(b.sku)) }))
      .sort((a, b) => Number(a.sinRuta) - Number(b.sinRuta) || suma(b.v, 'falta_neta') - suma(a.v, 'falta_neta'));
  };
  const bloque = (rs: AutoabastoMesaRenglon[]) => porSurte(rs).flatMap(({ k, v }) => [
    titulo(`${k}  ·  ${v.length} producto(s)  ·  falta neta ${qty(suma(v, 'falta_neta'))} caja(s)`, [231, 229, 228], INK),
    ...v.map(fila),
  ]);

  const body: unknown[] = [...bloque(conVenta)];
  if (sinVenta.length) {
    body.push(titulo(`SIN VENTA MEDIDA - revisar antes de pedir  ·  ${sinVenta.length} producto(s): la política pide tenerlos, pero no se vendieron en el periodo medido`, [254, 243, 199], [146, 64, 14]));
    body.push(...bloque(sinVenta));
  }

  autoTable(doc, {
    ...tablaBase,
    startY: y,
    head: [['SKU', 'Producto', 'Exist.', 'Mín', 'Reorden', 'Máx', 'Falta', 'Ya viene', 'Falta neta', 'Estado', 'Entrega']],
    body: body.length ? body : [[{ content: 'Nada que abastecer con estos filtros.', colSpan: COLS, styles: { halign: 'center', textColor: MUTED } }]],
    foot: body.length ? [['', 'Total (cajas)', '', '', '', '', qty(suma(rows, 'falta')), '', qty(suma(rows, 'falta_neta')), '', '']] : undefined,
    showFoot: 'lastPage',
    footStyles: { fillColor: [245, 245, 244], textColor: INK, fontStyle: 'bold' },
    styles: { ...tablaBase.styles, fontSize: 7.5, cellPadding: 3 },
    headStyles: { ...tablaBase.headStyles, fontSize: 7.5 },
    columnStyles: {
      0: { cellWidth: 52 },
      1: { cellWidth: 'auto' },
      ...Object.fromEntries([2, 3, 4, 5, 6, 7, 8].map((i) => [i, { halign: 'right', cellWidth: 46 }])),
      8: { halign: 'right', cellWidth: 50, fontStyle: 'bold' },
      9: { cellWidth: 74 },
      10: { cellWidth: 52 },
    },
    didParseCell: alinearTitulos([2, 3, 4, 5, 6, 7, 8]),
  });

  // ── Notas: cómo se lee cada columna ────────────────────────────────────────────────────
  const dias = coberturaAutoabasto(almacen.code).toLocaleString('es-MX', { maximumFractionDigits: 1 });
  const notas = [
    `Cantidades en cajas. Objetivo = venta diaria por temporalidad, para ${dias} días de cobertura de este almacén. Falta = objetivo - existencia.`,
    'Ya viene = pedido abierto a la matriz (7 días o menos) + embarcado sin recibir. Falta neta = falta - ya viene: es lo que hay que pedir.',
    'Lo que Compras planeó y todavía no está en Kepler NO se resta: mientras no sea un pedido en Kepler, la matriz no lo surte.',
  ];
  if (!rep.pedidos_medidos) {
    notas.push('Esta sucursal no tiene cliente de traspaso en Kepler: lo ya pedido NO se pudo medir, así que «Ya viene» puede quedarse corto.');
  }
  if (r.sin_valuar > 0) {
    notas.push(`${r.sin_valuar} producto(s) no entran en los importes de arriba: su costo de compra no coincide con su unidad, así que el dinero no se está midiendo. Las cantidades sí son válidas.`);
  }
  notas.push('Documento informativo: no es un pedido ni una requisición.');
  y = dibujarNotas(doc, lastY(doc, y) + 16, notas);

  // ── Firmas ───────────────────────────────────────────────────────────────────────────────
  const H = doc.internal.pageSize.getHeight();
  if (y > H - 90) { doc.addPage(); y = M; }
  const fy = Math.max(y + 34, H - 78);
  const firmas = [`Elaboró (Almacén) · ${opts.generadoPor || ''}`, 'Revisó (Encargado de sucursal)'];
  const fw = (W - 2 * M - 40) / 3;
  firmas.forEach((f, i) => {
    const fx = M + i * (fw + 20);
    doc.setDrawColor(...HEAD); doc.line(fx, fy, fx + fw, fy);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
    doc.text(f, fx, fy + 11);
  });

  // La hora ya va en el encabezado (la del servidor): el pie no repite una segunda, del navegador.
  dibujarPies(doc, `Autoabasto ${almacen.name} · ${fechaLarga(rep.fecha_mx)} ${rep.hora_mx}`, null, 'Almacén > Autoabasto');

  const archivo = `AUTOABASTO-${textoParaArchivo(almacen.name, 24)}-${rep.fecha_mx}-${rep.hora_mx.replace(':', '-')}.pdf`;
  doc.save(archivo);
  return archivo;
}
