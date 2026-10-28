import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PALETA_DOCUMENTO, TOKEN_DE, contraste } from './paleta-documento';

/**
 * `[E.29]` La paleta del papel no se desfasa de los tokens, y cada rol de TEXTO cumple AA (4.5:1)
 * sobre los fondos donde se usa. Si alguien cambia `tokens.css`, esto se pone rojo.
 */
const css = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'libs', 'design-tokens', 'tokens.css'), 'utf8')
  // Un comentario con llaves («.operations-shell { --row-h: … }») partía los bloques del primer instrumento.
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** Valor en MODO CLARO: la primera definición fuera de `body.theme-monochrome`, resolviendo var(). */
function claro(token: string, visto = new Set<string>()): string {
  const sinOscuro = css.replace(/body\.theme-monochrome\s*\{[^}]*\}/g, '');
  const m = new RegExp(`(?:^|[;{\\s])${token.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+);`, 'm').exec(sinOscuro);
  if (!m) throw new Error(`${token} no está en tokens.css`);
  const v = m[1].trim();
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref && !visto.has(ref[1])) return claro(ref[1], new Set([...visto, token]));
  return v.toUpperCase();
}

const valorDe = (ruta: string): string =>
  ruta.split('.').reduce((o: any, k) => o[k], PALETA_DOCUMENTO) as string;

describe('[E.29] paleta de documentos', () => {
  it('CONTROL del instrumento: lee valores conocidos de tokens.css', () => {
    // [AUD.4] La acción en claro es #C8401A; la marca (--brand-700) sigue siendo el sunset.
    expect(claro('--action')).toBe('#C8401A');
    expect(claro('--brand-700')).toBe('#F05A28');
    expect(claro('--card-bg')).toBe('#FFFFFF');
    expect(() => claro('--no-existe-xyz')).toThrow();
    expect(contraste('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
  });

  it('cada color es el de su token en modo claro', () => {
    for (const [ruta, token] of Object.entries(TOKEN_DE)) {
      expect({ ruta, valor: valorDe(ruta) }).toEqual({ ruta, valor: claro(token) });
    }
  });

  it('cada rol de TEXTO cumple 4.5:1 sobre los fondos donde va', () => {
    const P = PALETA_DOCUMENTO;
    const fondos = [P.blanco, P.fondoSuave, P.encabezado];
    for (const texto of [P.tinta, P.tintaSecundaria, P.marcaTexto]) {
      for (const fondo of fondos) expect({ texto, fondo, ok: contraste(texto, fondo) >= 4.5 }).toMatchObject({ ok: true });
    }
    for (const e of Object.values(P.estado)) {
      expect({ e, ok: contraste(e.fg, e.bg) >= 4.5 && contraste(e.fg, P.blanco) >= 4.5 }).toMatchObject({ ok: true });
    }
  });

  it('NEGATIVO: la marca como texto chico NO cumple — por eso existe marcaTexto', () => {
    expect(contraste(PALETA_DOCUMENTO.marca, PALETA_DOCUMENTO.blanco)).toBeLessThan(4.5);
    expect(contraste(PALETA_DOCUMENTO.blanco, PALETA_DOCUMENTO.marca)).toBeLessThan(4.5);
  });
});
