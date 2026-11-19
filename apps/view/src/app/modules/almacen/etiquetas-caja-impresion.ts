import { diaMxDeInstante, type EtiquetaCaja } from '@megadulces/contracts';
import { CSS_ETIQUETA_CAJA, PAGINA_TSC_3X, etiquetasCajaHtml } from '@megadulces/ui-web';
import { printIsolated } from '../../shared/util/print-isolated';

/**
 * `[RE.ETQ.3.x]` Vía A de la etiqueta de caja: el navegador manda cada fila de 3 como una hoja de 100 × 48 mm al
 * controlador de Windows de la TSC TE200 (el mismo mecanismo de GP.4). Las etiquetas llegan YA calculadas por el
 * servidor (fecha D6 y datos congelados): aquí sólo se dibujan.
 */
export function imprimirEtiquetasCaja(etiquetas: readonly EtiquetaCaja[], onDone?: () => void): void {
  if (!etiquetas.length) {
    onDone?.();
    return;
  }
  printIsolated({
    html: etiquetasCajaHtml(etiquetas),
    page: PAGINA_TSC_3X,
    css: CSS_ETIQUETA_CAJA,
    bodyClass: 'etiquetas-caja-printing',
    fallbackClass: 'etiquetas-caja-fallback',
    onDone,
  });
}

/** El documento de la vista previa (un `iframe` aislado, para que su CSS no toque la app). */
export function documentoVistaPrevia(etiquetas: readonly EtiquetaCaja[]): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>${CSS_ETIQUETA_CAJA}body{background:white}</style></head><body>${etiquetasCajaHtml(etiquetas)}</body></html>`;
}

/**
 * Los consecutivos que escribió la persona para reimprimir. Liberal con la FORMA (Postel): `7`, `3-5`, `1, 4 - 6`,
 * `7 9`. Estricto con el SIGNIFICADO: un número fuera de 1..total o un rango al revés es error, no se adivina.
 * Devuelve la lista ordenada o el problema en texto.
 */
export function leerConsecutivos(texto: string, total: number): number[] | string {
  const limpio = (texto ?? '').replace(/[–—]/g, '-').replace(/\s*-\s*/g, '-').trim();
  if (!limpio) return 'Escribe qué etiquetas: por ejemplo 7, o 3-5.';
  const out = new Set<number>();
  for (const parte of limpio.split(/[\s,;]+/).filter(Boolean)) {
    const m = /^(\d+)-(\d+)$/.exec(parte) ?? /^(\d+)$/.exec(parte);
    if (!m) return `No entendí «${parte}». Usa números y guiones: 7, o 3-5.`;
    const a = Number(m[1]);
    const b = m[2] != null ? Number(m[2]) : a;
    if (b < a) return `El rango ${a}-${b} va al revés.`;
    if (a < 1 || b > total) return `Las etiquetas de este renglón van de 1 a ${total}.`;
    for (let n = a; n <= b; n++) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

/** Hoy y hace `dias - 1` días, en la Ciudad de México (`AAAA-MM-DD`). */
export function rangoMx(dias: number, ahora = new Date()): { date_from: string; date_to: string } {
  const hasta = diaMxDeInstante(ahora) as string;
  const [y, m, d] = hasta.split('-').map(Number);
  const desde = new Date(Date.UTC(y, m - 1, d - (dias - 1))).toISOString().slice(0, 10);
  return { date_from: desde, date_to: hasta };
}
