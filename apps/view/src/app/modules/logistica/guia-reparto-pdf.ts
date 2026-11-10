/**
 * `[EMB.56]` La guía de reparto en papel — la hoja de ruta del chofer (FASE_EMB §8).
 *
 * Reemplaza la «Guía de Reparto» que imprime Kepler. Lo que cambia contra ese papel:
 *  · cada parada lleva los TRES folios (factura, embarque y pedido); Kepler imprimía el embarque en
 *    1 de 12 renglones de la guía 0000969 y nunca la factura;
 *  · el domicilio es el de ENTREGA (`kdudent`), no el fiscal;
 *  · los bultos van en su columna, no escritos en la nota (`CJ 4 PQ 1 UB 3`);
 *  · **ningún importe**: el chofer no cobra, cobra el vendedor (PM, 2026-11-09).
 *
 * Todo sale tal cual del endpoint (`GuiaRepartoHoja`): acá sólo se dibuja. Las piezas (encabezado,
 * tabla, pie) son las de `compras-pdf-comun`, las mismas de los demás documentos.
 *
 * ⚠️ Sólo Latin-1 (Helvetica de jsPDF): lo que venga de Kepler fuera de ese rango se quita.
 */
import type jsPDFType from 'jspdf';
import type { GuiaRepartoDocumento, GuiaRepartoHoja, GuiaRepartoParada } from '@megadulces/contracts';
import { warehouseName } from '@megadulces/contracts';
import {
  loadLibs, loadLogo, dibujarEncabezado, dibujarPies, tablaBase, lastY, textoParaArchivo, M, INK, MUTED,
  type AutoTableFn,
} from '../compras/compras-pdf-comun';

/** jsPDF con Helvetica sólo dibuja Latin-1: lo demás sale como basura, así que se quita. */
const latin1 = (s: string | null | undefined): string => (s ?? '').replace(/[^\u0000-ÿ]/g, '').trim();

const dmy = (ymd: string | null): string => {
  if (!ymd) return 'sin fecha';
  const [y, m, d] = ymd.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/**
 * Lo que el chofer entrega en la parada, en BULTOS: cajas de los renglones y paquetes según almacén.
 * ⛔ Los kilos no se imprimen: lo que se vende por kilo sale en bulto (BTO), y el bulto ya cuenta como
 * caja; «4 cajas · 60 kg» haría buscar 60 kg de más (visto con la guía 0000969).
 */
export function textoEntrega(p: Pick<GuiaRepartoParada, 'cajas' | 'paquetes'> & Partial<Pick<GuiaRepartoParada, 'kg' | 'documentos'>>): string {
  const partes: string[] = [];
  if (p.cajas > 0) partes.push(plural(p.cajas, 'caja', 'cajas'));
  if (p.paquetes != null) partes.push(plural(p.paquetes, 'paquete', 'paquetes'));
  if (partes.length) return partes.join('\n');
  // Ni cajas ni paquetes contados. Si el embarque no tiene renglones, se dice; si los tiene, la
  // mercancía va SUELTA — ⛔ no «sin conteo»: eso le decía al chofer que no llevaba nada (guía 0001979,
  // 9 kg sueltos). Aquí sí van los kilos: sin cajas, no hay bulto que ya los cuente.
  if (p.documentos?.length && p.documentos.every((d) => d.cajas == null)) return 'Sin renglones en Kepler';
  return ['Mercancía suelta', p.kg != null ? `${Math.round(p.kg * 100) / 100} kg` : 'ver la factura'].join('\n');
}

const ESTADO_FACTURA: Record<Exclude<GuiaRepartoDocumento['factura_estado'], 'no_aplica'>, string> = {
  facturado: '',
  sin_factura: 'Sin factura todavía',
  no_se_factura: 'No se factura',
};

const folioCorto = (digital: string | null) => (digital ? digital.slice(digital.lastIndexOf('-') + 1) : null);

/**
 * Los folios de la parada: la factura primero y completa (es la que entrega); embarque y pedido en un
 * renglón, por su folio corto. Dos renglones por embarque: con tres, una guía de 9 paradas se pasaba a
 * una segunda hoja. Los TRASPASOS no llevan factura y van juntos: «Traspaso: sin factura» repetido por
 * embarque llenaba la columna sin decir nada nuevo (guía 0001470, 7 embarques = 14 renglones).
 */
export function textoFolios(docs: GuiaRepartoDocumento[]): string {
  const traspasos = docs.filter((d) => d.factura_estado === 'no_aplica');
  const lineas = docs.filter((d) => d.factura_estado !== 'no_aplica').flatMap((d) => [
    ...(d.facturas.length ? d.facturas.map((f) => `Factura ${f.folio_digital}`) : [ESTADO_FACTURA[d.factura_estado as keyof typeof ESTADO_FACTURA]]),
    `Emb. ${folioCorto(d.embarque_folio_digital)} · Ped. ${folioCorto(d.pedido_folio_digital) ?? 'sin pedido'}`,
  ]);
  if (traspasos.length) {
    lineas.push(
      'Traspaso: no lleva factura',
      `Emb. ${traspasos.map((d) => folioCorto(d.embarque_folio_digital)).join(', ')}`,
      `Ped. ${traspasos.map((d) => folioCorto(d.pedido_folio_digital) ?? 'sin pedido').join(', ')}`,
    );
  }
  return lineas.join('\n');
}

/** La nota sólo se imprime si dice algo que el domicilio no dice ya («ZINAPARO» en Zinapáro, no). */
function notaQueAporta(p: GuiaRepartoParada): string | null {
  const n = latin1(p.instruccion);
  if (!n) return null;
  const sinAcento = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/\s+/g, ' ').trim();
  const domicilio = sinAcento(`${p.domicilio_calle ?? ''} ${p.domicilio_ciudad ?? ''}`);
  return domicilio.includes(sinAcento(n)) ? null : n;
}

/**
 * A quién y dónde: nombre, domicilio de entrega, teléfono y la nota de almacén. La nota se rotula
 * «Nota de almacén» y no «instrucción»: a veces es para el chofer («las velas sólidas son azul») y a
 * veces es interna («pasillo 2 y 3»), y no hay forma honesta de distinguirlas. La falta de orden de
 * visita sólo se dice cuando hay más de una parada que ordenar.
 */
export function textoDestino(p: GuiaRepartoParada, variasParadas = true): string {
  return [
    latin1(p.cliente_nombre) || latin1(p.cliente_code) || 'Cliente sin nombre',
    latin1(p.domicilio_calle) || 'Sin domicilio en Kepler',
    latin1(p.domicilio_ciudad),
    p.domicilio_telefono ? `Tel. ${latin1(p.domicilio_telefono)}` : '',
    p.domicilio_supuesto ? '(el embarque no trae domicilio: se tomó el principal)' : '',
    notaQueAporta(p) ? `Nota de almacén: ${notaQueAporta(p)}` : '',
    variasParadas && p.orden_visita == null ? 'Sin orden de visita en Kepler' : '',
  ].filter(Boolean).join('\n');
}

/** Los renglones de la tabla, en el orden de visita que trae el endpoint. */
export function renglonesGuia(h: GuiaRepartoHoja): string[][] {
  const varias = h.paradas.length > 1;
  return h.paradas.map((p) => [String(p.numero), textoDestino(p, varias), textoEntrega(p), textoFolios(p.documentos), '']);
}

/** Lo que se dice al pie de la tabla: sólo lo que aplica a ESTA guía. */
export function notasGuia(h: GuiaRepartoHoja): string[] {
  const r = h.resumen;
  const notas = ['Sin importes: el chofer entrega; cobra el vendedor.'];
  if (r.paquetes != null) notas.push('Paquetes: los que escribió almacén en la nota del embarque (los arma el checador).');
  if (r.sin_factura) notas.push(`${plural(r.sin_factura, 'embarque todavía no tiene', 'embarques todavía no tienen')} factura: pídela antes de salir.`);
  if (r.sin_orden && r.paradas > 1) notas.push(`${plural(r.sin_orden, 'parada no tiene', 'paradas no tienen')} orden de visita en Kepler: van al final.`);
  if (r.sin_domicilio) notas.push(`${plural(r.sin_domicilio, 'parada no tiene', 'paradas no tienen')} domicilio en el catálogo de Kepler.`);
  return notas;
}

/** Nombre del archivo: GUIA-REPARTO-01-G0000969-2026-07-23.pdf */
export const archivoGuia = (h: GuiaRepartoHoja): string =>
  `GUIA-REPARTO-${textoParaArchivo(h.viaje.guia_digital, 24)}-${h.viaje.fecha ?? 'SIN-FECHA'}.pdf`;

/** Nombre del archivo de varias guías: GUIAS-REPARTO-2026-11-09-3.pdf */
export const archivoGuias = (hojas: GuiaRepartoHoja[]): string =>
  hojas.length === 1 ? archivoGuia(hojas[0]) : `GUIAS-REPARTO-${hojas[0]?.viaje.fecha ?? 'SIN-FECHA'}-${hojas.length}.pdf`;

/** Dibuja la guía y la devuelve como PDF. `consultado` = cuándo se leyó el viaje (va al pie). */
export function pdfGuiaReparto(h: GuiaRepartoHoja, consultado: Date): Promise<Blob> {
  return pdfGuiasReparto([h], consultado);
}

/**
 * Varias guías en UN archivo, **una guía por hoja**, cada una con su encabezado, sus paradas y su
 * firma. No se funden en una sola lista: la guía es lo único que Kepler garantiza (un camión, un día),
 * y contra el GPS el camión y la fecha de la guía no siempre son la salida real (FASE_EMB §8).
 */
export async function pdfGuiasReparto(hojas: GuiaRepartoHoja[], consultado: Date): Promise<Blob> {
  const [{ jsPDF, autoTable }, logo] = await Promise.all([loadLibs(), loadLogo()]);
  const doc: jsPDFType = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter', compress: true });
  hojas.forEach((h, i) => {
    if (i > 0) doc.addPage();
    dibujarGuia(doc, autoTable, logo, h);
  });
  // Corto a propósito: el pie compartido pone el número de página a la derecha y un texto largo se le
  // encimaba («p.mPágina», visto con tres guías).
  const pie = hojas.length === 1
    ? `Guía de reparto ${hojas[0].viaje.guia}`
    : `${hojas.length} guías · ${dmy(hojas[0]?.viaje.fecha ?? null)}`;
  dibujarPies(doc, pie, consultado, 'Logística > Guía de reparto');
  return doc.output('blob');
}

/** Una guía, desde la hoja actual del documento. */
function dibujarGuia(doc: jsPDFType, autoTable: AutoTableFn, logo: string | null, h: GuiaRepartoHoja): void {
  const W = doc.internal.pageSize.getWidth();
  const r = h.resumen;
  // El MISMO nombre que la pantalla (`warehouseName`, «Padre Hidalgo»), no el del catálogo de Kepler
  // («Sucursal Hidalgo»): el papel y la pantalla no pueden llamar distinto a la misma sucursal.
  const conocido = warehouseName(h.viaje.sucursal);
  const sucursal = (conocido && conocido !== h.viaje.sucursal ? conocido : '') || latin1(h.viaje.sucursal_nombre) || h.viaje.sucursal;
  const bultos = [r.cajas ? plural(r.cajas, 'caja', 'cajas') : '', r.paquetes != null ? plural(r.paquetes, 'paquete', 'paquetes') : '']
    .filter(Boolean).join(' · ');

  let y = dibujarEncabezado(doc, logo, {
    titulo: 'Guía de reparto · hoja de ruta del chofer',
    // El número como lo imprime Kepler; la sucursal va por nombre en la línea de abajo (nunca «01-G…»).
    cajaTitulo: `Guía ${h.viaje.guia}`,
    cajaTitulo2: dmy(h.viaje.fecha),
    cajaLineas: [
      [latin1(h.unidad.descripcion) || 'Unidad sin descripción', latin1(h.unidad.placas)].filter(Boolean).join(' · '),
      `${sucursal} · ${plural(r.paradas, 'parada', 'paradas')}${bultos ? ' · ' + bultos : ''}`,
    ],
  });

  // Lo que Kepler no trae (chofer, hora de salida) se escribe a mano: el renglón está para eso.
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...INK);
  doc.text(`Chofer: ${latin1(h.chofer_kepler) || '______________________________'}`, M, y);
  doc.text('Salida: ________  Regreso: ________', W - M, y, { align: 'right' });
  y += 14;

  autoTable(doc, {
    ...tablaBase,
    startY: y,
    head: [['#', 'Cliente y domicilio de entrega', 'Entrega', 'Folios', 'Recibió (nombre y firma)']],
    body: renglonesGuia(h),
    styles: { ...tablaBase.styles, fontSize: 9.5, cellPadding: 5, valign: 'top' },
    columnStyles: {
      0: { cellWidth: 24, halign: 'center', fontStyle: 'bold', fontSize: 12 },
      1: { cellWidth: 200 },
      2: { cellWidth: 78, fontStyle: 'bold', fontSize: 10.5 },
      3: { cellWidth: 148, fontSize: 8 },
      4: { cellWidth: 'auto', minCellHeight: 46 },
    },
    // Una parada no se parte entre dos hojas: el chofer la lee de un vistazo.
    rowPageBreak: 'avoid',
  });

  // Las notas con margen propio: `dibujarNotas` reserva 90 pt al pie para las firmas de Compras, que
  // esta hoja no lleva, y mandaba una nota sola a una segunda hoja (visto con la guía 0000969).
  y = lastY(doc, y) + 14;
  const H = doc.internal.pageSize.getHeight();
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
  for (const n of notasGuia(h)) {
    const lineas = doc.splitTextToSize(n, W - 2 * M);
    if (y + lineas.length * 10 > H - 30) { doc.addPage(); y = M; }
    doc.text(lineas, M, y);
    y += lineas.length * 10;
  }
}
