import { test, expect, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * ⌨️ CAJA GENERAL · PASO ① — recorrer TODA la interfaz con las flechas.
 *
 * El pedido de Edgar: «todo se puede acceder mientras el teclado y las flechas».
 * Esto lo convierte en un candado: cada tramo del recorrido es un `test`, y cada guarda
 * tiene su PRUEBA NEGATIVA —se rompe a propósito en el navegador y se verifica el rojo—,
 * porque una compuerta sin prueba negativa es una intención, no una compuerta.
 *
 * El modelo que se afirma, completo:
 *
 *   Tab    · UNA parada por región (accesos, buscador, lista, arqueo). Nunca N paradas.
 *   ← →    · dentro del grupo de accesos, con vuelta circular; la selección SIGUE al foco.
 *   ↑ ↓    · dentro de la lista, SIN vuelta (una lista que da la vuelta hace perder el lugar).
 *   Home/End · primero y último, en los dos controles.
 *   Enter  · abre ② y deja el foco DENTRO de la reja, listo para teclear.
 *   ↑ ↓    · dentro de la reja, entre denominaciones, SIN tocar el valor tecleado.
 *   Esc    · cierra ② y devuelve el foco a la fila de la que se salió.
 *   /      · salta al buscador, salvo que ya estés escribiendo.
 */

/**
 * El prototipo vive AL LADO de la suite, así que el par viaja junto y no depende de
 * dónde lo haya dejado cada quien. `CAJA_PROTOTIPO` permite apuntar a otra copia
 * (p. ej. la de Downloads mientras se itera el diseño) sin tocar el código.
 */
const PAGINA = pathToFileURL(
  process.env.CAJA_PROTOTIPO || resolve(__dirname, 'caja-general-paso1.html'),
).href;

const BK   = '#bks .bk';
const FILA = '#rows tr';
const REJA = '.cg-pieza';

/** Quién tiene el foco, en una cadena legible cuando la prueba sale roja. */
const foco = (p: Page) => p.evaluate(() => {
  const a = document.activeElement as HTMLElement | null;
  if (!a) { return '(ninguno)'; }
  const etiqueta = (a.getAttribute('aria-label') || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  return `${a.tagName}${a.dataset?.b ? `[${a.dataset.b}]` : ''} «${etiqueta}»`;
});

/** El valor de `tabindex` de cada elemento de un conjunto: así se ve el roving de un vistazo. */
const tabindices = (p: Page, sel: string) =>
  p.$$eval(sel, (els) => els.map((e) => (e as HTMLElement).tabIndex));

test.beforeEach(async ({ page }) => {
  await page.goto(PAGINA);
  await page.waitForSelector(FILA);
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Tab: una parada por región, no una por control', () => {

  test('el grupo de accesos expone UNA sola parada de Tab (roving tabindex)', async ({ page }) => {
    const idx = await tabindices(page, BK);
    expect(idx.length, 'no hay accesos en pantalla').toBeGreaterThan(1);
    expect(idx.filter((t) => t === 0), `tabindex de los accesos: ${idx}`).toHaveLength(1);
    expect(idx[0], 'la parada tiene que arrancar en el acceso elegido').toBe(0);
  });

  test('la lista expone UNA sola parada de Tab', async ({ page }) => {
    const idx = await tabindices(page, FILA);
    expect(idx.filter((t) => t === 0), `tabindex de las filas: ${idx}`).toHaveLength(1);
  });

  test('⛔ [negativa] sin roving, Tab tendría una parada por control', async ({ page }) => {
    // Se rompe la guarda EN EL NAVEGADOR: todos los accesos quedan tabulables.
    await page.$$eval(BK, (els) => els.forEach((e) => { (e as HTMLElement).tabIndex = 0; }));
    const idx = await tabindices(page, BK);
    expect(idx.filter((t) => t === 0).length,
      'con el roving roto la prueba de arriba TIENE que fallar').toBeGreaterThan(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('← → : el grupo de accesos', () => {

  test('→ avanza, selecciona lo que enfoca, y da la vuelta al final', async ({ page }) => {
    const n = await page.locator(BK).count();
    await page.locator(BK).first().focus();

    for (let i = 1; i < n; i++) {
      await page.keyboard.press('ArrowRight');
      const enfocado = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.b);
      const elegido  = await page.locator(`${BK}[aria-checked="true"]`).getAttribute('data-b');
      expect(elegido, `paso ${i}: la selección no siguió al foco`).toBe(enfocado);
    }

    // La vuelta: del último al primero.
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.b),
      'el grupo no dio la vuelta').toBe('ingreso');
  });

  test('← retrocede y da la vuelta hacia atrás', async ({ page }) => {
    await page.locator(BK).first().focus();
    await page.keyboard.press('ArrowLeft');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.b),
      'desde el primero, ← tiene que caer en el último').toBe('fuera');
  });

  test('↑ ↓ también mueven el grupo (un radiogroup horizontal acepta los cuatro)', async ({ page }) => {
    await page.locator(BK).first().focus();
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.b)).toBe('egreso');
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.b)).toBe('ingreso');
  });

  test('Home y End saltan al primero y al último', async ({ page }) => {
    await page.locator(BK).nth(2).focus();
    await page.keyboard.press('End');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.b)).toBe('fuera');
    await page.keyboard.press('Home');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.b)).toBe('ingreso');
  });

  test('cambiar de acceso repinta la lista Y cierra el arqueo abierto', async ({ page }) => {
    await page.locator(FILA).first().press('Enter');
    await expect(page.locator('#ap2'), 'el arqueo tenía que abrir').toBeVisible();

    await page.locator(BK).first().focus();
    await page.keyboard.press('ArrowRight');       // → Egresos
    await expect(page.locator('#ap2'),
      'cambiar de grupo con el arqueo abierto lo dejaría mostrando un movimiento de otro grupo').toBeHidden();
    await expect(page.locator(FILA).first()).toContainText('X-D-26');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('↑ ↓ : la lista', () => {

  test('↓ baja, ↑ sube, y el foco acompaña', async ({ page }) => {
    await page.locator(FILA).first().focus();
    await page.keyboard.press('ArrowDown');
    expect(await foco(page), 'la segunda fila es la del 12/10').toContain('12/10/26');
    await page.keyboard.press('ArrowUp');
    expect(await foco(page)).toContain('10/10/26');
  });

  test('⛔ la lista NO da la vuelta: en el último, ↓ se queda', async ({ page }) => {
    // Una lista circular hace perder el lugar — ahí abajo es el final, no el principio.
    const n = await page.locator(FILA).count();
    await page.locator(FILA).nth(n - 1).focus();
    const antes = await foco(page);
    await page.keyboard.press('ArrowDown');
    expect(await foco(page), 'la lista dio la vuelta y no debería').toBe(antes);

    await page.locator(FILA).first().focus();
    const primero = await foco(page);
    await page.keyboard.press('ArrowUp');
    expect(await foco(page), 'la lista dio la vuelta hacia arriba').toBe(primero);
  });

  test('Home y End van al primero y al último de la lista', async ({ page }) => {
    const n = await page.locator(FILA).count();
    await page.locator(FILA).nth(1).focus();
    await page.keyboard.press('End');
    expect(await tabindices(page, FILA)).toEqual(
      Array.from({ length: n }, (_, i) => (i === n - 1 ? 0 : -1)));
    await page.keyboard.press('Home');
    expect(await tabindices(page, FILA)).toEqual(
      Array.from({ length: n }, (_, i) => (i === 0 ? 0 : -1)));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Enter / Esc : entrar al arqueo y volver', () => {

  test('Enter abre ② y deja el foco DENTRO de la reja, listo para teclear', async ({ page }) => {
    await page.locator(FILA).first().focus();
    await page.keyboard.press('Enter');

    await expect(page.locator('#ap2')).toBeVisible();
    expect(await foco(page), 'el foco se quedó en la lista: habría que volver a navegar a mano')
      .toContain('Piezas del billete de 500');

    /**
     * Y el valor tiene que quedar SELECCIONADO, para que teclear reemplace en vez de concatenar:
     * contando un fajo se teclea el número nuevo, no se corrige el viejo.
     *
     * ⚠️ Acá la primera versión de esta prueba medía `selectionStart === 0 && selectionEnd ===
     * value.length` y salía ROJA sobre código correcto: en `input[type=number]` Chrome devuelve
     * `selectionStart = null`, porque la selección sólo aplica a text/search/url/tel/password.
     * O sea que la prueba medía con la herramienta equivocada. Se mide la CONDUCTA: se teclea y
     * se ve si reemplazó — que además es lo que la persona experimenta.
     */
    await page.keyboard.type('7');
    expect(await page.locator(REJA).first().inputValue(),
      'teclear concatenó en vez de reemplazar: el conteo sale mal sin que nadie lo note').toBe('7');
  });

  test('Esc cierra ② y DEVUELVE el foco a la fila de la que se salió', async ({ page }) => {
    await page.locator(FILA).nth(2).focus();
    const salida = await foco(page);
    await page.keyboard.press('Enter');
    await expect(page.locator('#ap2')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('#ap2')).toBeHidden();
    expect(await foco(page), 'Esc dejó el foco en el limbo: volver exigiría el mouse').toBe(salida);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('↑ ↓ : la reja de denominaciones — el tramo que jsdom NO puede probar', () => {

  test('↓ pasa al siguiente renglón y el valor tecleado queda INTACTO', async ({ page }) => {
    await page.locator(FILA).first().press('Enter');
    const primero = page.locator(REJA).first();
    await primero.focus();
    const antes = await primero.inputValue();

    await page.keyboard.press('ArrowDown');

    expect(await primero.inputValue(),
      `el stepper nativo decrementó el fajo: ${antes} → ${await primero.inputValue()}`).toBe(antes);
    expect(await foco(page)).toContain('Piezas del billete de 200');
  });

  test('↑ sube un renglón, también sin tocar el valor', async ({ page }) => {
    await page.locator(FILA).first().press('Enter');
    const segundo = page.locator(REJA).nth(1);
    await segundo.focus();
    const antes = await segundo.inputValue();
    await page.keyboard.press('ArrowUp');
    expect(await segundo.inputValue(), 'el stepper incrementó al subir').toBe(antes);
    expect(await foco(page)).toContain('Piezas del billete de 500');
  });

  test('la reja se recorre ENTERA: de billetes a monedas sin saltarse el borde', async ({ page }) => {
    await page.locator(FILA).first().press('Enter');
    const total = await page.locator(REJA).count();
    expect(total, 'la reja tendría que tener 5 billetes + 6 monedas').toBe(11);

    await page.locator(REJA).first().focus();
    const recorrido: string[] = [await foco(page)];
    for (let i = 1; i < total; i++) {
      await page.keyboard.press('ArrowDown');
      recorrido.push(await foco(page));
    }
    // Cada parada es distinta: ningún renglón se salta ni se repite.
    expect(new Set(recorrido).size, `el recorrido repitió o saltó: ${recorrido.join(' → ')}`).toBe(total);
    // Y el cruce del borde billetes → monedas ocurre de verdad.
    expect(recorrido[4]).toContain('billete de 20');
    expect(recorrido[5]).toContain('moneda de 20');
  });

  test('⛔⛔ [negativa] SIN la guarda, la flecha corrompe el conteo — y esto es lo que jsdom no ve', async ({ page }) => {
    /**
     * Medido el 2026-10-16:
     *   jsdom  · ArrowDown sobre input[type=number] con 34 → 34
     *   Chrome · ArrowDown sobre input[type=number] con 34 → 33
     * Se clona el input para que pierda sus listeners: así queda el comportamiento NATIVO,
     * que es exactamente lo que quedaría si alguien borrara el `preventDefault()`.
     */
    await page.locator(FILA).first().press('Enter');
    await page.$eval(REJA, (el) => {
      const limpio = el.cloneNode(true) as HTMLInputElement;
      el.replaceWith(limpio);
      limpio.focus();
    });

    const antes = await page.locator(REJA).first().inputValue();
    await page.keyboard.press('ArrowDown');
    const despues = await page.locator(REJA).first().inputValue();

    expect(despues, 'sin guarda el navegador TIENE que decrementar; si no, la prueba de arriba no prueba nada')
      .not.toBe(antes);
    expect(Number(despues)).toBe(Number(antes) - 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('/ : el buscador', () => {

  test('/ salta al buscador desde cualquier parte', async ({ page }) => {
    await page.locator(FILA).nth(1).focus();
    await page.keyboard.press('/');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).id)).toBe('buscar');
  });

  test('⛔ / NO roba el foco mientras ya estás escribiendo', async ({ page }) => {
    await page.locator('#buscar').focus();
    await page.keyboard.type('DELICI');
    await page.keyboard.press('/');
    expect(await page.locator('#buscar').inputValue(),
      'el atajo se comió una barra que la persona quería escribir').toBe('DELICI/');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('El recorrido completo, de punta a punta', () => {

  test('con flechas y Enter se llega del primer acceso a guardar el arqueo, sin mouse', async ({ page }) => {
    // 1 · elegir el grupo
    await page.locator(BK).first().focus();
    await page.keyboard.press('ArrowRight');            // Egresos
    await expect(page.locator(FILA).first()).toContainText('X-D-26');

    // 2 · bajar en la lista
    await page.locator(FILA).first().focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const elegida = await foco(page);

    // 3 · entrar al arqueo
    await page.keyboard.press('Enter');
    await expect(page.locator('#ap2')).toBeVisible();
    await expect(page.locator('#fi-nom')).toContainText('CUERITOS PREMIUM ZACAPU');

    // 4 · recorrer la reja entera y volver
    for (let i = 0; i < 10; i++) { await page.keyboard.press('ArrowDown'); }
    expect(await foco(page), 'no se llegó al último renglón de la reja').toContain('50 centavos');

    // 5 · salir y quedar donde estábamos
    await page.keyboard.press('Escape');
    expect(await foco(page), 'el recorrido no cierra el círculo').toBe(elegida);
  });

  test('ningún control queda fuera del alcance del teclado', async ({ page }) => {
    // Todo lo interactivo tiene que ser alcanzable: o es tabulable, o lo gobierna
    // un roving (tabindex -1 con su grupo), o es un `details` nativo.
    const huerfanos = await page.$$eval(
      'button, input, [role="radio"], summary, a[href]',
      (els) => els
        .filter((e) => (e as HTMLElement).offsetParent !== null)        // visible
        .filter((e) => {
          const t = (e as HTMLElement).tabIndex;
          const enGrupo = e.closest('#bks') || e.closest('#rows') || e.closest('.reja');
          return t < 0 && !enGrupo;                                      // inalcanzable
        })
        .map((e) => e.tagName + ' «' + ((e as HTMLElement).innerText || e.getAttribute('aria-label') || '').trim().slice(0, 30) + '»'));
    expect(huerfanos, `controles visibles que el teclado no alcanza: ${huerfanos.join(' · ')}`).toEqual([]);
  });

  test('el foco SIEMPRE se ve: ningún control apaga su anillo', async ({ page }) => {
    // Un `outline:none` sin reemplazo deja a quien navega con teclado sin saber dónde está.
    await page.locator(BK).first().focus();
    const anillo = await page.evaluate(() => {
      const s = getComputedStyle(document.activeElement as Element);
      return { outline: s.outlineStyle, ancho: s.outlineWidth };
    });
    expect(anillo.outline, 'el acceso enfocado no dibuja anillo').not.toBe('none');
    expect(parseFloat(anillo.ancho), 'el anillo tiene ancho cero').toBeGreaterThan(0);
  });
});
