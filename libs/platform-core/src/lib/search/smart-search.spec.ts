import { applySmartSearch, corregirConVocabulario, distanciaEdicion, particionesDePalabra, similitudTrigramas, smartSearchRank } from './smart-search';

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
  // Las cuentas son las de Canindo (catálogo y padrón), medidas el 2026-11-17.
  const vocab = new Map<string, number>([
    ['gomitas', 72], ['gomas', 10], ['mazapan', 41], ['mazapantito', 1], ['bubbaloo', 20], ['bubbalo', 2], ['chamoy', 112],
    ['el', 300], ['rey', 30], ['reyma', 25], ['vaso', 80], ['es', 5], ['galleta', 8], ['marias', 6],
    ['maria', 111], ['mara', 1], ['abarrotes', 686], ['abarotes', 4], ['lupita', 40], ['ortiz', 18],
  ]);
  it('la distancia de edición cuenta el volteo de dos letras como UN cambio', () => {
    expect(distanciaEdicion('marai', 'maria')).toBe(1);
    expect(distanciaEdicion('gomtas', 'gomitas')).toBe(1);
    expect(distanciaEdicion('bubaloo', 'bubbalo')).toBe(2);
    expect(distanciaEdicion('abc', 'abcdefgh', 3)).toBe(4);
  });
  it('corrige cada palabra mal escrita; en empate gana la más común', () => {
    expect(corregirConVocabulario('Gomtas', vocab)).toBe('gomitas');
    expect(corregirConVocabulario('bubaloo chamoyy', vocab)).toBe('bubbaloo chamoy');
    expect(corregirConVocabulario('marai', vocab)).toBe('maria');
    expect(corregirConVocabulario('ortis', vocab)).toBe('ortiz');
  });
  it('una palabra que existe pero es variante RARA de otra 10 veces más común se corrige', () => {
    expect(corregirConVocabulario('abarotes lupita', vocab)).toBe('abarrotes lupita');
    expect(corregirConVocabulario('gomas', vocab)).toBeNull(); // 10 contra 72, pero a 2 cambios: se queda
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

/**
 * `[MCP.28]` `wholeWordUpTo`: una palabra corta coincide COMPLETA. Prueba de forma (el SQL que se arma);
 * la regex `\m…\M` es la misma que ya ejerce `smartSearchRank` contra Postgres.
 */
describe('[MCP.28] applySmartSearch · wholeWordUpTo', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const knex = require('knex')({ client: 'pg' });
  const armar = (q: string, wholeWordUpTo?: number) => {
    const qb = knex('t');
    applySmartSearch(qb, q, { columns: ['t.code', 't.name'], fuzzy: false, ...(wholeWordUpTo ? { wholeWordUpTo } : {}) });
    return qb.toSQL().toNative() as { sql: string; bindings: unknown[] };
  };

  it('sin la opción: todo como pedazo (el comportamiento de siempre no cambia)', () => {
    const r = armar('ruta 4');
    expect(r.bindings).toEqual(['%ruta%', '%4%']);
    expect(r.sql).not.toContain('~');
  });

  it('con la opción: «4» como palabra completa; «ruta» sigue como pedazo', () => {
    const r = armar('ruta 4', 2);
    expect(r.bindings).toEqual(['%ruta%', '\\m4\\M']);
    expect(r.sql).toContain(' ~ $2');
  });

  it('el límite es inclusivo', () => {
    expect(armar('pd', 2).bindings).toEqual(['\\mpd\\M']);
    expect(armar('pdx', 2).bindings).toEqual(['%pdx%']);
  });

  it('negativa: una palabra corta con signo («#4», «4.») va como pedazo — completa no podría pegar nunca', () => {
    expect(armar('#4', 2).bindings).toEqual(['%#4%']);
    expect(armar('lupita 4.', 2).bindings).toEqual(['%lupita%', '%4.%']);
  });
});
