import { test, expect, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * «Que no se haga scroll y que todo entre en la pantalla principal.»
 *
 * Es un requisito duro de la pantalla, y hasta hoy **no tenía compuerta**: las 22 pruebas de
 * `teclado.e2e.ts` recorren la interfaz pero ninguna mira si entra. Esto lo cierra.
 *
 * ── Por qué NO se mide con `scrollHeight`, medido el 2026-10-19 ──────────────────────────
 * La primera medición usó `documentElement.scrollHeight - innerHeight` y dio **+269px** a
 * 1280x600: parecía una barra de desplazamiento. No lo era. En esta pantalla `body` lleva
 * `overflow-y:hidden`, que el navegador **propaga al viewport** (el `html` está en `visible`),
 * así que la rueda del mouse no mueve nada:
 *
 *     window.scrollTo(0,400) → scrollY=269   ⇒ la propiedad dice que hay dónde ir
 *     rueda del mouse 400px  → scrollY=0     ⇒ la persona NO puede ir
 *
 * O sea que `scrollHeight` mide el alto del contenido, no si hay barra. Afirmar sobre él
 * habría dado un rojo falso. Lo que importa son **dos conductas distintas**, y se prueban por
 * separado:
 *
 *   1. que la rueda no desplace la página  (no hay barra: el armazón se queda quieto)
 *   2. que nada VISIBLE quede bajo el pliegue  (sin barra, lo recortado es inalcanzable)
 *
 * ⭐ El (2) es el que de verdad cobra. Sin barra, un número pintado fuera de la vista es
 * **peor** que uno con barra: a 1280x600 quedaban recortados el total contado del arqueo
 * ($19,138.00) y una fila entera de la cola, sin manera de bajar a verlos con el mouse.
 */

// ⚠️ `__dirname` y no `import.meta.url`: el repo transpila a CommonJS, y `import.meta` convierte
// el archivo en módulo ESM — ahí el `require` que Playwright inyecta deja de existir y la suite
// ni siquiera se descubre («No tests found», que se lee como un filtro mal escrito).
// Mismo patrón que `teclado.e2e.ts`, incluida la variable para apuntar a otra copia.
const PAGINA = pathToFileURL(
  process.env.CAJA_PROTOTIPO || resolve(__dirname, 'caja-general-paso1.html'),
).href;

const FILA = '#rows tr';

/**
 * El piso declarado de la flota y lo que hay arriba.
 *
 * ⚠️ **Declarado, no medido** (ADR-056). El censo de navegadores sale de
 * `public.users.last_login_user_agent` y trae navegador y SO de los 94 usuarios con login,
 * pero **el viewport no se guarda en ningún lado** — es el hueco H1. Así que estas alturas
 * son resoluciones de laptop Windows con la barra del navegador descontada, no una medición
 * de los equipos reales. El día que se capture el viewport, esta lista se reemplaza por datos.
 */
const SOPORTADOS = [
  { w: 1366, h: 625, nota: 'laptop 768p — el piso declarado' },
  { w: 1536, h: 730, nota: '1080p al 125%' },
  { w: 1920, h: 937, nota: '1080p al 100%' },
];

/** Por debajo del piso: se MIDE y se declara, no se afirma. Ver el bloque final. */
const BAJO_EL_PISO = { w: 1280, h: 600, nota: 'laptop 720p' };

/** ¿La rueda mueve la página? Es la pregunta de la persona, no la del DOM. */
async function ruedaDesplaza(page: Page): Promise<number> {
  const vp = page.viewportSize()!;
  await page.mouse.move(vp.width / 2, vp.height / 2);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(120);
  return page.evaluate(() => window.scrollY);
}

/**
 * Lo pintado que cae entero debajo del pliegue, **separado en dos montones**.
 *
 * ⛔ La primera versión los mezclaba y dio un rojo falso a 1536x730: marcaba el total del
 * arqueo como inalcanzable cuando en realidad vive dentro de `.ap-b`, que sí se desplaza.
 * «Debajo del pliegue» y «fuera de alcance» no son lo mismo, y confundirlos convierte el
 * patrón correcto —armazón quieto, lista con su propia barra— en una falla.
 *
 *   · `perdido`    nada desplazable arriba suyo ⇒ pintado y **sin forma de llegar**. Falla.
 *   · `enBarra`    cae dentro de un contenedor con barra ⇒ alcanzable. Se anota, no falla.
 *
 * ⚠️ Excluye `.sr-only` a propósito: esa región existe para el lector de pantalla y se
 * posiciona fuera de la vista **por diseño** — contarla daría un rojo permanente por la
 * técnica misma de accesibilidad que la pantalla usa bien.
 */
async function recortadoAbajo(page: Page) {
  return page.evaluate(() => {
    const H = window.innerHeight;
    const perdido: Array<{ el: string; top: number; texto: string; enfocable: boolean }> = [];
    const enBarra: typeof perdido = [];

    for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      if (el.closest('.sr-only')) continue;
      if (el.querySelector('*')) continue; // sólo hojas: el contenedor repetiría el hallazgo
      const r = el.getBoundingClientRect();
      if (r.height < 1 || r.width < 1) continue;
      if (r.top < H) continue;

      // ¿Algún ancestro se puede desplazar DE VERDAD? (declarar overflow:auto no basta:
      // si el contenido cabe, no hay barra y el elemento sigue siendo inalcanzable.)
      let alcanzable = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (/auto|scroll/.test(cs.overflowY) && p.scrollHeight - p.clientHeight > 1) {
          alcanzable = true;
          break;
        }
      }

      const dato = {
        el: el.tagName.toLowerCase() +
          (typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\s+/)[0]
            : ''),
        top: Math.round(r.top),
        texto: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        enfocable: el.matches('button,input,select,textarea,a[href],[tabindex]:not([tabindex="-1"])'),
      };
      (alcanzable ? enBarra : perdido).push(dato);
    }
    return { perdido, enBarra };
  });
}

type Recorte = Awaited<ReturnType<typeof recortadoAbajo>>['perdido'];

const comoLista = (xs: Recorte) =>
  xs.map((x) => `${x.el} @${x.top}px ${x.enfocable ? '[ENFOCABLE] ' : ''}"${x.texto}"`).join('\n  ');

for (const vp of SOPORTADOS) {
  test.describe(`${vp.w}x${vp.h} (${vp.nota})`, () => {
    test.use({ viewport: { width: vp.w, height: vp.h } });

    test('① la rueda no mueve la página y nada visible queda recortado', async ({ page }) => {
      await page.goto(PAGINA);

      expect(await ruedaDesplaza(page),
        'la página se desplazó con la rueda: el armazón perdió su cadena de min-height:0').toBe(0);

      const { perdido, enBarra } = await recortadoAbajo(page);
      if (enBarra.length) {
        test.info().annotations.push({
          type: 'bajo-el-pliegue-pero-alcanzable',
          description: `${enBarra.length} elementos dentro de un contenedor con barra:\n  ${comoLista(enBarra)}`,
        });
      }
      expect(perdido, `quedó contenido pintado bajo el pliegue y SIN barra para alcanzarlo:\n  ${comoLista(perdido)}`)
        .toEqual([]);
    });

    test('② con el arqueo abierto tampoco: es otro layout, y es donde está el dinero', async ({ page }) => {
      await page.goto(PAGINA);
      await page.locator(FILA).first().press('Enter');
      await expect(page.locator('#ap2'), 'el arqueo no abrió').toBeVisible();

      expect(await ruedaDesplaza(page),
        'con el arqueo abierto la página se desplaza con la rueda').toBe(0);

      const { perdido, enBarra } = await recortadoAbajo(page);
      if (enBarra.length) {
        test.info().annotations.push({
          type: 'bajo-el-pliegue-pero-alcanzable',
          description: `${enBarra.length} elementos dentro de un contenedor con barra:\n  ${comoLista(enBarra)}`,
        });
      }
      expect(perdido, `el arqueo dejó contenido fuera de la vista y sin barra:\n  ${comoLista(perdido)}`)
        .toEqual([]);
    });

    /**
     * ⭐ El total contado aparte, y con nombre propio.
     *
     * Medido 2026-10-19 a 1536x730: el bloque «Contado · $19,138.00» caía a 743px con el
     * pliegue en 730 — **13px**. No está perdido (vive dentro de `.ap-b`, que se desplaza),
     * pero es el número contra el que la persona cuadra el efectivo que tiene en la mano:
     * que haya que buscarlo con la barra, en la pantalla cuyo requisito es que todo entre,
     * es distinto de que una fila cualquiera de la cola quede abajo.
     */
    test('② el TOTAL CONTADO se ve sin tener que desplazar nada', async ({ page }) => {
      await page.goto(PAGINA);
      await page.locator(FILA).first().press('Enter');
      await expect(page.locator('#ap2')).toBeVisible();

      const total = page.locator('#ap2 .m-k', { hasText: 'Contado' }).first();
      await expect(total, 'no se encontró el bloque del total contado').toHaveCount(1);

      const caja = await total.evaluate((el) => {
        const r = el.getBoundingClientRect();
        // El bloque entero: el rótulo y la cifra que cuelga debajo.
        const grupo = el.parentElement ? el.parentElement.getBoundingClientRect() : r;
        return { top: Math.round(grupo.top), bottom: Math.round(grupo.bottom), H: window.innerHeight };
      });

      expect(caja.bottom,
        `el total contado termina en ${caja.bottom}px con el pliegue en ${caja.H}px: ` +
        `hay que desplazar ${caja.bottom - caja.H}px para ver el número que decide si el arqueo cuadra`)
        .toBeLessThanOrEqual(caja.H);
    });
  });
}

test.describe('⛔ [negativa] la compuerta se pone roja cuando de verdad hay algo recortado', () => {
  test.use({ viewport: { width: SOPORTADOS[0].w, height: SOPORTADOS[0].h } });

  test('un bloque metido a la fuerza bajo el pliegue SÍ lo detecta', async ({ page }) => {
    // Una compuerta sin prueba negativa es una intención: se rompe a propósito una vez.
    await page.goto(PAGINA);
    expect((await recortadoAbajo(page)).perdido, 'la pantalla ya venía con algo recortado').toEqual([]);

    await page.evaluate(() => {
      const intruso = document.createElement('div');
      intruso.textContent = 'esto NO se ve y nadie puede bajar a verlo';
      intruso.style.cssText =
        'position:absolute; top:' + (window.innerHeight + 40) + 'px; left:20px; width:300px; height:40px;';
      document.body.appendChild(intruso);
    });

    const { perdido } = await recortadoAbajo(page);
    expect(perdido.length, 'la compuerta NO vio un bloque puesto adrede fuera de la vista').toBeGreaterThan(0);
    // ⚠️ `texto` viene recortado a 40 caracteres para que el mensaje de error sea legible,
    // así que se busca un trozo que quepa — no la frase entera.
    expect(perdido[0].texto).toContain('esto NO se ve');
  });
});

test.describe(`⬜ [DECLARADO] ${BAJO_EL_PISO.w}x${BAJO_EL_PISO.h} — por debajo del piso`, () => {
  test.use({ viewport: { width: BAJO_EL_PISO.w, height: BAJO_EL_PISO.h } });

  /**
   * Acá **no se afirma nada**: se mide y se anota.
   *
   * Afirmar que tiene que entrar convertiría en requisito un tamaño que no sabemos si existe
   * en la flota (el viewport no se captura: hueco H1). Y afirmar que NO entra —fijando el
   * defecto— bloquearía a quien lo arregle. Las dos serían dibujar un resultado donde hubo
   * una medición. Queda el número, en el reporte, con su fecha.
   *
   * Medido 2026-10-19 en este tamaño: con el arqueo abierto quedaban recortados el total
   * contado del arqueo y una fila entera de la cola — 11 elementos pintados, sin barra.
   */
  test('se mide y se declara lo que queda fuera, sin convertirlo en requisito', async ({ page }) => {
    await page.goto(PAGINA);
    await page.locator(FILA).first().press('Enter');
    await expect(page.locator('#ap2')).toBeVisible();

    const { perdido, enBarra } = await recortadoAbajo(page);
    const rueda = await ruedaDesplaza(page);

    test.info().annotations.push({
      type: 'medicion',
      description:
        `${BAJO_EL_PISO.w}x${BAJO_EL_PISO.h} · arqueo abierto · rueda→scrollY=${rueda} · ` +
        `perdidos=${perdido.length} · alcanzables-con-barra=${enBarra.length}` +
        (perdido.length ? `\n  PERDIDOS:\n  ${comoLista(perdido)}` : ''),
    });

    // Lo único que se exige es que la medición se haya podido tomar.
    expect(Array.isArray(perdido), 'no se pudo medir el recorte en este tamaño').toBe(true);
  });
});
