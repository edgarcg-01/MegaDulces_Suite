import {
  bloqueoDelRenglon, motivoNoEnviable, surteDe, esEnviable,
  type AutoabastoPedidoLinea, type SurteRenglon,
} from './autoabasto-pedido.contract';

/**
 * `[AB.NI.10]` — **Un renglón sin ruta deja de estar bloqueado y pasa a ser resoluble.**
 *
 * POR QUÉ EXISTE ESTE ARCHIVO
 *   Medido en prod el 2026-11-25, sólo lectura: entre un cuarto y la mitad de los **375 proveedores
 *   activos con producto** no tienen ruta en cada sucursal (04 Yurécuaro **151, el 40.3 %**), y cada
 *   uno de esos renglones **no se podía mandar a ningún lado**. *Ése es el momento exacto en que la
 *   sucursal agarra papel y hace la requisición manual que pasa a Compras.*
 *
 * Y LA RUTA DERIVADA ERA UNA MONEDA AL AIRE
 *   La misma derivación corrida siete horas después de la que dejó el importer traía **otra `via` en
 *   145 de 2,076 pares**; en **70 pares el voto era un EMPATE** y el desempate lo daba el orden
 *   alfabético (`purchase` le gana a `transfer` porque empieza con p). De esos 70, **61 ya habían
 *   cambiado de valor**. Por eso la **declarada gana** sobre la observada.
 *
 * ⛔ LÍMITE DECLARADO
 *   Esto prueba el primitivo puro. Que el servidor LEA la ruta declarada y que declarar no escriba
 *   en Kepler se prueba contra base real con el payload de la pantalla (regla 13) en `[AB.NI.11]`.
 */

const surte = (s: Partial<SurteRenglon> = {}): SurteRenglon =>
  ({ tipo: 'proveedor', clave: 'prov-1', nombre: 'DULCES SA', ...s });

const linea = (over: Partial<AutoabastoPedidoLinea> = {}): Pick<AutoabastoPedidoLinea, 'estado' | 'surte' | 'ajuste' | 'a_pedir'> =>
  ({
    estado: 'sin_pedir',
    surte: surte(),
    ajuste: null,
    a_pedir: { cantidad: 3, unidad: 'CJA', cantidad_base: 36 },
    ...over,
  } as Pick<AutoabastoPedidoLinea, 'estado' | 'surte' | 'ajuste' | 'a_pedir'>);

describe('[AB.NI.10] surteDe: la ruta DECLARADA gana sobre la observada', () => {
  it('sin ruta declarada se comporta igual que antes (cero regresión)', () => {
    expect(surteDe('transfer', '01', 'prov-1', 'DULCES SA')).toEqual({ tipo: 'matriz', clave: '01', nombre: '01' });
    expect(surteDe('purchase', null, 'prov-1', 'DULCES SA')).toEqual({ tipo: 'proveedor', clave: 'prov-1', nombre: 'DULCES SA' });
    expect(surteDe(null, null, null, null)).toEqual({ tipo: 'sin_ruta', clave: null, nombre: 'Sin ruta configurada' });
  });

  it('⭐ la declarada manda cuando CONTRADICE a la observada', () => {
    // El histórico dice «te lo manda la matriz 01»; una persona declaró «me lo trae el proveedor».
    const r = surteDe('transfer', '01', 'prov-1', 'DULCES SA', { via: 'purchase', origen: 'declared' });
    expect(r.tipo).toBe('proveedor');
    expect(r.clave).toBe('prov-1');
    expect(r.origen_ruta).toBe('declared');
  });

  it('⭐ y manda también al revés: declarar traspaso donde el histórico veía compra', () => {
    const r = surteDe('purchase', null, 'prov-1', 'DULCES SA', { via: 'transfer', source_code: '01', origen: 'declared' });
    expect(r).toEqual({ tipo: 'matriz', clave: '01', nombre: '01', origen_ruta: 'declared' });
  });

  it('⛔ PRUEBA NEGATIVA: devolver la observada en el conflicto es un fallo', () => {
    const r = surteDe('transfer', '01', 'prov-1', 'DULCES SA', { via: 'purchase', origen: 'declared' });
    expect(r.tipo).not.toBe('matriz');
    expect(r.clave).not.toBe('01');
  });

  it('⛔ un traspaso declarado SIN origen no se inventa una matriz: cae a proveedor, y si no hay, a sin_ruta', () => {
    // La base lo impide con un CHECK; el primitivo tampoco debe rellenarlo (ADR-056).
    expect(surteDe('transfer', '01', 'prov-1', 'DULCES SA', { via: 'transfer', origen: 'declared' }).tipo).toBe('proveedor');
    expect(surteDe('transfer', '01', null, null, { via: 'transfer', origen: 'declared' })).toEqual(
      { tipo: 'sin_ruta', clave: null, nombre: 'Sin ruta configurada', origen_ruta: 'declared' });
  });

  it('la ruta heredada se marca como heredada, y la frágil como frágil', () => {
    expect(surteDe(null, null, 'prov-1', 'DULCES SA', { via: 'purchase', origen: 'inherited' }).origen_ruta).toBe('inherited');
    expect(surteDe(null, null, 'prov-1', 'DULCES SA', { via: 'purchase', origen: 'inherited', fragil: true }).fragil).toBe(true);
  });

  it('⛔ PRUEBA NEGATIVA: `fragil: false` NO agrega la marca (una pantalla no debe pintar «frágil: no»)', () => {
    expect(surteDe(null, null, 'prov-1', 'X', { via: 'purchase', fragil: false })).not.toHaveProperty('fragil');
    expect(surteDe(null, null, 'prov-1', 'X', { via: 'purchase' })).not.toHaveProperty('origen_ruta');
  });
});

describe('[AB.NI.10] bloqueoDelRenglon: de qué clase es el bloqueo', () => {
  it('⭐⭐ sin ruta es RESOLUBLE y ofrece declarar la ruta', () => {
    const b = bloqueoDelRenglon(linea({ surte: surte({ tipo: 'sin_ruta', clave: null, nombre: 'Sin ruta configurada' }) }));
    expect(b).toEqual({ motivo: 'No tiene a quién pedírselo (sin ruta configurada)', clase: 'resoluble', accion: 'declarar_ruta' });
  });

  it('⛔⛔ PRUEBA NEGATIVA: «sin ruta» y «no le falta» NO pueden ser de la misma clase', () => {
    // Si las dos fueran terminales, la pantalla no las distingue y el renglón vuelve a quedar sin
    // salida -- que es el defecto que este item existe para matar.
    const sinRuta = bloqueoDelRenglon(linea({ surte: surte({ tipo: 'sin_ruta', clave: null, nombre: 'Sin ruta configurada' }) }));
    const noFalta = bloqueoDelRenglon(linea({ estado: 'en_politica' }));
    expect(sinRuta?.clase).not.toBe(noFalta?.clase);
    expect(noFalta?.clase).toBe('terminal');
    expect(noFalta?.accion).toBeNull();
  });

  it('una ruta PROPUESTA está en espera de Compras, no es ni terminal ni resoluble', () => {
    const b = bloqueoDelRenglon(linea({ surte: surte({ origen_ruta: 'proposed' }) }));
    expect(b).toEqual({ motivo: 'Compras tiene que confirmar a quién se le pide', clase: 'en_espera', accion: null });
  });

  it('⛔ PRUEBA NEGATIVA: una ruta propuesta NO es enviable (no autoriza escribir en Kepler)', () => {
    expect(esEnviable(linea({ surte: surte({ origen_ruta: 'proposed' }) }) as AutoabastoPedidoLinea)).toBe(false);
  });

  it('una ruta heredada SÍ es enviable: cero regresión con lo que hoy funciona', () => {
    expect(bloqueoDelRenglon(linea({ surte: surte({ origen_ruta: 'inherited' }) }))).toBeNull();
    expect(esEnviable(linea({ surte: surte({ origen_ruta: 'inherited' }) }) as AutoabastoPedidoLinea)).toBe(true);
  });

  it('una confirmada es enviable, y una frágil confirmada también (se marca, no se bloquea)', () => {
    expect(bloqueoDelRenglon(linea({ surte: surte({ origen_ruta: 'declared' }) }))).toBeNull();
    expect(bloqueoDelRenglon(linea({ surte: surte({ origen_ruta: 'inherited', fragil: true }) }))).toBeNull();
  });

  it('los cuatro bloqueos de estado siguen siendo terminales, con su texto intacto', () => {
    expect(bloqueoDelRenglon(linea({ estado: 'lo_pediste' }))).toEqual({ motivo: 'Ya lo pediste a Compras', clase: 'terminal', accion: null });
    expect(bloqueoDelRenglon(linea({ estado: 'compras_lo_planeo' }))).toEqual({ motivo: 'Compras ya lo planeó', clase: 'terminal', accion: null });
    expect(bloqueoDelRenglon(linea({ estado: 'ya_viene' }))).toEqual({ motivo: 'Ya viene lo que falta', clase: 'terminal', accion: null });
    expect(bloqueoDelRenglon(linea({ estado: 'en_politica' }))).toEqual({ motivo: 'No le falta', clase: 'terminal', accion: null });
  });

  it('⛔ el estado gana sobre la falta de ruta: lo ya pedido no pide declarar nada', () => {
    const b = bloqueoDelRenglon(linea({ estado: 'lo_pediste', surte: surte({ tipo: 'sin_ruta', clave: null, nombre: 'Sin ruta configurada' }) }));
    expect(b?.clase).toBe('terminal');
    expect(b?.accion).toBeNull();
  });

  it('cantidad 0 sigue siendo terminal', () => {
    expect(bloqueoDelRenglon(linea({ a_pedir: { cantidad: 0, unidad: 'CJA', cantidad_base: 0 } }))?.motivo).toBe('La cantidad a pedir es 0');
  });

  it('motivoNoEnviable sigue devolviendo sólo el texto (misma firma para quien ya la usa)', () => {
    expect(motivoNoEnviable(linea())).toBeNull();
    expect(motivoNoEnviable(linea({ estado: 'ya_viene' }))).toBe('Ya viene lo que falta');
    expect(typeof motivoNoEnviable(linea({ surte: surte({ tipo: 'sin_ruta', clave: null, nombre: 'x' }) }))).toBe('string');
  });
});
