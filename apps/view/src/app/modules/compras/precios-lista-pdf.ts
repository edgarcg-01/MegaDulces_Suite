/**
 * `[CAT-PRECIO.2]` El PDF de la lista de precios, para entregar al CLIENTE.
 *
 * ⛔ Sin margen ni costo: es la decisión de Compras (2026-10-16). La pantalla muestra el margen para
 * que el vendedor lo entienda; el papel que se lleva el cliente no. `filasPdf` es pura y probada para
 * que esa regla no dependa de acordarse de quitar una columna.
 *
 * Ordenado como pide Compras: por artículo, o agrupado por línea, tipo o grupo (un renglón de título
 * por cada grupo). Sólo Latin-1: las fuentes estándar de jsPDF no traen flechas ni símbolos.
 */
import type { FilaListaPrecios, OrdenListaPrecios, PrecioUnidad } from '@megadulces/contracts';
import {
  M, RULE, ZEBRA, HEAD, dibujarEncabezado, dibujarPies, fecha, fechaHoraArchivo, loadLibs, loadLogo, money,
  tablaBase, textoParaArchivo,
} from './compras-pdf-comun';

export const NOMBRE_ORDEN: Record<OrdenListaPrecios, string> = {
  articulo: 'artículo', linea: 'línea', tipo: 'tipo', grupo: 'grupo',
};

/**
 * Una celda de unidad: el precio, debajo su cambio automático y debajo los códigos de barras de ESA
 * unidad (pedido de Compras, 2026-10-16: en una columna aparte no se sabía qué código era de qué unidad).
 * Vacía si la ficha no tiene esa unidad.
 */
export function celdaUnidad(u: PrecioUnidad | undefined): string {
  if (!u) return '';
  const lineas = [`${u.unidad}  ${u.precio === null ? 'sin precio' : money(u.precio)}`];
  // La conversión sólo cuando dice algo: «1 PZA» en la base es ruido en el papel.
  if (u.conversion && u.n > 1) lineas.push(u.conversion);
  for (const t of u.volumen) lineas.push(`Desde ${t.desde}: ${money(t.precio)}`);
  lineas.push(...u.codigos);
  return lineas.join('\n');
}

function impuestos(f: FilaListaPrecios): string {
  const t = (nombre: string, v: number) => (v === 0 ? '' : `${nombre} ${Math.abs(v)}%`);
  const partes = [t('IVA', f.iva), t('IEPS', f.ieps)].filter(Boolean);
  return partes.length ? partes.join(' + ') + (f.iva < 0 || f.ieps < 0 ? ' incl.' : '') : 'Exento';
}

export type RenglonPdf = { grupo: string } | { celdas: string[] };

/**
 * Los renglones del PDF. Cada producto: código, producto, las tres unidades (precio, cambio automático
 * y sus códigos de barras) y el impuesto. NUNCA margen ni costo.
 */
export function filasPdf(filas: FilaListaPrecios[], orden: OrdenListaPrecios): RenglonPdf[] {
  const out: RenglonPdf[] = [];
  let actual: string | null = null;
  for (const f of filas) {
    if (orden !== 'articulo') {
      const g = f[orden].nombre ?? 'Sin asignar';
      if (g !== actual) {
        out.push({ grupo: g });
        actual = g;
      }
    }
    const u = (n: 1 | 2 | 3) => f.unidades.find((x) => x.n === n);
    out.push({
      celdas: [
        f.sku,
        f.nombre,
        celdaUnidad(u(1)),
        celdaUnidad(u(2)),
        celdaUnidad(u(3)),
        impuestos(f),
      ],
    });
  }
  return out;
}

export interface DatosPdfPrecios {
  sucursal: { codigo: string; nombre: string };
  filas: FilaListaPrecios[];
  orden: OrdenListaPrecios;
  /** Lo que se filtró, en palabras ("Línea: DIST DE LA ROSA"), para que el papel diga qué lista es. */
  filtros: string[];
  fichaAl: Date | null;
}

export async function generarPdfPrecios(d: DatosPdfPrecios): Promise<void> {
  const [{ jsPDF, autoTable }, logo] = await Promise.all([loadLibs(), loadLogo()]);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  const emitido = new Date();
  const y = dibujarEncabezado(doc, logo, {
    titulo: 'Lista de precios',
    cajaTitulo: `${d.sucursal.codigo} · ${d.sucursal.nombre}`.toUpperCase(),
    cajaLineas: [
      `Emitida: ${fecha(emitido)}`,
      `Ordenada por ${NOMBRE_ORDEN[d.orden]} · ${d.filas.length} productos`,
      d.filtros.length ? d.filtros.join(' · ') : 'Todos los productos de la sucursal',
    ],
  });

  const renglones = filasPdf(d.filas, d.orden);
  const body = renglones.map((r) =>
    'grupo' in r
      ? [{ content: r.grupo.toUpperCase(), colSpan: 6, styles: { fillColor: ZEBRA, fontStyle: 'bold', textColor: HEAD } }]
      : r.celdas,
  );
  autoTable(doc, {
    ...tablaBase,
    startY: y,
    head: [['Código', 'Producto', 'Unidad base', 'Unidad 2', 'Unidad 3', 'Impuesto']],
    body,
    styles: { ...tablaBase.styles, fontSize: 7.5, valign: 'top', lineColor: RULE },
    columnStyles: {
      0: { cellWidth: 46 },
      1: { cellWidth: 200 },
      2: { cellWidth: 118 },
      3: { cellWidth: 118 },
      4: { cellWidth: 118 },
      5: { cellWidth: 'auto' },
    },
    margin: { left: M, right: M, bottom: 40 },
  });

  dibujarPies(doc, 'Precios con impuestos incluidos salvo que se indique', d.fichaAl, 'Compras > Catálogo > Precios');
  const archivo = `LISTA-PRECIOS-${textoParaArchivo(`${d.sucursal.codigo}-${d.sucursal.nombre}`, 30)}-${fechaHoraArchivo(emitido)}.pdf`;
  doc.save(archivo);
}
