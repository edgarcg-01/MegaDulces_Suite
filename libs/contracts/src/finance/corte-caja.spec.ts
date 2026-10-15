import { aCorteCajaDto } from './corte-caja.contract';

/**
 * `[CGP-L.7]` La respuesta de un corte, tipada. Antes salía la fila cruda de Postgres: el dinero como
 * TEXTO (`numeric` → `'1300.00'`, el repo no fija `setTypeParser`) y la fecha como `Date` (que por
 * JSON viaja con hora). Cada consumidor tenía que acordarse de convertir.
 */
describe('[CGP-L.7] aCorteCajaDto', () => {
  const fila = {
    id: 'c1', tenant_id: 't', folio: 'CC-2026-00009', fecha: new Date(2026, 9, 12), sucursal: '00',
    estado: 'cerrado', fondo_inicial: '500.00', fondo_origen: 'contado',
    total_ingresos: '1000.00', total_gastos: '200.00', total_depositos: '0.00',
    esperado: '1300.00', contado: '1300.00', morralla: '0.00', diferencia: '0.00', nota: null,
    created_by: 'u1', created_by_username: 'cajera', closed_by: 'u1', closed_by_username: 'cajera',
    closed_at: new Date('2026-10-13T01:00:00.000Z'), authorized_by: null, authorized_by_username: null,
    authorized_at: null, created_at: new Date(), updated_at: new Date(),
    conteo_previo: { contado: 1200 }, reconteo_motivo: null,
  };

  it('el dinero sale como número, no como texto', () => {
    const d = aCorteCajaDto(fila);
    expect(d.esperado).toBe(1300);
    expect(d.fondo_inicial).toBe(500);
    expect(d.diferencia).toBe(0);
    expect(typeof d.total_ingresos).toBe('number');
  });

  it('la fecha sale como YYYY-MM-DD, y los instantes como ISO', () => {
    const d = aCorteCajaDto(fila);
    expect(d.fecha).toBe('2026-10-12');
    expect(d.closed_at).toBe('2026-10-13T01:00:00.000Z');
    expect(d.authorized_at).toBeNull();
  });

  it('⛔ lo que no se midió sigue siendo null, no 0', () => {
    const d = aCorteCajaDto({ ...fila, fondo_inicial: null, esperado: null, contado: null, diferencia: null });
    expect(d.fondo_inicial).toBeNull();
    expect(d.esperado).toBeNull();
    expect(d.contado).toBeNull();
  });

  it('no publica lo que no es del contrato (tenant, conteo previo)', () => {
    const d = aCorteCajaDto(fila) as unknown as Record<string, unknown>;
    expect(d['tenant_id']).toBeUndefined();
    expect(d['conteo_previo']).toBeUndefined();
  });
});
