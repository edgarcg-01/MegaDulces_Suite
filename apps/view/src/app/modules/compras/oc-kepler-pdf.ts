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
import { ESTATUS_KEPLER, nombreArchivoOc, referenciaUtil, textoCajasRenglon } from './oc-kepler';

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
  const o = data.orden;
  const est = ESTATUS_KEPLER[o.estatus_kepler] ?? o.estatus_kepler;

  let y = dibujarEncabezado(doc, logo, {
    titulo: op.interno ? 'Orden de compra · copia interna' : 'Orden de compra · copia de consulta',
    cajaTitulo: `OC ${o.sucursal}-${o.folio}`,
    cajaLineas: [
      `Kepler: ${est} · ${o.dias} día${o.dias === 1 ? '' : 's'} abierta`,
      `Emitido: ${fecha(op.emitido)} · ${op.elaboro}`,
      'El documento oficial es el de Kepler.',
    ],
  });

  // ── Datos de la orden ────────────────────────────────────────────────────────────────────
  const ref = referenciaUtil(o.referencia);
  const body: unknown[][] = [
    ['Proveedor', { content: o.proveedor || 'Sin proveedor', styles: { fontStyle: 'bold' } }, 'RFC', o.proveedor_rfc || '—',
      'Sucursal', `${o.sucursal}${op.sucursalNombre ? ` · ${op.sucursalNombre}` : ''}`],
    ['Fecha OC', dia(o.fecha), 'Vence', dia(o.vence), 'Condición de pago', o.condicion_pago || '—'],
  ];
  // `concepto` (kdm1.c24) es texto libre de Kepler; en otros documentos ha traído motivos internos.
  // Sólo va en la copia interna. La referencia sí va en las dos (es el folio que cita el proveedor).
  const concepto = op.interno ? o.concepto : null;
  if (ref || concepto) body.push(['Referencia', ref || '—', 'Concepto', { content: concepto || '—', colSpan: 3 }]);
  autoTable(doc, {
    startY: y, margin: { left: M, right: M }, theme: 'plain', body,
    styles: { fontSize: 9, cellPadding: { top: 2, bottom: 2, left: 0, right: 8 }, textColor: INK },
    columnStyles: { 0: { textColor: MUTED, cellWidth: 64 }, 2: { textColor: MUTED, cellWidth: 44 }, 4: { textColor: MUTED, cellWidth: 104 } },
  });
  y = lastY(doc, y) + 10;

  // ── Recuadros ────────────────────────────────────────────────────────────────────────────
  const gap = 10;
  const partes = op.interno ? [0.16, 0.2, 0.2, 0.44] : [0.3, 0.35, 0.35];
  const ws = partes.map((f) => f * (W - 2 * M - gap * (partes.length - 1)));
  const h = 42;
  let cx = M;
  const surtido = data.pct_surtido === null ? 'Sin monto' : data.recepciones.length ? `${data.pct_surtido}%` : 'Sin recepciones';
  const sumLineas = data.lineas.reduce((s, l) => s + (Number(l.importe) || 0), 0);
  // Un solo total por versión: la del proveedor usa la suma de renglones (la misma que el pie de la
  // tabla), así nunca ve dos importes distintos sin explicación. La interna usa el importe del
  // documento de Kepler y, si no cuadra con los renglones, lo dice en las notas.
  const importe: [string, string] = op.interno
    ? ['Importe del documento', money(o.monto)]
    : ['Importe (suma de renglones)', money(sumLineas)];
  const cards: [string, string][] = [['Renglones', String(data.lineas.length)], importe, ['Surtido (en dinero)', surtido]];
  cards.forEach(([t, v], i) => { dibujarRecuadro(doc, cx, y, ws[i], h, t, v); cx += ws[i] + gap; });
  if (op.interno) {
    const s = data.seguimiento;
    dibujarRecuadro(doc, cx, y, ws[3], h, 'Seguimiento de Compras', etiqueta(s?.estatus ?? null));
    if (s) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...MUTED);
      const quien = [s.actualizado_por, dia(s.actualizado_en)].filter(Boolean).join(' · ');
      doc.text(doc.splitTextToSize(quien, ws[3] - 18)[0], cx + ws[3] - 9, y + 12, { align: 'right' });
    }
  }
  y += h + 16;

  // ── Renglones ────────────────────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
  doc.text('LO QUE SE PIDIÓ', M, y);
  let sinCajas = 0;
  const filas = data.lineas.map((l, i) => {
    const cj = textoCajasRenglon(l);
    if (cj === null) sinCajas++;
    return [String(i + 1), l.sku || '—', l.nombre || '—', num(l.cantidad), (l.unidad || '—').toLowerCase(),
      cj ?? 'sin verificar', money(l.costo_unitario), money(l.importe)];
  });
  autoTable(doc, {
    ...tablaBase, startY: y + 6,
    head: [['#', 'Código', 'Producto', 'Cantidad', 'Unidad', 'Cajas', 'Costo unit.', 'Importe']],
    body: filas,
    foot: [[{ content: 'Total', colSpan: 7 }, money(sumLineas)]],
    footStyles: { fillColor: RULE, textColor: INK, fontStyle: 'bold', halign: 'right' },
    showFoot: 'lastPage',
    columnStyles: {
      0: { halign: 'right', cellWidth: 24 }, 1: { cellWidth: 52 }, 3: { halign: 'right' }, 5: { halign: 'right', fontStyle: 'bold' },
      6: { halign: 'right' }, 7: { halign: 'right' },
    },
    didParseCell: alinearTitulos([0, 3, 5, 6, 7]),
  });
  y = lastY(doc, y) + 16;

  // ── Lo que ya llegó ──────────────────────────────────────────────────────────────────────
  if (y > doc.internal.pageSize.getHeight() - 120) { doc.addPage(); y = M; }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
  doc.text('LO QUE YA LLEGÓ', M, y);
  if (data.recepciones.length) {
    autoTable(doc, {
      ...tablaBase, startY: y + 6,
      head: [['Entrada', 'Fecha', 'Monto']],
      body: data.recepciones.map((r) => [r.folio, dia(r.fecha), money(r.monto)]),
      foot: [[{ content: `Recibido (${data.pct_surtido ?? '—'}% del importe)`, colSpan: 2 }, money(data.recibido)]],
      footStyles: { fillColor: RULE, textColor: INK, fontStyle: 'bold', halign: 'right' },
      columnStyles: { 2: { halign: 'right' } },
      didParseCell: alinearTitulos([2]),
      tableWidth: 360,
    });
    y = lastY(doc, y) + 14;
  } else {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
    doc.text('Kepler no tiene ninguna recepción contra esta orden.', M, y + 14);
    y += 28;
  }

  // ── Seguimiento (sólo la versión interna) ────────────────────────────────────────────────
  if (op.interno) {
    if (y > doc.internal.pageSize.getHeight() - 120) { doc.addPage(); y = M; }
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
      y += 28;
    }
  }

  const notas = [
    'Copia generada desde Compras > OC abiertas con los datos de Kepler. El documento oficial es el de Kepler.',
    'Surtido = recepciones ligadas a esta orden ÷ importe de la orden, en dinero: la orden y la recepción pueden venir en unidades distintas.',
  ];
  // Las notas sobre la CALIDAD DE NUESTROS DATOS (ligas equivocadas de Kepler, sumas que no cuadran,
  // factores sin verificar) son para Compras: en la copia para el proveedor no van.
  if (op.interno) {
    const desc = data.recepciones_descartadas;
    if (desc && desc.n > 0) {
      notas.push(`${desc.n} recepción(es) de Kepler citan este folio pero son de otro proveedor o anteriores a la orden (${money(desc.monto)}): no se cuentan como surtido.`);
    }
    if (sinCajas) notas.push(`${sinCajas} renglón(es) con cajas "sin verificar": el costo de caja de Kepler no confirma el factor, así que se muestra sólo la cantidad en su unidad.`);
    if (Math.abs(sumLineas - o.monto) > 1) notas.push(`La suma de los renglones (${money(sumLineas)}) no coincide con el importe del documento (${money(o.monto)}).`);
  }
  dibujarNotas(doc, y, notas);

  dibujarPies(doc, `OC ${o.sucursal}-${o.folio}${op.interno ? ' · copia interna' : ''}`, null, 'Compras > OC abiertas');
  doc.save(nombreArchivoOc(o.sucursal, o.folio, o.proveedor, op.emitido, op.interno));
}
