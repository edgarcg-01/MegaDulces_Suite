import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `[RD.45.3]` — **La barra de avance del conteo se anima con `transform`, no con `width`.**
 *
 * Animar `width` dispara layout en cada cuadro, y la compuerta de movimiento (`check-motion`) lo
 * cuenta como deuda que no puede crecer: esta barra la subió de 48 a 49 y dejó `main` en rojo.
 * El patrón es el de `MetricCard`: el relleno ocupa el ancho completo y se escala desde la
 * izquierda con `scaleX(var(--fill))`; el radio lo pone el track, que ya recorta.
 *
 * ⚠️ Mismo alcance que `almacen-rutas-contar.freno.spec.ts`: lee el FUENTE del componente,
 * no levanta la pantalla.
 */

const SRC = readFileSync(join(__dirname, 'almacen-rutas-contar.component.ts'), 'utf8');

describe('[RD.45.3] barra de avance del conteo', () => {
  it('el relleno recibe el avance como fracción en --fill, no como ancho', () => {
    expect(SRC).toContain('[style.--fill]="avance() / 100"');
    expect(SRC).not.toContain('[style.width.%]="avance()"');
  });

  it('se escala desde la izquierda y la transición es sobre transform', () => {
    const regla = SRC.match(/\.rk-barra > span \{[^}]*\}/)?.[0] ?? '';
    expect(regla).toContain('transform: scaleX(var(--fill, 0))');
    expect(regla).toContain('transform-origin: left center');
    expect(regla).toContain('transition: transform');
    expect(regla).not.toMatch(/transition:\s*width/);
  });

  it('el track sigue recortando, para que el casquete no se deforme al escalar', () => {
    expect(SRC).toMatch(/\.rk-barra \{[^}]*overflow: hidden/);
  });
});
