// [PDV.31] Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { abreGavetaAlCobrar, bloqueoPorGaveta, ESC_POS_ESTADO, escPosAbrirGaveta, leerEstadoGaveta, errorEfectivo, esCorreccionInmediata, leerComando, leerImporte, LineaCaja, precioRenglon, totalesCaja } from './caja-motor';

// Los precios son los cobrados en Yurécuaro del 24 al 30 de octubre (prototipo validado con Edgar).
const linea = (p: Partial<LineaCaja>): LineaCaja => ({
  codigo: '0', nombre: 'X', unidad: 'PZA', lista: 0, escalera: [], ivaPct: 0, iepsPct: 0,
  granel: false, cantidad: 1, quitado: null, presentaciones: [], ...p,
});

describe('[PDV.31] caja-motor — precio con escalera de mayoreo', () => {
  const levi = linea({ codigo: '94157', unidad: 'PAQ', lista: 18.5, escalera: [{ desde: 3, precio: 16.68 }], ivaPct: 16 });
  it('debajo del escalón cobra la lista y dice cuánto falta', () => {
    const p = precioRenglon({ ...levi, cantidad: 2 });
    expect(p.precio).toBe(18.5);
    expect(p.siguiente?.desde).toBe(3);
  });
  it('desde el escalón cobra el mayoreo', () => {
    expect(precioRenglon({ ...levi, cantidad: 3 }).precio).toBe(16.68);
  });
  it('varios escalones: gana el más alto alcanzado', () => {
    const cocadaCja = linea({ lista: 653.95, escalera: [{ desde: 10, precio: 642.35 }, { desde: 3, precio: 648.15 }, { desde: 6, precio: 645.25 }] });
    expect(precioRenglon({ ...cocadaCja, cantidad: 7 }).precio).toBe(645.25);
  });
});

describe('[PDV.31] caja-motor — totales con impuestos incluidos', () => {
  // El ticket del prototipo: $220.53, IVA $23.84, IEPS $2.21, ahorro $4.31.
  const ticket: LineaCaja[] = [
    linea({ lista: 18.5, escalera: [{ desde: 3, precio: 16.68 }], ivaPct: 16, cantidad: 2 }),
    linea({ lista: 15.3, escalera: [{ desde: 3, precio: 14.2 }], ivaPct: 16, cantidad: 1 }),
    linea({ lista: 6.55, escalera: [{ desde: 3, precio: 5.97 }], iepsPct: 8, cantidad: 5 }),
    linea({ unidad: 'KG', lista: 63.99, escalera: [{ desde: 3, precio: 59 }], ivaPct: 16, granel: true, cantidad: 1.884 }),
    linea({ lista: 6.41, escalera: [{ desde: 3, precio: 5.94 }], cantidad: 3 }),
  ];
  it('cuadra al centavo con el ticket del prototipo', () => {
    const t = totalesCaja(ticket);
    expect(t).toMatchObject({ total: 220.53, iva: 23.84, ieps: 2.21, ahorro: 4.31, articulos: 12, renglones: 5 });
  });
  it('un renglón quitado no suma, pero sigue en la lista', () => {
    const t = totalesCaja(ticket.map((l, i) => (i === 2 ? { ...l, quitado: { motivo: 'Se escaneó de más', quien: 'Supervisor' } } : l)));
    expect(t.total).toBe(190.68);
    expect(t.renglones).toBe(4);
  });
});

describe('[PDV.31] caja-motor — la línea de comandos', () => {
  it('código, cantidad*código y peso*código', () => {
    expect(leerComando('33061')).toEqual({ tipo: 'codigo', codigo: '33061', cantidad: 1, conCantidad: false });
    expect(leerComando('5*33061')).toEqual({ tipo: 'codigo', codigo: '33061', cantidad: 5, conCantidad: true });
    expect(leerComando('1,884*17083')).toMatchObject({ cantidad: 1.884, codigo: '17083' });
  });
  it('letras = buscar por nombre; vacío y basura se distinguen', () => {
    expect(leerComando('cocada ')).toEqual({ tipo: 'texto', texto: 'cocada' });
    expect(leerComando('  ').tipo).toBe('vacio');
    expect(leerComando('0*33061').tipo).toBe('invalido');
    expect(leerComando('12-4').tipo).toBe('invalido');
  });
});

describe('[PDV.31] caja-motor — el cobro', () => {
  it('lee importes con coma de miles y sin ella', () => {
    expect(leerImporte('1,250.50')).toBe(1250.5);
    expect(leerImporte('$250')).toBe(250);
    expect(leerImporte('25o')).toBeNull();
  });
  it('límite de cambio: un código tecleado como importe se rechaza', () => {
    expect(errorEfectivo(33061, 220.53)).toContain('$1,000');
    expect(errorEfectivo(1000, 220.53)).toBeNull();
    expect(errorEfectivo(1220.53, 220.53)).toContain('$1,000');
  });
  it('corrección inmediata sólo sobre el último renglón y dentro de 15 s', () => {
    expect(esCorreccionInmediata({ indice: 2, en: 1000 }, 2, 15_999)).toBe(true);
    expect(esCorreccionInmediata({ indice: 2, en: 1000 }, 2, 16_000)).toBe(false);
    expect(esCorreccionInmediata({ indice: 2, en: 1000 }, 1, 2000)).toBe(false);
  });
});

describe('[PDV.34] gaveta por ESC/POS', () => {
  it('el pulso y la consulta son los bytes de ESC/POS', () => {
    expect([...escPosAbrirGaveta()]).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa]);
    expect([...escPosAbrirGaveta(1)]).toEqual([0x1b, 0x70, 0x01, 0x19, 0xfa]);
    expect([...ESC_POS_ESTADO]).toEqual([0x10, 0x04, 0x01]);
  });
  it('lee el pin 3 contra el nivel calibrado con la gaveta cerrada', () => {
    // 0x12 = bits fijos, pin 3 bajo · 0x16 = pin 3 alto · 0x1a = fuera de línea, pin bajo
    expect(leerEstadoGaveta(0x12, false)).toBe('cerrada');
    expect(leerEstadoGaveta(0x16, false)).toBe('abierta');
    expect(leerEstadoGaveta(0x16, true)).toBe('cerrada');
    expect(leerEstadoGaveta(0x12, true)).toBe('abierta');
    expect(leerEstadoGaveta(0x1a, false)).toBe('cerrada');
  });
  it('un byte que no es la respuesta de DLE EOT 1 se ignora', () => {
    expect(leerEstadoGaveta(0x00, false)).toBeNull();
    expect(leerEstadoGaveta(0x93, false)).toBeNull();
    expect(leerEstadoGaveta(0x16 | 0x80, false)).toBeNull();
  });
  it('sólo la gaveta ABIERTA bloquea el cobro; sin sensor no se finge cerrada, se declara', () => {
    expect(bloqueoPorGaveta('abierta')).toContain('Cierra la gaveta');
    expect(bloqueoPorGaveta('cerrada')).toBeNull();
    expect(bloqueoPorGaveta('sin_sensor')).toBeNull();
    expect(bloqueoPorGaveta('desconectada')).toBeNull();
  });
  it('se abre al cobrar sólo si hubo efectivo', () => {
    expect(abreGavetaAlCobrar([{ forma: 'Tarjeta' }])).toBe(false);
    expect(abreGavetaAlCobrar([{ forma: 'Tarjeta' }, { forma: 'Efectivo' }])).toBe(true);
    expect(abreGavetaAlCobrar([])).toBe(false);
  });
});
