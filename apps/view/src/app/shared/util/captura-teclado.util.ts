/**
 * `[AB.41]` **Capturar cantidades con el teclado**, como en Excel: la regla de qué hace cada tecla en
 * una columna de captura. Nace en `/compras/pedido` (RA-PRO.57, `pedido-redondeo.ts`) y se mueve
 * aquí sin cambios para que Autoabasto capture igual. `pedido-redondeo.ts` la reexporta.
 *
 *   ↑ ↓            campo anterior / siguiente de la columna
 *   Enter          siguiente (Shift+Enter: anterior)
 *   ← →            restar / sumar un paso
 *   Alt + ↑ ↓      el mismo paso
 */

/** Lo que importa de una tecla para decidir el paso (subconjunto de `KeyboardEvent`, para probarlo sin DOM). */
export interface TeclaPaso { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; }

/**
 * `[RA-PRO.57]` Qué paso hace una tecla en la columna de captura del pedido: +1, −1 o nada (0).
 *  - `→` / `←` SIN modificadores: +1 / −1. Con Shift/Ctrl/Alt/Meta se deja lo nativo
 *    (Shift+← selecciona texto, Ctrl+← salta palabra…).
 *  - `Alt + ↑` / `Alt + ↓`: +1 / −1 (el atajo de antes, se conserva).
 *  - `↑ ↓` solas y `Enter` NO son paso: mueven de renglón (regla D.5), las resuelve el componente.
 */
export function pasoPorTecla(t: TeclaPaso): 1 | -1 | 0 {
  const mod = t.altKey || t.ctrlKey || t.metaKey || t.shiftKey;
  if (!mod && t.key === 'ArrowRight') return 1;
  if (!mod && t.key === 'ArrowLeft') return -1;
  if (t.altKey && !t.ctrlKey && !t.metaKey && !t.shiftKey) {
    if (t.key === 'ArrowUp') return 1;
    if (t.key === 'ArrowDown') return -1;
  }
  return 0;
}

/**
 * `[AB.41]` A qué campo moverse: −1 (↑, Shift+Enter), +1 (↓, Enter) o 0 (la tecla no mueve).
 * Con Alt, ↑ ↓ son paso (ver `pasoPorTecla`), no movimiento.
 */
export function movimientoPorTecla(t: TeclaPaso): 1 | -1 | 0 {
  if (t.altKey || t.ctrlKey || t.metaKey) return 0;
  if (t.key === 'ArrowUp' || (t.key === 'Enter' && t.shiftKey)) return -1;
  if ((t.key === 'ArrowDown' && !t.shiftKey) || (t.key === 'Enter' && !t.shiftKey)) return 1;
  return 0;
}

/**
 * `[AB.41]` Mueve el foco al campo anterior / siguiente de la columna (en el orden en que se ven) y
 * lo deja seleccionado, para que teclear reemplace. En el borde no da la vuelta: en captura, dar la
 * vuelta desorienta. Devuelve `true` si la tecla era de movimiento (el llamador corta lo nativo).
 */
export function moverEntreCampos(ev: KeyboardEvent, raiz: ParentNode, selector: string): boolean {
  const dir = movimientoPorTecla(ev);
  if (!dir) return false;
  const el = ev.target as HTMLInputElement;
  const campos = Array.from(raiz.querySelectorAll<HTMLInputElement>(selector))
    .filter((n) => !n.disabled && !n.readOnly && n.offsetParent !== null);
  const i = campos.indexOf(el);
  if (i < 0) return false;
  ev.preventDefault();                                  // corta el incremento nativo del ↑ ↓
  const next = campos[i + dir];
  if (next) { next.focus(); next.select(); }
  return true;
}
