import {
  CARGADORES_MAX, erroresDeCargadores, erroresDeCierreDeParada, FOTO_MAX_CHARS, seCierraEnLaSuite, totalesPorConcepto,
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
  it('con tarifa y personas distintas: se puede', () => {
    expect(erroresDeCargadores({ driver_ids: [A, B] }, 30)).toEqual([]);
  });

  it('sin tarifa capturada no se registra: un cero sería no pagar', () => {
    expect(erroresDeCargadores({ driver_ids: [A] }, null)[0]).toMatch(/tarifa de carga/);
    expect(erroresDeCargadores({ driver_ids: [A] }, 0)[0]).toMatch(/tarifa de carga/);
  });

  it('rechaza repetidos, ids inválidos y más del máximo', () => {
    expect(erroresDeCargadores({ driver_ids: [A, A] }, 30)).toContain('Un cargador está repetido.');
    expect(erroresDeCargadores({ driver_ids: ['x'] }, 30)).toContain('Hay un cargador inválido.');
    const muchos = Array.from({ length: CARGADORES_MAX + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(erroresDeCargadores({ driver_ids: muchos }, 30)).toContain(`Máximo ${CARGADORES_MAX} cargadores por carga.`);
  });

  it('una lista vacía es válida: quita a todos', () => {
    expect(erroresDeCargadores({ driver_ids: [] }, 30)).toEqual([]);
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
