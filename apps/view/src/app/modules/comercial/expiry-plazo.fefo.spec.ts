import { FEFO_MOTIVOS } from '@megadulces/contracts';
import { estadoFefo, mensajeFefo, motivoFefoEnTexto } from './expiry-plazo';

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

/**
 * `[P2.9 paso 4]` Desde que FEFO convierte a la unidad base, el motivo lo dice el SERVIDOR (`fefo_motivo`).
 * La inferencia de antes diría «no tiene existencia sin fecha» de un renglón que no fechó porque Kepler no
 * trae el factor de su unidad: una afirmación falsa (Ley 0 del estándar).
 */
describe('[P2.9 paso 4] estadoFefo dice el motivo del servidor', () => {
  it('⛔ NEGATIVA — sin factor NO se dice «no hay existencia sin fecha»: se dice que falta el factor', () => {
    const e = estadoFefo({ fed_to_fefo: false, fefo_qty: 0, quantity: 2, product_id: 'p1', unit: 'pieza', fefo_motivo: 'unidad_sin_factor' });
    expect(e.nivel).toBe('ninguno');
    expect(e.motivo).not.toMatch(/existencia sin fecha/);
    expect(e.motivo).toBe('Kepler no dice a cuánto del inventario equivale «pieza» en este producto');
  });

  it('una unidad que el producto no tiene en Kepler se nombra en plural', () => {
    expect(estadoFefo({ fed_to_fefo: false, quantity: 6, product_id: 'p1', unit: 'pieza', fefo_motivo: 'unidad_fuera_del_producto' }).motivo)
      .toBe('en Kepler este producto no se maneja en piezas');
  });

  it('parcial: el motivo del servidor manda; sin él, el de siempre', () => {
    const e = estadoFefo({ fed_to_fefo: true, fefo_qty: '4.167', quantity: '10.000', product_id: 'p1', unit: 'caja', fefo_motivo: 'existencia_sin_fecha_insuficiente' });
    expect(e).toMatchObject({ nivel: 'parcial', reflejado: 4.167, faltante: 10 - 4.167 });
    expect(e.motivo).toMatch(/no tenía más existencia sin fecha/);
  });

  it('total: no hay motivo aunque el renglón traiga uno viejo', () => {
    expect(estadoFefo({ fed_to_fefo: true, fefo_qty: 10, quantity: 10, product_id: 'p1', fefo_motivo: null }).motivo).toBeNull();
  });

  it('cada motivo del contrato tiene su frase (ninguno sale crudo), y uno desconocido sale crudo', () => {
    for (const m of FEFO_MOTIVOS) expect(motivoFefoEnTexto(m, 'caja')).not.toBe(m);
    expect(motivoFefoEnTexto('motivo_del_futuro')).toBe('motivo_del_futuro');
  });

  it('el mensaje al guardar lo lleva tal cual', () => {
    expect(mensajeFefo(estadoFefo({ fed_to_fefo: false, quantity: 2, product_id: 'p', unit: 'kg', fefo_motivo: 'sin_presentaciones' }), 'kg').detail)
      .toBe('Guardado, pero no movió inventario: Kepler no publica las presentaciones de este producto en esta sucursal, y sin ellas no se sabe a cuánto inventario equivale lo contado.');
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
