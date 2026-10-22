import { BadRequestException } from '@nestjs/common';

// platform-core exige JWT_SECRET al importarse (falla cerrado). Para la prueba basta un
// marcador de relleno: aqui no se firma ni se verifica ningun token.
vi.hoisted(() => { process.env['JWT_SECRET'] ||= 'solo-para-pruebas-'.repeat(3); });
import { Permission, PERMISSIONS_KEY, ANY_PERMISSIONS_KEY } from '@megadulces/platform-core';
import { StoreArqueoController } from './store-arqueo.controller';
import { CAJA_SIN_CAJA } from './blind-count.service';

/**
 * [SM.47] «Conteo de efectivo» — la puerta del arqueo SIN caja.
 *
 * Lo que se prueba es lo que el controlador IMPONE, no lo que el cliente manda:
 * tipo, caja literal, firma a nombre de quien inicio sesion y que la puerta de la
 * cajera (`POST /`) no sirva para colarse.
 */
describe('StoreArqueoController · [SM.47] conteo de efectivo sin caja', () => {
  let blind: { submit: ReturnType<typeof vi.fn> };
  let scope: { assertCanWrite: ReturnType<typeof vi.fn>; current: ReturnType<typeof vi.fn> };
  let ctl: StoreArqueoController;
  const finanzas = { username: 'ana_fin', role_name: 'finanzas', permissions: { STORE_ARQUEO_SIN_CAJA_CAPTURAR: true } };

  beforeEach(() => {
    blind = { submit: vi.fn(async (dto: any) => ({ tipo: dto.tipo, secuencia: 2, total_contado: 2001.5 })) };
    scope = {
      assertCanWrite: vi.fn(async () => undefined),
      current: vi.fn(async () => ({ dims: { warehouse: { modeWrite: 'listed', valuesWrite: ['04'] } } })),
    };
    ctl = new StoreArqueoController(blind as any, {} as any, {} as any, scope as any);
  });

  it('⭐ impone tipo sin_caja, caja SIN_CAJA y la firma de quien inicio sesion', async () => {
    const r = await ctl.submitSinCaja({
      tipo: 'cierre', caja: '7', warehouse_code: '04', business_date: '2026-10-22',
      cajero_code: 'OTRA_PERSONA', route_code: '21', cash_cut_folio: '999',
      denominations: { 1000: 2, 0.5: 3 }, motivo: 'caja fuerte',
    } as any, finanzas);

    const dto = blind.submit.mock.calls[0][0];
    expect(dto.tipo).toBe('sin_caja');
    expect(dto.caja).toBe(CAJA_SIN_CAJA);
    // NEGATIVA: el cliente no elige a nombre de quien queda.
    expect(dto.cajero_code).toBe('ANA_FIN');
    expect(dto.route_code).toBeUndefined();
    expect(dto.cash_cut_folio).toBeUndefined();
    expect(dto.motivo).toBe('caja fuerte');
    expect(scope.assertCanWrite).toHaveBeenCalledWith('warehouse', '04');
    expect(r).toEqual({ tipo: 'sin_caja', secuencia: 2, total_contado: 2001.5, medible: false, motivo_no_medible: 'sin_esperado' });
  });

  it('⭐ ni un supervisor puede firmar el conteo a nombre de otro', async () => {
    const sup = { username: 'edgar', role_name: 'encargado_tienda', permissions: { RECONCILIATION_VER: true } };
    await ctl.submitSinCaja({ warehouse_code: '04', cajero_code: 'OTRA', denominations: {}, motivo: 'x' } as any, sup);
    expect(blind.submit.mock.calls[0][0].cajero_code).toBe('EDGAR');
  });

  it('sin sucursal pedida usa la unica que tiene asignada', async () => {
    await ctl.submitSinCaja({ denominations: {}, motivo: 'x' } as any, finanzas);
    expect(blind.submit.mock.calls[0][0].warehouse_code).toBe('04');
  });

  it('⭐ NEGATIVA: POST / (la puerta de la cajera) rechaza tipo sin_caja', async () => {
    await expect(ctl.submit({ tipo: 'sin_caja', caja: '1', denominations: {} } as any, finanzas))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(blind.submit).not.toHaveBeenCalled();
  });

  it('⭐ cada puerta pide SU permiso', () => {
    const proto = StoreArqueoController.prototype as any;
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.submitSinCaja)).toEqual([Permission.STORE_ARQUEO_SIN_CAJA_CAPTURAR]);
    // CONTROL: la de la cajera sigue en la suya.
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.submit)).toEqual([Permission.STORE_ARQUEO_CAPTURAR]);
    // El listado lo abre cualquiera de las dos (Finanzas tiene STORE_ARQUEO_VER en false).
    expect(Reflect.getMetadata(ANY_PERMISSIONS_KEY, proto.list))
      .toEqual([Permission.STORE_ARQUEO_VER, Permission.STORE_ARQUEO_SIN_CAJA_CAPTURAR]);
  });
});
