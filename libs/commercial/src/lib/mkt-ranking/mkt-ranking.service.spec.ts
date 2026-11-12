import { BadRequestException } from '@nestjs/common';
import { MktRankingService } from './mkt-ranking.service';

/** Sólo las validaciones: no tocan la base. */
const svc = new MktRankingService({} as never, { requireTenantId: () => 't' } as never);

describe('[MKT.10] alta de promoción — validación', () => {
  const ok = { code: 'o9066', mecanica: '3 leches San Juan = gratis 1', vigencia_desde: '2026-10-20' };

  it('⭐ el código tecleado con letra O se corrige a cero (en el Excel había 44 en una sola semana)', () => {
    expect(svc.validarPromo(ok, false)['code']).toBe('09066');
  });

  it('por omisión cuenta en mostrador; sin fin = hasta agotar', () => {
    const d = svc.validarPromo(ok, false);
    expect(d['canales']).toEqual(['mostrador']);
    expect(d['vigencia_hasta']).toBeUndefined();
  });

  it('[negativas] sin mecánica, sin inicio, fin antes del inicio, canal inválido', () => {
    expect(() => svc.validarPromo({ ...ok, mecanica: ' ' }, false)).toThrow(BadRequestException);
    expect(() => svc.validarPromo({ ...ok, vigencia_desde: '' }, false)).toThrow('Falta la fecha de inicio');
    expect(() => svc.validarPromo({ ...ok, vigencia_hasta: '2026-10-01' }, false)).toThrow('anterior');
    expect(() => svc.validarPromo({ ...ok, canales: ['vecinal'] }, false)).toThrow('al menos un canal');
  });

  it('sucursales: sólo códigos de 2 dígitos; vacío = todas', () => {
    expect(svc.validarPromo({ ...ok, warehouse_codes: ['01', 'x', '08', '01'] }, false)['warehouse_codes']).toEqual(['01', '08']);
    expect(svc.validarPromo({ ...ok, warehouse_codes: [] }, false)['warehouse_codes']).toBeNull();
  });

  it('una edición parcial sólo valida lo que trae', () => {
    expect(svc.validarPromo({ activo: false }, true)).toEqual({ activo: false });
  });
});

describe('[MKT.14] incentivo — validación', () => {
  const ok = { nombre: 'Súper Sport', tipo: 'por_caja', pago: 50, skus: ['95304'], vigencia_desde: '2026-10-19' };

  it('acepta el caso típico y redondea el pago a centavos', () => {
    expect(svc.validarIncentivo({ ...ok, pago: 49.999 }, false)['pago']).toBe(50);
  });

  it('[negativas] pago cero, tipo inventado, sin productos, «por cada $X» sin X', () => {
    expect(() => svc.validarIncentivo({ ...ok, pago: 0 }, false)).toThrow('mayor a cero');
    expect(() => svc.validarIncentivo({ ...ok, tipo: 'por_bono' }, false)).toThrow('Tipo');
    expect(() => svc.validarIncentivo({ ...ok, skus: [] }, false)).toThrow('al menos un producto');
    expect(() => svc.validarIncentivo({ ...ok, tipo: 'por_monto', base_monto: 0 }, false)).toThrow('cuántos pesos');
  });

  it('el exhibidor colocado no exige productos (se captura)', () => {
    expect(svc.validarIncentivo({ ...ok, tipo: 'por_captura', skus: [] }, false)['skus']).toEqual([]);
  });
});

describe('[MKT.10] semana pedida', () => {
  it('[negativa] una semana futura responde 400, no un ranking vacío', () => {
    expect(() => svc.semana('2099-01-05')).toThrow(BadRequestException);
  });
});
