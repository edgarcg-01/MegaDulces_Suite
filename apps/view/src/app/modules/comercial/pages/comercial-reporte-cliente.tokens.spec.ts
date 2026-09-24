import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[TK.9]` — Ninguna pantalla pinta con una variable que NO EXISTE.
 *
 * ⛔ El defecto que lo motiva, medido el 2026-09-24 sobre `main`: estas dos pantallas
 * usaban `--text-1`, `--text-2`, `--text-3` y `--page-bg`, **17 veces**, y esas cuatro
 * variables no están definidas en ningún archivo del repo.
 *
 * Y no falla ruidosamente: un `color: var(--inexistente)` es un valor inválido, así que
 * la propiedad queda SIN VALOR y el texto **hereda el color principal**. O sea que toda
 * la jerarquía de texto secundario —migaja, subtítulos, encabezados de tabla, notas—
 * se veía al mismo peso que el contenido. La pantalla compila, las pruebas pasan, el
 * `tsc` da cero: sólo se ve abriéndola, y esta pantalla nunca se abrió.
 *
 * ⚠️ Este candado cubre los archivos de Tickets, no el repo entero: al 2026-09-24
 * quedan 13 usos más en `finanzas-cartera` (11), `tienda-arqueo-historial` (1) y
 * `logistica-rastreo` (1). Son de otras áreas y se declaran acá para que nadie los lea
 * como inexistentes — ampliar el alcance es de sus dueños, no de este PR.
 */

const TOKENS = readFileSync(
  join(__dirname, '../../../../../../../libs/design-tokens/tokens.css'), 'utf8',
);

/** Toda `--x:` declarada en la hoja de tokens, sin importar bajo qué selector. */
const definidas = new Set(
  [...TOKENS.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1].toLowerCase()),
);

const PANTALLAS = ['comercial-reporte-cliente.component.ts', 'comercial-tickets.component.ts'];

describe('TK.9 · las variables de color existen de verdad', () => {
  it('la hoja de tokens se leyó (si no, este candado sería un no-op que pasa siempre)', () => {
    expect(definidas.size).toBeGreaterThan(50);
    expect(definidas.has('--action')).toBe(true);
  });

  for (const archivo of PANTALLAS) {
    it(`${archivo} no usa ninguna variable sin definir`, () => {
      const src = readFileSync(join(__dirname, archivo), 'utf8');
      const huerfanas = [...src.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,[^)]*)?\)/gi)]
        // Con fallback (`var(--x, #fff)`) no queda sin valor: no es el defecto que se persigue.
        .filter((m) => !m[2])
        .map((m) => m[1].toLowerCase())
        .filter((v) => !definidas.has(v));
      expect([...new Set(huerfanas)]).toEqual([]);
    });
  }

  /** Prueba negativa: sin esto, el candado podría estar midiendo el aire. */
  it('PRUEBA NEGATIVA: detecta una variable inventada', () => {
    const falso = 'color: var(--text-3); background: var(--card-bg);';
    const huerfanas = [...falso.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,[^)]*)?\)/gi)]
      .filter((m) => !m[2])
      .map((m) => m[1].toLowerCase())
      .filter((v) => !definidas.has(v));
    expect(huerfanas).toEqual(['--text-3']);
  });
});
