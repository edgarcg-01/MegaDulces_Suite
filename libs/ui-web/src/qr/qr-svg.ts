/**
 * `[CG.74]` **Un QR, como SVG, sin dependencias nuevas.**
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────────────────────
 * La caja muestra un código de 6 caracteres para emparejar el teléfono que firma (`[CG.68]`), y
 * la pantalla decía *«Abrí Caja General › Firmar en el teléfono»* — una ruta que **no existe en
 * ningún menú** (medido: la ruta está registrada y nada en la navegación apunta ahí). O sea que
 * el procedimiento real era teclear una URL de memoria, en un teléfono, con un código que vive
 * **tres minutos**. Edgar lo encontró del modo más directo: preguntando «¿cómo hago esto?».
 *
 * ⚠️ **No se agregó ninguna dependencia.** `@zxing/browser` ya estaba declarada (se usa para
 * ESCANEAR códigos de producto) y trae `BrowserQRCodeSvgWriter`, que genera. Antes de escribir
 * esto se verificó que estuviera instalada y qué exporta — agregar un paquete toca
 * `package.json`, que en este repo no se mueve sin autorización.
 *
 * ⚠️ Vive en `libs/ui-web` y no en la pantalla porque «convertir un texto en un QR» no es de
 * caja: el verificador de precios, las etiquetas de tienda y las guías de logística tienen el
 * mismo problema. ADR-056 — un primitivo genérico vive en `libs/` o se declara como deuda.
 *
 * ⚠️ Devuelve un **SVG**, no un `<img>` con data URI: escala sin pixelarse (lo van a escanear de
 * lejos y en diagonal) y no obliga a pasar por `bypassSecurityTrustHtml`, que es la puerta por la
 * que se cuela el XSS cuando alguien, más adelante, mete texto de un usuario acá.
 */
/**
 * ⛔ **El `import` de `@zxing/browser` va DINÁMICO, y esto no es un detalle de estilo: el estático
 * rompió `main`.**
 *
 * Medido en el CI de `889c579af`: `bundle initial exceeded maximum budget. Budget 1.65 MB was not
 * met by 448.92 kB with a total of 2.10 MB` — o sea **449 kB de más** en el paquete inicial.
 *
 * ⭐ La causa no es el paquete: es **el barril**. `libs/ui-web/src/index.ts` re-exporta esto, y ese
 * barril lo importa medio `apps/view` desde código que carga al arrancar. Con un `import`
 * estático, el codificador entero entra al bundle inicial **aunque nadie pinte un QR nunca**. Y el
 * comentario de arriba era cierto y aun así insuficiente: `@zxing/browser` ya estaba declarada,
 * pero su uso previo —ESCANEAR códigos— vive en una pantalla perezosa. Exportarlo desde el barril
 * lo volvió eager. *Reusar una dependencia que ya existe no dice nada sobre dónde va a aterrizar.*
 *
 * Con `import()` el empaquetador lo corta en un trozo aparte que se baja la primera vez que se
 * pinta un QR. El costo es que las dos funciones pasan a ser `async`.
 */
type EscritorQr = { write(contenido: string, ancho: number, alto: number): SVGSVGElement };

/** Se resuelve una sola vez: la segunda llamada reusa el módulo ya bajado. */
let escritorPendiente: Promise<new () => EscritorQr> | null = null;

function cargarEscritor(): Promise<new () => EscritorQr> {
  if (!escritorPendiente) {
    escritorPendiente = import('@zxing/browser').then(
      (m) => m.BrowserQRCodeSvgWriter as unknown as new () => EscritorQr,
    );
  }
  return escritorPendiente;
}

/** Lado mínimo en píxeles. Por debajo, la cámara de un teléfono viejo no engancha. */
export const QR_LADO_MINIMO = 96;

/**
 * Convierte un texto en un elemento SVG con su QR.
 *
 * @param texto lo que se codifica (normalmente una URL absoluta).
 * @param lado  alto y ancho en píxeles; se sube a `QR_LADO_MINIMO` si viene más chico.
 * @returns el `SVGSVGElement`, o `null` si el texto está vacío o el codificador falla.
 *
 * ⭐ **Falla devolviendo `null`, no tirando.** Un QR es una comodidad: el código de 6 caracteres
 * sigue escrito al lado. Si esto reventara, se llevaría puesta toda la captura del movimiento —
 * y perder un arqueo contado por un adorno sería absurdo.
 */
export async function qrSvg(texto: string | null | undefined, lado = 160): Promise<SVGSVGElement | null> {
  const t = typeof texto === 'string' ? texto.trim() : '';
  if (!t) return null;
  const px = Math.max(Math.round(lado) || 0, QR_LADO_MINIMO);
  try {
    const Escritor = await cargarEscritor();
    const svg = new Escritor().write(t, px, px);
    // El writer no pone ninguno: sin esto, un lector de pantalla anuncia "gráfico" y nada más.
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Código QR para abrir la página en el teléfono');
    return svg;
  } catch {
    return null;
  }
}

/**
 * Pinta el QR DENTRO de un contenedor, reemplazando lo que hubiera.
 *
 * ⚠️ Vacía el contenedor primero. Sin eso, cada vez que cambia el código quedaría un QR nuevo
 * **debajo** del viejo — y el de arriba, que es el que la gente escanea, sería el vencido.
 *
 * @returns `true` si quedó pintado; `false` si no había texto, no había contenedor o falló.
 */
export async function pintarQr(
  destino: Element | null | undefined, texto: string | null | undefined, lado = 160,
): Promise<boolean> {
  if (!destino) return false;
  // ⚠️ Vacía PRIMERO, aunque ahora haya una espera en medio. Se intentó al revés —esperar al SVG y
  // recién entonces reemplazar, para que no parpadeara mientras baja el trozo diferido— y la
  // prueba de abajo lo rechazó con razón: dejaba el QR ANTERIOR a la vista cuando la nueva llamada
  // no produce ninguno. Un QR vencido que alguien escanea es peor que un hueco, porque el hueco se
  // ve y el vencido no. El parpadeo dura lo que tarda la primera carga del codificador, una vez.
  destino.replaceChildren();
  const svg = await qrSvg(texto, lado);
  if (!svg) return false;
  destino.appendChild(svg);
  return true;
}
