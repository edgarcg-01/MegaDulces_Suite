import { keplerPayableId, paymentGroupKey } from './payment-calendar.service';

/**
 * `[TP.18]` — **La llave del origen derivado** (ADR-094 §4).
 *
 * `finance.payment_allocation_items.obligation_id` es `uuid` y la llave natural de la deuda de
 * Kepler es compuesta (`sucursal · doc_tipo · doc_sub · folio`). El puente es un uuid
 * determinístico, y existe **dos veces**: en TS (`keplerPayableId`) y en SQL
 * (`KEPLER_PAYABLE_ID`, dentro del service).
 *
 * ⛔ **Si las dos dejan de coincidir, un pago guardado no vuelve a encontrar su factura** — y el
 * síntoma no sería un error, sería una etiqueta «—» y un saldo que no baja. Por eso el vector fijo
 * de abajo: lo produjo `md5('kepler_payable|01|3|1|A-123')::uuid` corriendo en el Postgres de
 * producción el 2026-10-16, y se cruzó además contra 5 documentos reales (5/5 coincidieron).
 * Si alguien cambia el formato de la cadena, de un lado o del otro, este test se pone rojo.
 */
describe('[TP.18] keplerPayableId — el uuid determinístico que liga el pago con la factura de Kepler', () => {
  const ID_A123 = '8a297a5b-4b00-4655-716e-6c39435d7c8d';

  it('coincide con lo que calcula Postgres (vector medido contra prod, 2026-10-16)', () => {
    expect(keplerPayableId('01', 3, 1, 'A-123')).toBe(ID_A123);
  });

  it('es determinístico: el mismo documento da siempre el mismo id', () => {
    expect(keplerPayableId('01', 3, 1, 'A-123')).toBe(keplerPayableId('01', 3, 1, 'A-123'));
  });

  it('acepta el tipo y el subtipo como número o como texto (la vista los entrega numéricos)', () => {
    expect(keplerPayableId('01', '3', '1', 'A-123')).toBe(ID_A123);
  });

  it('tiene forma de uuid (si no, Postgres rechaza el insert del item)', () => {
    expect(keplerPayableId('00', 45, 1, '0000304')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  // ⛔ Pruebas NEGATIVAS: cambiar cualquier parte de la llave tiene que dar otro documento. Sin
  // esto, dos facturas distintas podrían compartir id y una reserva taparía a la otra.
  it('cambia con la sucursal', () => {
    expect(keplerPayableId('08', 3, 1, 'A-123')).not.toBe(ID_A123);
  });
  it('cambia con el folio', () => {
    expect(keplerPayableId('01', 3, 1, 'A-124')).not.toBe(ID_A123);
  });
  it('cambia con el tipo y con el subtipo de documento', () => {
    expect(keplerPayableId('01', 4, 1, 'A-123')).not.toBe(ID_A123);
    expect(keplerPayableId('01', 3, 2, 'A-123')).not.toBe(ID_A123);
  });
  it('no confunde dos documentos que sólo difieren en dónde cae el separador', () => {
    // '01|3' + '|1|…' vs '01' + '|31|…' — sin separador serían la misma cadena.
    expect(keplerPayableId('01', 31, 1, 'A')).not.toBe(keplerPayableId('01', 3, 11, 'A'));
  });
});

/**
 * `[TP.18]` La deuda derivada **agrupa igual que la capturada**: las dos son facturas del mismo
 * proveedor y la misma sucursal, así que un pago puede cubrir una de cada una (ADR-094 §5). Lo que
 * NO puede es mezclar beneficiarios ni sucursales — la regla de `[TP.16.3]`, que no se reescribe.
 */
describe('[TP.18] paymentGroupKey — el origen derivado se agrupa como factura, no como gasto', () => {
  const capturada = paymentGroupKey('supplier_payable', { supplier_id: 'F', kepler_sucursal: '01' });

  it('una factura derivada y una capturada del mismo proveedor y sucursal se pagan juntas', () => {
    expect(paymentGroupKey('kepler_payable', { supplier_id: 'F', kepler_sucursal: '01' })).toEqual(capturada);
  });

  it('el mismo proveedor en otra sucursal NO se junta (cada pago entra a su centro de costo)', () => {
    const otra = paymentGroupKey('kepler_payable', { supplier_id: 'F', kepler_sucursal: '08' });
    expect(otra.payee).toBe(capturada.payee);
    expect(otra.branch).not.toBe(capturada.branch);
  });

  it('otro proveedor NO se junta: un pago es una transferencia a una sola cuenta', () => {
    expect(paymentGroupKey('kepler_payable', { supplier_id: 'G', kepler_sucursal: '01' }).payee).not.toBe(capturada.payee);
  });

  it('usa el id del proveedor, no su nombre: dos nombres distintos del mismo id son el mismo pago', () => {
    expect(paymentGroupKey('kepler_payable', { supplier_id: 'F', beneficiary: 'FERRERO SA', kepler_sucursal: '01' }))
      .toEqual(paymentGroupKey('kepler_payable', { supplier_id: 'F', beneficiary: 'ferrero', kepler_sucursal: '01' }));
  });

  it('⛔ no se agrupa con un gasto aunque el texto del beneficiario coincida', () => {
    expect(paymentGroupKey('kepler_payable', { supplier_id: 'F', beneficiary: 'CFE', kepler_sucursal: '01' }).payee)
      .not.toBe(paymentGroupKey('budget_expense', { beneficiary: 'CFE' }).payee);
  });
});
