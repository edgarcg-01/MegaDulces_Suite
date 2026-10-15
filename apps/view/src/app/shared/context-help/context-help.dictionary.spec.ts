import { CONTEXT_HELP } from './context-help.dictionary';

/**
 * `[VAC.U15]` La ayuda del verificador cubre lo que la tarjeta muestra y no es obvio.
 *
 * El diccionario es la FUENTE ÚNICA de estos textos (DESIGN §P): la pantalla no redacta
 * descripciones ad hoc. Si una regla de la tarjeta gana un aviso y nadie lo documenta, la persona
 * del mostrador lo ve y no sabe qué hacer con él; esto es el candado de que no se quede sin su
 * entrada.
 */
describe('[VAC.U15] ayuda del verificador', () => {
  const topic = CONTEXT_HELP['verificador'];
  const terminos = topic.groups!.flatMap((g) => g.entries.map((e) => e.term));

  it('existe y toda entrada trae término y definición no vacíos', () => {
    expect(topic).toBeDefined();
    for (const g of topic.groups!) {
      expect(g.heading.trim()).not.toBe('');
      for (const e of g.entries) {
        expect(e.term.trim(), `término vacío en "${g.heading}"`).not.toBe('');
        expect(e.def.trim().length, `definición corta en "${e.term}"`).toBeGreaterThan(20);
      }
    }
  });

  it('no repite términos (dos definiciones del mismo concepto se contradicen tarde o temprano)', () => {
    expect(new Set(terminos).size).toBe(terminos.length);
  });

  it.each([
    'Precio por mayoreo',
    'Ahorras $X por unidad',
    'Equivale a N piezas',
    'Este precio acaba de cambiar',
    'Ese código está en N productos',
    'Precios distintos entre plazas',
    'El código que escaneaste es de [unidad]',
    'Modo kiosco',
    'Escanear con la cámara',
  ])('documenta "%s"', (termino) => {
    expect(terminos).toContain(termino);
  });

  it('lo que dice del modo kiosco coincide con lo que la pantalla hace (el aviso de cambio no se muestra)', () => {
    const def = topic.groups!.flatMap((g) => g.entries).find((e) => e.term === 'Este precio acaba de cambiar')!.def;
    expect(def).toMatch(/modo kiosco[^.]*no se muestra/i);
  });
});
