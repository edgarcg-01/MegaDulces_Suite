import { escaleraUnidades, warehouseName } from '@megadulces/contracts';
import type { PlazaNueva } from './productos-nuevos.service';
import {
  RESULTADOS_LANZAMIENTO,
  SEMAFORO,
  VEREDICTOS,
  cantidadPartes,
  cantidadTexto,
  celdaFunciono,
  cruceCompra,
  diaLanzamiento,
  estadoHitoTexto,
  etiquetaResultado,
  existenciaPartes,
  existenciaTexto,
  fechaCorta,
  hitoVisible,
  inicioDistinto,
  leLlego,
  listaUnidades,
  margenTexto,
  ordenMovimiento,
  ordenSucursales,
  ordenReparto,
  resultadoValido,
  seMuevePorRuta,
  semanasCerradas,
  sucursalesTexto,
  tendenciaTexto,
  textoUnidades,
  tresMargenes,
  veredictoVista,
} from './productos-nuevos-vista';
import { CAJA_12, DETALLE, FILAS, MARGENES } from '../../../testing/productos-nuevos.fixture';

/**
 * `[NP.22]` Las funciones puras de Productos nuevos, que vivían dentro de su pantalla y ahora sirven a Productos
 * (resumen, «Lanzamiento» de la ficha, columnas ¿Funcionó? y Día). Las pruebas son las de la pantalla vieja, MOVIDAS
 * sin cambiar lo que comprueban; el filtro y la búsqueda de aquella pantalla ya no existen en el navegador (los hace el
 * servidor del catálogo: `libs/commercial/.../catalogo-detallado.spec.ts`).
 */
describe('[NP.5] funciones puras de Productos nuevos', () => {
  it('el hito se ve si ya cerró o es el tramo en curso', () => {
    expect([hitoVisible(45, 30), hitoVisible(45, 60), hitoVisible(45, 90), hitoVisible(null, 30)])
      .toEqual([true, true, false, false]);
  });

  it('⛔ la fecha NO se corre un día por la zona horaria', () => {
    expect(fechaCorta('2026-09-01')).toMatch(/^1 /);
  });

  it('⛔ la existencia va en cajas completas y lo demás en la base, y la caja sólo si la ficha la declara', () => {
    const k = { existencia_fuente: 'kepler' as const, existencia_duda: null };
    expect(existenciaTexto({ ...k, existencia: 36, existencia_unidad: 'PZA', escalera: CAJA_12 })).toBe('Hay 3 cajas');
    expect(existenciaTexto({ ...k, existencia: 13, existencia_unidad: 'PZA', escalera: CAJA_12 })).toBe('Hay 1 caja y 1 pieza');
    expect(existenciaTexto({ ...k, existencia: 36, existencia_unidad: 'PZA', escalera: null })).toBe('Hay 36 piezas');
    expect(existenciaTexto({ ...k, existencia: 36, existencia_unidad: null, escalera: CAJA_12 }))
      .toBe('Hay 36 (unidad sin declarar en Kepler)');
    expect(existenciaTexto({ ...k, existencia: 50, existencia_unidad: null, existencia_fuente: 'wincaja', escalera: null }))
      .toBe('Hay 50 unidades de Wincaja');
    expect(existenciaTexto({ ...k, existencia: 0, existencia_unidad: 'PZA', escalera: CAJA_12 })).toBe('Agotado');
    expect(existenciaTexto({ ...k, existencia: null, existencia_unidad: null, escalera: null })).toBe('Sin existencia registrada');
  });

  it('⭐ existencia en duda: lo que dice Kepler y, aparte, lo que debería haber según el kardex', () => {
    const p = { existencia_fuente: 'kepler' as const, existencia: 0, existencia_unidad: 'PZA', escalera: CAJA_12,
      existencia_duda: { kepler: -3, estimada: 1500, base: 'PZA', otros: ['PAQ'] } };
    expect(existenciaTexto(p)).toBe('En duda: según el kardex hay 125 cajas');
    const e = existenciaPartes(p);
    expect(e.estado).toBe('en_duda');
    expect(e.motivo).toContain('Kepler sumó paquetes como si fueran piezas');
    expect(existenciaTexto({ ...p, existencia: 13, existencia_duda: { kepler: 13, estimada: null, base: 'PZA', otros: ['500'] } }))
      .toBe('En duda: el kardex no alcanza para estimarla');
  });

  it('⭐ las unidades se dicen como Kepler las registró, de lo grande a lo chico, sin sumarse', () => {
    expect(textoUnidades({ PZA: 40, CJA: 3, PAQ: 1 })).toBe('3 cajas · 1 paquete · 40 piezas');
    expect(textoUnidades({ KG: 2.5 })).toBe('2.5 kg');
    expect(textoUnidades({ CJA: 1 })).toBe('1 caja');
    expect(textoUnidades({})).toBe('');
  });

  it('⛔ un gramaje no es una unidad, uno desconocido va crudo, y sin rótulo no es "pieza"', () => {
    expect(cantidadTexto(6, '500')).toBe('6 de 500 g');
    expect(cantidadTexto(2, 'SER')).toBe('2 SER');
    expect(cantidadTexto(4, '?')).toBe('4 sin unidad');
    expect(cantidadTexto(4, null)).toBe('4 sin unidad');
  });

  it('la tendencia se dice en palabras, y sin 8 semanas no se inventa', () => {
    expect(tendenciaTexto(1.1)).toContain('+10%');
    expect(tendenciaTexto(0.5)).toContain('-50%');
    expect(tendenciaTexto(null)).toContain('Sin 8 semanas');
  });

  it('⛔ la semana en curso NO se grafica: haría parecer que la venta se desploma', () => {
    expect(semanasCerradas([7, 7, 7, 7, 7, 7, 2], 45)).toEqual([7, 7, 7, 7, 7, 7]);
    expect(semanasCerradas([7, 7], 13)).toEqual([7, 7]);
    expect(semanasCerradas([3], 2)).toEqual([]);
    expect(semanasCerradas([], null)).toEqual([]);
  });
});

describe('[NP.15] márgenes y sucursales: funciones puras', () => {
  it('⛔ un margen sin medir es guion, nunca 0%', () => {
    expect(margenTexto(null)).toBe('—');
    expect(margenTexto(undefined)).toBe('—');
    expect(margenTexto(17)).toBe('17.0%');
    expect(margenTexto(-3.25)).toMatch(/^-3\.[23]%$/);
    expect(tresMargenes(MARGENES)).toBe('17.0% · 10.1% · —');
    expect(tresMargenes(null)).toBe('—');
  });

  it('el orden: primero las que compiten por su lugar, luego las demás; sin venta no aparecen', () => {
    const p = (plaza: string, venta: number | null, lugar: number | null) =>
      ({ ...DETALLE.plazas[0], plaza, movimiento: { venta_neta_dia: venta, dias: 10, desplazado: null, lugar } }) as PlazaNueva;
    const orden = ordenMovimiento([p('A', 50, 2), p('B', 900, null), p('C', 80, 1), p('D', null, null)]);
    expect(orden.map((x) => x.plaza)).toEqual(['C', 'A', 'B']);
    // [NP.22] La lista unificada no pierde a nadie: las que no se mueven van al final, en el orden del servidor.
    expect(ordenSucursales([p('A', 50, 2), p('D', null, null), p('B', 900, null), p('E', null, null), p('C', 80, 1)]).map((x) => x.plaza))
      .toEqual(['C', 'A', 'B', 'D', 'E']);
    expect(ordenSucursales([])).toEqual([]);
  });
});

describe('[NP.16] funciones puras', () => {
  it('las sucursales se dicen como se leen; sin nombre del servidor, por el resolvedor único (nunca «Sucursal 06»)', () => {
    expect(sucursalesTexto([])).toBe('');
    expect(sucursalesTexto([{ plaza: '01', nombre: 'Padre Hidalgo' }])).toBe('Padre Hidalgo');
    expect(sucursalesTexto([{ plaza: '01', nombre: 'A' }, { plaza: '06', nombre: null }, { plaza: '08', nombre: 'C' }]))
      .toBe(`A, ${warehouseName('06')} y C`);
    // [negativa] el número crudo con «Sucursal» delante ya no sale (PM, 2026-10-22: una sucursal se NOMBRA).
    expect(sucursalesTexto([{ plaza: '06', nombre: null }])).not.toContain('Sucursal 06');
  });

  it('el reparto: primero las que compraron, luego las que recibieron de otra; sin nada que decir, no aparece', () => {
    const base = DETALLE.plazas[0];
    const p = (plaza: string, over: Partial<PlazaNueva>) => ({ ...base, plaza, unidades_recibidas: {}, recibido_traspaso: {},
      enviado_sucursales: {}, enviado_rutas: {}, existencia: null, ...over }) as PlazaNueva;
    const orden = ordenReparto([
      p('05', { recibido_traspaso: { CJA: 1 } }),
      p('07', {}),
      p('01', { unidades_recibidas: { CJA: 50 } }),
      p('03', { existencia: 12 }),
    ]);
    expect(orden.map((x) => x.plaza)).toEqual(['01', '05', '03']);
  });

  it('⭐ lo que le llegó: compras más lo de otra sucursal, cada rótulo por su lado', () => {
    expect(leLlego({ unidades_recibidas: { CJA: 50 }, recibido_traspaso: { CJA: 10, PAQ: 3 } })).toEqual({ CJA: 60, PAQ: 3 });
    expect(leLlego({ unidades_recibidas: {}, recibido_traspaso: { PZA: 0.1 } })).toEqual({ PZA: 0.1 });
    expect(leLlego({ unidades_recibidas: {}, recibido_traspaso: {} })).toEqual({});
  });

  it('⭐ cada unidad en su renglón, de lo grande a lo chico, con la cifra aparte del rótulo', () => {
    expect(listaUnidades({ PZA: 2, PAQ: 178 })).toEqual([{ cifra: '178', rotulo: 'paquetes' }, { cifra: '2', rotulo: 'piezas' }]);
    expect(listaUnidades({ CJA: 1, KG: 0.0001 })).toEqual([{ cifra: '1', rotulo: 'caja' }]);
    expect(listaUnidades(null)).toEqual([]);
    expect(cantidadPartes(500, '250')).toEqual({ cifra: '500', rotulo: 'de 250 g' });
    expect(cantidadPartes(3, '?')).toEqual({ cifra: '3', rotulo: 'sin unidad' });
  });

  it('⭐ con la ficha: cajas completas y lo demás en paquetes o piezas, nunca "≈ 3.1 cajas"', () => {
    const kinder = escaleraUnidades({ u1: 'PZA', u2: 'PAQ', u3: 'CJA', f2: 10, f3: 60, uxc: 60 });
    expect(textoUnidades({ PAQ: 178, PZA: 2 }, kinder)).toBe('29 cajas, 4 paquetes y 2 piezas');
    expect(textoUnidades({ PZA: 334 }, kinder)).toBe('5 cajas, 3 paquetes y 4 piezas');
    expect(textoUnidades({ CJA: 60 }, kinder)).toBe('60 cajas');
    expect(listaUnidades({ PZA: 13 }, CAJA_12)).toEqual([{ cifra: '1', rotulo: 'caja' }, { cifra: '1', rotulo: 'pieza' }]);
    expect(textoUnidades({ PZA: 13, PAQ: 4 }, CAJA_12)).toBe('1 caja, 1 pieza y 4 paquetes');
    expect(textoUnidades({ PAQ: 178, PZA: 2 }, null)).toBe('178 paquetes · 2 piezas');
  });

  it('⛔ la existencia partida: agotado y sin registro no traen cifra', () => {
    const k = { existencia_fuente: 'kepler' as const, existencia_duda: null };
    expect(existenciaPartes({ ...k, existencia: 13, existencia_unidad: 'PZA', escalera: CAJA_12 }))
      .toEqual({ estado: 'hay', partes: [{ cifra: '1', rotulo: 'caja' }, { cifra: '1', rotulo: 'pieza' }], motivo: null });
    expect(existenciaPartes({ ...k, existencia: 0, existencia_unidad: 'PZA', escalera: CAJA_12 }))
      .toEqual({ estado: 'agotado', partes: [], motivo: null });
    expect(existenciaPartes({ ...k, existencia: null, existencia_unidad: null, escalera: null }).estado).toBe('sin_registro');
  });
});

describe('[NP.UI.1] [NP.UI.2] [NP.6] funciones puras', () => {
  it('⛔ «sin meta» y «sin medir» NO son verde', () => {
    expect(SEMAFORO.sin_meta.severity).toBe('secondary');
    expect(SEMAFORO.sin_medir.severity).toBe('secondary');
    expect(SEMAFORO.ok.severity).toBe('success');
  });

  it('[NP.6] el estado de cada corte, derivado de la historia: definitivo, en curso o todavía no llega (nada de «congelado»)', () => {
    expect(estadoHitoTexto({ cerrado: true }, 45, 30)).toBe('Definitivo');
    expect(estadoHitoTexto({ cerrado: false }, 45, 60)).toBe('En curso');
    expect(estadoHitoTexto({ cerrado: false }, 45, 90)).toBe('Todavía no llega');
  });

  it('[NP.UI.6] si la mercancía llegó antes que la compra aplicada, se dicen las dos fechas', () => {
    expect(inicioDistinto(FILAS[0])).toEqual({ seguimiento: '2026-08-23', llegada: '2026-08-21' });
    expect(inicioDistinto({ lanzamiento: '2026-08-23', llegada: { ...FILAS[0].llegada!, fecha: '2026-08-23' } })).toBeNull();
    expect(inicioDistinto({ lanzamiento: '2026-08-23', llegada: null })).toBeNull();
  });

  it('[NP.UI.5] se mueve por ruta si alguna sucursal lo mandó a camiones', () => {
    expect(seMuevePorRuta(DETALLE.plazas)).toBe(true);
    expect(seMuevePorRuta([{ enviado_rutas: {} }])).toBe(false);
  });
});

describe('[NP.20] [NP.21] [NP.UI.3] el lanzamiento y la compra', () => {
  it('el vocabulario viejo de un servidor anterior se lee con el nuevo (nunca una etiqueta vacía)', () => {
    expect(['recomprar', 'esperar', 'no_recomprar', 'revisar', 'agotado', 'pronto', 'raro', null].map(veredictoVista))
      .toEqual(['se_queda', 'se_queda', 'sacar', 'revisar', 'agotado', 'pronto', 'revisar', 'revisar']);
    expect(Object.keys(VEREDICTOS)).toEqual(['sacar', 'revisar', 'agotado', 'se_queda', 'pronto']);
  });

  it('el cruce se dice sólo cuando tiran en contra: sacar aquí y comprar o mover en Qué hacer', () => {
    expect(cruceCompra('sacar', 'comprar')).toContain('Antes de reponer');
    expect(cruceCompra('sacar', 'traspasar')).not.toBeNull();
    expect(cruceCompra('agotado', 'comprar')).toBeNull();
    expect(cruceCompra('se_queda', 'comprar')).toBeNull();
    expect(cruceCompra('sacar', null)).toBeNull();
  });
});

describe('[NP.22] los resultados del lanzamiento dentro de Productos', () => {
  it('⭐ los sub-filtros son los de la pantalla vieja, con sus nombres, en el orden de «qué pide atención primero»', () => {
    expect(RESULTADOS_LANZAMIENTO.map((r) => r.label)).toEqual([
      'Todos en seguimiento', 'Sacar', 'Revisar', 'Agotado: no se juzga', 'Se queda', 'Aún es pronto',
      'Sin venta en su primer mes', 'Dados de alta, sin movimiento', 'No medibles', 'Excluidos',
    ]);
    // Los cinco resultados llevan su veredicto (para el tono y el icono); las otras vistas, no.
    expect(RESULTADOS_LANZAMIENTO.filter((r) => r.veredicto).map((r) => r.id)).toEqual(['sacar', 'revisar', 'agotado', 'se_queda', 'pronto']);
  });

  it('un resultado desconocido en la URL cae a «Todos en seguimiento» (el mismo default del servidor)', () => {
    expect(resultadoValido('sacar')).toBe('sacar');
    expect(resultadoValido('recomprar')).toBe('seguimiento');
    expect(resultadoValido(null)).toBe('seguimiento');
    expect(etiquetaResultado('sin_movimiento')).toBe('Dados de alta, sin movimiento');
  });

  it('⭐ la celda «Día»: el día y, si ya pasó de 90 o salió del juicio, en qué está', () => {
    expect(diaLanzamiento({ dia: 45, etapa: 'mes_2', estado: 'seguimiento' })).toEqual({ dia: 'Día 45', etapa: null });
    expect(diaLanzamiento({ dia: 120, etapa: 'graduado', estado: 'seguimiento' })).toEqual({ dia: 'Día 120', etapa: 'Cumplió 90 días' });
    expect(diaLanzamiento({ dia: null, etapa: 'sin_movimiento', estado: 'sin_movimiento' })).toEqual({ dia: 'Sin movimiento', etapa: null });
    expect(diaLanzamiento({ dia: 40, etapa: 'mes_2', estado: 'excluido' })).toEqual({ dia: 'Día 40', etapa: 'Excluido' });
    expect(diaLanzamiento(null)).toBeNull();
  });

  it('⭐ la celda «¿Funcionó?»: el resultado con su tono y su razón; fuera del juicio se dice por qué, nunca un verde', () => {
    expect(celdaFunciono({ veredicto: 'sacar', motivo: 'Lleva 30 días sin venderse', estado: 'seguimiento' }))
      .toEqual({ label: 'Sacar', tono: 'bad', icon: 'pi pi-times-circle', motivo: 'Lleva 30 días sin venderse' });
    // [negativa] sin resultado (no está en seguimiento) no se inventa uno: gris, con su motivo.
    expect(celdaFunciono({ veredicto: null, motivo: 'Dado de alta, sin movimiento', estado: 'sin_movimiento' }))
      .toMatchObject({ label: 'Sin movimiento', tono: 'muted', icon: null });
    expect(celdaFunciono({ veredicto: null, motivo: null, estado: 'no_medible' })?.label).toBe('No se puede medir');
    expect(celdaFunciono(undefined)).toBeNull();
  });
});
