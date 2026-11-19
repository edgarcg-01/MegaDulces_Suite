import type { EtiquetaCaja } from '@megadulces/contracts';
import { enFilas, modulosCode128 } from './etiquetera';

/**
 * `[RE.ETQ.1.6]` Vía B (D3): la misma etiqueta de caja escrita en **TSPL**, el lenguaje de la TSC TE200. La
 * impresora dibuja la barra con su propio motor (nítida a 2 puntos por módulo) y el envío pesa una fracción del
 * de la vía A: lo que necesitan los días de 4,417 etiquetas de Suc 00.
 *
 * Una fila de 3 etiquetas = un `CLS … PRINT 1`. ⚠️ El plan proponía `SET COUNTER` para que la impresora numere;
 * se escribe cada fila explícita porque el consecutivo `n:total` es TEXTO compuesto y la última fila puede ir
 * incompleta, y con contadores ambas cosas dependen del firmware. Se decide al medir la impresora.
 *
 * ⛔ NO MEDIDO en la impresora real: el TRANSPORTE (red, WebUSB o un agente en la PC) y la geometría final se
 * deciden con `[RE.ETQ.0.3]` en Suc 08, y la prueba física es `[RE.ETQ.3.5]`. Hasta entonces la pantalla no ofrece
 * esta vía. El texto sale en CODEPAGE 1252: quien lo mande lo codifica en ese juego (Ñ y acentos).
 */

/** 203 dpi = 8 puntos por milímetro. */
export const PUNTOS_POR_MM = 8;
const mm = (x: number): number => Math.round(x * PUNTOS_POR_MM);

/** Geometría del rollo (la de GP.4, medida por Francisco el 2026-10-08). */
export const GEOMETRIA_TSC_3X = { anchoMm: 100, altoMm: 48, etiquetaMm: 32, separacionMm: 2, margenMm: 1.5 } as const;

/** Una cadena de TSPL: las comillas se escriben `\["]`; los saltos de renglón no caben en un TEXT. */
export function tsplTexto(s: string): string {
  return `"${s.replace(/[\r\n]+/g, ' ').replace(/"/g, '\\["]')}"`;
}

function etiquetaTspl(e: EtiquetaCaja, columna: number): string[] {
  const g = GEOMETRIA_TSC_3X;
  const x0 = mm(columna * (g.etiquetaMm + g.separacionMm) + g.margenMm);
  const ancho = mm(g.etiquetaMm - 2 * g.margenMm);
  const derecha = x0 + ancho;
  const centro = x0 + Math.round(ancho / 2);
  const modulos = modulosCode128(e.codigo) ?? 0;
  const xBarra = x0 + Math.max(0, Math.round((ancho - modulos * 2) / 2));
  const fuenteNombre = e.nombre.length <= 40 ? '2' : '1';
  const out = [
    `TEXT ${x0},${mm(1.5)},"3",0,1,1,${tsplTexto(e.clave)}`,
    `TEXT ${derecha},${mm(1.5)},"4",0,1,1,3,${tsplTexto(e.consecutivo)}`,
    `BARCODE ${xBarra},${mm(7)},"128",${mm(8.5)},0,0,2,2,${tsplTexto(e.codigo)}`,
    `TEXT ${centro},${mm(16)},"1",0,1,1,2,${tsplTexto(e.codigo)}`,
  ];
  if (e.incompleta) {
    // La caja incompleta se dice en negativo, como en la vía A.
    out.push(`TEXT ${x0},${mm(19)},"3",0,1,1,${tsplTexto(e.contenido)}`, `REVERSE ${x0},${mm(18.6)},${mm(15)},${mm(3.8)}`);
  } else {
    out.push(`TEXT ${x0},${mm(19)},"3",0,1,1,${tsplTexto(e.contenido)}`);
  }
  out.push(
    `TEXT ${derecha},${mm(19)},"3",0,1,1,3,${tsplTexto(e.fecha)}`,
    `BLOCK ${x0},${mm(23.5)},${ancho},${mm(14)},"${fuenteNombre}",0,1,1,0,0,${tsplTexto(e.nombre)}`,
    `BLOCK ${x0},${mm(40.5)},${ancho},${mm(5)},"1",0,1,1,0,0,${tsplTexto(e.pie)}`,
  );
  return out;
}

/** El trabajo TSPL completo: encabezado del rollo y una fila de 3 por `PRINT`. Renglones en CRLF. */
export function tsplEtiquetasCaja(etiquetas: readonly EtiquetaCaja[]): string {
  const g = GEOMETRIA_TSC_3X;
  const lineas = [
    `SIZE ${g.anchoMm} mm,${g.altoMm} mm`,
    `GAP 2 mm,0 mm`,
    'DIRECTION 1',
    'REFERENCE 0,0',
    'CODEPAGE 1252',
  ];
  for (const fila of enFilas(etiquetas)) {
    lineas.push('CLS');
    fila.forEach((e, i) => lineas.push(...etiquetaTspl(e, i)));
    lineas.push('PRINT 1,1');
  }
  return lineas.join('\r\n') + '\r\n';
}
