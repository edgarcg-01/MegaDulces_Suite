import { agruparPorCodigo, type PriceChangeRow } from '@megadulces/contracts';

/**
 * `[ETQ-AVISOS.3]` La lista de «Cambios de precio» como CSV, para quien la quiere fuera de la Suite.
 *
 * ── Qué lleva ─────────────────────────────────────────────────────────────────────────────
 * Una fila por PRODUCTO Y PRESENTACIÓN: en una hoja de cálculo es lo que se puede filtrar y
 * ordenar. Es la MISMA lista que muestra la pantalla —`agruparPorCodigo`, la regla del contrato—:
 * lo que se movió varias veces el mismo día va resumido en «antes → ahora», y lo que terminó donde
 * empezó no sale. Si el archivo discrepara de la pantalla, nadie sabría cuál creerle.
 *
 * ── Dos cuidados ──────────────────────────────────────────────────────────────────────────
 *  · **BOM UTF-8**: sin él Excel abre «GALLETA SALADA» bien pero «CAÑA» y «MÍNIMO» como basura.
 *  · **Nombres que empiezan con `= + - @`**: Excel los ejecuta como fórmula. Los nombres vienen
 *    del ERP y no los controlamos, así que se neutralizan con un apóstrofo.
 */

/** Marca de orden de bytes UTF-8: sin ella Excel abre los acentos como basura. */
const BOM = String.fromCharCode(0xfeff);

const ENCABEZADO = ['Código', 'Producto', 'Presentación', 'Precio anterior', 'Precio nuevo', 'Diferencia', 'Cambio %', 'Estado'];

const ESTADO: Record<string, string> = { sube: 'Sube', baja: 'Baja', sin_precio: 'Sin precio en Kepler', sin_cambio: 'Sin cambio' };

const escapa = (t: string): string => (/[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);

/**
 * Celda de TEXTO: neutraliza lo que Excel interpretaría como fórmula y escapa lo que rompe el CSV.
 * ⚠️ No se usa en las columnas numéricas: un `-25.00` con apóstrofo deja de ser número.
 */
export function celdaCsv(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  let t = String(valor);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return escapa(t);
}

/** Celda NUMÉRICA: ya viene de `toFixed`, así que sólo se escapa; el signo menos es parte del número. */
export function celdaNumero(valor: string): string {
  return escapa(valor);
}

const dinero = (n: number | null): string => (n === null || n === undefined ? '' : n.toFixed(2));

const porcentaje = (r: PriceChangeRow): string => {
  const antes = r.precio_anterior;
  if (antes === null || antes <= 0 || r.delta === null) return '';
  return ((r.delta / antes) * 100).toFixed(1);
};

export function cambiosACsv(items: readonly PriceChangeRow[]): string {
  // Cada celda lleva su tipo: las de texto (código, producto, presentación, estado) se neutralizan;
  // las numéricas, no.
  const filas: string[] = [ENCABEZADO.map(celdaCsv).join(',')];
  for (const p of agruparPorCodigo(items)) {
    if (p.direccion === 'sin_cambio') continue; // terminó donde empezó: no hay nada que reimprimir
    for (const r of p.filas) {
      filas.push([
        celdaCsv(p.sku),
        celdaCsv(p.name ?? ''),
        celdaCsv(r.unidad ?? ''),
        celdaNumero(dinero(r.precio_anterior)),
        celdaNumero(dinero(r.precio_nuevo)),
        celdaNumero(dinero(r.delta)),
        celdaNumero(porcentaje(r)),
        celdaCsv(r.es_baja ? ESTADO['sin_precio'] : (r.delta ?? 0) > 0 ? ESTADO['sube'] : ESTADO['baja']),
      ].join(','));
    }
  }
  // `\r\n` es el fin de línea que Excel espera; el BOM va al principio y una sola vez.
  return BOM + filas.join('\r\n') + '\r\n';
}

/** `cambios-de-precio_01_2026-10-08.csv` — la plaza y el día en el nombre, o los archivos se confunden entre sí. */
export function nombreArchivoCambios(plaza: string | null, fecha: string): string {
  const p = /^[0-9]{2}$/.test(String(plaza ?? '')) ? String(plaza) : 'todas';
  const f = /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : 'sin-fecha';
  return `cambios-de-precio_${p}_${f}.csv`;
}
