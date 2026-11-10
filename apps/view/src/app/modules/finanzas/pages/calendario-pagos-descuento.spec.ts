import { cuenta, cubiertoDe, faltaDescuento, faltaLista, leerPesos, lineasDe, pctDeTasa, pesosDeTexto, prontoCapturado, round2, tasaDePct } from './calendario-pagos-descuento';

/**
 * `[PGP.91]` La cuenta del descuento al pagar que ve la persona ANTES de guardar. Las cifras de
 * control son las de #482: 3 % de $38,880 = $1,166.40 y se transfieren $37,713.60; $5,000 en pesos
 * son 12.86 %. ⛔ Sin globals de 'vitest' importados: en esta suite un import así deja el archivo
 * en cero pruebas sin ponerse rojo.
 */
describe('[PGP.91] tasaDePct: el % tecleado a fracción', () => {
  it('lee «3», «3.5», «3,5» y «3 %»; «3,5» NO es 35 (el error de leerlo con numero())', () => {
    expect(tasaDePct('3')).toBe(0.03);
    expect(tasaDePct('3.5')).toBe(0.035);
    expect(tasaDePct('3,5')).toBe(0.035);
    expect(tasaDePct(' 3 % ')).toBe(0.03);
  });
  it('lo que no es un número mayor que cero no es una tasa', () => {
    for (const t of ['', '0', '-3', 'tres', '1,166.40', null, undefined]) expect(tasaDePct(t as string), String(t)).toBeNull();
  });
  it('se queda en 6 decimales (cabe en numeric(9,6), como redondea el servidor)', () => {
    expect(tasaDePct('12.857142')).toBe(0.128571);
  });
});

describe('[PGP.91] cuenta: factura − descuento = se transfieren', () => {
  it('⭐ 3 % de $38,880 = $1,166.40 y se transfieren $37,713.60', () => {
    expect(cuenta(38880, 'tasa', '3', 0)).toEqual({ tasa: 0.03, descuento: 1166.4, neto: 37713.6 });
  });
  it('⭐ $5,000 en pesos sobre $38,880 son 12.86 % (la tasa sólo se muestra)', () => {
    const c = cuenta(38880, 'pesos', '', 5000);
    expect(c.descuento).toBe(5000);
    expect(c.neto).toBe(33880);
    expect((c.tasa! * 100).toFixed(2)).toBe('12.86');
  });
  it('en modo % se ignoran los pesos, y en modo pesos se ignora el %', () => {
    expect(cuenta(1000, 'tasa', '2', 999).descuento).toBe(20);
    expect(cuenta(1000, 'pesos', '50', 30).descuento).toBe(30);
  });
  it('pesos negativos o vacíos no descuentan (no se suma lo que se resta)', () => {
    expect(cuenta(1000, 'pesos', '', -5)).toEqual({ tasa: null, descuento: 0, neto: 1000 });
    expect(cuenta(1000, 'pesos', '', 0)).toEqual({ tasa: null, descuento: 0, neto: 1000 });
  });
  it('⛔ cuadra con la regla del servidor en todo el barrido: |round2(tasa × cubierto) − descuento| ≤ 0.01 y neto + descuento = cubierto', () => {
    for (const cub of [1, 99.99, 1234.56, 38880, 149640.17]) {
      for (const p of ['0.5', '1', '2', '2,5', '3', '3.5', '7.41', '12.86', '33.333']) {
        const c = cuenta(cub, 'tasa', p, 0);
        expect(Math.abs(round2(c.tasa! * cub) - c.descuento), `${p} % de ${cub}`).toBeLessThanOrEqual(0.01);
        expect(round2(c.neto + c.descuento), `${p} % de ${cub}`).toBe(round2(cub));
      }
    }
  });
});

describe('[PGP.91] faltaDescuento: por qué todavía no se guarda', () => {
  const cub = 38880;
  it('con motivo y % válidos, se puede', () => {
    expect(faltaDescuento('pronto_pago', cuenta(cub, 'tasa', '3', 0), cub, '')).toBeNull();
    expect(faltaDescuento('volumen', cuenta(cub, 'pesos', '', 5000), cub, '')).toBeNull();
  });
  it('⛔ 100 % o más es inválido (no hay pago que programar)', () => {
    expect(faltaDescuento('volumen', cuenta(cub, 'tasa', '100', 0), cub, '')).toMatch(/menor que lo que este pago cubre/);
    expect(faltaDescuento('volumen', cuenta(cub, 'tasa', '150', 0), cub, '')).toMatch(/menor que lo que este pago cubre/);
    expect(faltaDescuento('volumen', cuenta(cub, 'pesos', '', 38880), cub, '')).toMatch(/menor que lo que este pago cubre/);
  });
  it('⛔ sin importe no hay descuento; sin motivo tampoco', () => {
    expect(faltaDescuento('volumen', cuenta(cub, 'tasa', '', 0), cub, '')).toMatch(/Captura el %/);
    expect(faltaDescuento('ninguno', cuenta(cub, 'tasa', '', 0), cub, '')).toMatch(/Elige el motivo/);
    expect(faltaDescuento('ninguno', cuenta(cub, 'tasa', '3', 0), cub, '')).toMatch(/Elige el motivo/);
  });
  it('⛔ «Otro» sin detalle no se guarda (el servidor lo rechaza igual)', () => {
    expect(faltaDescuento('otro', cuenta(cub, 'tasa', '3', 0), cub, '   ')).toMatch(/Falta el detalle/);
    expect(faltaDescuento('otro', cuenta(cub, 'tasa', '3', 0), cub, 'apoyo de aniversario')).toBeNull();
  });
});

describe('[PGP.91] lo guardado se reabre como se capturó', () => {
  it('pctDeTasa devuelve el % que se tecleó, y su vuelta da la misma cuenta', () => {
    expect(pctDeTasa(0.03)).toBe('3');
    expect(pctDeTasa('0.035000')).toBe('3.5');
    expect(pctDeTasa(0.1286)).toBe('12.86');
    expect(pctDeTasa(null)).toBe('');
    expect(cuenta(38880, 'tasa', pctDeTasa(0.03), 0).descuento).toBe(1166.4);
  });
  it('cubiertoDe suma neto + descuento aunque lleguen como texto (numeric de Postgres)', () => {
    expect(cubiertoDe({ applied_amount: '37713.60', discount_amount: '1166.40' })).toBe(38880);
    expect(cubiertoDe({ applied_amount: 1000, discount_amount: null })).toBe(1000);
  });
});

describe('[PGP.91] pesosDeTexto: los pesos tecleados, sin adivinar', () => {
  // La factura de control: con numero() «1166,40» se leía como $116,640, cabía en $149,640.17 y se guardaba.
  const cub = 149640.17;
  const falta = (txt: string) => {
    const l = leerPesos(txt);
    return faltaDescuento('volumen', cuenta(cub, 'pesos', '', l.pesos ?? 0), cub, '', l.error);
  };
  it('⛔ «1166,40» es ambiguo: no se lee como 116640 ni como 1166.40, se pide el punto', () => {
    expect(pesosDeTexto('1166,40')).toBeNull();
    expect(falta('1166,40')).toBe('Escribe los centavos con punto (1,166.40).');
  });

  it('⛔ un espacio ENTRE dígitos («1166 40», «1 166.40») no se borra: leería ×100', () => {
    expect(pesosDeTexto('1166 40')).toBeNull();
    expect(pesosDeTexto('1 166.40')).toBeNull();
    expect(falta('1166 40')).toBe('Ese importe no se entiende.');
    // Control: los espacios de las orillas y el que va después del «$» sí se toleran.
    expect(pesosDeTexto('  1,166.40 ')).toBe(1166.4);
    expect(pesosDeTexto('$ 1,166.40')).toBe(1166.4);
  });
  it('⭐ «1,166.40» son $1,166.40 sobre $149,640.17: se transfieren $148,473.77 y se puede guardar', () => {
    expect(pesosDeTexto('1,166.40')).toBe(1166.4);
    expect(cuenta(cub, 'pesos', '', pesosDeTexto('1,166.40')!)).toMatchObject({ descuento: 1166.4, neto: 148473.77 });
    expect(falta('1,166.40')).toBeNull();
  });
  it('liberal con la forma: «$ 1,166.40», «$1,166.40», «1166.40», «1166.4», «1166», «149,640», «1,166»', () => {
    expect(pesosDeTexto('$ 1,166.40')).toBe(1166.4);
    expect(pesosDeTexto('$1,166.40')).toBe(1166.4);
    expect(pesosDeTexto(' 1166.40 ')).toBe(1166.4);
    expect(pesosDeTexto('1166.4')).toBe(1166.4);
    expect(pesosDeTexto('1166')).toBe(1166);
    expect(pesosDeTexto('149,640')).toBe(149640);
    expect(pesosDeTexto('1,166')).toBe(1166);
  });
  it('⛔ coma con 1 o 2 dígitos al final y sin punto («1,16», «12,5», «0,50») es ambiguo', () => {
    for (const t of ['1,16', '12,5', '0,50', '1,166,40']) {
      expect(pesosDeTexto(t), t).toBeNull();
      expect(falta(t), t).toBe('Escribe los centavos con punto (1,166.40).');
    }
  });
  it('⛔ lo que no tiene forma de importe no se entiende: «abc», «-5», «1166.405», «11,66.40», «1.166,40»', () => {
    for (const t of ['abc', '-5', '1166.405', '11,66.40', '1.166,40', '1166,400', ',40', '$', '1..2']) {
      expect(pesosDeTexto(t), t).toBeNull();
      expect(falta(t), t).toBe('Ese importe no se entiende.');
    }
  });
  it('vacío no es un error: es «falta capturar»', () => {
    expect(leerPesos('')).toEqual({ pesos: null, error: null });
    expect(leerPesos('   ')).toEqual({ pesos: null, error: null });
    expect(falta('')).toMatch(/Captura el %/);
  });
  it('el % sigue aceptando «3,5» como 3.5 (en un % no hay miles)', () => {
    expect(tasaDePct('3,5')).toBe(0.035);
  });
});

describe('[PGP.101] varios descuentos por factura', () => {
  it('lineasDe: usa discount_lines; sin ellas arma uno con las columnas de siempre', () => {
    const l = [{ reason: 'volumen' as const, amount: 20, rate: null, note: null }];
    expect(lineasDe({ discount_lines: l, discount_amount: 20, discount_reason: 'volumen' })).toBe(l);
    expect(lineasDe({ discount_amount: '30.00', discount_reason: 'pronto_pago', discount_rate: '0.03' }))
      .toEqual([{ reason: 'pronto_pago', amount: 30, rate: 0.03, note: null }]);
    expect(lineasDe({ discount_amount: 0, discount_reason: null })).toEqual([]);
  });
  it('prontoCapturado: sólo el renglón de pronto pago', () => {
    expect(prontoCapturado({ discount_lines: [
      { reason: 'pronto_pago', amount: 300, rate: 0.03, note: null }, { reason: 'volumen', amount: 200, rate: 0.02, note: null },
    ] })).toBe(300);
    expect(prontoCapturado({ discount_lines: [{ reason: 'volumen', amount: 200, rate: null, note: null }] })).toBe(0);
  });
  it('faltaLista: la suma no puede ser toda la factura y hay tope de renglones', () => {
    const ya = [{ reason: 'volumen' as const, amount: 600, rate: null, note: null }];
    expect(faltaLista(ya, 300, 1000)).toBeNull();
    expect(faltaLista(ya, 400, 1000)).toMatch(/menores/);
    expect(faltaLista(Array(5).fill(ya[0]).map((x) => ({ ...x, amount: 1 })), 1, 1000)).toMatch(/máximo/);
  });
});
