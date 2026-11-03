// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import {
  analizarKardex, familiaDeDocumento, recortarKardex, TOPE_RENGLONES_KARDEX, type MovimientoKardex,
} from './kardex-negativo.contract';

let n = 0;
/** Un renglón de kardex; `piezas` con signo. */
function mov(dia: string, doc: string, piezas: number, extra: Partial<MovimientoKardex> = {}): MovimientoKardex {
  n++;
  const venta = doc === 'U-D-10';
  return {
    dia, doc, sub: venta ? 2 : 1, nombre: extra.nombre ?? (venta ? 'Ticket Contado Caja 2' : doc), folio: venta ? null : `F${n}`,
    documentos: 1, piezas, importe: null, unidad: null, factor: null, ...extra,
  };
}

describe('[MX.1.9] familiaDeDocumento — el tipo de Kepler en llano', () => {
  it('nombra los documentos medidos en kdmm', () => {
    expect(familiaDeDocumento('X-A-40')).toBe('compra');
    expect(familiaDeDocumento('U-A-50')).toBe('traspaso_entra');
    expect(familiaDeDocumento('N-A-30')).toBe('conteo');
    expect(familiaDeDocumento('N-D-30')).toBe('conteo');
    expect(familiaDeDocumento('U-D-10')).toBe('venta');
    expect(familiaDeDocumento('U-D-41')).toBe('embarque');
    expect(familiaDeDocumento('X-D-40')).toBe('devolucion_proveedor');
  });
  it('lo no listado cae en «otra» según su naturaleza, no se inventa', () => {
    expect(familiaDeDocumento('N-A-90')).toBe('otra_entrada');
    expect(familiaDeDocumento('N-D-35')).toBe('otra_salida');
  });
});

describe('[MX.1.9] analizarKardex — saldo corrido, cruce y control contra Kepler', () => {
  const k = [
    mov('2026-09-01', 'X-A-40', 10),
    mov('2026-09-02', 'U-D-10', -8),
    mov('2026-09-05', 'U-D-10', -5), // cruza: −3
    mov('2026-09-06', 'X-A-40', 20), // vuelve: 17
    mov('2026-09-10', 'U-D-10', -15), // 2
    mov('2026-09-12', 'U-D-10', -6, { importe: 60 }), // cruza: −4 ← episodio ACTUAL
    mov('2026-09-13', 'U-D-41', -3, { nombre: 'Embarque Sucursal', importe: 30 }), // −7
  ];

  it('el saldo corre renglón por renglón y cuadra con Kepler', () => {
    const a = analizarKardex(k, -7);
    expect(a.renglones.map((r) => r.saldo)).toEqual([10, 2, -3, 17, 2, -4, -7]);
    expect(a.cuadra).toBe(true);
    expect(a.diferencia).toBe(0);
  });

  it('el cruce es el del episodio ACTUAL, no el primero de la historia', () => {
    expect(analizarKardex(k, -7).cruce).toEqual({ dia: '2026-09-12', saldo_antes: 2 });
  });

  it('lo que salió desde el cruce, por documento, de más a menos piezas', () => {
    expect(analizarKardex(k, -7).salidas_desde_cruce).toEqual([
      { nombre: 'Ticket Contado Caja 2', familia: 'venta', piezas: 6, importe: 60, documentos: 1 },
      { nombre: 'Embarque Sucursal', familia: 'embarque', piezas: 3, importe: 30, documentos: 1 },
    ]);
  });

  it('si el kardex NO cuadra con Kepler se declara, y no se calculan cruce ni pistas', () => {
    const a = analizarKardex(k, -1);
    expect(a.cuadra).toBe(false);
    expect(a.diferencia).toBe(-6);
    expect(a.cruce).toBeNull();
    expect(a.pistas).toEqual([]);
    expect(a.salidas_desde_cruce).toEqual([]);
  });

  it('sin negativo al final no hay cruce', () => {
    expect(analizarKardex([mov('2026-09-01', 'X-A-40', 5)], 5).cruce).toBeNull();
  });
});

describe('[MX.1.9] pista «entrada tardía» — estuvo en negativo hasta que entró mercancía', () => {
  it('cuenta los episodios pasados que cerró una entrada de mercancía', () => {
    const a = analizarKardex([
      mov('2026-09-01', 'U-D-10', -2), mov('2026-09-03', 'U-A-50', 5, { nombre: 'Recepción Traspaso Suc', folio: '0000458' }),
      mov('2026-09-05', 'U-D-10', -6),
    ], -3);
    const p = a.pistas.find((x) => x.tipo === 'entrada_tardia');
    expect(p?.texto).toContain('Ya había pasado una vez');
    expect(p?.texto).toContain('Recepción Traspaso Suc 0000458 (+5 pz) lo dejó en 3 pz');
    expect(p?.folio).toBe('0000458');
  });

  it('un CONTEO que saca del negativo no es entrada tardía', () => {
    const a = analizarKardex([
      mov('2026-09-01', 'U-D-10', -2), mov('2026-09-03', 'N-A-30', 5), mov('2026-09-05', 'U-D-10', -6),
    ], -3);
    expect(a.pistas.some((x) => x.tipo === 'entrada_tardia')).toBe(false);
  });
});

describe('[MX.1.9] pista de conteo — dónde empieza la diferencia', () => {
  it('conteo ANTES del cruce: la diferencia está en lo capturado desde entonces', () => {
    const a = analizarKardex([mov('2026-09-01', 'N-A-30', 10), mov('2026-09-05', 'U-D-10', -12)], -2);
    expect(a.pistas).toEqual([expect.objectContaining({ tipo: 'conteo', dia: '2026-09-01' })]);
    expect(a.pistas[0].texto).toContain('cayó a negativo el 5-sep, después');
  });

  it('sin conteo en lo registrado lo dice', () => {
    const a = analizarKardex([mov('2026-09-01', 'X-A-40', 10), mov('2026-09-05', 'U-D-10', -12)], -2);
    expect(a.pistas).toEqual([expect.objectContaining({ tipo: 'sin_conteo' })]);
  });

  it('un conteo que lo deja en negativo: «el conteo no lo corrigió»', () => {
    const a = analizarKardex([mov('2026-09-01', 'U-D-10', -12), mov('2026-09-05', 'N-A-30', 2)], -10);
    expect(a.pistas.find((x) => x.tipo === 'conteo')?.texto).toContain('el conteo no lo corrigió');
  });
});

describe('[MX.1.9] pista de unidad — una caja capturada como pieza (o al revés)', () => {
  /** Ventas normales: 1 pz a $60. */
  const normales = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24']
    .map((d) => mov(d, 'U-D-10', -1, { importe: 60, unidad: 'PZA', factor: 1 }));

  it('CONTROL POSITIVO (44320 en 8 Esquinas): PAQ ×12 descuenta 12 pz al precio de 1 → explica el negativo', () => {
    const malas = ['2026-10-01', '2026-10-03', '2026-10-10', '2026-10-10']
      .map((d) => mov(d, 'U-D-10', -12, { importe: 60, unidad: 'PAQ', factor: 12 }));
    const k = [mov('2026-09-01', 'N-A-30', 50), ...normales, ...malas];
    const existencia = 50 - 5 - 48; // −3
    const a = analizarKardex(k, existencia);
    const p = a.pistas.filter((x) => x.tipo === 'unidad');
    expect(p).toHaveLength(1); // las cuatro repeticiones son UNA pista
    expect(p[0].texto).toContain('4 renglones de venta en PAQ ×12 descontaron 48 pz');
    expect(p[0].texto).toContain('salieron 44 pz de más');
    expect(p[0].texto).toContain('quedaría en 41 pz');
    expect(a.pistas[0].tipo).toBe('unidad'); // va primero
  });

  it('CONTROL NEGATIVO: una venta CARA por pieza (descontó de menos) no explica un negativo → no hay pista', () => {
    const k = [...normales, mov('2026-09-25', 'U-D-10', -1, { importe: 1440, unidad: 'PAQ', factor: 1 }), mov('2026-09-26', 'U-D-10', -4)];
    expect(analizarKardex(k, -10).pistas.some((x) => x.tipo === 'unidad')).toBe(false);
  });

  it('una entrada CARA por pieza (sumó de menos) sí es pista', () => {
    const compras = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05']
      .map((d) => mov(d, 'X-A-40', 10, { importe: 100 }));
    const k = [...compras, mov('2026-08-06', 'X-A-40', 1, { importe: 120, unidad: 'CJA', factor: 1 }), mov('2026-08-07', 'U-D-10', -60)];
    const p = analizarKardex(k, -9).pistas.find((x) => x.tipo === 'unidad');
    expect(p?.texto).toContain('faltaron 11 pz por entrar');
  });

  it('lo anterior al último conteo no cuenta: el conteo ya puso la verdad', () => {
    const mala = mov('2026-09-01', 'U-D-10', -12, { importe: 60, unidad: 'PAQ', factor: 12 });
    const k = [mala, mov('2026-09-02', 'N-A-30', 12), ...normales, mov('2026-09-30', 'U-D-10', -5)];
    expect(analizarKardex(k, -5).pistas.some((x) => x.tipo === 'unidad')).toBe(false);
  });

  it('con menos de 5 renglones con precio en la familia no hay mediana confiable', () => {
    const k = [mov('2026-09-01', 'U-D-10', -1, { importe: 60 }), mov('2026-09-02', 'U-D-10', -12, { importe: 60 })];
    expect(analizarKardex(k, -13).pistas.some((x) => x.tipo === 'unidad')).toBe(false);
  });
});

describe('[MX.1.9] recortarKardex — lo que cabe en el panel', () => {
  it('publica desde poco antes del cruce, con el saldo con el que arranca', () => {
    const k = [...Array.from({ length: 20 }, (_, i) => mov(`2026-08-${String(i + 1).padStart(2, '0')}`, 'X-A-40', 1)),
      mov('2026-09-01', 'U-D-10', -25)];
    const a = analizarKardex(k, -5);
    const r = recortarKardex(a);
    expect(r.renglones[r.renglones.length - 1].saldo).toBe(-5);
    expect(r.omitidos).toBe(15);
    expect(r.saldo_inicial).toBe(15);
    expect(r.renglones).toHaveLength(6);
  });

  it(`nunca publica más de ${TOPE_RENGLONES_KARDEX} renglones`, () => {
    const k = [mov('2026-01-01', 'U-D-10', -1), ...Array.from({ length: 300 }, () => mov('2026-02-01', 'U-D-10', -1))];
    const r = recortarKardex(analizarKardex(k, -301));
    expect(r.renglones).toHaveLength(TOPE_RENGLONES_KARDEX);
    expect(r.saldo_inicial).toBe(-151);
  });
});
