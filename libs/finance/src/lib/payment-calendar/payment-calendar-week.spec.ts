import { clabeValida, isPrepared, paymentGroupKey, weekDates } from './payment-calendar.service';

describe('[TP.16.3] paymentGroupKey — un pago: un beneficiario y una sucursal (centro de costo)', () => {
  const ferrero01 = paymentGroupKey('supplier_payable', { supplier_id: 'F', kepler_sucursal: '01' });
  it('mismo proveedor y misma sucursal → se pueden pagar juntas', () => {
    expect(paymentGroupKey('supplier_payable', { supplier_id: 'F', kepler_sucursal: '01' })).toEqual(ferrero01);
  });
  it('mismo proveedor en OTRA sucursal → otra llave de sucursal (no se juntan)', () => {
    const f08 = paymentGroupKey('supplier_payable', { supplier_id: 'F', kepler_sucursal: '08' });
    expect(f08.payee).toBe(ferrero01.payee);
    expect(f08.branch).not.toBe(ferrero01.branch);
  });
  it('otro proveedor en la misma sucursal → otro beneficiario (no se juntan)', () => {
    expect(paymentGroupKey('supplier_payable', { supplier_id: 'G', kepler_sucursal: '01' }).payee).not.toBe(ferrero01.payee);
  });
  it('sin sucursal (captura manual, gasto, compromiso) no se mezcla con una conocida', () => {
    expect(paymentGroupKey('supplier_payable', { supplier_id: 'F', kepler_sucursal: null }).branch).not.toBe(ferrero01.branch);
    expect(paymentGroupKey('budget_expense', { beneficiary: ' CFE ' })).toEqual(paymentGroupKey('budget_expense', { beneficiary: 'cfe' }));
  });
});

describe('[TP.16] isPrepared — lo que Caja General necesita para dispersar', () => {
  it('sin método no está preparado', () => {
    expect(isPrepared({ payment_method: null, bank_account_id: 'o1', destination_account_text: 'BBVA · CLABE x' })).toBe(false);
  });
  it('transferencia pide origen Y destino (antes bastaba uno)', () => {
    expect(isPrepared({ payment_method: 'transferencia', bank_account_id: 'o1', destination_account_text: 'BBVA · CLABE x' })).toBe(true);
    expect(isPrepared({ payment_method: 'transferencia', bank_account_id: null, destination_account_text: 'BBVA · CLABE x' })).toBe(false);
    expect(isPrepared({ payment_method: 'transferencia', bank_account_id: 'o1', destination_account_text: '  ' })).toBe(false);
  });
  it('cheque y cargo automático piden origen; efectivo no', () => {
    expect(isPrepared({ payment_method: 'cheque', bank_account_id: null })).toBe(false);
    expect(isPrepared({ payment_method: 'cargo_automatico', bank_account_id: 'o1' })).toBe(true);
    expect(isPrepared({ payment_method: 'efectivo', bank_account_id: null })).toBe(true);
  });
});

describe('[TP.16] weekDates — la semana del Calendario va de lunes a domingo', () => {
  it('desde un viernes da su lunes y su domingo', () => {
    expect(weekDates('2026-10-16')).toEqual([
      '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18',
    ]);
  });
  it('un lunes es su propio inicio', () => {
    expect(weekDates('2026-10-19')[0]).toBe('2026-10-19');
  });
  it('un domingo pertenece a la semana que TERMINA ese día (no a la siguiente)', () => {
    expect(weekDates('2026-10-25')).toEqual([
      '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25',
    ]);
  });
  it('cruza mes y año sin perder ni repetir días', () => {
    expect(weekDates('2026-12-31')).toEqual([
      '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03',
    ]);
  });
});

describe('[TP.16] clabeValida — dígito de control de Banxico', () => {
  it('acepta CLABEs con control correcto', () => {
    expect(clabeValida('032180000118359719')).toBe(true);
    expect(clabeValida('002010077777777771')).toBe(true);
  });
  it('rechaza un error de dedo en el último dígito', () => {
    expect(clabeValida('032180000118359710')).toBe(false);
  });
  it('rechaza dos dígitos transpuestos', () => {
    expect(clabeValida('032180000118395719')).toBe(false);
  });
  it('rechaza lo que no son 18 dígitos', () => {
    expect(clabeValida('03218000011835971')).toBe(false);
    expect(clabeValida('03218000011835971X')).toBe(false);
    expect(clabeValida('')).toBe(false);
  });
});
