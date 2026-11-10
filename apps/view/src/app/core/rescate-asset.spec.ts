import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[RES.6]` — **Un archivo que no llega se vuelve a pedir con otra dirección.**
 *
 * ── El defecto, medido el 2026-11-10 ────────────────────────────────────────────────────────
 * En Yurécuaro la suite abría en blanco. `main-FXZ7HISR.js` daba **404** en esa máquina y **200**
 * desde otros tres caminos de red, con Chrome 157 al día. La MISMA dirección con un parámetro
 * pegado atrás sí cargaba (`cf-cache-status: MISS` → 200, 683,476 bytes). Es una respuesta «no
 * existe» que el borde de la CDN guardó durante la ventana en que el despliegue todavía no había
 * publicado el archivo nuevo, y que después siguió sirviendo durante días.
 *
 * `[RES.5]` no lo cubre: limpia el estado LOCAL y recarga, pero lo roto está río arriba, así que
 * la recarga vuelve a pedir la misma dirección envenenada. Peor: se marca «ya intenté» y se rinde.
 *
 * ── Por qué el candado lee el `index.html` y no un módulo ───────────────────────────────────
 * El rescate es **inline a propósito** (tiene que correr aunque el bundle no cargue, que es justo
 * el caso que viene a cubrir). No hay nada que importar: lo que se prueba es el texto que se sirve.
 * Se extrae el bloque del `index.html` y se ejecuta contra un `window`/`document` de mentira.
 *
 * ⚠️ Lo que este candado NO prueba: que la CDN deje de envenenarse (eso se arregla purgando al
 * final del despliegue), ni que el archivo reinyectado efectivamente cargue en el navegador real.
 */

const RAIZ = join(__dirname, '..', '..');
const PARAM = 'rescate_asset';

/** Saca el cuerpo del `<script>` de `[RES.6]` tal como se sirve, sin reescribirlo. */
function guionDelRescate(): string {
  const html = readFileSync(join(RAIZ, 'index.html'), 'utf8');
  const desde = html.indexOf('`[RES.6]`');
  expect(desde, 'el bloque [RES.6] tiene que existir en index.html').toBeGreaterThan(-1);
  // ⚠️ Se busca DESPUÉS del cierre del comentario: su prosa menciona `<script>` y un indexOf
  // ingenuo extrae el comentario en vez del código (lo cazó esta misma prueba, 2026-11-10).
  const finComentario = html.indexOf('-->', desde);
  expect(finComentario, 'el comentario de [RES.6] tiene que cerrar').toBeGreaterThan(desde);
  const abre = html.indexOf('<script>', finComentario);
  const cierra = html.indexOf('</script>', abre);
  expect(abre, 'el bloque [RES.6] tiene que traer su <script> inline').toBeGreaterThan(-1);
  expect(cierra).toBeGreaterThan(abre);
  return html.slice(abre + '<script>'.length, cierra);
}

interface Falso {
  disparar: (objetivo: unknown) => void;
  agregados: Array<{ src: string; type?: string }>;
}

/** Monta el guion contra un DOM de mentira y devuelve con qué dispararlo y qué fue quedando. */
function montar(): Falso {
  const agregados: Array<{ src: string; type?: string }> = [];
  let oyente: ((ev: { target: unknown }) => void) | null = null;

  const documentFalso = {
    createElement: () => ({ src: '', type: undefined as string | undefined, crossOrigin: undefined }),
    head: { appendChild: (el: { src: string; type?: string }) => agregados.push({ src: el.src, type: el.type }) },
  };
  const windowFalso = {
    addEventListener: (tipo: string, fn: (ev: { target: unknown }) => void) => {
      if (tipo === 'error') oyente = fn;
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('window', 'document', guionDelRescate())(windowFalso, documentFalso);
  expect(oyente, 'el guion tiene que registrar un oyente de "error"').not.toBeNull();

  return { disparar: (objetivo: unknown) => oyente!({ target: objetivo }), agregados };
}

const script = (src: string, type = 'module') => ({ tagName: 'SCRIPT', src, type, crossOrigin: undefined });

describe('[RES.6] el rescate vuelve a pedir el archivo con otra dirección', () => {
  it('un <script> que falla se vuelve a pedir CON el parámetro (que es lo que saltea el borde)', () => {
    const f = montar();
    f.disparar(script('https://megadulcessuite.com/main-FXZ7HISR.js'));
    expect(f.agregados).toHaveLength(1);
    expect(f.agregados[0].src).toContain('main-FXZ7HISR.js');
    expect(f.agregados[0].src).toContain(`${PARAM}=`);
  });

  it('conserva el type="module": sin eso el bundle de Angular no ejecuta', () => {
    const f = montar();
    f.disparar(script('https://megadulcessuite.com/main-FXZ7HISR.js'));
    expect(f.agregados[0].type).toBe('module');
  });

  it('respeta una dirección que YA traía parámetros (pega el suyo con &, no con un segundo ?)', () => {
    const f = montar();
    f.disparar(script('https://megadulcessuite.com/main.js?v=3'));
    expect(f.agregados[0].src).toContain('?v=3&');
    expect(f.agregados[0].src.match(/\?/g)).toHaveLength(1);
  });

  it('⛔ PRUEBA NEGATIVA: el reintento que TAMBIÉN falla no se reintenta (si no, parpadea para siempre)', () => {
    const f = montar();
    f.disparar(script(`https://megadulcessuite.com/main.js?${PARAM}=123`));
    expect(f.agregados).toEqual([]);
  });

  it('⛔ PRUEBA NEGATIVA: el mismo archivo no se reintenta dos veces', () => {
    const f = montar();
    const uno = script('https://megadulcessuite.com/main-FXZ7HISR.js');
    f.disparar(uno);
    f.disparar(uno);
    expect(f.agregados).toHaveLength(1);
  });

  it('⛔ PRUEBA NEGATIVA: un fallo que NO es de un <script> no mueve nada (una imagen rota no recarga código)', () => {
    const f = montar();
    f.disparar({ tagName: 'IMG', src: 'https://megadulcessuite.com/logo.png' });
    f.disparar({ tagName: 'SCRIPT', src: '' });
    f.disparar(null);
    expect(f.agregados).toEqual([]);
  });

  it('⛔ PRUEBA NEGATIVA: el guion vive ANTES del primer <script src> del head, o no alcanza a oír nada', () => {
    const html = readFileSync(join(RAIZ, 'index.html'), 'utf8');
    const res6 = html.indexOf('`[RES.6]`');
    const primerSrc = html.search(/<script[^>]+src=/);
    expect(res6).toBeGreaterThan(-1);
    if (primerSrc !== -1) expect(res6).toBeLessThan(primerSrc);
  });
});
