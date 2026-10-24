import {
  CARGADORES_MAX, corteAPagar, corteDe, corteVecino, erroresDeCargadores, erroresDeCierreDeParada, faltasDelViaje,
  FOTO_MAX_CHARS, repartoDeCarga, seCierraEnLaSuite, tipoDeParadaKepler, tipoDelViaje, totalDeCarga, totalesPorConcepto,
} from './cierre-viaje.contract';

/**
 * `[EMB.24]` Cierre de paradas y `[EMB.27]` cargadores (ADR-091). La regla vive en el contrato:
 * la pantalla la usa para habilitar el botón y la API para rechazar con 400.
 */

const FOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const CLIENTE = { tipo_parada: 'cliente' as const, recipient_status: 'pendiente' };
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('seCierraEnLaSuite — quién cierra cada tipo de parada', () => {
  it('cliente y paradas sin documento de Kepler las cierra la Suite', () => {
    for (const t of ['cliente', 'manual', 'sin_documento', 'otro'] as const) expect(seCierraEnLaSuite(t)).toBe(true);
  });
  it('traspaso y carga a ruta las cierra Kepler', () => {
    expect(seCierraEnLaSuite('traspaso')).toBe(false);
    expect(seCierraEnLaSuite('carga_ruta')).toBe(false);
  });
});

describe('erroresDeCierreDeParada', () => {
  it('entregado con quien recibió y foto: se puede', () => {
    expect(erroresDeCierreDeParada({ resultado: 'entregado', recibio: 'María López', foto: FOTO }, CLIENTE)).toEqual([]);
  });

  it('no entregado con motivo y foto: se puede', () => {
    expect(erroresDeCierreDeParada({ resultado: 'no_entregado', motivo: 'not_located', foto: FOTO }, CLIENTE)).toEqual([]);
  });

  it('sin foto también se cierra (opcional desde 2026-10-12)', () => {
    expect(erroresDeCierreDeParada({ resultado: 'entregado', recibio: 'María López' }, CLIENTE)).toEqual([]);
    expect(erroresDeCierreDeParada({ resultado: 'entregado', recibio: 'María López', foto: '' }, CLIENTE)).toEqual([]);
  });

  it('si viene foto, tiene que ser imagen o PDF y no pasar de 8 MB', () => {
    expect(erroresDeCierreDeParada({ resultado: 'entregado', recibio: 'Ana', foto: 'data:text/plain;base64,aG9sYQ==' }, CLIENTE))
      .toContain('La foto debe ser una imagen o un PDF.');
    const grande = 'data:image/png;base64,' + 'A'.repeat(FOTO_MAX_CHARS);
    expect(erroresDeCierreDeParada({ resultado: 'entregado', recibio: 'Ana', foto: grande }, CLIENTE))
      .toContain('La foto pesa más de 8 MB.');
  });

  it('entregado sin quién recibió no se cierra', () => {
    expect(erroresDeCierreDeParada({ resultado: 'entregado', recibio: ' ', foto: FOTO }, CLIENTE))
      .toContain('Escribe el nombre de quien recibió.');
  });

  it('no entregado sin motivo, o con «otro» sin explicación, no se cierra', () => {
    expect(erroresDeCierreDeParada({ resultado: 'no_entregado', foto: FOTO }, CLIENTE)).toContain('Elige por qué no se entregó.');
    expect(erroresDeCierreDeParada({ resultado: 'no_entregado', motivo: 'other', foto: FOTO }, CLIENTE)).toContain('Explica el motivo.');
  });

  it('sin resultado no se cierra', () => {
    expect(erroresDeCierreDeParada({ foto: FOTO }, CLIENTE)).toContain('Indica si se entregó o no.');
    expect(erroresDeCierreDeParada(null, CLIENTE)).toContain('Indica si se entregó o no.');
  });

  it('un traspaso no se cierra a mano aunque traiga todo: lo cierra la recepción de Kepler', () => {
    const e = erroresDeCierreDeParada(
      { resultado: 'entregado', recibio: 'Ana', foto: FOTO },
      { tipo_parada: 'traspaso', recipient_status: 'pendiente' },
    );
    expect(e).toHaveLength(1);
    expect(e[0]).toMatch(/recepción en Kepler/);
  });

  it('una parada ya cerrada no se vuelve a cerrar', () => {
    expect(erroresDeCierreDeParada(
      { resultado: 'entregado', recibio: 'Ana', foto: FOTO },
      { tipo_parada: 'cliente', recipient_status: 'entregado' },
    )).toEqual(['La parada ya se cerró.']);
  });
});

describe('erroresDeCargadores', () => {
  const CARGA = { tarifa_por_caja: 0.2, cajas: 531 };

  it('con tarifa, cajas y personas distintas: se puede', () => {
    expect(erroresDeCargadores({ driver_ids: [A, B] }, CARGA)).toEqual([]);
  });

  it('PRUEBA NEGATIVA: sin tarifa vigente no se registra: un cero sería no pagar', () => {
    expect(erroresDeCargadores({ driver_ids: [A] }, { ...CARGA, tarifa_por_caja: null })[0]).toMatch(/tarifa de carga por caja/);
    expect(erroresDeCargadores({ driver_ids: [A] }, { ...CARGA, tarifa_por_caja: 0 })[0]).toMatch(/tarifa de carga por caja/);
    expect(erroresDeCargadores({ driver_ids: [A] }, null)[0]).toMatch(/tarifa de carga por caja/);
  });

  it('PRUEBA NEGATIVA: cajas que no se saben (null) frenan; cero cajas es un dato y NO frena', () => {
    expect(erroresDeCargadores({ driver_ids: [A] }, { ...CARGA, cajas: null })).toContain(
      'No se sabe cuántas cajas lleva el embarque: captúralas en «Información» antes de registrar a quienes cargaron.');
    expect(erroresDeCargadores({ driver_ids: [A] }, { ...CARGA, cajas: 0 })).toEqual([]);
  });

  it('rechaza repetidos, ids inválidos y más del máximo', () => {
    expect(erroresDeCargadores({ driver_ids: [A, A] }, CARGA)).toContain('Un cargador está repetido.');
    expect(erroresDeCargadores({ driver_ids: ['x'] }, CARGA)).toContain('Hay un cargador inválido.');
    const muchos = Array.from({ length: CARGADORES_MAX + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(erroresDeCargadores({ driver_ids: muchos }, CARGA)).toContain(`Máximo ${CARGADORES_MAX} cargadores por carga.`);
  });

  it('una lista vacía es válida aunque no haya tarifa ni cajas: quitar a todos no paga nada', () => {
    expect(erroresDeCargadores({ driver_ids: [] }, CARGA)).toEqual([]);
    expect(erroresDeCargadores({ driver_ids: [] }, { tarifa_por_caja: null, cajas: null })).toEqual([]);
  });
});

describe('[EMB.39] carga por caja', () => {
  it('total = cajas × tarifa, a centavos', () => {
    expect(totalDeCarga(531, 0.2)).toBe(106.2);
    expect(totalDeCarga(25, 0.2)).toBe(5);
    expect(totalDeCarga(0, 0.2)).toBe(0);
    expect(totalDeCarga(3, 0.333)).toBe(1);
  });

  it('sin cajas o sin tarifa no hay total (no es cero)', () => {
    expect(totalDeCarga(null, 0.2)).toBeNull();
    expect(totalDeCarga(25, null)).toBeNull();
  });

  it('reparto en partes iguales; lo que no divide exacto va de a centavo a los primeros', () => {
    expect(repartoDeCarga(106.2, 3)).toEqual([35.4, 35.4, 35.4]);
    expect(repartoDeCarga(5, 3)).toEqual([1.67, 1.67, 1.66]);
    expect(repartoDeCarga(0.05, 3)).toEqual([0.02, 0.02, 0.01]);
  });

  it('PRUEBA NEGATIVA: la suma de las partes es SIEMPRE el total, ni un centavo de más o de menos', () => {
    for (const [cajas, personas] of [[1, 3], [7, 6], [531, 7], [12345, 9], [2, 10]]) {
      const total = totalDeCarga(cajas, 0.2) as number;
      const partes = repartoDeCarga(total, personas);
      expect(partes).toHaveLength(personas);
      expect(Math.round(partes.reduce((a, b) => a + b, 0) * 100)).toBe(Math.round(total * 100));
    }
  });

  it('sin personas no hay partes; con total cero cada quien cobra cero', () => {
    expect(repartoDeCarga(10, 0)).toEqual([]);
    expect(repartoDeCarga(0, 2)).toEqual([0, 0]);
  });
});

describe('totalesPorConcepto', () => {
  it('suma por concepto a centavos', () => {
    expect(totalesPorConcepto([
      { concept: 'comision', amount: 129 },
      { concept: 'comision', amount: 91.2 },
      { concept: 'viatico', amount: 200 },
      { concept: 'maniobra_carga', amount: 30 },
    ])).toEqual({ comision: 220.2, viatico: 200, maniobra_carga: 30 });
  });
});

describe('[EMB.43] la catorcena', () => {
  it('jueves a miércoles, anclada en el jueves 1-ene-2026; se paga el viernes', () => {
    expect(corteDe('2026-10-14')).toEqual({ desde: '2026-10-08', hasta: '2026-10-21', pago: '2026-10-23' });
    expect(corteDe('2026-10-08')).toEqual(corteDe('2026-10-21'));
    expect(corteDe('2026-10-22').desde).toBe('2026-10-22');
  });
  it('el que se paga es el último que ya cerró; el vecino se mueve de 14 en 14', () => {
    expect(corteAPagar('2026-10-24')).toEqual({ desde: '2026-10-08', hasta: '2026-10-21', pago: '2026-10-23' });
    expect(corteVecino(corteDe('2026-10-14'), 1).desde).toBe('2026-10-22');
    expect(corteVecino(corteDe('2026-10-14'), -1).desde).toBe('2026-09-24');
  });
});

describe('[EMB.43] la bandeja: tipo de parada y lo que le falta al viaje', () => {
  it('serie 1 = cliente; serie 2: TI = traspaso, RUTA/RD = carga a ruta (como erp_shipment_stop_closure)', () => {
    expect(tipoDeParadaKepler(1, 'C0001')).toBe('cliente');
    expect(tipoDeParadaKepler('2', 'TI006')).toBe('traspaso');
    expect(tipoDeParadaKepler(2, 'RUTA21')).toBe('carga_ruta');
    expect(tipoDeParadaKepler(2, 'RD505')).toBe('carga_ruta');
  });
  it('el viaje se clasifica sólo por las paradas que pagan; de puras cargas a ruta, no entra', () => {
    expect(tipoDelViaje(['traspaso', 'carga_ruta'])).toBe('traspaso');
    expect(tipoDelViaje(['cliente', 'traspaso'])).toBe('mixto');
    expect(tipoDelViaje(['carga_ruta', 'carga_ruta'])).toBeNull();
    expect(tipoDelViaje([])).toBeNull();
  });
  it('lo que falta, en el orden en que se captura; nada = completo', () => {
    expect(faltasDelViaje(null)).toEqual(['tomar']);
    const base = { shipment_id: 's', guide_id: 'g', driver_id: 'd', departure_time: '06:00', arrival_time: '15:00', cargadores: 2 };
    expect(faltasDelViaje(base)).toEqual([]);
    expect(faltasDelViaje({ ...base, driver_id: null, arrival_time: null, cargadores: 0 })).toEqual(['chofer', 'horario', 'cargadores']);
  });
  it('PRUEBA NEGATIVA: medio horario no es horario', () => {
    const base = { shipment_id: 's', guide_id: 'g', driver_id: 'd', departure_time: '06:00', arrival_time: null, cargadores: 1 };
    expect(faltasDelViaje(base)).toEqual(['horario']);
  });
});
