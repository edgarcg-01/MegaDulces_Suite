import {
  buscarParecidos,
  codigoKepler,
  decidirLiga,
  domicilioLegible,
  normalizarClave,
  parecido,
  tokensSignificativos,
  type HechosLiga,
} from './new-customers-kepler.engine';

/**
 * `[MCP.3.8]` Reglas puras del alta de cliente nuevo y su liga con Kepler.
 * Cada regla importante tiene su caso negativo: la mutación a mano se documenta en el informe.
 */
describe('parecido · frenar duplicados en el alta', () => {
  it('ignora las palabras genéricas: «Abarrotes Lupita» es «Tienda Lupita»', () => {
    expect(parecido('Abarrotes Lupita', 'Tienda Lupita')).toBe(1);
  });

  it('tolera acentos, mayúsculas y signos', () => {
    expect(parecido('ABARROTES  LA ESQUINA', 'abarrotes la esquína.')).toBe(1);
  });

  it('tolera una falta o diminutivo («Esquina» / «Esquinita»)', () => {
    expect(parecido('La Esquina', 'La Esquinita')).toBeGreaterThanOrEqual(0.7);
  });

  it('dos negocios distintos con la misma palabra genérica NO se parecen', () => {
    expect(parecido('Abarrotes Lupita', 'Abarrotes Rosy')).toBeLessThan(0.7);
  });

  it('el nombre vacío no se parece a nada', () => {
    expect(buscarParecidos('   ', [{ name: 'Lupita' }])).toEqual([]);
  });

  it('ordena del más parecido al menos y corta en el máximo', () => {
    const r = buscarParecidos('Abarrotes Lupita', [
      { name: 'Abarrotes Rosy' },
      { name: 'Lupita' },
      { name: 'Miscelánea Lupita Centro' },
      { name: 'Lupe' },
    ]);
    expect(r.map((x) => x.name)).toEqual(['Lupita', 'Miscelánea Lupita Centro']);
    expect(r[0].score).toBe(1);
  });

  it('las palabras que distinguen no incluyen las genéricas', () => {
    expect(tokensSignificativos('Abarrotes La Esquina de Don Pepe')).toEqual(['esquina', 'don', 'pepe']);
  });
});

describe('normalizarClave · la clave como se escribe en Kepler', () => {
  it('quita espacios y pone mayúsculas', () => {
    expect(normalizarClave('  c1087 ')).toBe('C1087');
  });
  it('NO rellena ceros (2 y 00002 son claves distintas)', () => {
    expect(normalizarClave('2')).toBe('2');
  });
  it('rechaza vacío y caracteres raros', () => {
    expect(normalizarClave('')).toBeNull();
    expect(normalizarClave(null)).toBeNull();
    expect(normalizarClave("10'; drop")).toBeNull();
  });
  it('el código del cliente ligado sigue la forma de la sincronización', () => {
    expect(codigoKepler('02', '10281')).toBe('K02-10281');
  });
});

describe('domicilioLegible', () => {
  it('prefiere el domicilio estructurado', () => {
    expect(domicilioLegible({ street: 'Hidalgo 12', neighborhood: 'Centro' }, 'frente a la iglesia')).toBe('Hidalgo 12, Centro');
  });
  it('sin estructurado usa la referencia del vendedor; sin nada, null', () => {
    expect(domicilioLegible(null, ' frente a la iglesia ')).toBe('frente a la iglesia');
    expect(domicilioLegible(null, '')).toBeNull();
  });
});

describe('decidirLiga · cuándo se puede ligar un cliente con su clave', () => {
  const ok: HechosLiga = {
    cliente: { id: 'c1', name: 'ABARROTES LUPITA', erp_customer_code: null, erp_source_branch: null },
    branch: '02',
    enAlcance: true,
    clave: '10281',
    kepler: { nombre: 'ABARROTES LUPITA SA', es_interno: false },
    yaLigadoA: null,
  };

  it('con todo en orden, se liga', () => {
    expect(decidirLiga(ok)).toEqual({ ok: true });
  });

  it('cliente de otra sucursal: no se liga (alcance)', () => {
    const d = decidirLiga({ ...ok, enAlcance: false });
    expect(d).toMatchObject({ ok: false, motivo: 'fuera_de_alcance' });
  });

  it('cliente que no existe', () => {
    expect(decidirLiga({ ...ok, cliente: null })).toMatchObject({ ok: false, motivo: 'no_encontrado' });
  });

  it('ya ligado: no se vuelve a ligar', () => {
    const d = decidirLiga({ ...ok, cliente: { ...ok.cliente!, erp_customer_code: '999', erp_source_branch: '02' } });
    expect(d).toMatchObject({ ok: false, motivo: 'ya_ligado' });
  });

  it('sin sucursal conocida no se sabe dónde buscar la clave', () => {
    expect(decidirLiga({ ...ok, branch: null })).toMatchObject({ ok: false, motivo: 'sin_sucursal' });
  });

  it('clave mal escrita', () => {
    expect(decidirLiga({ ...ok, clave: null })).toMatchObject({ ok: false, motivo: 'clave_invalida' });
  });

  it('clave que no existe en Kepler de esa sucursal: lo dice con la sucursal', () => {
    const d = decidirLiga({ ...ok, kepler: null });
    expect(d).toMatchObject({ ok: false, motivo: 'clave_inexistente' });
    expect(!d.ok && d.mensaje).toContain('sucursal 02');
  });

  it('cuenta interna (la tienda o un vendedor) no es un cliente', () => {
    expect(decidirLiga({ ...ok, kepler: { nombre: 'PADRE HIDALGO PISO', es_interno: true } })).toMatchObject({
      ok: false,
      motivo: 'cuenta_interna',
    });
  });

  it('clave ya ligada a OTRO cliente: duplicado, con su nombre', () => {
    const d = decidirLiga({ ...ok, yaLigadoA: { id: 'c9', name: 'LUPITA (K02-10281)' } });
    expect(d).toMatchObject({ ok: false, motivo: 'duplicado' });
    expect(!d.ok && d.mensaje).toContain('LUPITA (K02-10281)');
  });
});
