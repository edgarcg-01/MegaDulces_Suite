import tsconfigPaths from 'vite-tsconfig-paths';
import { resolve } from 'node:path';

/**
 * La raíz de un proyecto, con la letra de unidad SIEMPRE en mayúscula.
 *
 * ── Por qué esto existe (Windows) ───────────────────────────────────────────────────────────
 * ⛔ La misma suite daba **6 fallas corriendo `vitest` a mano y 125 corriendo `nx test`**, con
 * el mismo config y el mismo comando. La diferencia era una letra:
 *
 *     npx vitest run   (dentro de apps/view) → RUN v4.1.11 C:/Users/…/apps/view   →   0 avisos
 *     npx nx test view                       → RUN v4.1.11 c:/Users/…/apps/view   →  32 avisos
 *
 * Node hereda de `process.cwd()` la caja de la letra de unidad, y Nx lanza el comando con
 * `c:` minúscula. Vite normaliza los ids de módulo contra esa raíz, mientras que el programa de
 * Angular indexa sus archivos con la ruta que devuelve `readConfiguration` (mayúscula). Las dos
 * cadenas apuntan al mismo archivo y NO son iguales, así que la búsqueda en el emisor falla y
 * el plugin reporta "contains Angular decorators but is not in the TypeScript program" — un
 * mensaje que manda a revisar el `include` del tsconfig, donde no está el problema.
 *
 * ⚠️ Lo que esto costó: la correlación con el paralelismo era CASUAL. Todas las corridas
 * directas (que pasaban) eran en mayúscula y todas las de Nx (que fallaban) en minúscula; medir
 * "en paralelo falla / serializado pasa" daba una respuesta consistente y equivocada. Se cerró
 * cruzando las dos variables en una tabla, no probando una sola.
 */
export function raizCanonica(dir: string): string {
  return resolve(dir).replace(/^([a-z]):/, (_, unidad: string) => `${unidad.toUpperCase()}:`);
}

/**
 * Lo que TODOS los `vitest.config.ts` del monorepo necesitan de la resolución de módulos,
 * en un solo lugar.
 *
 * ── Por qué esto no puede ser `tsconfigPaths()` a secas ──────────────────────────────────────
 * Tres trampas, las tres medidas el 2026-09-17 contra este repo, y cada una produce el MISMO
 * síntoma inútil: `Cannot find package '@megadulces/…'`.
 *
 *  1. ⚠️ **El `root` tiene que ser la raíz del workspace.** Por default el plugin busca un
 *     `tsconfig.json` en el root de Vite —que es el directorio del proyecto—, y `apps/api` NO
 *     TIENE uno: sólo `tsconfig.app.json`, `tsconfig.build.json` y `tsconfig.spec.json`. Ahí
 *     se resolvían cero alias.
 *
 *  2. ⛔ **El plugin sólo busca archivos llamados `tsconfig.json` / `jsconfig.json`.** Los
 *     `tsconfig.spec.json` quedaban invisibles, y como cada tsconfig sólo mapea los archivos
 *     que su `include` cubre, los alias funcionaban dentro del código de producción y fallaban
 *     **sólo dentro de los `.spec.ts`**. Eso es peor que fallar entero: `auth.controller.spec.ts`
 *     pasaba (importa platform-core de forma indirecta, vía un archivo cubierto por
 *     `tsconfig.app.json`) y `auth.service.spec.ts` no, que lo importa directo.
 *
 *  3. Apuntar `projects` al `tsconfig.spec.json` del proyecto tampoco alcanza: ese archivo
 *     incluye sólo los `*.spec.ts`, así que los alias DENTRO del código que el spec importa
 *     se quedarían sin mapear. Se necesitan los dos lados.
 *
 * ── Por qué vive acá y no copiado en cada config ────────────────────────────────────────────
 * Son siete proyectos. Un detalle así, repetido siete veces, diverge en la primera prisa — y
 * la forma de divergir es que en un proyecto los tests dejen de ver una librería, con un
 * mensaje que no menciona nada de esto. Misma razón por la que los alias viven una sola vez en
 * `tsconfig.base.json` y no en cada proyecto.
 */
export function aliasDeTsconfig(dirDelProyecto: string) {
  return tsconfigPaths({
    root: resolve(dirDelProyecto, '../..'),
    configNames: ['tsconfig.json', 'tsconfig.spec.json', 'tsconfig.app.json', 'tsconfig.lib.json'],
    // El crawl recorre el workspace entero. Estas carpetas no tienen código que los tests
    // importen y sí tienen mucho archivo: sacarlas es puro tiempo de arranque.
    skip: (dir) => ['dist', 'coverage', 'tmp', '.nx', '.angular', '_imported', 'database'].includes(dir),
  });
}
