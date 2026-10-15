import * as fs from 'fs';
import * as path from 'path';
import { SUCURSAL_CAJA_GENERAL } from '@megadulces/contracts';

/**
 * `[CGP-L.9]` La sucursal del cajón es UNA constante (`SUCURSAL_CAJA_GENERAL`, `libs/contracts`).
 *
 * Había un `'00'` escrito a mano en seis lugares de caja —el alcance del corte, el cajero, los
 * valores por defecto del controlador, el libro— más la pantalla. Dos copias del mismo `'00'`
 * divergen sin que nada avise; esta prueba lo hace: ningún archivo de caja escribe el suyo.
 */
const sinComentarios = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const literal = /['"]00['"]/;

describe('[CGP-L.9] la sucursal del cajón es una sola constante', () => {
  it('es la 00, Oficinas', () => {
    expect(SUCURSAL_CAJA_GENERAL).toBe('00');
  });

  it('⛔ [negativa] el detector ve un 00 escrito a mano, y no uno que sólo está en un comentario', () => {
    expect(literal.test(sinComentarios("if (sucursal === '00') return null;"))).toBe(true);
    expect(literal.test(sinComentarios("// el '00' es oficinas\nconst x = 1;"))).toBe(false);
    expect(literal.test(sinComentarios("/* '00' */ const y = 2;"))).toBe(false);
  });

  it('⛔ ningún archivo de caja escribe su propio 00', () => {
    const culpables = fs.readdirSync(__dirname)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
      .filter((f) => literal.test(sinComentarios(fs.readFileSync(path.join(__dirname, f), 'utf8'))));
    expect(culpables).toEqual([]);
  });
});
