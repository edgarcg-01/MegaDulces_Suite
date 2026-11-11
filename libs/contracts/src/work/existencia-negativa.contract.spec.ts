// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import {
  clasificarNegativo, describirNegativo, MOTIVOS_EXISTENCIA_NEGATIVA, ordenarNegativos, reaperturaNegativo,
  validarResolucionNegativo, type NegativoKepler,
} from './existencia-negativa.contract';

/** El caso que originó el pedido: 17210 en Zamora Centro, medido en prod el 2026-11-03. */
const ZAMORA_17210: NegativoKepler = {
  existencia: -260, ult_entrada: '2026-10-30', ult_salida: '2026-11-02',
  vale_piezas: 600, vale_desde: '2026-11-01', vale_folios: ['0000251'],
};
const HOY = '2026-11-03';

describe('[MX.1.8] clasificarNegativo — sólo se afirma la causa que el dato prueba', () => {
  it('vale sin orden de entrada → «entrada sin aplicar», con lo que quedaría al aplicarla', () => {
    expect(clasificarNegativo(ZAMORA_17210, HOY)).toEqual({ causa: 'entrada_sin_aplicar', quedaria: 340 });
  });

  it('un vale que NO alcanza sigue siendo la causa, y dice que quedaría en negativo', () => {
    expect(clasificarNegativo({ ...ZAMORA_17210, vale_piezas: 100 }, HOY)).toEqual({ causa: 'entrada_sin_aplicar', quedaria: -160 });
  });

  it('sin vale y con movimiento reciente → «salió sin existencia» (no se inventa el porqué)', () => {
    expect(clasificarNegativo({ ...ZAMORA_17210, vale_piezas: null, vale_folios: [] }, HOY))
      .toEqual({ causa: 'salio_sin_existencia', quedaria: null });
  });

  it('el rezago se mide por la ÚLTIMA actividad (entrada o salida), en el borde de 30 días', () => {
    const base = { existencia: -5, vale_piezas: null, vale_desde: null, vale_folios: [] };
    expect(clasificarNegativo({ ...base, ult_entrada: '2026-01-01', ult_salida: '2026-10-04' }, HOY).causa).toBe('salio_sin_existencia'); // 30 días
    expect(clasificarNegativo({ ...base, ult_entrada: '2026-01-01', ult_salida: '2026-10-03' }, HOY).causa).toBe('rezago');               // 31 días
    expect(clasificarNegativo({ ...base, ult_entrada: '2026-10-20', ult_salida: '2026-01-01' }, HOY).causa).toBe('salio_sin_existencia');
  });

  it('⛔ sin ninguna fecha es rezago, no «salió hoy»', () => {
    expect(clasificarNegativo({ existencia: -1, ult_entrada: null, ult_salida: null, vale_piezas: null, vale_desde: null, vale_folios: [] }, HOY).causa).toBe('rezago');
  });
});

describe('[MX.1.8] describirNegativo — dónde está el error, en una línea', () => {
  it('17210: dice el vale, desde cuándo y en cuánto queda', () => {
    const d = describirNegativo(ZAMORA_17210, clasificarNegativo(ZAMORA_17210, HOY));
    expect(d).toBe('Kepler marca -260 pz. Hay 600 pz en el vale 0000251 (desde 1-nov) sin orden de entrada: al aplicarla queda en 340 pz.');
  });

  it('varios vales se nombran todos', () => {
    const n = { ...ZAMORA_17210, vale_folios: ['0000251', '0000260'] };
    expect(describirNegativo(n, clasificarNegativo(n, HOY))).toContain('los vales 0000251, 0000260');
  });

  it('sin vale: las dos últimas fechas y que ningún vale lo explica', () => {
    const n = { ...ZAMORA_17210, vale_piezas: null, vale_folios: [] };
    expect(describirNegativo(n, clasificarNegativo(n, HOY)))
      .toBe('Kepler marca -260 pz: salió más de lo que entró. Última salida 2-nov, última entrada 30-oct; ningún vale pendiente lo explica.');
  });

  it('rezago: desde cuándo no se mueve', () => {
    const n = { existencia: -12.5, ult_entrada: '2025-03-01', ult_salida: '2025-06-15', vale_piezas: null, vale_desde: null, vale_folios: [] };
    expect(describirNegativo(n, clasificarNegativo(n, HOY))).toBe('Kepler marca -12.5 pz, sin movimiento desde 15-jun.');
  });

  it('sin fecha se dice «sin fecha», no un día inventado', () => {
    const n = { existencia: -3, ult_entrada: null, ult_salida: '2026-11-01', vale_piezas: null, vale_desde: null, vale_folios: [] };
    expect(describirNegativo(n, clasificarNegativo(n, HOY))).toContain('última entrada sin fecha');
  });
});

/**
 * `[IC.26]` El caso que lo originó: 83816 en Padre Hidalgo el 7-nov-2026, a media racha. CEDIS le
 * envió 150 pz el 6-nov (UD4102-0001457); la tienda ya había mandado 30 a Yurécuaro y vendía en
 * mostrador, pero la recepción se capturó hasta el 9-nov. Kepler marcaba −60.
 */
const PH_83816_7NOV: NegativoKepler = {
  existencia: -60, ult_entrada: '2026-10-08', ult_salida: '2026-11-07',
  vale_piezas: null, vale_desde: null, vale_folios: [],
  traspaso_piezas: 150, traspaso_desde: '2026-11-06', traspaso_folios: ['0001457'], traspaso_origen: 'CEDIS',
  traspasos_revisados: true,
};
const HOY_7NOV = '2026-11-07';

describe('[IC.26] traspaso enviado y sin recepción — también es «entrada sin aplicar»', () => {
  it('83816: la causa es la entrada, no «salió sin existencia», y dice en cuánto queda', () => {
    expect(clasificarNegativo(PH_83816_7NOV, HOY_7NOV)).toEqual({ causa: 'entrada_sin_aplicar', quedaria: 90 });
    expect(describirNegativo(PH_83816_7NOV, clasificarNegativo(PH_83816_7NOV, HOY_7NOV))).toBe(
      'Kepler marca -60 pz. CEDIS le envió 150 pz en el traspaso 0001457 (desde 6-nov) y aquí no se ha capturado la recepción: al capturarla queda en 90 pz.');
  });

  it('vale y traspaso a la vez: se nombran los dos y lo que queda suma ambos', () => {
    const n = { ...PH_83816_7NOV, vale_piezas: 10, vale_desde: '2026-11-05', vale_folios: ['0000300'] };
    const c = clasificarNegativo(n, HOY_7NOV);
    expect(c).toEqual({ causa: 'entrada_sin_aplicar', quedaria: 100 });
    expect(describirNegativo(n, c)).toBe(
      'Kepler marca -60 pz. Hay 10 pz en el vale 0000300 (desde 5-nov) sin orden de entrada, y CEDIS le envió 150 pz en el traspaso 0001457 (desde 6-nov) y aquí no se ha capturado la recepción: al aplicar las dos queda en 100 pz.');
  });

  it('un traspaso que no alcanza sigue siendo la causa (quedaría en negativo) y varios folios se nombran', () => {
    const n = { ...PH_83816_7NOV, existencia: -470, traspaso_piezas: 320, traspaso_folios: ['0003791', '0003792'], traspaso_origen: 'Padre Hidalgo' };
    expect(clasificarNegativo(n, HOY_7NOV).quedaria).toBe(-150);
    expect(describirNegativo(n, clasificarNegativo(n, HOY_7NOV))).toContain('los traspasos 0003791, 0003792');
  });

  it('sin traspaso pendiente: si se revisaron, lo dice; si NO se pudieron revisar, no lo afirma', () => {
    const sin = { ...PH_83816_7NOV, traspaso_piezas: null, traspaso_folios: [] };
    expect(describirNegativo(sin, clasificarNegativo(sin, HOY_7NOV))).toContain('ningún vale ni traspaso pendiente lo explica');
    const noRevisado = { ...sin, traspasos_revisados: false };
    expect(describirNegativo(noRevisado, clasificarNegativo(noRevisado, HOY_7NOV))).toContain('; ningún vale pendiente lo explica.');
  });
});

describe('[MX.1.8] resolución: motivo válido y cuándo deja de valer', () => {
  it('motivo fuera del catálogo o nota faltante se rechazan en palabras', () => {
    expect(validarResolucionNegativo('inventado', null)).toBe('Elige un motivo de la lista.');
    expect(validarResolucionNegativo('faltante_confirmado', '  ')).toMatch(/necesita una nota/);
    expect(validarResolucionNegativo('entrada_aplicada', null)).toBeNull();
    expect(validarResolucionNegativo('otro', 'x'.repeat(1001))).toMatch(/1,000/);
  });

  it('cada motivo tiene etiqueta y los que piden nota son los que no se pueden verificar en Kepler', () => {
    for (const m of MOTIVOS_EXISTENCIA_NEGATIVA) expect(m.etiqueta).toBeTruthy();
    expect(MOTIVOS_EXISTENCIA_NEGATIVA.filter((m) => m.pide_nota).map((m) => m.codigo)).toEqual(['error_de_captura', 'faltante_confirmado', 'otro']);
  });

  const r = { fecha: '2026-11-03', existencia_vista: -260 };

  it('igual o mejor, sin entrada nueva → la resolución sigue valiendo', () => {
    expect(reaperturaNegativo(r, { existencia: -260, ult_entrada: '2026-10-30' })).toBeNull();
    expect(reaperturaNegativo(r, { existencia: -100, ult_entrada: '2026-11-03' })).toBeNull(); // entrada el MISMO día
  });

  it('más negativo → vuelve: se siguió vendiendo sin existencia', () => {
    expect(reaperturaNegativo(r, { existencia: -261, ult_entrada: '2026-10-30' })).toBe('se_hundio');
  });

  it('entró mercancía después de resolver y sigue en negativo → vuelve', () => {
    expect(reaperturaNegativo(r, { existencia: -10, ult_entrada: '2026-11-04' })).toBe('entro_y_sigue');
  });
});

describe('[MX.1.8] ordenarNegativos — el dinero manda', () => {
  it('por valor; sin costo al final; empate por lo más negativo', () => {
    const rows = [
      { sku: 'a', kepler_code: '01', valor: null, existencia: -999 },
      { sku: 'b', kepler_code: '01', valor: 50, existencia: -1 },
      { sku: 'c', kepler_code: '01', valor: 5000, existencia: -2 },
      { sku: 'd', kepler_code: '01', valor: 50, existencia: -40 },
    ];
    expect(ordenarNegativos(rows).map((x) => x.sku)).toEqual(['c', 'd', 'b', 'a']);
  });
});
