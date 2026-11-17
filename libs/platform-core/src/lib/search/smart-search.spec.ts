import { smartSearchRank } from './smart-search';

/**
 * `[BU.5.1]` La calificación de coincidencia para ORDENAR. ⚠️ Prueba de forma: la regex se ejerció contra
 * prod (sólo lectura, Canindo, 2026-11-17): «el rey» pasó de 1 a 12 productos El Rey entre los 12
 * primeros, «rey» dejó de traer REYMA arriba y «reyma», «mazapan» y «gomitas» quedaron igual.
 */
describe('[BU.5.1] smartSearchRank', () => {
  const opts = { columns: ['v.name', 'v.sku'], ignore: ['el', 'de'] };

  it('sin texto o sin columnas válidas: null (el caller ordena como siempre)', () => {
    expect(smartSearchRank('  ', opts)).toBeNull();
    expect(smartSearchRank('rey', { columns: ['v.name; drop table x'] })).toBeNull();
  });

  it('nivel 0 = la frase TAL CUAL, con las palabras de relleno, en palabras completas', () => {
    const r = smartSearchRank('El  Rey', opts)!;
    expect(r.bindings[0]).toBe('\\mel\\s+rey\\M');
  });

  it('niveles 1 y 2 = cada palabra útil completa, y después al inicio de palabra (sin el relleno)', () => {
    const r = smartSearchRank('vaso el rey', opts)!;
    expect(r.bindings.slice(1)).toEqual(['\\mvaso\\M', '\\mrey\\M', '\\mvaso', '\\mrey']);
    expect(r.sql.match(/~ \?/g)).toHaveLength(1 + 2 + 2);
  });

  it('acentos y mayúsculas se normalizan como el filtro; los caracteres de regex se escapan', () => {
    const r = smartSearchRank('Mazapán (1.5)', opts)!;
    expect(r.bindings[0]).toBe('\\mmazapan\\s+\\(1\\.5\\)\\M');
  });

  it('sólo palabras de relleno: no se quedan sin palabras, se califican con ellas', () => {
    const r = smartSearchRank('el', opts)!;
    expect(r.bindings).toEqual(['\\mel\\M', '\\mel\\M', '\\mel']);
  });
});
