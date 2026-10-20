import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[MT.6]` **Las pantallas se miden contra su panel, no contra la ventana.**
 *
 * ── El defecto ───────────────────────────────────────────────────────────────
 * Con la pantalla partida abierta, una pantalla mide ~600 px pero `@media` le
 * sigue preguntando a la VENTANA, que dice 1600 y responde «escritorio». Medido
 * en el navegador: las tarjetas de KPI del Centro de control se encimaban con
 * sus íconos y la tabla de Compras salía cortada en «Costo unit.». El CSS
 * responsive estaba ahí, intacto, y nunca se enteraba de que había menos lugar.
 *
 * ── La regla, y la enmienda que la hizo posible ──────────────────────────────
 * `DESIGN.md` §9/§R ya mandaba `@container` desde jul-2026 (el repo midió **0
 * usos** en ago-2026). Lo que faltaba era resolver que «página» había dejado de
 * ser sinónimo de «ventana»: desde `[MT.5]` cualquier pantalla puede vivir en un
 * panel, así que el layout de la página es contenido, no chrome.
 *
 *   `@media`     → chrome de la app (sidebar, bottom nav, barra, visibilidad del
 *                  panel) y rasgos del dispositivo (`pointer`, `prefers-*`,
 *                  `print`, `forced-colors`).
 *   `@container` → todo lo que vive DENTRO de un panel, layout de página incluido.
 *
 * ── Qué fija este gate ───────────────────────────────────────────────────────
 * Que nadie vuelva a escribir una consulta de ancho contra la ventana en
 * `apps/view`. Las dos excepciones están acá con su motivo: si alguien necesita
 * una tercera, que la escriba y la justifique, no que la cuele.
 */
describe('[MT.6] gate: nadie mide contra la ventana', () => {
  const RAIZ = join(__dirname, '..', '..', '..');

  /** Archivo → por qué SÍ puede consultar la ventana. */
  const PERMITIDOS: Record<string, string> = {
    'app/core/panel/panel-lateral.component.css':
      'ES el contenedor: su consulta decide si la VENTANA tiene ancho que partir, y un contenedor no puede consultarse a sí mismo',
    'app/modules/auth/login/login.component.css':
      'el login nunca vive en un panel — no hay pantalla partida sin sesión, así que ahí la ventana es la medida correcta',
  };

  /** Rasgos de dispositivo: `@container` no sabe consultarlos y se quedan en `@media`. */
  const DISPOSITIVO = /pointer|hover|prefers-|forced-colors|orientation|print|display-mode|resolution|monochrome/;

  function fuentes(dir: string, acc: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) fuentes(p, acc);
      else if (/\.(css|ts)$/.test(e) && !e.endsWith('.spec.ts')) acc.push(p);
    }
    return acc;
  }

  /**
   * ⚠️ La consulta y su `{` tienen que estar en la MISMA línea. Un patrón
   * `[^{]*` se come comentarios enteros: cualquier `@media` nombrado en prosa
   * matchea hasta la próxima llave, cientos de líneas abajo. Ese defecto estaba
   * en la primera versión del script que hizo este barrido, y con él habría
   * reescrito comentarios.
   */
  const CONSULTA_DE_ANCHO = /@media([^{\n]*(?:max|min)-width[^{\n]*)\{/g;

  it('ninguna pantalla consulta el ancho de la VENTANA', () => {
    const culpables: string[] = [];
    for (const p of fuentes(RAIZ)) {
      const rel = p.slice(RAIZ.length + 1).split('\\').join('/');
      if (PERMITIDOS[rel]) continue;
      const texto = readFileSync(p, 'utf8');
      for (const m of texto.matchAll(CONSULTA_DE_ANCHO)) {
        if (DISPOSITIVO.test(m[1])) continue; // mezcla un rasgo que @container no sabe
        culpables.push(rel + ' ::' + m[1].trim());
      }
    }
    expect(culpables).toEqual([]);
  });

  /** El gate no sirve si la lista crece sin pensarla: cada permiso dice por qué. */
  it('cada excepción tiene motivo escrito', () => {
    for (const [archivo, motivo] of Object.entries(PERMITIDOS)) {
      expect(motivo.length, archivo).toBeGreaterThan(40);
    }
  });

  /**
   * ⭐ La otra mitad: una consulta `@container` sin ancestro contenedor **no
   * matchea nunca**, y eso se rompe EN SILENCIO — las reglas de pantalla
   * angosta dejarían de aplicarse y el móvil se vería con layout de escritorio,
   * sin un error en consola. `body` es el contenedor de último recurso y por eso
   * es incondicional.
   */
  it('body es contenedor SIEMPRE: la red que evita el fallo silencioso', () => {
    const estilos = readFileSync(join(RAIZ, 'styles.css'), 'utf8');
    expect(estilos).toMatch(/body\s*\{[^}]*container-type:\s*inline-size/);
  });

  /**
   * ⛔ Y la columna, al revés: contenerla SIEMPRE rompía la captura. Medido: 16
   * `position: fixed; inset: 0` (overlays de cámara y escaneo), y
   * `container-type` implica `contain: layout`, que los confina y los recorta —
   * también en el teléfono, donde no hay pantalla partida y es donde se usa la
   * cámara. Por eso va condicionada a `con-panel`.
   */
  it('la columna se contiene SÓLO con el panel abierto', () => {
    const estilos = readFileSync(join(RAIZ, 'styles.css'), 'utf8');
    expect(estilos).toMatch(/\.split-shell\.con-panel\s+\.pane\s*\{[^}]*container-type:\s*inline-size/);
    // NEGATIVA de forma: que no exista un `.pane` suelto declarando contenedor.
    expect(estilos).not.toMatch(/(^|\n)\.pane\s*\{[^}]*container-type/);
  });
});
