/**
 * `[RA-PRO.61]` PDF de una orden de compra de Kepler, desde `/compras/oc-abiertas`.
 *
 * Es una COPIA DE CONSULTA: el documento oficial es el de Kepler, y lo dice en el encabezado. Se
 * arma en el navegador con lo que devuelve `open-purchase-orders/:sucursal/:folio`; no escribe nada.
 *
 * Dos versiones, porque el PDF se envía:
 *  - **para el proveedor** (`interno: false`): la orden, sus renglones y lo que ya llegó;
 *  - **interno** (`interno: true`): además, el estatus de seguimiento de Compras y su historia.
 *    Una nota como "detenida por falta de pago" no debe salir hacia el proveedor por descuido.
 *
 * Las decisiones de números (cajas verificadas por costo, nombre del archivo) están en
 * `oc-kepler.ts` con pruebas; acá sólo se dibuja.
 */
import { OC_SEGUIMIENTO_LABEL, OC_SIN_REVISAR, OcDetalleDto, OcSeguimientoEstatus } from '@megadulces/contracts';
import {
  INK, M, MUTED, RULE, alinearTitulos, dibujarEncabezado, dibujarNotas, dibujarPies, dibujarRecuadro, fecha,
  lastY, loadLibs, loadLogo, money, tablaBase,
} from './compras-pdf-comun';
import { ESTATUS_KEPLER, nombreArchivoOc, referenciaUtil, textoCajasRenglon, totalesOc } from './oc-kepler';

/** Lo que devuelve la API para una orden: el tipo es el del contrato (ADR-052). */
export type OcDetalle = OcDetalleDto;

export interface OcPdfOpciones {
  emitido: Date;
  elaboro: string;
  sucursalNombre: string | null;
  interno: boolean;
}

const num = (v: number) => (Math.round((Number(v) || 0) * 1000) / 1000).toLocaleString('es-MX');
const dia = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
};
const etiqueta = (e: OcSeguimientoEstatus | null) => (e ? OC_SEGUIMIENTO_LABEL[e] : OC_SIN_REVISAR);

export async function generarOcPdf(data: OcDetalle, op: OcPdfOpciones): Promise<void> {
  const [{ jsPDF, autoTable }, logo] = await Promise.all([loadLibs(), loadLogo()]);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const o = data.orden;
  const est = ESTATUS_KEPLER[o.estatus_kepler] ?? o.estatus_kepler;
  // `[PQ.32]` La sucursal por NOMBRE (nunca «00»), y su dirección sólo si está capturada.
  const sucNombre = o.sucursal_nombre || op.sucursalNombre || o.sucursal;
  const entregar = o.sucursal_direccion ? `${sucNombre} — ${o.sucursal_direccion}` : sucNombre;

  // ── Encabezado ───────────────────────────────────────────────────────────────────────────
  // `[PQ.32]` Las cinco preguntas (diseno §0b), con el PDF de la OC 00/0007259 enfrente:
  //  1. Quién lo lee y qué busca: el PROVEEDOR — qué surtir, dónde entregar, cuánto le vamos a pagar.
  //  2. Qué no debe ver: el estatus interno de Kepler, los días abierta, el usuario que lo emitió,
  //     «el documento oficial es el de Kepler», el surtido en dinero y su fórmula: eso es de Compras.
  //  3. Qué acceso necesita: el TOTAL con impuestos (el de Kepler) y dónde se entrega, a la vista.
  //  4. Liga a otro proceso: el folio de la OC es el que cita en su factura; la referencia, si la hay.
  //  5. ¿Le toca?: lo interno (seguimiento, notas de calidad del dato) sólo en la copia interna.
  let y = dibujarEncabezado(doc, logo, {
    titulo: op.interno ? 'Orden de compra · copia interna' : 'Orden de compra',
    cajaTitulo: `OC ${o.folio}`,
    cajaLineas: op.interno
      ? [`Kepler: ${est} · ${o.dias} día${o.dias === 1 ? '' : 's'} abierta`, `Emitido: ${fecha(op.emitido)} · ${op.elaboro}`, `Total: ${money(o.monto)}`]
      : [`Fecha: ${dia(o.fecha)}`, `Total: ${money(o.monto)}`],
  });

  // ── Datos de la orden ────────────────────────────────────────────────────────────────────
  const ref = referenciaUtil(o.referencia);
  const body: unknown[][] = [
    ['Proveedor', { content: o.proveedor || 'Sin proveedor', styles: { fontStyle: 'bold' } }, 'RFC', o.proveedor_rfc || '—'],
    ['Entregar en', entregar, 'Condición de pago', o.condicion_pago || '—'],
    // La fecha de la orden ya está en el recuadro de arriba; aquí no se repite.
    ['Vence', dia(o.vence), ref ? 'Referencia' : '', ref || ''],
  ];
  // La referencia va en las dos (puede ser el folio que cita el proveedor). `concepto` (kdm1.c24) es
  // texto libre de Kepler que ha traído motivos internos: sólo en la copia interna.
  if (op.interno && o.concepto) body.push(['Concepto', { content: o.concepto, colSpan: 3 }]);
  autoTable(doc, {
    startY: y, margin: { left: M, right: M }, theme: 'plain', body,
    styles: { fontSize: 9.5, cellPadding: { top: 2.5, bottom: 2.5, left: 0, right: 10 }, textColor: INK },
    // Etiquetas con ancho suficiente: «Concepto» se partía en «Concept / o».
    columnStyles: { 0: { textColor: MUTED, cellWidth: 96 }, 2: { textColor: MUTED, cellWidth: 104 } },
  });
  y = lastY(doc, y) + 20;

  // ── Recuadros (sólo la copia interna: al proveedor no le dicen nada que no esté en la tabla) ─
  const sumLineas = data.lineas.reduce((s, l) => s + (Number(l.importe) || 0), 0);
  if (op.interno) {
    const gap = 10;
    const partes = [0.16, 0.2, 0.2, 0.44];
    const ws = partes.map((f) => f * (W - 2 * M - gap * (partes.length - 1)));
    const h = 42;
    let cx = M;
    const surtido = data.pct_surtido === null ? 'Sin monto' : data.recepciones.length ? `${data.pct_surtido}%` : 'Sin recepciones';
    const cards: [string, string][] = [['Renglones', String(data.lineas.length)], ['Total del documento', money(o.monto)], ['Surtido (en dinero)', surtido]];
    cards.forEach(([t, v], i) => { dibujarRecuadro(doc, cx, y, ws[i], h, t, v); cx += ws[i] + gap; });
    const s = data.seguimiento;
    dibujarRecuadro(doc, cx, y, ws[3], h, 'Seguimiento de Compras', etiqueta(s?.estatus ?? null));
    if (s) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...MUTED);
      const quien = [s.actualizado_por, dia(s.actualizado_en)].filter(Boolean).join(' · ');
      doc.text(doc.splitTextToSize(quien, ws[3] - 18)[0], cx + ws[3] - 9, y + 12, { align: 'right' });
    }
    y += h + 16;
  }

  // ── Renglones ────────────────────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
  doc.text('LO QUE SE PIDE', M, y);
  let sinCajas = 0;
  // `[PQ.32]` UNA columna de cantidad. Antes eran tres que decían lo mismo («30» · «cja» · «30 cj»):
  // la caja verificada por costo si la hay; si no, la cantidad en su unidad.
  const filas = data.lineas.map((l, i) => {
    const cj = textoCajasRenglon(l);
    if (cj === null) sinCajas++;
    return [String(i + 1), l.sku || '—', l.nombre || '—', cj ?? `${num(l.cantidad)} ${(l.unidad || '').toLowerCase()}`.trim(),
      money(l.costo_unitario), money(l.importe)];
  });
  const tot = totalesOc(sumLineas, o.monto, o.iva, o.ieps);
  autoTable(doc, {
    ...tablaBase, startY: y + 6,
    head: [['#', 'Código', 'Producto', 'Cantidad', 'Costo unit.', 'Importe']],
    body: filas,
    foot: tot.map((t) => [{ content: t.etiqueta, colSpan: 5 }, money(t.monto)]),
    footStyles: { fillColor: RULE, textColor: INK, fontStyle: 'normal', halign: 'right' },
    didParseCell: (hook: { section: string; row: { index: number }; cell: { styles: Record<string, unknown> } }) => {
      alinearTitulos([0, 3, 4, 5])(hook as never);
      // El Total, fuerte; el resto del pie, normal: un solo número manda.
      if (hook.section === 'foot' && tot[hook.row.index]?.fuerte) { hook.cell.styles['fontStyle'] = 'bold'; hook.cell.styles['fontSize'] = 11; }
    },
    showFoot: 'lastPage',
    columnStyles: {
      0: { halign: 'right', cellWidth: 24 }, 1: { cellWidth: 56 }, 3: { halign: 'right', fontStyle: 'bold' },
      4: { halign: 'right' }, 5: { halign: 'right' },
    },
  });
  y = lastY(doc, y) + 16;

  // ── Lo que ya llegó ──────────────────────────────────────────────────────────────────────
  // Al proveedor sólo si hay algo que decirle; en la copia interna, siempre.
  if (op.interno || data.recepciones.length) {
    if (y > H - 120) { doc.addPage(); y = M; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
    doc.text('LO QUE YA LLEGÓ', M, y);
    if (data.recepciones.length) {
      autoTable(doc, {
        ...tablaBase, startY: y + 6,
        head: [['Entrada', 'Fecha', 'Monto']],
        body: data.recepciones.map((r) => [r.folio, dia(r.fecha), money(r.monto)]),
        foot: [[{ content: `Recibido (${data.pct_surtido ?? '—'}% del total)`, colSpan: 2 }, money(data.recibido)]],
        footStyles: { fillColor: RULE, textColor: INK, fontStyle: 'bold', halign: 'right' },
        columnStyles: { 2: { halign: 'right' } },
        didParseCell: alinearTitulos([2]),
        tableWidth: 360,
      });
      y = lastY(doc, y) + 14;
    } else {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
      doc.text('Kepler no tiene ninguna recepción contra esta orden.', M, y + 14);
      y += 36;
    }
  }

  // ── Seguimiento (sólo la versión interna) ────────────────────────────────────────────────
  if (op.interno) {
    if (y > H - 120) { doc.addPage(); y = M; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
    doc.text('SEGUIMIENTO DE COMPRAS (INTERNO)', M, y);
    if (data.historia.length) {
      autoTable(doc, {
        ...tablaBase, startY: y + 6,
        head: [['Fecha', 'De', 'A', 'Nota', 'Por']],
        body: data.historia.map((hh) => [dia(hh.en), etiqueta(hh.estatus_anterior), etiqueta(hh.estatus), hh.nota || '—', hh.por || '—']),
        columnStyles: { 0: { cellWidth: 64 }, 1: { cellWidth: 118 }, 2: { cellWidth: 118 }, 4: { cellWidth: 90 } },
      });
      y = lastY(doc, y) + 14;
      // La API manda los últimos 50 cambios: si llegaron 50, puede haber más viejos. Se declara.
      if (data.historia.length >= 50) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
        doc.text('Se muestran los 50 cambios más recientes; puede haber anteriores.', M, y);
        y += 12;
      }
    } else {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
      doc.text('Nadie ha revisado esta orden todavía (Sin revisar).', M, y + 14);
      y += 36;
    }
  }

  // Las notas sobre el ORIGEN del dato y su CALIDAD (ligas equivocadas de Kepler, sumas que no
  // cuadran, factores sin verificar) son para Compras: en la copia para el proveedor no van.
  if (op.interno) {
    const notas = [
      'Copia generada desde Compras con los datos de Kepler. El documento oficial es el de Kepler.',
      'Surtido = recepciones ligadas a esta orden ÷ total de la orden, en dinero: la orden y la recepción pueden venir en unidades distintas.',
    ];
    const desc = data.recepciones_descartadas;
    if (desc && desc.n > 0) {
      notas.push(`${desc.n} recepción(es) de Kepler citan este folio pero son de otro proveedor o anteriores a la orden (${money(desc.monto)}): no se cuentan como surtido.`);
    }
    if (sinCajas) notas.push(`${sinCajas} renglón(es) con cajas "sin verificar": el costo de caja de Kepler no confirma el factor, así que se muestra la cantidad en su unidad.`);
    if (tot.some((t) => t.etiqueta.startsWith('Impuestos y ajustes'))) {
      notas.push(o.iva == null || o.ieps == null
        ? 'No se pudieron leer el IVA y el IEPS de Kepler: la diferencia entre el total y los renglones va en un solo renglón.'
        : `Renglones + IVA + IEPS (${money(sumLineas + Number(o.iva) + Number(o.ieps))}) no cuadran con el total de Kepler (${money(o.monto)}): la diferencia va en un solo renglón.`);
    }
    dibujarNotas(doc, y, notas);
  }

  dibujarPies(doc, `OC ${o.folio} · ${sucNombre}${op.interno ? ' · copia interna' : ''}`, null, op.interno ? 'Compras > Órdenes de compra' : 'Compras');
  doc.save(nombreArchivoOc(o.sucursal, o.folio, o.proveedor, op.emitido, op.interno));
}
