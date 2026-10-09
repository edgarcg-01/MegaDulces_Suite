import {
  CRITERIO_FLUJO,
  DatosPlaza,
  LoteFila,
  PLAZA_CEDIS,
  enJuegoPorDia,
  juzgarLotes,
  juzgarPlaza,
  liderPideAtencion,
  motivosLider,
  periodos,
  resumirCaducidad,
  resumirProducto,
} from './product-flow';
import { escaleraDeFicha } from './new-products';

const HOY = '2026-10-09';
const P = periodos(HOY);
const ESC = escaleraDeFicha({ u1: 'PZA', u2: null, u3: 'CJA', f2: null, f3: '12', uxc: '12' });
const NOMBRES = new Map([['00', 'CEDIS'], ['01', 'Padre Hidalgo'], ['02', 'La Piedad Abastos'], ['03', '8 Esquinas']]);

/** Una sucursal que vende `diaria` piezas a $10 cada día. */
const plaza = (plazaCode: string, diaria: number, existencia: number | null, over: Partial<DatosPlaza> = {}) => juzgarPlaza(P, {
  plaza: plazaCode, nombre: NOMBRES.get(plazaCode) ?? null,
  mes: diaria * 10 * P.dias, mes_anterior_mismo: diaria * 10 * P.dias, mes_anterior_total: diaria * 10 * 30,
  monto30: diaria * 10 * 30, unidades30: diaria * 30, ultima: diaria > 0 ? HOY : null,
  existencia, duda: null, escalera: ESC, costo: null, ...over,
});
const lote = (plazaCode: string, caduca: string, cantidad: number, l = 'L1'): LoteFila =>
  ({ product_id: 'p', plaza: plazaCode, lote: l, caduca, cantidad, registrado: '2026-09-01' });

describe('[PF.2] líderes', () => {
  it('⭐ a un líder se le compra antes: con 18 días un producto común espera y un líder compra', () => {
    const plazas = [plaza('01', 10, 180)];
    expect(resumirProducto('p', P, plazas).compra.veredicto).toBe('esperar');
    const lider = resumirProducto('p', P, plazas, { lider: { rank: 3, participacion: 0.012 } });
    expect(lider.compra.veredicto).toBe('comprar');
    expect(lider.compra.motivos[0]).toBe('Es líder: el #3 en venta de la red en 90 días (1.2% de la venta). No debe faltar');
    expect(lider.lider).toEqual({ rank: 3, participacion: 0.012 });
  });

  it('un líder agotado dice cuánto se deja de vender ahí por día', () => {
    const r = resumirProducto('p', P, [plaza('01', 10, 500), plaza('02', 5, 0)], { lider: { rank: 1, participacion: 0.02 } });
    expect(r.agotadas).toEqual([{ plaza: '02', nombre: 'La Piedad Abastos', venta_dia: 50 }]);
    expect(r.compra.impacto).toContain('Es líder y está agotado en La Piedad Abastos: ahí se dejan de vender cerca de $50 por día');
  });

  it('⛔ una sucursal estancada sola NO pide atención (en prod marcaba 239 de 245)', () => {
    const r = resumirProducto('p', P, [plaza('01', 10, 400), plaza('03', 0, 50, { ultima: '2026-09-01' })]);
    expect(r.estancadas).toHaveLength(1);
    expect(motivosLider(P, r)).toEqual([]);
    expect(liderPideAtencion(P, r)).toBe(false);
  });

  it('pide atención por agotado, comprar, mover o porque se frenó la red', () => {
    const agot = resumirProducto('p', P, [plaza('01', 10, 500), plaza('02', 5, 0)]);
    expect(motivosLider(P, agot)).toContain('agotado');
    const frenado = resumirProducto('p', P, [plaza('01', 10, 400, { mes: 300, mes_anterior_mismo: 900 })]);
    expect(motivosLider(P, frenado)).toEqual(['se_freno']);
  });

  it('⭐ el orden: primero lo que ya se deja de vender; si se acaba en menos de una semana, toda su venta', () => {
    const agot = resumirProducto('p', P, [plaza('01', 10, 500), plaza('02', 5, 0)]);
    expect(enJuegoPorDia(agot)).toBe(50);
    const seAcaba = resumirProducto('p', P, [plaza('01', 10, 30)]);
    expect(seAcaba.compra.cobertura_dias).toBe(3);
    expect(enJuegoPorDia(seAcaba)).toBe(100);
    expect(enJuegoPorDia(resumirProducto('p', P, [plaza('01', 10, 400)]))).toBe(0);
  });
});

describe('[PF.3] caducidad: ¿se alcanza a vender antes de que caduque?', () => {
  it('⭐ no alcanza: 10 al día, caduca en 20 días y hay 300 → quedan 100 y se propone mover a quien sí lo vende', () => {
    const plazas = [plaza('01', 10, 300), plaza('02', 20, 40)];
    const [l] = juzgarLotes(P, [lote('01', '2026-10-29', 300)], plazas, NOMBRES);
    expect(l).toMatchObject({ dias: 20, en_existencia: 300, se_vende_antes: 200, queda: 100, estado: 'no_alcanza' });
    // La Piedad vende 20/día: en 20 días 400, menos las 40 que ya tiene → caben 360.
    expect(l.mover_a).toEqual([{ plaza: '02', nombre: 'La Piedad Abastos', cantidad: 100 }]);
    expect(l.sin_destino).toBe(0);
  });

  it('⭐ si una sola no alcanza, reparte entre varias y declara lo que no cabe en ninguna', () => {
    // Caducan en 10 días 1000 piezas que aquí no se venden; La Piedad absorbe 200 (20/día), 8 Esquinas 50 (5/día).
    const plazas = [plaza('01', 0, 1000), plaza('02', 20, 0), plaza('03', 5, 0)];
    const [l] = juzgarLotes(P, [lote('01', '2026-10-19', 1000)], plazas, NOMBRES);
    expect(l.mover_a).toEqual([
      { plaza: '02', nombre: 'La Piedad Abastos', cantidad: 200 },
      { plaza: '03', nombre: '8 Esquinas', cantidad: 50 },
    ]);
    expect(l.sin_destino).toBe(750);
    expect(l.accion).toContain('promoverlo o devolverlo');
  });

  it('⭐ se vende primero lo que caduca primero: el segundo lote sólo cuenta con la venta que sobra', () => {
    const [a, b] = juzgarLotes(P, [lote('01', '2026-10-19', 80, 'A'), lote('01', '2026-10-24', 100, 'B')], [plaza('01', 10, 500)], NOMBRES)
      .sort((x, y) => x.caduca.localeCompare(y.caduca));
    expect(a).toMatchObject({ se_vende_antes: 80, queda: 0, estado: 'justo' });
    // En 15 días se venden 150; 80 se los llevó el lote A → al B le tocan 70 de 100.
    expect(b).toMatchObject({ se_vende_antes: 70, queda: 30, estado: 'no_alcanza' });
  });

  it('⛔ lo registrado se topa con la existencia de hoy (Kepler no descuenta por lote); el más viejo primero', () => {
    const ls = juzgarLotes(P, [lote('01', '2026-11-01', 100, 'A'), lote('01', '2027-06-01', 100, 'B')], [plaza('01', 1, 120)], NOMBRES)
      .sort((x, y) => x.caduca.localeCompare(y.caduca));
    expect(ls.map((l) => l.en_existencia)).toEqual([100, 20]);
  });

  it('sin existencia, el lote ya se vendió: no se avisa', () => {
    const [l] = juzgarLotes(P, [lote('01', '2026-10-15', 50)], [plaza('01', 5, 0)], NOMBRES);
    expect(l).toMatchObject({ en_existencia: 0, queda: 0, estado: 'a_tiempo' });
    expect(resumirCaducidad([l])).toMatchObject({ vencido: 0, en_riesgo: 0, proxima: null });
  });

  it('caducado según el registro: se pide confirmarlo en el piso', () => {
    const [l] = juzgarLotes(P, [lote('01', '2026-10-01', 12)], [plaza('01', 5, 40)], NOMBRES);
    expect(l).toMatchObject({ dias: -8, estado: 'caducado', se_vende_antes: 0 });
    expect(l.accion).toContain('confirmarlo en el piso');
    expect(resumirCaducidad([l])).toMatchObject({ vencido: 12, plazas_vencido: ['Padre Hidalgo'] });
  });

  it('⭐ el CEDIS no vende en mostrador: su lote se mide contra la venta de toda la red', () => {
    const plazas = [plaza(PLAZA_CEDIS, 0, 1000), plaza('01', 10, 50), plaza('02', 15, 50)];
    const [l] = juzgarLotes(P, [lote(PLAZA_CEDIS, '2026-11-08', 1000)], plazas, NOMBRES);
    // 25 al día × 30 días = 750 → caducarían 250, y no hay a quién moverlo: ya surte a todas.
    expect(l).toMatchObject({ se_vende_antes: 750, queda: 250, estado: 'no_alcanza', mover_a: [], sin_destino: 250 });
    expect(l.accion).toContain('Ni toda la red');
  });

  it('justo: alcanza, pero caduca en menos de un mes → ponerlo al frente', () => {
    const [l] = juzgarLotes(P, [lote('01', '2026-10-30', 50)], [plaza('01', 10, 50)], NOMBRES);
    expect(l.estado).toBe('justo');
    expect(l.dias).toBeLessThanOrEqual(CRITERIO_FLUJO.caducidadAviso);
  });

  it('el veredicto de compra avisa que hay que sacar lo que caduca antes de comprar', () => {
    const plazas = [plaza('01', 10, 60)];
    const cad = resumirCaducidad(juzgarLotes(P, [lote('01', '2026-10-12', 60)], plazas, NOMBRES));
    const r = resumirProducto('p', P, plazas, { caducidad: cad });
    expect(r.compra.veredicto).toBe('comprar');
    expect(r.compra.motivos.some((m) => m.includes('caducan antes de venderse en Padre Hidalgo'))).toBe(true);
    expect(r.compra.impacto).toContain('Antes de comprar, mover o promover lo que está por caducar');
  });

  it('[negativa] sin lotes registrados no hay resumen: NO quiere decir que no caduque', () => {
    expect(resumirCaducidad([])).toBeNull();
    expect(resumirProducto('p', P, [plaza('01', 10, 300)]).caducidad).toBeNull();
  });
});
