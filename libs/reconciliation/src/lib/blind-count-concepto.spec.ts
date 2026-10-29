import { BadRequestException } from '@nestjs/common';

// platform-core exige JWT_SECRET al importarse (falla cerrado). Para la prueba basta un
// marcador de relleno: aqui no se firma ni se verifica ningun token.
vi.hoisted(() => { process.env['JWT_SECRET'] ||= 'solo-para-pruebas-'.repeat(3); });
import { BlindCountService } from './blind-count.service';

/**
 * [SM.49] El concepto del retiro: lo que el servicio acepta y rechaza ANTES de tocar la
 * base. La base lo exige otra vez con su CHECK (test-newdb-arqueo-concepto.js).
 */
describe('BlindCountService · [SM.49] concepto del retiro', () => {
  let llegoALaBase: boolean;
  let svc: BlindCountService;
  beforeEach(() => {
    llegoALaBase = false;
    const tk = { run: vi.fn(async () => { llegoALaBase = true; return { result: { tipo: 'retiro', total_contado: 0 }, badCut: null }; }) };
    svc = new BlindCountService(tk as never, { requireTenantId: () => 't' } as never, {} as never, undefined);
  });
  const base = { warehouse_code: '06', caja: '1', business_date: '2026-10-28', tipo: 'retiro' as const, denominations: { 500: 2 } };

  it.each(['retiro_caja', 'pago_proveedor', 'pago_nomina', 'gasto_sucursal', 'deposito_banco'])('acepta el concepto %s', async (concepto) => {
    await svc.submit({ ...base, concepto }, 'u');
    expect(llegoALaBase).toBe(true);
  });

  it('⭐ «otro» exige el motivo escrito', async () => {
    await expect(svc.submit({ ...base, concepto: 'otro' }, 'u')).rejects.toThrow(/por que es el retiro/i);
    await expect(svc.submit({ ...base, concepto: 'otro', motivo: '   ' }, 'u')).rejects.toBeInstanceOf(BadRequestException);
    expect(llegoALaBase).toBe(false);
    await svc.submit({ ...base, concepto: 'otro', motivo: 'se pagó el gas' }, 'u');
    expect(llegoALaBase).toBe(true);
  });

  it('NEGATIVA: un concepto fuera de la lista se rechaza', async () => {
    await expect(svc.submit({ ...base, concepto: 'cambio_feria' }, 'u')).rejects.toThrow(/concepto invalido/);
    expect(llegoALaBase).toBe(false);
  });

  it('NEGATIVA: el concepto es solo del retiro', async () => {
    await expect(svc.submit({ ...base, tipo: 'cierre', concepto: 'pago_proveedor' }, 'u')).rejects.toThrow(/solo aplica al retiro/);
  });

  it('NEGATIVA: un retiro con concepto que no es «otro» NO lleva motivo', async () => {
    await expect(svc.submit({ ...base, concepto: 'pago_proveedor', motivo: 'algo' }, 'u')).rejects.toThrow(/motivo solo aplica/);
  });

  it('⭐ un retiro SIN concepto (pantalla vieja en caché) se acepta: no se deja a la cajera sin registrar', async () => {
    await svc.submit({ ...base }, 'u');
    expect(llegoALaBase).toBe(true);
  });
});
