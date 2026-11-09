/**
 * `[CGA-A.71]` ¿El pendiente ya entró al libro por otro camino? Casos REALES de prod (2026-11-09,
 * sólo lectura): la cola ofrecía estos cobros de camioneta y el libro ya los tenía como depósitos de
 * CAOS sin documento, o con la llave de otro.
 *
 * ⚠️ PRUEBA NEGATIVA (corrida el 2026-11-09): sin comparar la ruta de la glosa se pone roja la 2;
 * sin el «uno con uno» de la regla por importe, la 4; sin pedir la misma sucursal en `otra_llave`, la 5.
 */
import { rutaDeLaGlosa, yaEnElLibro, type CapturaDelLibro, type PendienteParaLibro } from './caja-ya-en-libro.engine';

const pend = (sucursal: string, folio: string, fecha: string, monto: number, ruta: string | null): PendienteParaLibro => ({
  origen_ref: `${sucursal}|U-A-5|${folio}|0011`, sucursal, doc_tipo: 'U-A-5', folio, fecha, monto, tipo: 'ingreso', ruta,
});
const deposito = (folio: string, fecha: string, monto: number, glosa: string): CapturaDelLibro => ({
  folio, fecha, monto, tipo: 'ingreso', origen_tipo: 'caos', origen_ref: `AST700-19758|${folio.slice(-4)}`, declared_doc_ref: null, glosa,
});
const cobro = (folio: string, fecha: string, monto: number, origen_ref: string): CapturaDelLibro => ({
  folio, fecha, monto, tipo: 'ingreso', origen_tipo: 'cobro', origen_ref, declared_doc_ref: null, glosa: null,
});

describe('[CGA-A.71] la ruta y el día que la persona escribió en la glosa', () => {
  it.each([
    ['CAOS Deposito #1580 · rd21 10/10', { ruta: '21', dia: '2026-10-10' }],
    ['CAOS Deposito #1614 · ruta22151026', { ruta: '22', dia: '2026-10-15' }],
    ['CAOS Deposito #1612 · ruta 27  151026', { ruta: '27', dia: '2026-10-15' }],
    ['CAOS Deposito #1569 · r23 12 10 26', { ruta: '23', dia: '2026-10-12' }],
    ['CAOS Deposito #1590 · rd 28 13 10 26', { ruta: '28', dia: '2026-10-13' }],
    ['CAOS Deposito #1564 · ruta 27', { ruta: '27', dia: null }],
  ])('%s', (g, esperado) => expect(rutaDeLaGlosa(g, '2026-10-15')).toEqual(esperado));

  it('sin ruta escrita no inventa una (ni el «#1580» del depósito, ni una ruta vecinal «2V005»)', () => {
    expect(rutaDeLaGlosa('venta 14/10/2026', '2026-10-14')).toBeNull();
    expect(rutaDeLaGlosa('CAOS Deposito #1594 - RV MOR 7-10-2026 - ruta 2V005', '2026-10-14')).toBeNull();
    expect(rutaDeLaGlosa(null, '2026-10-14')).toBeNull();
  });
});

describe('[CGA-A.71] qué pendiente ya está en el libro', () => {
  it('1 · la ruta 21 del 10-oct ya es CI-2026-00011 («rd21 10/10»): certeza alta', () => {
    const m = yaEnElLibro([pend('01-001', '0000008', '2026-10-10', 13552, 'ruta_21')],
      [deposito('CI-2026-00011', '2026-10-13', 13552, 'CAOS Deposito #1580 · rd21 10/10')]);
    expect(m.get('01-001|U-A-5|0000008|0011')).toMatchObject({ como: 'deposito_ruta', certeza: 'alta', folio: 'CI-2026-00011' });
  });

  it('2 · CONTROL NEGATIVO: el depósito de OTRA ruta, de otro día o por otro importe no lo explica', () => {
    const p = [pend('01-001', '0000008', '2026-10-10', 13552, 'ruta_21')];
    expect(yaEnElLibro(p, [deposito('CI-1', '2026-10-13', 13552, 'rd22 10/10')]).size).toBe(0);
    expect(yaEnElLibro(p, [deposito('CI-1', '2026-10-13', 13552, 'rd21 11/10')]).size).toBe(0);
    expect(yaEnElLibro(p, [deposito('CI-1', '2026-10-13', 13552 + 317, 'rd21 10/10')]).size).toBe(0);
    // Ni uno ya declarado: ése ya dice qué documento es.
    expect(yaEnElLibro(p, [{ ...deposito('CI-1', '2026-10-13', 13552, 'rd21 10/10'), declared_doc_ref: '01-001|U-A-5|0000007|0011' }]).size).toBe(0);
  });

  it('3 · el mismo cobro capturado con la llave de otra camioneta (Canindo 06-002 / 06-004, folio 6)', () => {
    const m = yaEnElLibro([pend('06-004', '0000006', '2026-10-08', 16482.23, 'ruta_504')],
      [cobro('CI-2026-00017', '2026-10-13', 16482, '06-002|U-A-5|0000006|0011')]);
    expect(m.get('06-004|U-A-5|0000006|0011')).toMatchObject({ como: 'otra_camioneta', certeza: 'por_confirmar' });
  });

  it('4 · un depósito sin ruta por el mismo importe casa UNO con UNO; con dos candidatos no se afirma', () => {
    const p1 = pend('01-006', '0000011', '2026-10-14', 15559, 'ruta_28');
    const d = deposito('CI-2026-00034', '2026-10-14', 15559, 'venta 14/10/2026');
    expect(yaEnElLibro([p1], [d]).get(p1.origen_ref)).toMatchObject({ como: 'deposito_importe', certeza: 'por_confirmar' });
    const p2 = pend('01-002', '0000011', '2026-10-14', 15559, 'ruta_22');
    expect(yaEnElLibro([p1, p2], [d]).size).toBe(0);
    expect(yaEnElLibro([p1], [d, deposito('CI-2026-00099', '2026-10-15', 15559, 'venta 15/10')]).size).toBe(0);
  });

  it('5 · la misma camioneta, mismo día e importe, con otro folio (ruta 28: capturado como el 30, Kepler dice 31)', () => {
    const p = pend('01-006', '0000031', '2026-11-05', 14749, 'ruta_28');
    expect(yaEnElLibro([p], [cobro('CI-2026-00322', '2026-11-05', 14749, '01-006|U-A-5|0000030|0011')]).get(p.origen_ref))
      .toMatchObject({ como: 'otra_llave', folio: 'CI-2026-00322' });
    expect(yaEnElLibro([p], [cobro('CI-2026-00322', '2026-11-05', 14749, '01-005|U-A-5|0000030|0011')]).size).toBe(0);
    expect(yaEnElLibro([p], [cobro('CI-2026-00322', '2026-11-06', 14749, '01-006|U-A-5|0000030|0011')]).size).toBe(0);
  });

  it('6 · una captura explica UN solo pendiente, y la regla fuerte va primero', () => {
    const a = pend('01-001', '0000008', '2026-10-10', 13552, 'ruta_21');
    const b = pend('01-002', '0000008', '2026-10-10', 13552, 'ruta_22');
    const m = yaEnElLibro([b, a], [deposito('CI-2026-00011', '2026-10-13', 13552, 'rd21 10/10')]);
    expect([...m.keys()]).toEqual([a.origen_ref]);
    // Los egresos no se marcan: lo medido el 2026-11-09 son cobros.
    expect(yaEnElLibro([{ ...a, tipo: 'gasto' }], [deposito('CI-2026-00011', '2026-10-13', 13552, 'rd21 10/10')]).size).toBe(0);
  });
});
