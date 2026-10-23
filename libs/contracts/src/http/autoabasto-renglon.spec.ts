import {
  armarRenglon, estadoRenglon, surteDe, ESTADOS_RENGLON, ESTADO_RENGLON_LABEL,
  type EntradaRenglon, type EscaleraUnidades,
} from './autoabasto-pedido.contract';

/**
 * `[AB.26]` CANDADO de la cuenta única del renglón: la misma que usan «Mi pedido» y la mesa de
 * Autoabasto. Si una de estas pruebas cambia, cambió lo que el almacén ve como «falta», no un detalle.
 *
 * Prueba negativa hecha al escribirla (2026-10-23): quitando `- caminoBase` de `armarRenglon` se
 * ponen en rojo «el embarque sin recibir se resta» y «lo que ya viene cubre toda la falta».
 */
const cajaDe12: EscaleraUnidades = { unit_base: 'PZA', u2_label: 'CJA', u3_label: null, f2: 12, f3: null, is_weight: false };
const matriz = surteDe('transfer', '01', 'prov-1', 'DULCES SA');

/** Un renglón al que le faltan 2 cajas de 12 (24 piezas), costo $1.50 por pieza, sin nada en camino. */
const entrada = (p: Partial<EntradaRenglon> = {}): EntradaRenglon => ({
  product_id: 'p-1', sku: '70056', nombre: 'MAZAPÁN', venta_30d: 10, existencia: 1, objetivo: 3,
  falta: 2, falta_base: 24, caja_factor: 12, costo_base: 1.5, rung_veredicto: null, posicion: 'bajo_minimo',
  viene: null, planeado_compras: 0, escalera: cajaDe12, ajuste: null, surte: matriz, ...p,
});
const viene = (v: Partial<{ ya: number; atorado: number; negado: number; camino: number }>) =>
  ({ ya: 0, atorado: 0, negado: 0, camino: 0, ...v });

describe('[AB.26] armarRenglon — la cuenta única del renglón', () => {
  it('CONTROL: sin nada que venga, se pide lo que falta (2 cajas) y nadie lo ha pedido', () => {
    const { linea, efectivo_base, efectivo_cantidad } = armarRenglon(entrada());
    expect(linea).toMatchObject({ falta: 2, falta_neta: 2, ya_pedido: 0, en_camino: 0, estado: 'sin_pedir', valor: 36 });
    expect(linea.a_pedir).toMatchObject({ regla: 'cajas', cantidad: 2, cantidad_base: 24 });
    expect({ efectivo_base, efectivo_cantidad }).toEqual({ efectivo_base: 24, efectivo_cantidad: 2 });
  });

  it('el embarque sin recibir se resta: viene 1 caja → falta neta 1, se pide 1', () => {
    const { linea } = armarRenglon(entrada({ viene: viene({ camino: 12 }) }));
    expect(linea).toMatchObject({ en_camino: 1, falta_neta: 1, estado: 'sin_pedir' });
    expect(linea.a_pedir.cantidad).toBe(1);
  });

  it('lo que ya viene cubre toda la falta (pedido + embarque) → no se pide y el estado es «ya viene»', () => {
    const { linea, efectivo_base } = armarRenglon(entrada({ viene: viene({ ya: 12, camino: 12 }) }));
    expect(linea).toMatchObject({ ya_pedido: 1, en_camino: 1, falta_neta: 0, estado: 'ya_viene', valor: null });
    expect(linea.a_pedir.cantidad).toBe(0);
    expect(efectivo_base).toBe(0);
  });

  it('lo atorado y lo negado se MUESTRAN pero no se restan', () => {
    const { linea } = armarRenglon(entrada({ viene: viene({ atorado: 24, negado: 12 }) }));
    expect(linea).toMatchObject({ atorado: 2, negado_30d: 1, falta_neta: 2 });
  });

  it('lo planeado por Compras NO se resta (sin folio no se sabe si ya está en Kepler) y el estado lo dice', () => {
    const { linea } = armarRenglon(entrada({ planeado_compras: 2 }));
    expect(linea).toMatchObject({ planeado_compras: 2, falta_neta: 2, estado: 'compras_lo_planeo' });
  });

  it('⛔ «ya viene» gana sobre el plan: no se cuenta dos veces lo que pudo ser la misma mercancía', () => {
    const { linea } = armarRenglon(entrada({ viene: viene({ ya: 24 }), planeado_compras: 2 }));
    expect(linea.estado).toBe('ya_viene');
  });

  it('sin falta → en política', () => {
    expect(armarRenglon(entrada({ falta: 0, falta_base: 0 })).linea.estado).toBe('en_politica');
  });

  it('el ajuste guardado manda sobre lo sugerido, en cantidad y en valor', () => {
    const ajuste = { cantidad: 5, unidad: 'CJA', motivo: 'promocion_proxima' as const, ajustado_por: 'ana', ajustado_at: '2026-10-23T10:00:00.000Z', cantidad_base: 60 };
    const { linea, efectivo_base, efectivo_cantidad } = armarRenglon(entrada({ ajuste }));
    expect({ efectivo_base, efectivo_cantidad }).toEqual({ efectivo_base: 60, efectivo_cantidad: 5 });
    expect(linea.valor).toBe(90);
    expect(linea.ajuste).toEqual({ cantidad: 5, unidad: 'CJA', motivo: 'promocion_proxima', ajustado_por: 'ana', ajustado_at: '2026-10-23T10:00:00.000Z' });
  });

  it('⛔ con el peldaño contradicho el $ no se dibuja: valor y costo salen null, nunca 0', () => {
    const { linea } = armarRenglon(entrada({ rung_veredicto: 'x1_inflada' }));
    expect(linea.valor).toBeNull();
    expect(linea.costo_base).toBeNull();
    expect(linea.a_pedir.cantidad).toBe(2);
  });

  it('un factor de caja menor que 1 se toma como 1 (no divide entre cero)', () => {
    const { linea } = armarRenglon(entrada({ caja_factor: 0, viene: viene({ camino: 5 }) }));
    expect(linea.en_camino).toBe(5);
  });
});

describe('[AB.26] estadoRenglon', () => {
  it.each([
    [0, 0, 0, 'en_politica'],
    [10, 0, 0, 'ya_viene'],
    [10, 0, 3, 'ya_viene'],
    [10, 4, 3, 'compras_lo_planeo'],
    [10, 4, 0, 'sin_pedir'],
  ])('falta %s, neta %s, plan %s → %s', (falta, neta, plan, esperado) => {
    expect(estadoRenglon(falta, neta, plan)).toBe(esperado);
  });

  it('cada estado tiene su rótulo', () => {
    for (const e of ESTADOS_RENGLON) expect(ESTADO_RENGLON_LABEL[e]).toBeTruthy();
  });
});

describe('[AB.26] surteDe — a quién se le pide (reemplaza a la «Acción» de la mesa)', () => {
  it('canal de traspaso con origen → su matriz', () => {
    expect(surteDe('transfer', '01', 'prov-1', 'DULCES SA')).toEqual({ tipo: 'matriz', clave: '01', nombre: '01' });
  });
  it('traspaso SIN origen no es traspaso: cae al proveedor', () => {
    expect(surteDe('transfer', null, 'prov-1', 'DULCES SA')).toEqual({ tipo: 'proveedor', clave: 'prov-1', nombre: 'DULCES SA' });
  });
  it('compra → el proveedor; sin nombre, «Proveedor»', () => {
    expect(surteDe('purchase', null, 'prov-1', null)).toEqual({ tipo: 'proveedor', clave: 'prov-1', nombre: 'Proveedor' });
  });
  it('⛔ sin canal ni proveedor se dice «sin ruta», no se inventa un origen', () => {
    expect(surteDe(null, null, null, null)).toEqual({ tipo: 'sin_ruta', clave: null, nombre: 'Sin ruta configurada' });
  });
});
