import { decidirCategoria, diasHabiles, type ContextoDelMotor, type MovimientoParaElMotor } from './motor-de-categoria';
import { canonico } from './motor-de-categoria.aplicar';

const CTX: ContextoDelMotor = { mapa: [['511', 'compra_mercancia'], ['602', 'gasto_logistico'], ['611-003', 'comision_bancaria'], ['611', 'gasto_venta']],
  hoy: '2026-11-20', hayOds: true };
const retiro = (o: Partial<MovimientoParaElMotor> = {}): MovimientoParaElMotor =>
  ({ id: 'm', fecha: '2026-11-03', amount_in: 0, amount_out: 500, concepto: 'SPEI ENVIADO PROVEEDOR X', classified_by: 'banco', ...o });
const cat = (d: ReturnType<typeof decidirCategoria>) => ('manual' in d ? 'MANUAL' : d.categoria ?? d.motivo);

describe('[BFU.7.3] decidirCategoria — el orden de las fuentes', () => {
  it('lo manual no se toca', () => {
    expect(decidirCategoria(retiro({ classified_by: 'manual' }), CTX)).toEqual({ manual: true });
  });
  it('IVA y comisión del banco van por su texto aunque el documento diga otra cosa', () => {
    const k = { ruta: 'pareo' as const, pase: 'motor-tes', documentos: ['10-1-1@00'], renglones: [{ cuenta: '611-003', importe: 500 }] };
    expect(cat(decidirCategoria(retiro({ concepto: 'IVA COM SERV', kepler: k }), CTX))).toBe('iva_acreditable');
  });
  it('el documento de Kepler manda sobre el texto genérico («compra con tarjeta» es el medio, la cuenta es la naturaleza)', () => {
    const k = { ruta: 'pareo' as const, pase: 'motor-tes', documentos: ['10-1-1@00'], renglones: [{ cuenta: '611-006', importe: 500, departamento: '1-03-50' }] };
    const d = decidirCategoria(retiro({ concepto: 'Compra - Disposicion por POS', kepler: k }), CTX);
    expect(d).toMatchObject({ categoria: 'gasto_venta', evidencia: { fuente: 'documento', cuenta: '611-006', departamento: '1-03-50', ruta: 'pareo' } });
  });
  it('la ruta del Calendario también da la cuenta', () => {
    const k = { ruta: 'calendario' as const, pase: null, documentos: ['20-1-9@01'], renglones: [{ cuenta: '511', importe: 500 }] };
    expect(cat(decidirCategoria(retiro({ kepler: k }), CTX))).toBe('compra_mercancia');
  });
  it('traspaso y cobro salen del tipo de documento; un pago sin aplicación aún usa al acreedor', () => {
    expect(cat(decidirCategoria(retiro({ pareo: { doc_tipo: 'N-A-26', pase: 'motor-tes' } }), CTX))).toBe('traspaso_entre_cuentas');
    expect(cat(decidirCategoria(retiro({ pareo: { doc_tipo: 'X-D-26', entidad: 'CD001', pase: 'motor-tes' } }), CTX))).toBe('compra_mercancia');
  });
  it('sin documento: el texto del banco, y un depósito es cobranza declarada', () => {
    expect(cat(decidirCategoria(retiro({ concepto: 'COMISION MANEJO DE CUENTA' }), CTX))).toBe('comision_bancaria');
    expect(decidirCategoria(retiro({ amount_in: 100, amount_out: 0, concepto: 'DEPOSITO EN EFECTIVO' }), CTX))
      .toMatchObject({ categoria: 'cobranza', evidencia: { fuente: 'deposito' } });
  });
});

describe('[BFU.7.3] ⛔ sin categoría, siempre con su motivo y quién lo resuelve', () => {
  it('cuenta de Kepler sin mapeo → contabilidad, con la cuenta', () => {
    const k = { ruta: 'pareo' as const, pase: 'motor-tes', documentos: ['10-1-1@00'], renglones: [{ cuenta: '607-002', importe: 500 }] };
    expect(decidirCategoria(retiro({ kepler: k }), CTX)).toMatchObject({ categoria: null, motivo: 'cuenta_sin_categoria', responsable: 'contabilidad', evidencia: { cuenta: '607-002' } });
  });
  it('un pase débil de la conciliación NO decide la categoría', () => {
    const k = { ruta: 'pareo' as const, pase: 'motor-tes-group', documentos: ['10-1-1@00'], renglones: [{ cuenta: '511', importe: 500 }] };
    expect(decidirCategoria(retiro({ pareo: { doc_tipo: 'X-D-26', entidad: 'CD001', pase: 'motor-tes-group' }, kepler: k }), CTX))
      .toMatchObject({ categoria: null, motivo: 'pareo_debil', responsable: 'tesoreria' });
  });
  it('las pistas de la conciliación: misma cuenta sin casar, u otra cuenta', () => {
    expect(cat(decidirCategoria(retiro({ pista: 'pareo_pendiente' }), CTX))).toBe('pareo_pendiente');
    expect(cat(decidirCategoria(retiro({ pista: 'kepler_en_otra_cuenta' }), CTX))).toBe('kepler_en_otra_cuenta');
  });
  it('Kepler no lo tiene: dentro del plazo de captura «todavía no»; después, al área', () => {
    expect(decidirCategoria(retiro({ fecha: '2026-11-17' }), CTX)).toMatchObject({ motivo: 'kepler_aun_no_lo_tiene', responsable: 'nadie_todavia' });
    expect(decidirCategoria(retiro({ fecha: '2026-11-03' }), CTX)).toMatchObject({ motivo: 'kepler_no_lo_tiene', responsable: 'area' });
  });
  it('sin ODS se dice, no se finge «Kepler no lo tiene»', () => {
    expect(cat(decidirCategoria(retiro(), { ...CTX, hayOds: false }))).toBe('sin_ods');
  });
});

describe('utilidades', () => {
  it('días hábiles sin fines de semana', () => {
    expect(diasHabiles('2026-11-13', '2026-11-20')).toBe(5); // vie → vie: lun..vie
    expect(diasHabiles('2026-11-20', '2026-11-20')).toBe(0);
  });
  it('⛔ canonico ignora el orden de las llaves (jsonb las reordena): si no, el motor reescribiría cada corrida', () => {
    expect(canonico({ b: 1, a: { d: 2, c: [1, { z: 1, y: 2 }] } })).toBe(canonico({ a: { c: [1, { y: 2, z: 1 }], d: 2 }, b: 1 }));
    expect(canonico({ a: 1, b: undefined })).toBe(canonico({ a: 1 }));
  });
});
