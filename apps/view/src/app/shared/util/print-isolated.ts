/**
 * **Imprimir un pedazo de HTML sin que salga la app en la hoja.**
 *
 * El navegador imprime el documento entero. Para sacar SÓLO una etiqueta o un
 * cartel hacen falta dos caminos, porque ninguno funciona solo:
 *
 *  1. **Un iframe aislado** con su propio bloque de página. Es el camino bueno:
 *     el documento del iframe no tiene el layout de la app, así que sale limpio.
 *     La regla de página **no se puede acotar por selector**, de ahí el documento
 *     aparte — declararla en los estilos de un componente le cambiaría el tamaño
 *     de hoja a cualquier otra impresión de la app después de visitar esa pantalla.
 *  2. **Una copia colgada del body** + una clase que en impresión esconde todo lo
 *     demás. Es la red de seguridad: hay tablets (Safari/iPadOS, WebViews de
 *     Android) donde el navegador ignora el print() del iframe e imprime el
 *     documento de arriba. Sin esto, ahí sale la pantalla de la app.
 *
 * Las tres lecciones que ya costaron una impresión mala en la etiquetera y que
 * están incorporadas acá:
 *
 *  - **La altura al 100% del styles.css global** (que se clona junto con el resto
 *    de los estilos) vale, en impresión, una hoja completa; sumada al margen de la
 *    regla de página el body desborda y sale una **segunda hoja en blanco** en
 *    cada impresión. De ahí el reset con important.
 *  - **afterprint llega a la ventana equivocada** cuando el navegador imprimió el
 *    documento principal en vez del iframe. Hay que escucharlo en las dos, o el
 *    botón se queda en "Preparando…" hasta el timeout.
 *  - **Las reglas del camino de respaldo son globales por naturaleza** (hablan del
 *    body), así que NO pueden vivir en los estilos de un componente encapsulado.
 *    Acá se inyectan en un elemento de estilos temporal y se quitan al terminar,
 *    que es lo que evita que un componente tenga que renunciar a su encapsulación.
 *
 * Es una extracción del printIsolated() de `tienda-etiquetas.component.ts`, que
 * todavía tiene su propia copia (tiene 20 candados escritos alrededor y migrarla
 * es un trabajo aparte). Queda **declarada como deuda con nombre** en el tracker,
 * en vez de duplicarse una tercera vez sin dueño.
 */

export interface PrintIsolatedOpts {
  /** El HTML a imprimir. Se clona tal cual: los símbolos en SVG sobreviven. */
  html: string;
  /** Contenido de la regla de página. Ej. `size: letter portrait; margin: 0;`. */
  page: string;
  /** CSS del documento aislado, después de los estilos clonados de la app. */
  css?: string;
  /** Clase que se le pone al body de la app mientras dura el respaldo. */
  bodyClass: string;
  /** Clase del contenedor de respaldo colgado del body. */
  fallbackClass: string;
  /** Se llama una sola vez cuando terminó (imprimió, canceló o se rindió). */
  onDone?: () => void;
}

/** Reset que anula la altura al 100% del styles.css global clonado. Ver la nota de arriba. */
const RESET_HOJA =
  'html,body{margin:0 !important;padding:0 !important;background:#fff;' +
  'height:auto !important;min-height:0 !important;width:auto !important;overflow:visible !important;}' +
  '*{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;}';

export function printIsolated(o: PrintIsolatedOpts): void {
  const html = (o.html || '').trim();
  if (!html) { o.onDone?.(); return; }

  const fallback = document.createElement('div');
  fallback.className = o.fallbackClass;
  fallback.setAttribute('aria-hidden', 'true');
  fallback.innerHTML = html;
  document.body.appendChild(fallback);
  document.body.classList.add(o.bodyClass);

  // Si algo apagó la clase entre medio, el navegador avisa justo antes de imprimir.
  const rearm = () => { if (document.body.contains(fallback)) document.body.classList.add(o.bodyClass); };
  window.addEventListener('beforeprint', rearm);

  const styles = Array.from(document.querySelectorAll('head style, head link[rel="stylesheet"]'))
    .map((n) => n.outerHTML).join('\n');

  // Estilos del camino de respaldo + papel. Temporales a propósito: viven sólo
  // mientras dura la impresión, así ninguna otra pantalla hereda este tamaño de
  // hoja ni el "esconder todo" (ver la 3a lección del bloque de arriba). Se
  // agregan DESPUÉS de clonar los estilos para no duplicarlos dentro del iframe.
  const temp = document.createElement('style');
  temp.textContent =
    '.' + o.fallbackClass + '{display:none;}' +
    '@media print{' +
      'body.' + o.bodyClass + ' > *:not(.' + o.fallbackClass + '){display:none !important;}' +
      'body.' + o.bodyClass + ' .' + o.fallbackClass + '{display:block !important;}' +
      'body.' + o.bodyClass + ' *{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;}' +
      (o.css || '') +
    '}' +
    '@page{' + o.page + '}';
  document.head.appendChild(temp);

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;

  const limpiar = () => {
    window.removeEventListener('beforeprint', rearm);
    document.body.classList.remove(o.bodyClass);
    fallback.remove();
    temp.remove();
  };

  if (!doc || !win) { limpiar(); iframe.remove(); o.onDone?.(); return; }

  doc.open();
  doc.write(
    '<!doctype html><html><head><meta charset="utf-8">' + styles +
    '<style>@page{' + o.page + '}' + RESET_HOJA + (o.css || '') + '</style>' +
    '</head><body>' + html + '</body></html>',
  );
  doc.close();

  let listo = false;
  const fin = () => {
    if (listo) return;
    listo = true;
    window.removeEventListener('afterprint', fin);
    limpiar();
    iframe.remove();
    o.onDone?.();
  };
  win.addEventListener('afterprint', fin);
  window.addEventListener('afterprint', fin);

  const disparar = () => { try { win.focus(); win.print(); } catch { fin(); } };
  const fonts = (doc as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts;
  if (fonts?.ready) fonts.ready.then(() => setTimeout(disparar, 150)).catch(() => setTimeout(disparar, 300));
  else setTimeout(disparar, 450);

  // Si nunca llega afterprint (el usuario deja el diálogo abierto), se limpia igual.
  setTimeout(fin, 120000);
}
