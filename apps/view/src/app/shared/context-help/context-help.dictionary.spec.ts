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

/**
 * `[PGP.7]` **El «about» del Calendario de pagos.**
 *
 * La pantalla absorbió a Pronto pago y quedó como el único lugar donde se hace un pago. Si este
 * tópico desaparece, el botón de ayuda del encabezado queda abriendo nada — y, peor, lo absorbido
 * se queda sin explicación justo donde antes había una pantalla entera para explicarlo.
 *
 * ⛔ Las tres advertencias que se verifican abajo no son decorativas: son las que evitan que
 * alguien lea la ventana de descuento como una promesa del proveedor, trate un «fuera de ventana»
 * como dinero perdido, o lea «sin medir» como «no da descuento».
 */
describe('[PGP.7] el about del Calendario de pagos', () => {
  const topic = CONTEXT_HELP['calendario-de-pagos'];
  const entradas = () => topic.groups!.flatMap((g) => g.entries);

  it('existe y toda entrada trae término y definición con sustancia', () => {
    expect(topic).toBeDefined();
    for (const e of entradas()) {
      expect(e.term.trim()).not.toBe('');
      expect(e.def.trim().length, `definición corta en "${e.term}"`).toBeGreaterThan(20);
    }
  });

  it.each([
    '1 · Armar el día',
    '2 · Preparar',
    '3 · Autorizar el día',
    '4 · Ejecutar y ligar',
  ])('explica el paso "%s" del circuito', (termino) => {
    expect(entradas().map((e) => e.term)).toContain(termino);
  });

  it('dice que la ventana del descuento es OBSERVADA, no pactada', () => {
    const def = entradas().find((e) => e.term.startsWith('Antes del'))!.def;
    expect(def).toMatch(/observada/i);
    expect(def).toMatch(/no pactada|no de una condición acordada/i);
  });

  it('⛔ aclara que «fuera de ventana» NO es «perdido»', () => {
    const def = entradas().find((e) => e.term === 'Fuera de ventana')!.def;
    expect(def).toMatch(/no quiere decir .perdido|NO.*perdido/i);
  });

  it('⛔ aclara que «sin medir» NO es «no da descuento»', () => {
    const def = entradas().find((e) => e.term === 'Sin medir')!.def;
    expect(def).toMatch(/no es lo mismo no saber que saber que no/i);
  });

  it('dice dónde quedó lo que salió del menú, y que las direcciones siguen vivas', () => {
    for (const t of ['Pronto pago (la pantalla)', 'Programa de pagos']) {
      const def = entradas().find((e) => e.term === t)!.def;
      expect(def, t).toMatch(/sigue funcionando si la tenés guardada/i);
    }
  });
});
