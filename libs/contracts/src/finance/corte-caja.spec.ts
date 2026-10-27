import { aCorteCajaDto, leerCorte } from './corte-caja.contract';

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

/**
 * `[CGS.52]` Lo que quedó en caja y la diferencia, dichas por separado. Los casos son los cortes
 * REALES de octubre: el 21-oct publicaba «sobra +$245,268.64» con un «debería haber» de −$221,512.14.
 */
describe('[CGS.52] leerCorte', () => {
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  const base = { contado: 25787, esperado: 24585.37, diferencia: 1201.63, fondo_inicial: 87772.5, sin_medir_motivo: null };

  it('un corte normal: quedó en caja, debería haber y la diferencia con su sentido', () => {
    const l = leerCorte(base, fmt);
    expect(l.quedo).toEqual({ texto: '$25787.00', sub: null, medido: true });
    expect(l.deberia).toEqual({ texto: '$24585.37', sub: null, medido: true });
    expect(l.dif).toEqual({ texto: '+$1201.63', sub: 'sobra', tono: 'bad' });
  });

  it('⛔ [negativa] con el «debería haber» NEGATIVO no se publica un sobrante (el 21-oct)', () => {
    const l = leerCorte({ contado: 23756.5, esperado: -221512.14, diferencia: 245268.64, fondo_inicial: 25787, sin_medir_motivo: null }, fmt);
    expect(l.quedo.texto).toBe('$23756.50');                 // el hecho se sigue diciendo
    expect(l.deberia.texto).toBe('no calculable');
    expect(l.deberia.sub).toBe('el libro trae $221512.14 más de salidas que de dinero');
    expect(l.dif.texto).toBe('no calculable');
    expect(l.dif.texto).not.toContain('245');
  });

  it('con el esperado negativo pero la diferencia ATESTIGUADA, la cifra sí vale; «sin confirmar» no alcanza', () => {
    const neg = { contado: 100, esperado: -50, diferencia: 150, fondo_inicial: 0, sin_medir_motivo: null };
    expect(leerCorte(neg, fmt, { valor: 120, nota: 'confirmada por los testigos', atestiguada: true }).dif.texto).toBe('+$120.00');
    // [CGS.53] …pero no se lee como sobrante: el «debería haber» del mismo renglón es «no calculable».
    expect(leerCorte(neg, fmt, { valor: 120, nota: 'confirmada por los testigos', atestiguada: true }).dif.sub)
      .toBe('el libro no la explica · confirmada por los testigos');
    expect(leerCorte(neg, fmt, { valor: 150, nota: 'sin confirmar', atestiguada: false }).dif.texto).toBe('no calculable');
  });

  it('⛔ sin conteo físico (el 13-oct) no hay diferencia, y se dice por qué — nunca $0', () => {
    const l = leerCorte({ contado: null, esperado: -28784.79, diferencia: null, fondo_inicial: 3653.5, sin_medir_motivo: 'No hubo conteo fisico' }, fmt);
    expect(l.quedo).toEqual({ texto: 'sin conteo físico', sub: null, medido: false });
    expect(l.dif).toEqual({ texto: 'sin medir', sub: 'ver la nota del día', tono: 'dim' });
  });

  it('sin fondo conocido (el 14-oct) el «debería haber» es sin medir y dice por qué', () => {
    const l = leerCorte({ contado: 14128.5, esperado: null, diferencia: null, fondo_inicial: null, sin_medir_motivo: 'El 13 no tuvo conteo' }, fmt);
    expect(l.quedo.texto).toBe('$14128.50');
    expect(l.deberia).toEqual({ texto: 'sin medir', sub: 'no se sabe con cuánto arrancó', medido: false });
    expect(l.dif.texto).toBe('sin medir');
  });

  it('cuadra al centavo', () => {
    expect(leerCorte({ ...base, contado: 100, esperado: 100, diferencia: 0 }, fmt).dif).toEqual({ texto: '$0.00', sub: 'cuadra', tono: 'ok' });
  });
});
