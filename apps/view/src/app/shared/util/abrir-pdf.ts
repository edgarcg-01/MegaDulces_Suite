/**
 * **Entregar un PDF que llega por XHR, sin que el navegador bloquee la pestaña.**
 *
 * El endpoint del PDF pide JWT, así que no se puede apuntar una pestaña a su URL: hay que
 * pedirlo por XHR y entregar el blob. De ahí sale la trampa que esto resuelve.
 *
 * ⛔ `window.open()` llamado DESPUÉS de que llegó la respuesta HTTP **se bloquea**. El permiso
 * para abrir una pestaña vive en el gesto del usuario, y para cuando contesta el backend ese
 * gesto ya terminó. Chrome de escritorio a veces lo deja pasar y por eso el defecto sobrevivió;
 * el Safari del iPhone no lo deja nunca. *Medido el 2026-10-28: `/comercial/documentos` abierta
 * desde un teléfono contestaba «El navegador bloqueó la ventana» en cada impresión.*
 *
 * El orden correcto son dos tiempos:
 *
 *  1. `abrirPestanaParaPdf()` **dentro del clic** — la pestaña nace vacía, con el gesto todavía
 *     vivo, y muestra un aviso para que no se vea como una pestaña en blanco rota.
 *  2. `entregarPdf()` cuando llega el blob — recién ahí se le pone la dirección.
 *
 * Es el mismo camino que ya usaba `almacen-preventa-guias`, la única de las cinco pantallas que
 * imprimen un PDF que no tenía el defecto.
 *
 * ⭐ Y si aun así no hubo pestaña, el PDF **se descarga**: un `<a download>` no necesita permiso
 * de ventana emergente. Lo que no se hace nunca es dejar a la persona con un aviso y sin
 * documento — menos cuando ese aviso manda a un botón que la pantalla ya no tiene.
 *
 * ⚠️ NO MEDIDO: qué hace el visor de PDF del iPhone con un `blob:` en una pestaña nueva, y si
 * `print()` le llega. Desde acá no hay instrumento para ese navegador. Lo que sí está medido es
 * la causa del bloqueo, que es la regla de la ventana emergente y no depende del visor.
 *
 * Quedan con su propia copia de este mecanismo —**deuda con nombre**, ADR-056—
 * `almacen-preventa-guias`, `finanzas-calendario-pagos` y `tienda-arqueo-historial`.
 */

/** Dónde terminó el documento. El llamador lo necesita para decir la verdad en el aviso. */
export type EntregaPdf = 'pestana' | 'descarga';

/**
 * Abre la pestaña **ya**, dentro del manejador del clic. Devuelve `null` si el navegador la negó
 * igual; eso no es un error: `entregarPdf` descarga el archivo en ese caso.
 */
export function abrirPestanaParaPdf(aviso = 'Preparando el documento…'): Window | null {
  const win = window.open('', '_blank');
  if (!win) return null;
  // Sin esto la pestaña se queda en `about:blank` todo lo que tarde el backend y se lee como rota.
  try {
    win.document.write(
      '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + aviso + '</title><style>' +
      'html{color-scheme:light dark}' +
      'body{margin:0;display:grid;place-items:center;height:100vh;' +
      'font:15px/1.5 system-ui,sans-serif;color:#57534e;background:#fafaf9}' +
      '@media (prefers-color-scheme:dark){body{color:#a8a29e;background:#111}}' +
      '</style></head><body>' + aviso + '</body></html>',
    );
    win.document.close();
  } catch { /* si no deja escribirla, la pestaña sirve igual */ }
  return win;
}

/**
 * Pone el PDF en la pestaña que abrió el clic. Si no hay pestaña, lo descarga.
 *
 * `imprimir` manda el diálogo de impresión: el visor no dispara `load` de forma confiable, así
 * que se intenta al cargar y también tras un retraso corto, con un cerrojo para no abrir dos
 * diálogos.
 */
export function entregarPdf(
  win: Window | null,
  blob: Blob,
  nombreArchivo: string,
  opts: { imprimir?: boolean } = {},
): EntregaPdf {
  const url = URL.createObjectURL(blob);
  // el objeto vive hasta que el visor terminó de usarlo
  setTimeout(() => URL.revokeObjectURL(url), 60_000);

  if (win && !win.closed) {
    win.location.href = url;
    if (opts.imprimir) {
      let lanzado = false;
      const lanzar = () => {
        if (lanzado) return;
        lanzado = true;
        try { win.focus(); win.print(); } catch { /* el visor tiene su propio botón */ }
      };
      try { win.addEventListener('load', lanzar); } catch { /* cross-origin: queda el timer */ }
      setTimeout(lanzar, 1200);
    }
    return 'pestana';
  }

  const a = document.createElement('a');
  a.href = url;
  a.download = nombreArchivo.toLowerCase().endsWith('.pdf') ? nombreArchivo : nombreArchivo + '.pdf';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return 'descarga';
}

/** Cierra la pestaña de espera cuando el PDF no se pudo generar. */
export function cerrarPestanaDePdf(win: Window | null): void {
  try { win?.close(); } catch { /* ya la cerró la persona */ }
}
