import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[MS.3.9]` Todo ícono `pi-*` que usa la Mesa de Servicio EXISTE en la fuente de íconos.
 *
 * Un nombre que no existe (`pi-life-ring`, `pi-hand-pointer` — los dos se colaron) no da error, ni aviso,
 * ni falla el build: el `<i>` mide 0 px de ancho y el botón se ve sin ícono. Sólo se descubre abriendo la
 * pantalla, que es justo lo que ninguna otra prueba hace. Por eso se lee el CSS REAL de primeicons.
 */
const RAIZ = join(__dirname);
const CSS = readFileSync(join(__dirname, '../../../../../../node_modules/primeicons/primeicons.css'), 'utf8');
/** Clases `pi-*` que NO son glifos (animaciones/utilidades de PrimeIcons). */
const NO_GLIFO = new Set(['pi-spin']);

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return archivos(p);
    return /\.(ts|html)$/.test(f) && !/\.spec\.ts$/.test(f) ? [p] : [];
  });
}

describe('[MS.3.9] íconos de la Mesa de Servicio', () => {
  const usados = new Map<string, string>();
  for (const f of [...archivos(RAIZ), join(__dirname, '../dashboard/layout/layout.component.html')]) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\bpi-[a-z0-9-]+/g)) if (!usados.has(m[0])) usados.set(m[0], f);
  }

  it('hay íconos que revisar (la prueba no es vacua)', () => {
    expect(usados.size).toBeGreaterThan(10);
  });

  it('⭐ cada uno existe en primeicons.css', () => {
    const faltan = [...usados].filter(([ic]) => !NO_GLIFO.has(ic) && !new RegExp(`\\.${ic}:{1,2}before`).test(CSS)).map(([ic, f]) => `${ic} (${f.split(/[\\/]/).pop()})`);
    expect(faltan).toEqual([]);
  });

  it('NEGATIVA: el detector SÍ marca un nombre inventado', () => {
    expect(new RegExp('\\.pi-life-ring:{1,2}before').test(CSS)).toBe(false);
    expect(new RegExp('\\.pi-ticket:{1,2}before').test(CSS)).toBe(true);
  });
});
