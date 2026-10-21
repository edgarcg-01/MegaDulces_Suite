import { estadoFefo, mensajeFefo } from './expiry-plazo';

/**
 * `[P2.6.12]` «Ya se reflejó» sólo cuando se reflejó TODO.
 *
 * El caso que lo motivó: se capturan 10 cajas y el sistema tiene 4 sin fecha de ese producto.
 * `feedLine` mueve `min(10, 4)` = 4, deja `fed_to_fefo = true` y `fefo_qty = 4`, y la pantalla
 * decía «Ya se reflejó en el control de inventario». El inventario tenía 4 de 10.
 */
describe('estadoFefo · cuánto de lo capturado llegó al inventario', () => {
  it('⭐ el caso del reporte: 10 capturadas, 4 fechadas → PARCIAL, con lo que falta', () => {
    const e = estadoFefo({ fed_to_fefo: true, fefo_qty: '4.000', quantity: '10.000', product_id: 'p1' });
    expect(e).toMatchObject({ nivel: 'parcial', reflejado: 4, capturado: 10, faltante: 6 });
    expect(e.motivo).toMatch(/no tenía más existencia sin fecha/);
  });

  it('todo lo capturado se fechó → total, sin motivo ni faltante', () => {
    expect(estadoFefo({ fed_to_fefo: true, fefo_qty: '10.000', quantity: '10.000', product_id: 'p1' }))
      .toEqual({ nivel: 'total', reflejado: 10, capturado: 10, faltante: 0, motivo: null });
  });

  it('los `numeric` llegan como string con 3 decimales y el ruido de coma flotante no cuenta como faltante', () => {
    expect(estadoFefo({ fed_to_fefo: true, fefo_qty: '2.4999999', quantity: '2.500', product_id: 'p1' }).nivel).toBe('total');
    expect(estadoFefo({ fed_to_fefo: true, fefo_qty: '2.4990', quantity: '2.500', product_id: 'p1' }).nivel).toBe('parcial');
  });

  it('⛔ no se dice «12 de 10»: si se fechó de más, es total y el reflejado se recorta a lo capturado', () => {
    expect(estadoFefo({ fed_to_fefo: true, fefo_qty: 12, quantity: 10, product_id: 'p1' }))
      .toMatchObject({ nivel: 'total', reflejado: 10, faltante: 0 });
  });

  it('nada se movió: ninguno, y el motivo distingue «sin catálogo» de «sin existencia sin fecha»', () => {
    expect(estadoFefo({ fed_to_fefo: false, fefo_qty: 0, quantity: 3, product_id: null }))
      .toMatchObject({ nivel: 'ninguno', reflejado: 0, faltante: 3, motivo: 'el producto no está en el catálogo' });
    expect(estadoFefo({ fed_to_fefo: false, fefo_qty: 0, quantity: 3, product_id: 'p1' }).motivo)
      .toMatch(/no tiene existencia sin fecha/);
  });

  it('⛔ una cifra suelta no se cree sin la bandera, ni la bandera sin cifra', () => {
    // sobra un `fefo_qty` pero la bandera dice que NO se alimentó (p. ej. tras corregir una alta)
    expect(estadoFefo({ fed_to_fefo: false, fefo_qty: 10, quantity: 10, product_id: 'p1' }).nivel).toBe('ninguno');
    // bandera verdadera sin cantidad: no hay nada que afirmar
    expect(estadoFefo({ fed_to_fefo: true, fefo_qty: 0, quantity: 10, product_id: 'p1' }).nivel).toBe('ninguno');
    expect(estadoFefo({ fed_to_fefo: true, fefo_qty: null, quantity: 10, product_id: 'p1' }).nivel).toBe('ninguno');
    expect(estadoFefo({ fed_to_fefo: true, quantity: 10, product_id: 'p1' }).nivel).toBe('ninguno');
  });

  it('una línea sin banderas (la hoja vieja o el detalle sin cargar) no revienta', () => {
    expect(estadoFefo({})).toMatchObject({ nivel: 'ninguno', reflejado: 0, capturado: 0 });
  });
});

describe('mensajeFefo · lo que se le dice a quien guarda', () => {
  it('⭐ «success» sólo si TODO llegó; lo parcial es «warn» y dice cuánto y cuánto falta', () => {
    expect(mensajeFefo(estadoFefo({ fed_to_fefo: true, fefo_qty: 10, quantity: 10, product_id: 'p' }), 'caja'))
      .toEqual({ severity: 'success', detail: 'Ya se reflejó todo en el control de inventario.' });

    const p = mensajeFefo(estadoFefo({ fed_to_fefo: true, fefo_qty: 4, quantity: 10, product_id: 'p' }), 'caja');
    expect(p.severity).toBe('warn');
    expect(p.detail).toContain('Se reflejaron 4 cajas de 10 cajas');
    expect(p.detail).toContain('Quedan 6 cajas sin fechar');
  });

  it('la unidad se pluraliza bien (1 caja · 2 cajas · kg y pz no cambian)', () => {
    expect(mensajeFefo(estadoFefo({ fed_to_fefo: true, fefo_qty: 1, quantity: 3, product_id: 'p' }), 'caja').detail)
      .toContain('Se reflejaron 1 caja de 3 cajas');
    expect(mensajeFefo(estadoFefo({ fed_to_fefo: true, fefo_qty: 1.5, quantity: 4, product_id: 'p' }), 'kg').detail)
      .toContain('Se reflejaron 1.5 kg de 4 kg');
  });

  it('nada movido: «info» con el motivo (no es un error de quien captura)', () => {
    const m = mensajeFefo(estadoFefo({ fed_to_fefo: false, quantity: 2, product_id: null }), 'pieza');
    expect(m.severity).toBe('info');
    expect(m.detail).toBe('Guardado, pero no movió inventario: el producto no está en el catálogo.');
  });
});
