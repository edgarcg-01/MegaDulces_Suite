import {
  BILLETES_MXN,
  DENOMINACIONES_MXN,
  DENOM_KEYS,
  MONEDAS_MXN,
  denomDe,
  totalDenominaciones,
  valorDe,
} from './denominations';

/**
 * SM.39 — La moneda de $20.
 *
 * El pedido era de una linea ("en el apartado de monedas agregar las monedas de
 * $20") y no se podia cumplir: **la llave de una denominacion era su VALOR**, o
 * sea que `20` ya estaba ocupado por el billete, y el reparto billetes/monedas
 * se hacia comparando `valor >= 20`, con lo cual una moneda de $20 caia en la
 * columna de billetes incluso si se lograra capturar.
 *
 * Este spec fija las dos cosas que tienen que ser ciertas para que eso no vuelva:
 * que dos denominaciones puedan valer lo mismo sin pisarse, y que lo YA
 * capturado conserve su significado.
 *
 * ⚠️ Estas aserciones son de COMPORTAMIENTO, no de tipos. Verificado en esta
 * entrega: `libs/contracts` corre vitest sin `typecheck` declarado, igual que
 * `view` — y los dos dejaron pasar, sin una sola queja, un tipo que no existia
 * (`RutaArqueo` sin importar) y un campo obligatorio faltante. O sea que el
 * unico gate real de tipos en el frontend es `nx build view`, y tampoco los
 * atrapo. Por eso lo que este archivo fija son valores devueltos.
 */

describe('el billete y la moneda de $20 son cosas distintas', () => {
  it('las dos existen, valen lo mismo y tienen llaves distintas', () => {
    expect(valorDe('20')).toBe(20);
    expect(valorDe('20m')).toBe(20);
    expect(denomDe('20')!.familia).toBe('billete');
    expect(denomDe('20m')!.familia).toBe('moneda');
  });

  it('LA PRUEBA DEL PEDIDO: un billete de $20 y una moneda de $20 suman $40, una en cada columna', () => {
    const r = totalDenominaciones({ '20': 1, '20m': 1 });
    expect(r.total).toBe(40);
    expect(r.billetes).toBe(20);
    expect(r.monedas).toBe(20);
    // Antes esto era imposible de expresar: ambas habrian sido la llave '20'.
    expect(r.desconocidas).toEqual([]);
  });

  it('la moneda de $20 NO cae en billetes (el bug del umbral `>= 20`)', () => {
    const r = totalDenominaciones({ '20m': 3 });
    expect(r.monedas).toBe(60);
    expect(r.billetes).toBe(0);
  });

  it('COMPATIBILIDAD: lo ya capturado como `20` sigue siendo BILLETE', () => {
    // Si esto se rompiera, todos los arqueos guardados cambiarian de significado
    // sin que nadie los toque.
    const r = totalDenominaciones({ '20': 2 });
    expect(r.billetes).toBe(40);
    expect(r.monedas).toBe(0);
  });
});

describe('lo que no se reconoce se ENUMERA, no se suma como cero', () => {
  it('una llave desconocida se reporta y no entra al total', () => {
    const r = totalDenominaciones({ '1000': 1, '777': 5 });
    expect(r.total).toBe(1000);
    expect(r.desconocidas).toEqual(['777']);
  });

  it('valorDe devuelve null —no 0— para una llave que no existe', () => {
    // Un 0 se suma en silencio y deja el total mas chico que el dinero real,
    // que es la peor forma de fallar en un arqueo.
    expect(valorDe('777')).toBeNull();
    expect(valorDe('20x')).toBeNull();
    expect(valorDe('')).toBeNull();
  });

  it('un conteo vacio o basura da 0 sin reventar', () => {
    expect(totalDenominaciones({}).total).toBe(0);
    expect(totalDenominaciones(null).total).toBe(0);
    expect(totalDenominaciones(undefined).total).toBe(0);
    expect(totalDenominaciones({ '100': 0 }).total).toBe(0);
    expect(totalDenominaciones({ '100': -3 }).total).toBe(0);
  });
});

describe('el catalogo es coherente', () => {
  it('no hay llaves repetidas — es lo que rompe el JSONB', () => {
    // PRUEBA NEGATIVA del catalogo: si alguien agrega la moneda de $50 con la
    // llave '50' (la del billete), este test cae antes de que llegue a prod.
    expect(new Set(DENOM_KEYS).size).toBe(DENOM_KEYS.length);
  });

  it('cada familia tiene su lista y la union es el catalogo', () => {
    expect(BILLETES_MXN.every((d) => d.familia === 'billete')).toBe(true);
    expect(MONEDAS_MXN.every((d) => d.familia === 'moneda')).toBe(true);
    expect(DENOMINACIONES_MXN.length).toBe(BILLETES_MXN.length + MONEDAS_MXN.length);
  });

  it('los billetes van de mayor a menor y las monedas tambien (es el orden de captura)', () => {
    const baja = (l: readonly { valor: number }[]) => l.every((d, i) => i === 0 || l[i - 1].valor >= d.valor);
    expect(baja(BILLETES_MXN)).toBe(true);
    expect(baja(MONEDAS_MXN)).toBe(true);
  });

  it('la moneda de $20 va PRIMERA entre las monedas', () => {
    // Si fuera al final, quien ya conoce la pantalla no la encuentra.
    expect(MONEDAS_MXN[0].key).toBe('20m');
  });

  it('todos los valores son positivos y todas las llaves no vacias', () => {
    expect(DENOMINACIONES_MXN.every((d) => d.valor > 0 && d.key.trim().length > 0)).toBe(true);
  });

  it('el total del catalogo completo, una pieza de cada una', () => {
    const una = Object.fromEntries(DENOM_KEYS.map((k) => [k, 1]));
    const esperado = DENOMINACIONES_MXN.reduce((s, d) => s + d.valor, 0);
    expect(totalDenominaciones(una).total).toBe(Math.round(esperado * 100) / 100);
  });
});
