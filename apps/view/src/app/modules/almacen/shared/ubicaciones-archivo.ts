import type { BulkLocationInputRow } from '@megadulces/contracts';

/**
 * `[UB.2]` Leer un archivo de ubicaciones (Excel o CSV) a renglones para la captura masiva.
 *
 * Es una función pura sobre una tabla de celdas: el Excel lo abre `exceljs` y el CSV un lector
 * mínimo, pero las dos llegan aquí como `unknown[][]`. Así la parte que decide qué columna es cuál
 * se prueba sin abrir archivos.
 *
 * Los encabezados se reconocen sin acentos ni mayúsculas, con sinónimos, porque la gente los escribe
 * como quiere: «Código», «codigo», «Ubicación»… Lo que NO se adivina es el contenido: el servidor
 * valida cada código y señala la fila exacta.
 */

const SIN_ACENTOS = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

const ALIAS: Record<'code' | 'tipo' | 'label', string[]> = {
  code: ['codigo', 'code', 'ubicacion', 'clave'],
  tipo: ['tipo', 'type', 'uso'],
  label: ['nombre', 'etiqueta', 'label', 'descripcion'],
};

export type LecturaArchivo =
  | { ok: true; filas: BulkLocationInputRow[]; vacias: number }
  | { ok: false; motivo: string };

function celda(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    // exceljs: celdas con texto enriquecido o fórmulas llegan como objeto.
    const o = v as { text?: unknown; result?: unknown; error?: unknown; richText?: Array<{ text: string }> };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join('');
    if (o.error != null) return String(o.error); // #N/A, #REF!… se ven como tales, no como [object Object]
    if (o.text != null) return String(o.text);
    if (o.result != null) return String(o.result);
  }
  return String(v);
}

/** La fila 1 son encabezados. `fila` de cada renglón = su número en el archivo (para señalarlo). */
export function leerTablaUbicaciones(tabla: unknown[][]): LecturaArchivo {
  if (!tabla.length) return { ok: false, motivo: 'El archivo está vacío.' };
  const enc = (tabla[0] ?? []).map((c) => SIN_ACENTOS(celda(c)));
  const col = (k: keyof typeof ALIAS) => enc.findIndex((h) => ALIAS[k].includes(h));
  const iCode = col('code');
  if (iCode < 0) {
    return { ok: false, motivo: 'No encontré la columna del código. La primera fila debe traer los encabezados: Código, Tipo, Nombre (descarga la plantilla).' };
  }
  const iTipo = col('tipo');
  const iLabel = col('label');
  const filas: BulkLocationInputRow[] = [];
  let vacias = 0;
  for (let i = 1; i < tabla.length; i++) {
    const r = tabla[i] ?? [];
    const code = celda(r[iCode]).trim();
    const tipo = iTipo >= 0 ? celda(r[iTipo]).trim() : '';
    const label = iLabel >= 0 ? celda(r[iLabel]).trim() : '';
    if (!code && !tipo && !label) {
      vacias++;
      continue;
    }
    filas.push({ fila: i + 1, code, tipo: tipo || null, label: label || null });
  }
  if (!filas.length) return { ok: false, motivo: 'El archivo no trae renglones debajo de los encabezados.' };
  return { ok: true, filas, vacias };
}

/**
 * Texto de un CSV respetando el acento: Excel en español lo guarda en Windows-1252 y leído como
 * UTF-8 «Código» llega como «C\uFFFDdigo». Se intenta UTF-8 estricto y, si falla, Windows-1252.
 */
export function decodificarCsv(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** CSV mínimo: separador `,` o `;` (el que más aparezca en el encabezado) y comillas dobles. */
export function csvATabla(texto: string): string[][] {
  const lineas = texto.replace(/^﻿/, '').split(/\r?\n/);
  const sep = (lineas[0]?.split(';').length ?? 0) > (lineas[0]?.split(',').length ?? 0) ? ';' : ',';
  // Las líneas en blanco SE QUEDAN: si se quitaran, la fila que se reporta se recorre y deja de ser
  // la del archivo. El lector de tabla ya las salta y las cuenta como vacías.
  if (lineas.length > 1 && lineas[lineas.length - 1] === '') lineas.pop(); // el salto final
  return lineas
    .map((l) => {
      const out: string[] = [];
      let cur = '';
      let q = false;
      for (let i = 0; i < l.length; i++) {
        const ch = l[i];
        if (q) {
          if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; }
          else if (ch === '"') q = false;
          else cur += ch;
        } else if (ch === '"') q = true;
        else if (ch === sep) { out.push(cur); cur = ''; }
        else cur += ch;
      }
      out.push(cur);
      return out;
    });
}
