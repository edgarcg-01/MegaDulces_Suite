import {
  CRITERIO_FLUJO,
  DatosPlaza,
  PlazaFlujo,
  analizarCompra,
  juntarPlaza,
  juzgarPlaza,
  kardexPorPlaza,
  llegadaDeKardex,
  periodos,
  resumirProducto,
  serieAcumulada,
  sugerirTraspasos,
  variacion,
} from './product-flow';
import { escaleraDeFicha } from './new-products';

const HOY = '2026-10-09';
const P = periodos(HOY);
const KINDER = escaleraDeFicha({ u1: 'PZA', u2: 'PAQ', u3: 'CJA', f2: '9.9961', f3: '59.9786', uxc: '60.00' });

/** Una sucursal con venta pareja: `diaria` piezas a $10 cada día de los últimos 30 días. */
function datos(over: Partial<DatosPlaza> & { diaria?: number } = {}): DatosPlaza {
  const diaria = over.diaria ?? 10;
  return {
    plaza: '01', nombre: 'Padre Hidalgo',
    mes: diaria * 10 * P.dias, mes_anterior_mismo: diaria * 10 * P.dias, mes_anterior_total: diaria * 10 * 30,
    monto30: diaria * 10 * 30, unidades30: diaria * 30, ultima: diaria > 0 ? HOY : null,
    existencia: 300, duda: null, escalera: KINDER, costo: 5,
    ...over,
  };
}

describe('[PF.1] periodos: el mes contra LOS MISMOS DÍAS del anterior', () => {
  it('a mitad de mes: del 1 al día de hoy, contra el 1 al mismo día del mes anterior', () => {
    expect(P).toMatchObject({ mesIni: '2026-10-01', dias: 9, prevIni: '2026-09-01', prevFin: '2026-09-10', desde30: '2026-09-10' });
  });

  it('⛔ un 31 contra un mes de 28 días: el mes anterior completo, no se pasa al mes en curso', () => {
    expect(periodos('2026-03-31')).toMatchObject({ prevIni: '2026-02-01', prevFin: '2026-03-01', dias: 31 });
  });

  it('enero se compara con diciembre del año anterior', () => {
    expect(periodos('2026-01-05')).toMatchObject({ prevIni: '2025-12-01', prevFin: '2025-12-06' });
  });

  it('⛔ sin venta en el mes anterior no hay variación (no se dibuja +100% ni infinito)', () => {
    expect(variacion(500, 0)).toBeNull();
    expect(variacion(120, 100)).toBe(0.2);
    expect(variacion(50, 100)).toBe(-0.5);
  });
});

describe('[PF.1] historia cerrada + lo de hoy en vivo', () => {
  it('lo de hoy suma al mes, a los últimos 30 días y mueve la última venta', () => {
    const hist = { product_id: 'p', plaza: '01', mes: '800', mes_anterior_mismo: '700', mes_anterior_total: '2000',
      monto30: '2500', unidades30: '250', ultima: '2026-10-08' };
    const j = juntarPlaza(P, hist, [{ sku: 'X', plaza: '01', fecha: HOY, monto: '100', unidades: '10' }]);
    expect(j).toEqual({ mes: 900, mes_anterior_mismo: 700, mes_anterior_total: 2000, monto30: 2600, unidades30: 260, ultima: HOY });
  });

  it('si el nocturno falló, el tramo en vivo que cae en el mes anterior va a su periodo', () => {
    const j = juntarPlaza(periodos('2026-10-02'), undefined, [
      { sku: 'X', plaza: '01', fecha: '2026-09-30', monto: '50', unidades: '5' },
      { sku: 'X', plaza: '01', fecha: '2026-10-01', monto: '70', unidades: '7' },
    ]);
    expect(j.mes).toBe(70);
    expect(j.mes_anterior_total).toBe(50);
    // Del 1 al 2 de septiembre no hubo venta: el 30 no cuenta como "los mismos días".
    expect(j.mes_anterior_mismo).toBe(0);
  });
});

describe('[PF.1] cada sucursal: se mueve, se frenó, estancado, agotado', () => {
  it('se mueve, con la cobertura en días al ritmo de los últimos 30', () => {
    const x = juzgarPlaza(P, datos());
    expect(x.estado).toBe('se_mueve');
    expect(x.unidades_dia).toBe(10);
    expect(x.cobertura_dias).toBe(30);
    expect(x.inmovilizado).toBe(1500);
  });

  it('⭐ estancado: hay existencia y lleva 14 días o más sin venderse', () => {
    const x = juzgarPlaza(P, datos({ ultima: '2026-09-20' }));
    expect(x.estado).toBe('estancado');
    expect(x.dias_sin_venta).toBe(19);
    expect(x.motivo).toContain('19 días');
  });

  it('⭐ estancado aunque no haya venta en toda la ventana: se dice "más de 120 días", no se inventa una fecha', () => {
    const x = juzgarPlaza(P, datos({ diaria: 0, mes: 0, mes_anterior_mismo: 0 }));
    expect(x.estado).toBe('estancado');
    expect(x.dias_sin_venta).toBeNull();
    expect(x.cobertura_dias).toBeNull();
    expect(x.motivo).toContain(`más de ${CRITERIO_FLUJO.ventanaHistoria} días`);
  });

  it('agotado: se vende y no hay existencia', () => {
    expect(juzgarPlaza(P, datos({ existencia: 0 })).estado).toBe('agotado');
    expect(juzgarPlaza(P, datos({ existencia: null })).estado).toBe('agotado');
  });

  it('⭐ le sobra: se vende, pero tiene para más de 60 días (de aquí se puede mover)', () => {
    const x = juzgarPlaza(P, datos({ existencia: 1300 }));
    expect(x.estado).toBe('le_sobra');
    expect(x.motivo).toBe('Tiene para 130 días al ritmo actual');
  });

  it('sin movimiento: ni existencia ni venta', () => {
    expect(juzgarPlaza(P, datos({ diaria: 0, existencia: 0, mes: 0, mes_anterior_mismo: 0 })).estado).toBe('sin_movimiento');
  });

  it('⭐ se frenó: el mes va a menos de la mitad de los mismos días del anterior', () => {
    const x = juzgarPlaza(P, datos({ mes: 300, mes_anterior_mismo: 900 }));
    expect(x.estado).toBe('se_freno');
    expect(x.variacion).toBe(-0.67);
    expect(x.motivo).toContain('67% menos');
  });

  it('⛔ con menos de 7 días del mes no se juzga el frenado: pocos días mueven mucho el porcentaje', () => {
    const p = periodos('2026-10-03');
    expect(juzgarPlaza(p, datos({ mes: 10, mes_anterior_mismo: 900 })).estado).toBe('se_mueve');
  });

  it('⭐ existencia en duda: decide la estimada (Canindo: Kepler dice 0, el kardex 1,500) y no sale agotado', () => {
    const x = juzgarPlaza(P, datos({ existencia: 0, duda: { kepler: -3, estimada: 1500, base: 'PZA', otros: ['PAQ'] } }));
    // Con 1,500 piezas a 10 por día tiene para 150 días: le sobra (y de ahí se puede mover).
    expect(x.estado).toBe('le_sobra');
    expect(x.existencia_usada).toBe(1500);
    expect(x.cobertura_dias).toBe(150);
  });

  it('⛔ en duda sin estimada: no se da por agotado (no se sabe)', () => {
    const x = juzgarPlaza(P, datos({ existencia: 0, duda: { kepler: 0, estimada: null, base: 'PZA', otros: ['500'] } }));
    expect(x.estado).not.toBe('agotado');
  });

  it('sin costo (o sin permiso) no hay pesos inmovilizados', () => {
    expect(juzgarPlaza(P, datos({ costo: null })).inmovilizado).toBeNull();
  });
});

describe('[PF.1] ¿hace falta comprar?', () => {
  const plaza = (over: Partial<DatosPlaza> & { diaria?: number }) => juzgarPlaza(P, datos(over));
  const total = (xs: PlazaFlujo[]) => ({ mes: xs.reduce((a, x) => a + x.mes, 0), mes_anterior_mismo: xs.reduce((a, x) => a + x.mes_anterior_mismo, 0) });

  it('⭐ comprar: alcanza para menos de 15 días; dice cuándo se acaba y cuánto se deja de vender', () => {
    const xs = [plaza({ existencia: 50 })];
    const a = analizarCompra(P, xs, total(xs));
    expect(a.veredicto).toBe('comprar');
    expect(a.cobertura_dias).toBe(5);
    expect(a.se_acaba).toBe('2026-10-14');
    expect(a.impacto.join(' ')).toContain('alrededor del 14 de octubre');
    expect(a.impacto.join(' ')).toContain('$100 por día');
  });

  it('⛔ sin existencia no dice "alcanza para 0 días": ya no hay, y ya se deja de vender', () => {
    const xs = [plaza({ existencia: 0 })];
    const a = analizarCompra(P, xs, total(xs));
    expect(a.veredicto).toBe('comprar');
    expect(a.titulo).toBe('Comprar: ya no hay existencia');
    expect(a.impacto[0]).toContain('Ya se están dejando de vender cerca de $100 por día');
    const casi = [plaza({ existencia: 5 })];
    expect(analizarCompra(P, casi, total(casi)).titulo).toBe('Comprar: alcanza para menos de un día');
    expect(analizarCompra(P, casi, total(casi)).impacto[0]).toBe('Si no se compra, al ritmo actual se acaba hoy');
  });

  it('⛔ si la venta cayó porque se agotó, no se avisa que "podría sobrar": no es falta de demanda', () => {
    const agotada = [plaza({ existencia: 0, mes: 50, mes_anterior_mismo: 900 })];
    const a = analizarCompra(P, agotada, total(agotada));
    expect(a.veredicto).toBe('comprar');
    expect(a.motivos.join(' ')).toContain('porque se agotó');
    expect(a.impacto.join(' ')).not.toContain('podría sobrar');
    // Sin agotado, la misma caída sí lleva el aviso.
    const frenada = [plaza({ existencia: 50, mes: 50, mes_anterior_mismo: 900 })];
    expect(analizarCompra(P, frenada, total(frenada)).impacto.join(' ')).toContain('podría sobrar');
  });

  it('sobra: hay para más de 60 días; dice cuánto dinero está en inventario', () => {
    const xs = [plaza({ existencia: 900 })];
    const a = analizarCompra(P, xs, total(xs));
    expect(a.veredicto).toBe('sobra');
    expect(a.impacto.join(' ')).toContain('$4,500');
  });

  it('esperar: entre 15 y 60 días', () => {
    const xs = [plaza({ existencia: 300 })];
    const a = analizarCompra(P, xs, total(xs));
    expect(a.veredicto).toBe('esperar');
    expect(a.impacto[0]).toContain('15 días');
  });

  it('⭐ no comprar: no se vende y hay existencia', () => {
    const xs = [plaza({ diaria: 0, mes: 0, mes_anterior_mismo: 0, existencia: 200 })];
    const a = analizarCompra(P, xs, total(xs));
    expect(a.veredicto).toBe('no_comprar');
    expect(a.motivos.join(' ')).toContain('Estancado en Padre Hidalgo');
  });

  it('⭐ traspasar: en la red alcanza, pero está en la sucursal que no lo vende', () => {
    const xs = [
      plaza({ plaza: '01', nombre: 'Padre Hidalgo', existencia: 0 }),
      plaza({ plaza: '06', nombre: 'Canindo', diaria: 0, mes: 0, mes_anterior_mismo: 0, existencia: 600 }),
    ];
    const a = analizarCompra(P, xs, total(xs));
    expect(a.veredicto).toBe('traspasar');
    expect(a.traspasos).toEqual([{ desde: '06', desde_nombre: 'Canindo', hacia: '01', hacia_nombre: 'Padre Hidalgo', cantidad: 150 }]);
    expect(a.motivos.join(' ')).toContain('Agotado en Padre Hidalgo');
  });

  it('⛔ la existencia en duda se dice en los motivos: contar antes de decidir', () => {
    const xs = [plaza({ existencia: 0, duda: { kepler: -3, estimada: 1500, base: 'PZA', otros: ['PAQ'] } })];
    expect(analizarCompra(P, xs, total(xs)).motivos[0]).toContain('en duda en Padre Hidalgo');
  });

  it('sin venta ni existencia: sin movimiento', () => {
    const xs = [plaza({ diaria: 0, mes: 0, mes_anterior_mismo: 0, existencia: 0 })];
    expect(analizarCompra(P, xs, total(xs)).veredicto).toBe('sin_movimiento');
  });
});

describe('[PF.1] traspasos sugeridos', () => {
  it('la que da se queda con 30 días de su propia venta; lo estancado se puede mover completo', () => {
    const xs = [
      juzgarPlaza(P, datos({ plaza: '01', existencia: 20 })),                       // falta: 10×15 − 20 = 130
      juzgarPlaza(P, datos({ plaza: '08', diaria: 2, existencia: 200 })),           // sobra: 200 − 2×30 = 140 (cobertura 100 > 60)
    ];
    expect(sugerirTraspasos(xs)).toEqual([{ desde: '08', desde_nombre: 'Padre Hidalgo', hacia: '01', hacia_nombre: 'Padre Hidalgo', cantidad: 130 }]);
  });

  it('⛔ si a nadie le sobra no se inventa un traspaso', () => {
    expect(sugerirTraspasos([juzgarPlaza(P, datos({ existencia: 20 }))])).toEqual([]);
  });
});

describe('[PF.1] resumen y serie', () => {
  it('el resumen junta las sucursales por estado', () => {
    const xs = [
      juzgarPlaza(P, datos({ plaza: '01', nombre: 'A', existencia: 0 })),
      juzgarPlaza(P, datos({ plaza: '06', nombre: 'B', ultima: '2026-09-01' })),
    ];
    const r = resumirProducto('p1', P, xs);
    expect(r.agotadas.map((x) => x.plaza)).toEqual(['01']);
    expect(r.estancadas).toEqual([{ plaza: '06', nombre: 'B', dias_sin_venta: 38 }]);
    expect(r.variacion).toBe(0);
  });

  it('la serie acumula día por día; el mes en curso se corta en hoy, el anterior sigue', () => {
    const porDia = new Map([['2026-10-01', 10], ['2026-10-09', 5], ['2026-09-01', 7], ['2026-09-30', 3]]);
    const s = serieAcumulada(P, porDia);
    expect(s.dias.length).toBe(30);
    expect(s.actual[0]).toBe(10);
    expect(s.actual[8]).toBe(15);
    expect(s.actual[9]).toBeNull();
    expect(s.anterior[0]).toBe(7);
    expect(s.anterior[29]).toBe(10);
  });
});

describe('[PF.1] kardex: existencia en duda y llegada', () => {
  const filas = [
    { plaza: '06', sku: 'X', unidad: 'PAQ', q: '167', ult: '2026-09-19', aj: null, primera_compra: '2026-09-18', ultima_compra: '2026-09-18', comprado: '180' },
    { plaza: '06', sku: 'X', unidad: 'PZA', q: '-170', ult: '2026-10-08', aj: null, primera_compra: null, ultima_compra: '2026-10-06', comprado: '600' },
    { plaza: '01', sku: 'X', unidad: 'PZA', q: '40', ult: '2026-10-08', aj: '2026-10-01', primera_compra: '2026-09-18', ultima_compra: '2026-10-06', comprado: '0' },
  ];

  it('el kardex por sucursal: neto por rótulo, crudo, último ajuste y la existencia de Kepler', () => {
    const k = kardexPorPlaza(filas, new Map([['06', -3]]));
    expect(k.get('06')).toEqual({ u: { PAQ: { q: 167, ult: '2026-09-19' }, PZA: { q: -170, ult: '2026-10-08' } }, crudo: -3, kdil: -3 });
    expect(k.get('01')?.aj).toBe('2026-10-01');
  });

  it('la llegada: la primera y la última compra física y en qué sucursales', () => {
    const l = llegadaDeKardex(filas, new Map([['01', 'Padre Hidalgo'], ['06', 'Canindo']]));
    expect(l.primera_compra).toBe('2026-09-18');
    expect(l.primera_compra_plazas.map((x) => x.nombre)).toEqual(['Padre Hidalgo', 'Canindo']);
    expect(l.ultima_compra).toBe('2026-10-06');
  });
});
