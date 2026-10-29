import { BadRequestException } from '@nestjs/common';

// platform-core exige JWT_SECRET al importarse (falla cerrado). Para la prueba basta un
// marcador de relleno: aqui no se firma ni se verifica ningun token.
vi.hoisted(() => { process.env['JWT_SECRET'] ||= 'solo-para-pruebas-'.repeat(3); });
import { Permission, PERMISSIONS_KEY } from '@megadulces/platform-core';
import { StoreArqueoController } from './store-arqueo.controller';

/**
 * [SM.48] Lo que el controlador hace con un conteo SIN folio (lo ancla por caja + hora)
 * y la puerta de «Sucursales y sus cajas».
 */
describe('StoreArqueoController · [SM.48] folio por caja + hora y cajas del día', () => {
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  const cajera = { username: 'yazmin_sarai', role_name: 'cajero', permissions: { STORE_ARQUEO_CAPTURAR: true } };
  let blind: { submit: ReturnType<typeof vi.fn>; turnoPorCajaYHora: ReturnType<typeof vi.fn>; cajasDelDia: ReturnType<typeof vi.fn> };
  let scope: { assertCanWrite: ReturnType<typeof vi.fn>; current: ReturnType<typeof vi.fn>; readParam: ReturnType<typeof vi.fn> };
  let ctl: StoreArqueoController;

  beforeEach(() => {
    blind = {
      submit: vi.fn(async (dto: { tipo?: string }) => ({ tipo: dto.tipo ?? 'cierre', secuencia: 1, total_contado: 100 })),
      turnoPorCajaYHora: vi.fn(async () => ({ folio: '226', caja: '4', turno: '2', abierto_at: '2026-10-26T15:47:00' })),
      cajasDelDia: vi.fn(async (fecha: string) => ({ fecha, umbral: 50, sucursales: [] })),
    };
    scope = {
      assertCanWrite: vi.fn(async () => undefined),
      current: vi.fn(async () => ({ dims: { warehouse: { modeWrite: 'listed', valuesWrite: ['03'] } } })),
      readParam: vi.fn(async () => ['03']),
    };
    ctl = new StoreArqueoController(blind as never, {} as never, {} as never, scope as never);
  });

  const dto = (over: Record<string, unknown> = {}) =>
    ({ tipo: 'retiro', caja: '4', business_date: hoy, denominations: { 500: 2 }, ...over }) as never;

  it('⭐ un retiro sin folio se guarda CON el folio del turno abierto en esa caja', async () => {
    await ctl.submit(dto(), cajera);
    expect(blind.turnoPorCajaYHora).toHaveBeenCalledWith('03', '4', hoy, 'retiro', expect.stringMatching(/^\d{2}:\d{2}:\d{2}$/));
    const guardado = blind.submit.mock.calls[0][0];
    expect(guardado.cash_cut_folio).toBe('226');
    // La caja la sigue diciendo la persona: es la llave de la búsqueda, no se reescribe.
    expect(guardado.caja).toBe('4');
  });

  it('sin turno (0 o ambiguo) se guarda igual, sin folio', async () => {
    blind.turnoPorCajaYHora.mockResolvedValueOnce(null);
    await ctl.submit(dto(), cajera);
    expect(blind.submit.mock.calls[0][0].cash_cut_folio).toBeUndefined();
  });

  it('⭐ si la consulta falla, la captura NO se bloquea', async () => {
    blind.turnoPorCajaYHora.mockRejectedValueOnce(new Error('ODS caido'));
    await ctl.submit(dto(), cajera);
    expect(blind.submit).toHaveBeenCalledTimes(1);
    expect(blind.submit.mock.calls[0][0].cash_cut_folio).toBeUndefined();
  });

  it('NEGATIVA: un conteo de otro día no se ancla por la hora de hoy', async () => {
    await ctl.submit(dto({ business_date: '2026-01-02' }), cajera);
    expect(blind.turnoPorCajaYHora).not.toHaveBeenCalled();
  });

  it('con folio en la captura NO se busca por hora (manda Kepler, como antes)', async () => {
    (blind as unknown as { buscarTurno: unknown }).buscarTurno = vi.fn(async () => ({ folio: '9', caja: '4', business_date: hoy }));
    await ctl.submit(dto({ cash_cut_folio: '9' }), { ...cajera, permissions: { ...cajera.permissions, RECONCILIATION_VER: true } });
    expect(blind.turnoPorCajaYHora).not.toHaveBeenCalled();
  });

  it('⭐ la vista de cajas es de quien valida (muestra el esperado)', () => {
    const proto = StoreArqueoController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto['cajas'])).toEqual([Permission.RECONCILIATION_VER]);
  });

  it('fecha por defecto = hoy; una fecha mal escrita es 400', async () => {
    await ctl.cajas({});
    expect(blind.cajasDelDia).toHaveBeenCalledWith(hoy, ['03']);
    await expect(ctl.cajas({ fecha: '26/10/2026' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
