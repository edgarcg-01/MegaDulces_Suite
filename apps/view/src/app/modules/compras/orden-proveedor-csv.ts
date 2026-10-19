import { fechaHoraArchivo, textoParaArchivo } from './compras-pdf-comun';
import type { OcProvData } from './orden-proveedor-pdf';

/**
 * `[OC.4]` — **El mismo pedido del proveedor, en CSV.**
 *
 * Hermano de `orden-proveedor-pdf.ts`: **mismo dato, misma consolidación**, otro destino. El PDF
 * es para mandar; esto es para trabajarlo (pegarlo en el formato del proveedor, cruzarlo, subirlo
 * a su portal).
 *
 * ── Dos diferencias deliberadas contra el PDF, y el porqué de cada una ───────────────────────
 *
 *  1. **La columna «Falta» va SIEMPRE.** En el papel se oculta cuando no hay nada a medias,
 *     porque repetiría la columna de al lado y el papel se lee. Un archivo de datos no se lee:
 *     se procesa, y una columna que a veces está y a veces no rompe a quien lo abre con una
 *     fórmula.
 *  2. ⭐ **Lleva los FOLIOS por renglón.** Es la liga que la consolidación borra —a qué orden
 *     pertenecía cada cantidad— y en el papel no cabe (por eso allá van en el encabezado). Acá
 *     hay una columna, así que se devuelve donde sí se puede usar.
 *
 * ── La convención de CSV es la del repo, no una nueva ────────────────────────────────────────
 *
 * Separador coma, comillas dobladas cuando el valor trae `" , ; \n`, y **BOM al principio**: sin
 * él Excel abre el archivo en la codificación del sistema y «MAZAPÁN» sale «MAZAPÃN». Igual que
 * `/finanzas/cartera` y los otros ocho exportadores de la app.
 */

const n = (v: unknown): number => Number(v) || 0;

/** Escapa un valor para CSV. Mismo criterio que el resto de la app. */
export function esc(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_CABECERA = [
  'SKU', 'Producto', 'Destinos', 'Cantidad', 'Falta', 'Costo_unitario', 'Costo_varia', 'Importe', 'Ordenes', 'Folios',
] as const;

/**
 * El texto completo del CSV, **con BOM**. Función pura: es lo que se puede probar sin navegador.
 *
 * ⚠️ Los números salen con punto decimal y **sin separador de miles**: es un archivo para
 * procesar, no para leer. Formatearlos a es-MX metería comas dentro de las celdas numéricas.
 */
export function csvPedidoProveedor(data: OcProvData): string {
  const filas = (data?.filas ?? []).map((f) => [
    f.sku,
    f.nombre,
    (f.destinos ?? []).join(' '),
    n(f.cantidad),
    n(f.pendiente),
    n(f.unit_cost).toFixed(4),
    f.costo_varia ? 'SI' : '',
    n(f.importe).toFixed(2),
    (f.folios ?? []).length || '',
    (f.folios ?? []).join(' '),
  ].map(esc).join(','));
  return '﻿' + [CSV_CABECERA.join(','), ...filas].join('\n');
}

/** Nombre del archivo: proveedor + fecha, sin acentos ni caracteres que rompan una descarga. */
export function nombreArchivoCsv(proveedor: string, emitido: Date): string {
  return `pedido-${textoParaArchivo(proveedor, 30)}-${fechaHoraArchivo(emitido)}.csv`;
}

/** Arma el CSV y lo baja. Lo único que toca el navegador, y por eso lo único sin prueba. */
export function descargarCsvPedidoProveedor(data: OcProvData): void {
  const blob = new Blob([csvPedidoProveedor(data)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombreArchivoCsv(data.proveedor.name, data.emitido);
  a.click();
  URL.revokeObjectURL(url);
}
