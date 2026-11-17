import { corregirConVocabulario, particionesDePalabra, similitudTrigramas, smartSearchRank } from './smart-search';

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

/**
 * `[BU.6.1]` «¿Quisiste decir…?». Los parecidos son los que dio `similarity()` de pg_trgm en prod (2026-11-17);
 * con el vocabulario real de Canindo (4,510 palabras) la corrección tardó 9–17 ms en memoria.
 */
describe('[BU.6.1] corregirConVocabulario', () => {
  it('el parecido reproduce a pg_trgm', () => {
    expect(similitudTrigramas('gomitas', 'gomtas').toFixed(2)).toBe('0.50');
    expect(similitudTrigramas('mazapan', 'mazapna').toFixed(2)).toBe('0.45');
    expect(similitudTrigramas('bubbaloo', 'bubaloo').toFixed(2)).toBe('0.70');
    expect(similitudTrigramas('chamoy', 'chamoyy').toFixed(2)).toBe('0.67');
  });
  const vocab = new Set(['gomitas', 'gomas', 'mazapan', 'mazapantito', 'bubbaloo', 'chamoy', 'el', 'rey', 'reyma', 'vaso', 'es', 'galleta', 'marias']);
  it('corrige cada palabra mal escrita con la más parecida del vocabulario', () => {
    expect(corregirConVocabulario('Gomtas', vocab)).toBe('gomitas');
    expect(corregirConVocabulario('bubaloo chamoyy', vocab)).toBe('bubbaloo chamoy');
  });
  it('separa lo pegado sólo si no hay parecida («elrey» → «el rey»), y un plural no se parte', () => {
    expect(corregirConVocabulario('elrey', vocab)).toBe('el rey');
    expect(corregirConVocabulario('mazapanes', vocab)).toBe('mazapan');
  });
  it('lo que ya existe, los códigos y lo que no se parece a nada: null', () => {
    expect(corregirConVocabulario('vaso el rey', vocab)).toBeNull();
    expect(corregirConVocabulario('7500533001091', vocab)).toBeNull();
    expect(corregirConVocabulario('xyzqw', vocab)).toBeNull();
    expect(corregirConVocabulario('', vocab)).toBeNull();
  });
  it('particiones: mitades de 2 letras o más, sólo en palabras de 5 letras o más', () => {
    expect(particionesDePalabra('elrey')).toEqual([['el', 'rey'], ['elr', 'ey']]);
    expect(particionesDePalabra('rey')).toEqual([]);
  });
});
