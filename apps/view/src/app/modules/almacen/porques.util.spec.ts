import {
  fechaCorta, diasHasta, diasDeCobertura,
  origenTexto, origenCls, origenPorQue,
  cuandoTexto, cuandoPorQue, cantidadPorQue, PorqueRow,
} from './porques.util';

/** Renglón sano: compra al proveedor, con calendario y venta medida. */
const base: PorqueRow = {
  on_hand: 12, in_transit: 3, suggested_qty: 25, transfer_in: 0, buy_qty: 25,
  target_qty: 40,
  replenish_via: 'purchase', source_warehouse_code: null, supplier_name: 'DULCES XYZ',
  cadence_days: 7, next_due_date: '2026-09-25', lead_time_days: 4, avg_daily_units: 2,
};

describe('fechaCorta — la trampa de la zona horaria (LC.16)', () => {
  it('NO corre el día cuando la API manda medianoche UTC', () => {
    // Esto es el candado de la fase. `new Date(iso).toLocaleDateString('es-MX')` daría 24 de sep
    // porque el navegador está en −06:00. En una fecha de entrega se leería "llega un día antes".
    expect(fechaCorta('2026-09-25T00:00:00.000Z')).toContain('25');
    expect(fechaCorta('2026-09-25T00:00:00.000Z')).not.toContain('24');
  });

  it('acepta la fecha pelada igual que la ISO — misma respuesta', () => {
    expect(fechaCorta('2026-09-25')).toBe(fechaCorta('2026-09-25T00:00:00.000Z'));
  });

  it('el primero de mes no se va al mes anterior', () => {
    // El caso que destapó el bug en LC.16: 2026-09-01 imprimía "31 ago".
    const f = fechaCorta('2026-09-01T00:00:00.000Z') ?? '';
    expect(f).toContain('01');
    expect(f).not.toContain('ago');
  });

  it('sin fecha devuelve null, no la fecha de hoy', () => {
    expect(fechaCorta(null)).toBeNull();
    expect(fechaCorta('')).toBeNull();
    expect(fechaCorta('no es fecha')).toBeNull();
  });
});

describe('diasHasta', () => {
  const hoy = new Date(2026, 8, 21); // 21-sep-2026 local

  it('cuenta días de calendario hacia adelante y hacia atrás', () => {
    expect(diasHasta('2026-09-25', hoy)).toBe(4);
    expect(diasHasta('2026-09-18', hoy)).toBe(-3);
    expect(diasHasta('2026-09-21', hoy)).toBe(0);
  });

  it('no se corre un día con la ISO en UTC', () => {
    expect(diasHasta('2026-09-25T00:00:00.000Z', hoy)).toBe(4);
  });
});

describe('diasDeCobertura — sin venta medida NO es "dura para siempre"', () => {
  it('divide existencia entre venta diaria', () => {
    expect(diasDeCobertura({ on_hand: 12, avg_daily_units: 2 })).toBe(6);
  });

  it('venta 0 o nula devuelve null, nunca Infinity ni un número grande', () => {
    expect(diasDeCobertura({ on_hand: 12, avg_daily_units: 0 })).toBeNull();
    expect(diasDeCobertura({ on_hand: 12, avg_daily_units: null })).toBeNull();
    // Infinity impreso en pantalla sería una fecha de agotamiento inventada.
    expect(diasDeCobertura({ on_hand: 12, avg_daily_units: 0 })).not.toBe(Infinity);
  });
});

describe('origen — "a quién le pido"', () => {
  it('traspaso nombra el almacén que surte, no el proveedor', () => {
    const r = { replenish_via: 'transfer' as const, source_warehouse_code: '01', supplier_name: 'DULCES XYZ' };
    expect(origenTexto(r)).toBe('← 01');
    expect(origenPorQue(r)).toContain('almacén 01');
  });

  it('compra nombra al proveedor', () => {
    expect(origenTexto(base)).toBe('DULCES XYZ');
    expect(origenPorQue(base)).toContain('DULCES XYZ');
  });

  it('⛔ sin ruta configurada NO se disfraza de compra', () => {
    // Es la aserción negativa que justifica la columna: rellenar con "Compra" inventaría un
    // origen que nadie configuró, y el almacenista le pediría al proveedor equivocado.
    const r = { replenish_via: null, source_warehouse_code: null, supplier_name: null };
    expect(origenTexto(r)).toBe('—');
    expect(origenPorQue(r)).toContain('Sin ruta configurada');
    expect(origenPorQue(r)).not.toContain('Compra directa');
  });

  it('sin ruta se ve DISTINTO de compra, no sólo dice distinto', () => {
    expect(origenCls({ replenish_via: null })).not.toBe(origenCls({ replenish_via: 'purchase' }));
    expect(origenCls({ replenish_via: null })).toBe('ab-o-none');
  });

  it('un proveedor conocido sin canal sigue siendo "sin ruta", no compra', () => {
    // El proveedor se muestra como referencia, pero el VEREDICTO de origen sigue sin decidirse.
    const r = { replenish_via: null, source_warehouse_code: null, supplier_name: 'DULCES XYZ' };
    expect(origenTexto(r)).toBe('DULCES XYZ');
    expect(origenCls(r)).toBe('ab-o-none');
    expect(origenPorQue(r)).toContain('Sin ruta configurada');
  });
});

describe('cuándo — "por qué debo pedir hoy"', () => {
  const hoy = new Date(2026, 8, 21);

  it('dice la fecha, los días que faltan, el lead time y la cobertura', () => {
    const t = cuandoPorQue(base, hoy);
    expect(t).toContain('en 4 día(s)');
    expect(t).toContain('Tarda 4 día(s)');
    expect(t).toContain('alcanza ~6 día(s)');
  });

  it('marca la entrega vencida en vez de mostrarla como futura', () => {
    expect(cuandoPorQue({ ...base, next_due_date: '2026-09-18' }, hoy)).toContain('vencida por 3 día(s)');
  });

  it('sin calendario lo declara, y no inventa una fecha', () => {
    const t = cuandoPorQue({ ...base, next_due_date: null, cadence_days: null }, hoy);
    expect(t).toContain('Sin calendario de entregas configurado');
    expect(cuandoTexto({ next_due_date: null, cadence_days: null })).toBe('—');
  });

  it('con cadencia pero sin próxima fecha, dice exactamente eso', () => {
    const t = cuandoPorQue({ ...base, next_due_date: null }, hoy);
    expect(t).toContain('cada 7 día(s)');
    expect(t).toContain('no hay fecha de próxima entrega registrada');
  });

  it('⛔ sin venta medida no estima agotamiento', () => {
    const t = cuandoPorQue({ ...base, avg_daily_units: null }, hoy);
    expect(t).toContain('no se puede estimar cuándo se agota');
    expect(t).not.toContain('alcanza ~');
  });
});

describe('cantidad — "por qué esa cantidad"', () => {
  it('muestra la resta con el objetivo que publicó el motor', () => {
    expect(cantidadPorQue(base)).toBe(
      'Objetivo 40 − existencia 12 − en camino 3 = faltan 25 caja(s).');
  });

  it('separa lo que sale de la red de lo que hay que comprar', () => {
    const t = cantidadPorQue({ ...base, transfer_in: 10, buy_qty: 15 });
    expect(t).toContain('10 sale del sobrante de la red');
    expect(t).toContain('15 hay que comprarlo');
  });

  it('cuando la red lo cubre entero, lo dice', () => {
    expect(cantidadPorQue({ ...base, transfer_in: 25, buy_qty: 0 }))
      .toContain('Se cubre completo con el sobrante');
  });

  it('⛔ sin objetivo publicado NO imprime "Objetivo 0"', () => {
    // Una API anterior a AB.3b manda `undefined`. Formatearlo daría 0, y un objetivo de cero
    // se lee como "no hay que tener nada de este producto" — lo contrario de lo que pasa.
    const t = cantidadPorQue({ ...base, target_qty: null });
    expect(t).toContain('no publica el objetivo que usó');
    expect(t).not.toContain('Objetivo 0');
  });

  it('⛔ un objetivo basura tampoco se dibuja', () => {
    const t = cantidadPorQue({ ...base, target_qty: Number.NaN });
    expect(t).toContain('no publica el objetivo que usó');
    expect(t).not.toContain('NaN');
  });
});
