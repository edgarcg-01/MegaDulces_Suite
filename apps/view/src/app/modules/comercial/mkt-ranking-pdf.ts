/**
 * `[MKT.12]` Los PDF del ranking de promociones y de los incentivos, con las piezas comunes de los
 * documentos de la suite (`compras-pdf-comun.ts`: logo, encabezado, tabla base, pie con el origen
 * de los datos). Reemplazan el Excel semanal impreso.
 *
 * Las FILAS salen de funciones puras (probadas en `mkt-ranking-pdf.spec.ts`); el dibujo es jsPDF.
 * Sólo Latin-1: Helvetica estándar no trae flechas ni símbolos.
 */
import type jsPDFType from 'jspdf';
import {
  HEAD, M, MUTED, RULE, ZEBRA, INK,
  dibujarEncabezado, dibujarNotas, dibujarPies, fecha, fechaHoraArchivo, lastY, loadLibs, loadLogo, money, tablaBase,
  alinearTitulos,
} from '../compras/compras-pdf-comun';
import {
  CANAL_LARGO, IncentivoConResultado, ParticipanteRanking, RankingSemana, Semana, pct, textoSemana,
  textoProductos, textoVentaProducto,
} from './mkt-ranking.service';
import { warehouseName } from '@megadulces/contracts';

/** Salto de línea dentro de una celda de autoTable. */
const SALTO = String.fromCharCode(10);
const n0 = (v: number) => (Math.round(v * 100) / 100).toLocaleString('es-MX', { maximumFractionDigits: 2 });

/** Renglones de la tabla de lugares. Un participante sin ningún objetivo va sin lugar y lo dice. */
export function filasRanking(r: RankingSemana): string[][] {
  return r.participantes.map((p) => [
    p.lugar === null ? '-' : String(p.lugar),
    p.nombre,
    p.puntaje === null ? 'Sin objetivos' : pct(p.puntaje),
    `${p.cumplidas} de ${p.con_objetivo}`,
    String(p.sin_venta),
    p.sin_objetivo ? String(p.sin_objetivo) : '-',
  ]);
}

/** Renglones del detalle de un participante: lo que el Excel tenía en cada hoja. */
export function filasDetalle(p: ParticipanteRanking, conExistencia: boolean): string[][] {
  return p.promos.map((x) => {
    const fila = [
      x.code,
      [
        x.mecanica + (x.descripcion_distinta ? ' (el código cambió de promoción en Kepler)' : ''),
        ...(x.productos.length ? x.productos.map(textoVentaProducto) : [textoProductos(x.productos_metodo, [])]),
      ].join(SALTO),
      // [MKT.17] El dinámico se dice: no es una meta que alguien fijó.
      x.objetivo === null ? 'Sin objetivo' : n0(x.objetivo) + (x.objetivo_fuente === 'dinamico' ? SALTO + '(dinámico)' : ''),
      n0(x.venta),
      x.cubrimiento === null ? '-' : pct(x.cubrimiento),
    ];
    if (conExistencia) fila.push(x.existencia === null ? '-' : n0(x.existencia));
    return fila;
  });
}

/** [MKT.16] Renglones del ranking de promociones de un canal: la misma regla que el de participantes. */
export function filasPromociones(r: RankingSemana): string[][] {
  return r.promos_ranking.map((x) => [
    x.lugar === null ? '-' : String(x.lugar),
    // [MKT.24] El proveedor (lo asigna Mercadotecnia) va bajo el nombre; sin asignar, se dice.
    [`${x.nombre} (${x.code})`, `Proveedor: ${x.proveedor ? `${x.proveedor.code} · ${x.proveedor.name}${x.proveedor_fuente === 'producto' ? ' (del producto)' : ''}` : 'sin asignar'}`,
      ...(x.productos.length ? [x.productos.join(' · ')] : [])].join(SALTO),
    x.puntaje === null ? 'Sin objetivos' : pct(x.puntaje),
    `${x.cumplidas} de ${x.con_objetivo}`,
    n0(x.venta_total),
    `${x.sin_venta} de ${x.participantes}`,
  ]);
}

/** [MKT.18] Renglones del ranking por vendedora (mostrador). */
export function filasVendedoras(r: RankingSemana): string[][] {
  return (r.vendedoras?.personas ?? []).map((x) => [
    String(x.lugar),
    x.nombre,
    x.warehouse_name,
    n0(x.aplicaciones),
    String(x.tickets),
    x.promos.slice(0, 2).map((p) => `${p.mecanica} x ${n0(p.cantidad)}`).join(SALTO) + (x.promos.length > 2 ? `${SALTO}y ${x.promos.length - 2} más` : ''),
  ]);
}

/** [MKT.18] Cuánto de la venta está atribuido: el ranking por vendedora sólo cuenta eso. */
export function coberturaVendedoras(r: RankingSemana): string {
  const v = r.vendedoras;
  if (!v || !v.tickets_con_promo) return 'Esta semana no hay tickets de mostrador con promociones del ranking.';
  const sin = v.por_sucursal.filter((x) => x.tickets_con_vendedora === 0).map((x) => warehouseName(x.warehouse_code));
  return `${v.tickets_con_vendedora} de ${v.tickets_con_promo} tickets con promoción tienen vendedora `
    + `(${Math.round((100 * v.tickets_con_vendedora) / v.tickets_con_promo)} %); el ranking cuenta sólo ésos.`
    + (sin.length ? ` Sin captura: ${sin.join(', ')}.` : '');
}

/** Renglones del pago de un incentivo, con su total. */
export function filasIncentivo(i: IncentivoConResultado): string[][] {
  const rows = i.resultados.map((r) => [
    r.warehouse_name,
    r.vendor_name,
    n0(r.semana_cantidad),
    n0(r.acumulado_cantidad) + (r.sin_resolver ? ` (+${n0(r.sin_resolver)} sin factor)` : ''),
    money(r.semana_pago),
    money(r.acumulado_pago),
  ]);
  rows.push(['', 'Total', '', '', money(i.total_semana), money(i.total_acumulado)]);
  return rows;
}

function titulo(doc: jsPDFType, y: number, texto: string, sub?: string): number {
  const H = doc.internal.pageSize.getHeight();
  if (y > H - 120) { doc.addPage(); y = M; }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...INK);
  doc.text(texto, M, y + 10);
  if (sub) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
    doc.text(doc.splitTextToSize(sub, doc.internal.pageSize.getWidth() - 2 * M)[0], M, y + 22);
    return y + 30;
  }
  return y + 18;
}

export interface DatosPdfRanking {
  semana: Semana;
  /** Un ranking por canal (sólo los que tienen promociones vigentes). */
  rankings: RankingSemana[];
  elaboro: string;
  consultado: Date;
  /**
   * [MKT.21] Reporte FILTRADO: lo que la persona tenía puesto en pantalla ("Canal: Sucursales", "Sucursal: Padre
   * Hidalgo"…). Vacío o ausente = el reporte completo de la semana. Un PDF parcial que no dijera sus filtros se
   * leería como el ranking completo: por eso van en la portada, en la nota y en el nombre del archivo.
   */
  filtros?: string[];
}

/** El reporte semanal: lugares por canal y, después, el detalle de cada participante. */
export async function pdfRanking(d: DatosPdfRanking): Promise<{ blob: Blob; archivo: string }> {
  const [{ jsPDF, autoTable }, logo] = await Promise.all([loadLibs(), loadLogo()]);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const emitido = new Date();
  const filtrado = !!d.filtros?.length;
  let y = dibujarEncabezado(doc, logo, {
    titulo: filtrado ? 'Ranking de promociones (filtrado)' : 'Ranking de promociones',
    cajaTitulo: `SEMANA ${d.semana.numero}`,
    cajaLineas: [textoSemana(d.semana).replace(/^Semana \d+ · /, ''), `Emitido: ${fecha(emitido)}`, `Elaboró: ${d.elaboro}`],
  });

  if (filtrado) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
    doc.text('Reporte filtrado: no es el ranking completo.', M, y + 10);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...MUTED);
    const lineas = doc.splitTextToSize(d.filtros!.join('  ·  '), doc.internal.pageSize.getWidth() - 2 * M);
    doc.text(lineas, M, y + 24);
    y += 24 + lineas.length * 11 + 8;
  }

  for (const r of d.rankings) {
    const gen = r.promedio_general === null ? 'sin objetivos capturados'
      : `promedio general ${filtrado ? 'de la semana completa ' : ''}${pct(r.promedio_general)}`;
    y = titulo(doc, y, CANAL_LARGO[r.canal], `${r.promos_vigentes} promociones vigentes · ${gen}`);
    autoTable(doc, {
      ...tablaBase,
      startY: y,
      head: [['Lugar', r.canal === 'mostrador' ? 'Sucursal' : 'Vendedor', 'Cubrimiento', 'Cumplidas', 'Sin venta', 'Sin objetivo']],
      body: filasRanking(r),
      columnStyles: { 0: { cellWidth: 40, halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
      didParseCell: alinearTitulos([0, 2, 3, 4, 5]),
      margin: { left: M, right: M, bottom: 40 },
    });
    y = lastY(doc, y) + 16;

    // [MKT.16] La misma semana vista por promoción.
    if (r.promos_ranking.length) {
      y = titulo(doc, y, `${CANAL_LARGO[r.canal]} · por promoción`, 'Cubrimiento promedio de quienes la tienen con objetivo; cuántos llegaron a su objetivo.');
      autoTable(doc, {
        ...tablaBase,
        startY: y,
        head: [['Lugar', 'Promoción', 'Cubrimiento', 'Cumplieron', 'Venta', 'Sin venta']],
        body: filasPromociones(r),
        styles: { ...tablaBase.styles, fontSize: 7.5 },
        columnStyles: { 0: { cellWidth: 40, halign: 'right' }, 2: { halign: 'right', cellWidth: 64 }, 3: { halign: 'right', cellWidth: 60 }, 4: { halign: 'right', cellWidth: 46 }, 5: { halign: 'right', cellWidth: 52 } },
        didParseCell: alinearTitulos([0, 2, 3, 4, 5]),
        margin: { left: M, right: M, bottom: 40 },
      });
      y = lastY(doc, y) + 16;
    }

    // [MKT.18] Quién vendió en el mostrador, con lo que falta por capturar dicho.
    if (r.canal === 'mostrador' && r.vendedoras) {
      y = titulo(doc, y, 'Sucursales · por vendedora', coberturaVendedoras(r));
      if (r.vendedoras.personas.length) {
        autoTable(doc, {
          ...tablaBase,
          startY: y,
          head: [['Lugar', 'Vendedora', 'Sucursal', 'Aplicadas', 'Tickets', 'Lo que más vendió']],
          body: filasVendedoras(r),
          styles: { ...tablaBase.styles, fontSize: 7.5 },
          columnStyles: { 0: { cellWidth: 40, halign: 'right' }, 3: { halign: 'right', cellWidth: 52 }, 4: { halign: 'right', cellWidth: 44 } },
          didParseCell: alinearTitulos([0, 3, 4]),
          margin: { left: M, right: M, bottom: 40 },
        });
        y = lastY(doc, y) + 16;
      }
    }
  }

  for (const r of d.rankings) {
    for (const p of r.participantes) {
      if (!p.promos.length) continue;
      const lugar = p.lugar === null ? 'sin lugar' : `lugar ${p.lugar}`;
      y = titulo(doc, y, `${CANAL_LARGO[r.canal]} · ${p.nombre}`,
        `${lugar} · cubrimiento ${p.puntaje === null ? 'sin objetivos' : pct(p.puntaje)} · ${p.cumplidas} de ${p.con_objetivo} cumplidas`);
      const conEx = r.canal === 'mostrador';
      autoTable(doc, {
        ...tablaBase,
        startY: y,
        head: [['Código', 'Promoción', 'Objetivo', 'Venta', 'Cubrimiento', ...(conEx ? ['Existencia'] : [])]],
        body: filasDetalle(p, conEx),
        styles: { ...tablaBase.styles, fontSize: 7.5 },
        columnStyles: { 0: { cellWidth: 46 }, 2: { halign: 'right', cellWidth: 56 }, 3: { halign: 'right', cellWidth: 46 }, 4: { halign: 'right', cellWidth: 60 }, 5: { halign: 'right', cellWidth: 56 } },
        didParseCell: alinearTitulos([2, 3, 4, 5]),
        margin: { left: M, right: M, bottom: 40 },
      });
      y = lastY(doc, y) + 14;
    }
  }

  y = dibujarNotas(doc, y + 4, [
    'Cubrimiento = venta / objetivo semanal, con tope de 100 % por promoción. El lugar es el promedio de las promociones CON objetivo; las que no tienen se cuentan aparte y no como cero.',
    'Venta = veces que se aplicó el código de la promoción en Kepler, de lunes a domingo, en piezas (en Kepler la caja de un código de promoción es de 1 pieza). Existencia = regalos disponibles según Kepler.',
    'Proveedor: el que asignó Mercadotecnia en Objetivos o, marcado «del producto», el del producto que activa la promoción (sólo si todos sus productos son de un mismo proveedor). Kepler registra el código de la promoción a nombre de «PROMOCIONES MKT».',
    'Bajo cada promoción, el producto que la activa y lo vendido de él en la semana (piezas y cajas). Kepler no liga el código con el producto: se deduce de los tickets donde se aplicó y de su nombre; si no se puede, dice «sin identificar».',
    'Objetivo: el que fijó Mercadotecnia o, marcado «dinámico», el promedio de las 4 semanas anteriores dentro de la vigencia, recalculado cada semana.',
    'Por vendedora: Kepler no sabe quién vendió en el mostrador; lo escriben las cajeras en su arqueo. Cuenta sólo los tickets que tienen vendedora.',
    filtrado
      ? 'Reporte filtrado: trae sólo lo que coincide con los filtros de la portada. El lugar es el de la semana completa, por eso puede saltar números.'
      : 'Es el reporte completo de la semana: no aplica los filtros de la pantalla.',
  ]);
  dibujarPies(doc, `Ranking de promociones, semana ${d.semana.numero}`, d.consultado, 'Mercadotecnia > Ranking');
  return { blob: doc.output('blob'), archivo: `RANKING-PROMOCIONES-S${d.semana.numero}${filtrado ? '-FILTRADO' : ''}-${fechaHoraArchivo(emitido)}.pdf` };
}

export interface DatosPdfIncentivos {
  semana: Semana;
  incentivos: IncentivoConResultado[];
  elaboro: string;
  consultado: Date;
}

/** El reporte de pago de incentivos: por incentivo, lo que lleva cada vendedor y su total. */
export async function pdfIncentivos(d: DatosPdfIncentivos): Promise<{ blob: Blob; archivo: string }> {
  const [{ jsPDF, autoTable }, logo] = await Promise.all([loadLibs(), loadLogo()]);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const emitido = new Date();
  const totalSemana = d.incentivos.reduce((a, i) => a + i.total_semana, 0);
  let y = dibujarEncabezado(doc, logo, {
    titulo: 'Incentivos de venta',
    cajaTitulo: `SEMANA ${d.semana.numero}`,
    cajaTitulo2: `A pagar en la semana: ${money(totalSemana)}`,
    cajaLineas: [`Emitido: ${fecha(emitido)}`, `Elaboró: ${d.elaboro}`],
  });

  for (const i of d.incentivos) {
    const vig = `del ${i.vigencia_desde} ${i.vigencia_hasta ? `al ${i.vigencia_hasta}` : 'sin fecha de fin'}`;
    y = titulo(doc, y, i.nombre, `${i.regla} · ${vig}${i.redondeo === 'completo' ? ' · sólo unidades completas' : ''}`);
    if (!i.resultados.length) {
      y = dibujarNotas(doc, y, ['Sin venta en esta vigencia.']) + 8;
      continue;
    }
    const filas = filasIncentivo(i);
    autoTable(doc, {
      ...tablaBase,
      startY: y,
      head: [['Sucursal', 'Vendedor', 'Semana', 'Acumulado', 'A pagar semana', 'A pagar acumulado']],
      body: filas,
      styles: { ...tablaBase.styles, fontSize: 8 },
      columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
      didParseCell: (h: { section: string; row: { index: number }; column: { index: number }; cell: { styles: Record<string, unknown> } }) => {
        alinearTitulos([2, 3, 4, 5])(h as never);
        if (h.section === 'body' && h.row.index === filas.length - 1) {
          h.cell.styles['fontStyle'] = 'bold';
          h.cell.styles['fillColor'] = ZEBRA;
        }
      },
      margin: { left: M, right: M, bottom: 40 },
    });
    y = lastY(doc, y) + 6;
    if (i.nota_medicion) y = dibujarNotas(doc, y + 4, [i.nota_medicion]);
    y += 12;
  }

  // Firmas: el pago lo arma Marketing y lo autoriza quien corresponda.
  const H = doc.internal.pageSize.getHeight();
  const W = doc.internal.pageSize.getWidth();
  if (y > H - 100) { doc.addPage(); y = M; }
  const fy = Math.max(y + 40, H - 80);
  const fw = (W - 2 * M - 40) / 3;
  ['Elaboró (Mercadotecnia)', 'Autorizó', 'Recibió'].forEach((f, k) => {
    const fx = M + k * (fw + 20);
    doc.setDrawColor(...HEAD); doc.line(fx, fy, fx + fw, fy);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
    doc.text(k === 0 ? `${f} · ${d.elaboro}` : f, fx, fy + 11);
  });
  doc.setDrawColor(...RULE);
  dibujarPies(doc, `Incentivos de venta, semana ${d.semana.numero}`, d.consultado, 'Mercadotecnia > Incentivos');
  return { blob: doc.output('blob'), archivo: `INCENTIVOS-S${d.semana.numero}-${fechaHoraArchivo(emitido)}.pdf` };
}
