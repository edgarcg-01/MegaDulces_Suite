import { parseFolioBuscado } from './commercial-tickets.service';

/**
 * Candado del parseo del folio (Fase TK.1).
 *
 * ⚠️ **Existe por un fallo real, encontrado probando la pantalla.** Se tecleó
 * `05UD10050006440` —la identidad del ticket, sin el guion— y la pantalla contestó
 * *"Ningún documento con ese folio · Revisa el número"* sobre un folio que estaba **bien**.
 *
 * Y no fue sólo que no lo reconociera: al no calzar el molde, caía al camino de "folio suelto",
 * le arrancaba las letras y terminaba buscando **`0510050006440`**, un número que no existe en
 * ninguna sucursal. O sea que el bug fabricaba una búsqueda que nadie pidió y después culpaba a
 * quien preguntaba.
 *
 * Por eso el parseo vive en una función PURA y exportada, y por eso tiene test: es la puerta de
 * entrada del módulo, y lo que entra por ahí es texto tecleado por una persona con un cliente
 * enfrente esperando su ticket.
 */
describe('parseFolioBuscado — identidad completa', () => {
  const ESPERADO = { sucursal: '05', docPrefix: 'UD1005' };

  /** EL caso que falló en pantalla. Si esto se vuelve a romper, se rompió lo mismo. */
  it('reconoce la identidad SIN guion (el fallo que originó este candado)', () => {
    const r = parseFolioBuscado('05UD10050006440');
    expect(r.identidad).toMatchObject(ESPERADO);
    expect(r.identidad?.folios).toContain('0006440');
  });

  it('reconoce la identidad CON guion', () => {
    const r = parseFolioBuscado('05UD1005-0006440');
    expect(r.identidad).toMatchObject(ESPERADO);
    expect(r.identidad?.folios).toContain('0006440');
  });

  it('reconoce la identidad con el folio sin los ceros a la izquierda', () => {
    // Kepler lo guarda a 7 posiciones; la gente dicta "el seis mil cuatrocientos cuarenta".
    for (const t of ['05UD1005-6440', '05UD10056440']) {
      expect(parseFolioBuscado(t).identidad?.folios).toContain('0006440');
    }
  });

  it('tolera minúsculas y espacios pegados al copiar de un PDF', () => {
    const r = parseFolioBuscado('  05ud1005 - 0006440 ');
    expect(r.identidad).toMatchObject(ESPERADO);
    expect(r.identidad?.folios).toContain('0006440');
  });

  /**
   * ⛔ La regresión concreta: NUNCA volver a fabricar un folio arrancándole las letras a una
   * identidad. Ese número no lo tecleó nadie y no existe en ninguna plaza.
   */
  it('no inventa el folio basura que buscaba la version rota', () => {
    for (const t of ['05UD10050006440', '05UD1005-0006440']) {
      const r = parseFolioBuscado(t);
      expect(r.folios).not.toContain('0510050006440');
      expect(r.folios).not.toContain('510050006440');
    }
  });

  it('con identidad del ERP no se buscan pedidos propios', () => {
    expect(parseFolioBuscado('05UD10050006440').code).toBeNull();
  });
});

describe('parseFolioBuscado — folio suelto', () => {
  it('prueba el numero tal cual y relleno a 7 posiciones', () => {
    const r = parseFolioBuscado('6440');
    expect(r.identidad).toBeNull();
    expect(r.folios).toEqual(expect.arrayContaining(['6440', '0006440']));
  });

  it('acepta el folio ya con sus ceros', () => {
    expect(parseFolioBuscado('0006440').folios).toEqual(expect.arrayContaining(['0006440', '6440']));
  });

  /**
   * Texto con letras que NO calzó con ninguna forma conocida: se busca TAL CUAL. Quitarle las
   * letras es lo que fabricaba el folio fantasma — mejor no encontrar nada que encontrar el
   * documento equivocado.
   */
  it('no le arranca las letras a un texto que no reconoce', () => {
    expect(parseFolioBuscado('ABC-123').folios).toEqual(['ABC-123']);
  });
});

describe('parseFolioBuscado — pedidos de la plataforma', () => {
  it('reconoce PD-YYYY-NNNNN', () => {
    const r = parseFolioBuscado('pd-2026-00012');
    expect(r.code).toBe('PD-2026-00012');
    expect(r.identidad).toBeNull();
  });
});

describe('parseFolioBuscado — vacío', () => {
  it('no devuelve nada que buscar', () => {
    for (const t of ['', '   ', null as unknown as string, undefined as unknown as string]) {
      const r = parseFolioBuscado(t);
      expect(r.crudo).toBe('');
      expect(r.folios).toEqual([]);
      expect(r.identidad).toBeNull();
      expect(r.code).toBeNull();
    }
  });
});
