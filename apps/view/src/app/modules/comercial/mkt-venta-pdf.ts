/**
 * `[MKT.30]`/`[MKT.31]` El PDF de los dos rankings de la semana —promociones (toda la venta) y
 * vendedores (lo que se le cargó a cada uno)—, con las piezas comunes de los documentos de la suite.
 *
 * Las FILAS salen de funciones puras (probadas en `mkt-venta-pdf.spec.ts`); el dibujo es jsPDF.
 * Sólo Latin-1: Helvetica estándar no trae flechas ni símbolos.
 */
import type jsPDFType from 'jspdf';
import {
  INK, M, MUTED, dibujarEncabezado, dibujarNotas, dibujarPies, fecha, fechaHoraArchivo, lastY, loadLibs, loadLogo, tablaBase, alinearTitulos,
} from '../compras/compras-pdf-comun';
import { CANAL_VENTA, VendedorVenta, VentaSemana, dinero, pct, textoSemana, canalesSinContrastar } from './mkt-ranking.service';

const SALTO = String.fromCharCode(10);
const n0 = (v: number) => v.toLocaleString('es-MX', { maximumFractionDigits: 2 });

/** Renglones del ranking de promociones: lugar, promoción (con código), paquetes, objetivo, avance, dinero. */
export function filasPromos(d: VentaSemana): string[][] {
  return d.promos.map((p, i) => [
    String(i + 1),
    [p.nombre, `Código ${p.code}`].join(SALTO),
    n0(p.paquetes),
    p.objetivo === null ? '-' : n0(p.objetivo),
    p.avance === null ? '-' : pct(p.avance),
    dinero(p.dinero),
  ]);
}

/** Renglones del ranking de vendedores: lugar, vendedor (con su ruta o sucursal), canal, paquetes, promociones, total. */
export function filasVendedores(d: VentaSemana): string[][] {
  return d.vendedores.map((v, i) => [
    String(i + 1),
    [v.nombre, v.detalle].join(SALTO),
    CANAL_VENTA[v.canal],
    n0(v.paquetes),
    String(v.promos.length),
    dinero(v.total) + (v.promos_sin_dato ? `${SALTO}+ ${v.promos_sin_dato} sin dato` : ''),
  ]);
}

/** El detalle de un vendedor: promoción, paquetes, precio por paquete y total. */
export function filasDeVendedor(v: VendedorVenta): string[][] {
  return [
    ...v.promos.map((p) => [[p.nombre, `Código ${p.code}`].join(SALTO), n0(p.paquetes), dinero(p.precio), dinero(p.total)]),
    ['Total', n0(v.paquetes), '', dinero(v.total)],
  ];
}

/** Qué dice la portada sobre el dinero: sin contrastar se DECLARA (ADR-056). */
export function notaDinero(d: VentaSemana): string {
  const sin = canalesSinContrastar(d, d.filtro.canal);
  return sin.length
    ? `Dinero de ${sin.map((c) => CANAL_VENTA[c]).join(', ')}: todavía sin contrastar contra el total de los documentos de Kepler.`
    : 'Dinero contrastado contra el total de los documentos de Kepler.';
}

export interface DatosPdfVenta {
  datos: VentaSemana;
  vista: 'promociones' | 'vendedores';
  /** Los filtros de la pantalla en palabras («Canal: Ruta vecinal»). Vacío = la semana completa. */
  filtros: string[];
  elaboro: string;
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

/** El reporte de lo que se ve: la pestaña abierta, con sus filtros en la portada y en el nombre. */
export async function pdfVenta(p: DatosPdfVenta): Promise<{ blob: Blob; archivo: string }> {
  const [{ jsPDF, autoTable }, logo] = await Promise.all([loadLibs(), loadLogo()]);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const d = p.datos;
  const emitido = new Date();
  const promos = p.vista === 'promociones';
  let y = dibujarEncabezado(doc, logo, {
    titulo: promos ? 'Ranking de promociones' : 'Ranking de vendedores',
    cajaTitulo: `SEMANA ${d.semana.numero}`,
    cajaLineas: [textoSemana(d.semana).replace(/^Semana \d+ · /, ''), `Emitido: ${fecha(emitido)}`, `Elaboró: ${p.elaboro}`],
  });
  const tabla = (head: string[], body: string[][], derecha: number[], ancho: Record<number, number> = {}) => {
    autoTable(doc, {
      ...tablaBase, startY: y, head: [head], body,
      columnStyles: Object.fromEntries(head.map((_, i) => [i, { ...(derecha.includes(i) ? { halign: 'right' } : {}), ...(ancho[i] ? { cellWidth: ancho[i] } : {}) }])),
      didParseCell: alinearTitulos(derecha),
      margin: { left: M, right: M, bottom: 40 },
    });
    y = lastY(doc, y) + 16;
  };

  const sub = p.filtros.length ? p.filtros.join('  ·  ') : 'Todas las sucursales y canales';
  if (promos) {
    y = titulo(doc, y, `Toda la venta: ${n0(d.totales.paquetes)} paquetes · ${dinero(d.totales.dinero)}`, sub);
    tabla(['#', 'Promoción', 'Paquetes', 'Objetivo', 'Avance', 'Dinero'], filasPromos(d), [0, 2, 3, 4, 5], { 0: 26 });
  } else {
    const asig = d.mostrador ? ` · Sucursales: ${d.mostrador.tickets_asignados} de ${d.mostrador.tickets_con_promo} tickets asignados por la cajera` : '';
    y = titulo(doc, y, 'Lo que se le cargó a cada vendedor', sub + asig);
    tabla(['#', 'Vendedor', 'Canal', 'Paquetes', 'Promociones', 'Total'], filasVendedores(d), [0, 3, 4, 5], { 0: 26 });
    for (const v of d.vendedores) {
      y = titulo(doc, y, `${v.nombre} · ${CANAL_VENTA[v.canal]}`, v.detalle);
      tabla(['Promoción', 'Paquetes', 'Precio', 'Total'], filasDeVendedor(v), [1, 2, 3]);
    }
  }

  dibujarNotas(doc, y + 4, [
    promos
      ? 'Cuenta TODA la venta de la semana, se le haya cargado a un vendedor o no. Paquetes = veces que se aplicó el código de la promoción en Kepler.'
      : 'Cuenta sólo lo que se le cargó a cada vendedor: en Sucursales, los tickets que la cajera le asignó en su arqueo; lo no asignado no se reparte.',
    'Dinero = lo que pagó el cliente, con impuestos, por los productos que activan la promoción en los tickets donde se aplicó (un piso). Sin producto identificado: «sin dato», no cero.',
    notaDinero(d),
    'Objetivo: el que fijó Mercadotecnia o, si no fijó, el promedio de las 4 semanas anteriores.',
  ]);
  dibujarPies(doc, `${promos ? 'Ranking de promociones' : 'Ranking de vendedores'}, semana ${d.semana.numero}`, new Date(d.consultado_at), 'Mercadotecnia > Ranking');
  const filtrado = p.filtros.length ? '-FILTRADO' : '';
  return { blob: doc.output('blob'), archivo: `${promos ? 'RANKING-PROMOCIONES' : 'RANKING-VENDEDORES'}-S${d.semana.numero}${filtrado}-${fechaHoraArchivo(emitido)}.pdf` };
}
