import { armarSuficiencia, conUnPagoMas, masDias, type EntradaDeSuficiencia, type PagoConCuenta, type SaldoDeLaCuenta, type SerieEsperada } from './suficiencia-de-cuentas.contract';

const HOY = '2026-11-12';
const C = { id: 'c1', bank: 'SANTANDER', account_label: '0001', alias: null };
const serie = (fecha: string, importe: number, extra: Partial<SerieEsperada> = {}): SerieEsperada => ({
  bank_account_id: 'c1', series_key: `fixed_amount|c1|DOMICILIACION PAGO SERVICIO|${importe}`, rule: 'fixed_amount',
  concept_head: 'DOMICILIACION PAGO SERVICIO', latest_concept: 'DOMICILIACION PAGO SERVICIO', next_expected_date: fecha,
  expected_monthly_amount: importe, ...extra,
});
const pago = (fecha: string, importe: number, extra: Partial<PagoConCuenta> = {}): PagoConCuenta => ({
  allocation_id: `p-${fecha}-${importe}`, bank_account_id: 'c1', fecha, importe, ejecutado: false, ...extra,
});
const entrada = (saldo: SaldoDeLaCuenta | null, series: SerieEsperada[] | null, pagos: PagoConCuenta[] = [], extra: Partial<EntradaDeSuficiencia> = {}): EntradaDeSuficiencia => ({
  hoy: HOY, hasta: masDias(HOY, 7), cuentas: [C], saldos: new Map([['c1', saldo]]), series, pagos,
  sinCuenta: { pagos: 0, importe: 0 }, ...extra,
});
const saldo = (s: number, fecha = HOY): SaldoDeLaCuenta => ({ saldo: s, fecha, fuente: 'banco' });
const una = (e: EntradaDeSuficiencia) => armarSuficiencia(e).cuentas[0];

describe('[PGP.218] ¿le alcanza a la cuenta para lo programado y para los cargos que el banco cobra solo?', () => {
  it('el caso de Santander del 12-nov: $31,144.45 contra 4 cargos de la arrendadora el 14 → faltan $48,731.55, sin programa', () => {
    const r = una(entrada(saldo(31144.45), [serie('2026-11-14', 6353), serie('2026-11-14', 10590), serie('2026-11-14', 21559), serie('2026-11-14', 41374)]));
    expect(r.estado).toBe('no_alcanza');
    expect(r.cargos_total).toBe(79876);
    expect(r.disponible).toBe(-48731.55);
    expect(r.faltan).toBe(48731.55);
    expect(r.programa_excede).toBe(false);
    // El primero que no cubre, en orden: 6,353 y 10,590 sí caben (16,943 de 31,144); 21,559 ya no.
    expect(r.cargo_sin_cubrir).toMatchObject({ importe: 21559, fecha: '2026-11-14', faltan: 7357.55 });
    // Cada cargo dice si cabe: los dos primeros sí, los otros dos no.
    expect(r.cargos.map((x) => [x.importe, x.cubierto])).toEqual([[6353, true], [10590, true], [21559, false], [41374, false]]);
  });

  it('el caso de BanBajío del 16-jul: lo programado solo pasa el saldo → no alcanza, sin cargo que nombrar', () => {
    const r = una(entrada(saldo(729576.86, '2026-07-16'), [], [pago('2026-07-17', 738682)], { hoy: '2026-07-16', hasta: '2026-07-23' }));
    expect(r.estado).toBe('no_alcanza');
    expect(r.programa_excede).toBe(true);
    expect(r.faltan).toBe(9105.14);
    expect(r.cargo_sin_cubrir).toBeNull();
  });

  it('NEGATIVA: sin cargos esperados y con lo programado dentro del saldo, no hay aviso', () => {
    const r = una(entrada(saldo(100000), [], [pago('2026-11-13', 60000)]));
    expect(r.estado).toBe('alcanza');
    expect(r.cargo_sin_cubrir).toBeNull();
    expect(r.programa_excede).toBe(false);
    expect(r.disponible).toBe(40000);
    expect(r.faltan).toBe(0);
  });

  it('el cargo va antes que los pagos de su día: el pago es el que no cabe, no el cargo', () => {
    const r = una(entrada(saldo(50000), [serie('2026-11-14', 30000)], [pago('2026-11-14', 30000)]));
    expect(r.estado).toBe('no_alcanza');
    expect(r.cargo_sin_cubrir).toBeNull();
    expect(r.faltan).toBe(10000);
  });

  it('el pago de un día anterior al cargo sí se lleva el dinero del cargo', () => {
    const r = una(entrada(saldo(50000), [serie('2026-11-14', 30000)], [pago('2026-11-13', 30000)]));
    expect(r.cargo_sin_cubrir).toMatchObject({ fecha: '2026-11-14', faltan: 10000 });
  });

  it('NEGATIVA: sin saldo se dice «no medido», nunca «alcanza»', () => {
    const r = una(entrada(null, [serie('2026-11-14', 100)]));
    expect(r.estado).toBe('no_medido');
    expect(r.disponible).toBeNull();
    expect(r.faltan).toBeNull();
    expect(r.cargos_total).toBe(100);
    expect(r.cargos[0].cubierto).toBeNull();
  });

  it('el saldo de hace más de 2 días se dice; el de hace 2, no', () => {
    expect(una(entrada(saldo(1000, '2026-11-07'), [])).saldo_dias).toBe(5);
    expect(una(entrada(saldo(1000, '2026-11-07'), [])).saldo_viejo).toBe(true);
    expect(una(entrada(saldo(1000, '2026-11-10'), [])).saldo_viejo).toBe(false);
  });

  it('el cargo atrasado (su fecha ya pasó y el banco no lo ha cobrado) sigue esperado y se dice', () => {
    const r = una(entrada(saldo(1000), [serie('2026-11-09', 5000)]));
    expect(r.cargos[0]).toMatchObject({ atrasado: true, fecha: '2026-11-09' });
    expect(r.cargo_sin_cubrir).toMatchObject({ faltan: 4000 });
  });

  it('el caso de Santander 5565 del 26-nov: un cargo con más de 31 días de atraso ya no se cuenta; se lista aparte', () => {
    // IVA esperado el 1-ago, saldo del libro en cero desde el 3-ago: antes decía «no alcanza, faltan $83.20».
    const r = una(entrada(saldo(0, '2026-08-03'), [serie('2026-08-01', 83.2, { concept_head: 'I V A' })], [], { hoy: '2026-11-26', hasta: '2026-12-03' }));
    expect(r.cargos).toHaveLength(0);
    expect(r.cargos_total).toBe(0);
    expect(r.cargos_detenidos).toMatchObject([{ fecha: '2026-08-01', importe: 83.2, atrasado: true, cubierto: null }]);
    expect(r.estado).toBe('alcanza');
    expect(r.cargo_sin_cubrir).toBeNull();
  });

  it('NEGATIVA (el borde): con 31 días de atraso todavía se cuenta y se le busca dinero; con 32, ya no', () => {
    const a31 = una(entrada(saldo(1000), [serie(masDias(HOY, -31), 5000)]));
    expect(a31.cargos_detenidos).toHaveLength(0);
    expect(a31.cargo_sin_cubrir).toMatchObject({ faltan: 4000 });
    const a32 = una(entrada(saldo(1000), [serie(masDias(HOY, -32), 5000)]));
    expect(a32.cargos).toHaveLength(0);
    expect(a32.cargos_detenidos).toHaveLength(1);
    expect(a32.estado).toBe('alcanza');
  });

  it('fuera de la ventana no cuenta', () => {
    expect(una(entrada(saldo(1000), [serie('2026-11-20', 5000)])).cargos).toHaveLength(0);
    expect(una(entrada(saldo(1000), [], [pago('2026-11-25', 5000)])).programado).toBe(0);
  });

  it('el interés variable se marca estimado', () => {
    const r = una(entrada(saldo(100000), [serie('2026-11-15', 10529.5, { rule: 'variable_amount' })]));
    expect(r.cargos[0].estimado).toBe(true);
  });

  it('lo pagado después del día del saldo resta (la descarga no lo muestra); lo pagado antes ya está en el saldo', () => {
    const despues = una(entrada(saldo(10000, '2026-11-10'), [], [pago('2026-11-11', 4000, { ejecutado: true })]));
    expect(despues.programado).toBe(4000);
    expect(despues.pagos[0].ejecutado_sin_descarga).toBe(true);
    const antes = una(entrada(saldo(10000, '2026-11-11'), [], [pago('2026-11-10', 4000, { ejecutado: true })]));
    expect(antes.programado).toBe(0);
    // Sin saldo no se sabe si ya está: no se cuenta lo ejecutado.
    expect(una(entrada(null, [], [pago('2026-11-11', 4000, { ejecutado: true })])).programado).toBe(0);
  });

  it('el saldo mínimo registrado se aparta; sin registro se dice null y cuenta cero', () => {
    const con = una(entrada(saldo(10000), [serie('2026-11-14', 8000)], [], { minimos: new Map([['c1', 3000]]) }));
    expect(con.saldo_minimo).toBe(3000);
    expect(con.cargo_sin_cubrir).toMatchObject({ faltan: 1000 });
    expect(una(entrada(saldo(10000), [serie('2026-11-14', 8000)])).saldo_minimo).toBeNull();
  });

  it('sin la vista de cargos: cargos_medidos = false (no «cero cargos»)', () => {
    const s = armarSuficiencia(entrada(saldo(1000), null));
    expect(s.cargos_medidos).toBe(false);
    expect(armarSuficiencia(entrada(saldo(1000), [])).cargos_medidos).toBe(true);
  });

  describe('con un pago más (la pregunta de «Preparar pago»)', () => {
    const cuenta = () => una(entrada(saldo(50000), [serie('2026-11-14', 30000)], [pago('2026-11-13', 10000)]));
    it('el pago antes del cargo se lleva su dinero: nombra el cargo y lo que falta', () => {
      const r = conUnPagoMas(cuenta(), HOY, { allocation_id: 'nuevo', fecha: '2026-11-13', importe: 25000 });
      expect(r).toMatchObject({ disponible: -15000, faltan: 15000, ya_contado: false });
      expect(r?.cargo_sin_cubrir).toMatchObject({ fecha: '2026-11-14', faltan: 15000 });
    });
    it('el mismo pago después del cargo: el cargo sí cabe, pero la cuenta queda corta', () => {
      const r = conUnPagoMas(cuenta(), HOY, { allocation_id: 'nuevo', fecha: '2026-11-15', importe: 25000 });
      expect(r?.cargo_sin_cubrir).toBeNull();
      expect(r?.faltan).toBe(15000);
    });
    it('NEGATIVA: si cabe, no falta nada', () => {
      const r = conUnPagoMas(cuenta(), HOY, { allocation_id: 'nuevo', fecha: '2026-11-13', importe: 5000 });
      expect(r).toMatchObject({ disponible: 5000, faltan: 0, cargo_sin_cubrir: null });
    });
    it('re-preparar desde la misma cuenta no lo cuenta dos veces', () => {
      const c = cuenta();
      const r = conUnPagoMas(c, HOY, { allocation_id: c.pagos[0].allocation_id, fecha: '2026-11-13', importe: 10000 });
      expect(r).toMatchObject({ ya_contado: true, disponible: 10000, cargo_sin_cubrir: null });
    });
    it('NEGATIVA: sin saldo no se sabe (null), nunca «cabe»', () => {
      expect(conUnPagoMas(una(entrada(null, [])), HOY, { allocation_id: 'x', fecha: HOY, importe: 1 })).toBeNull();
    });
  });

  it('los centavos no se pierden al sumar', () => {
    const r = una(entrada(saldo(0.3), [serie('2026-11-14', 0.1), serie('2026-11-14', 0.2, { series_key: 'b' })]));
    expect(r.cargos_total).toBe(0.3);
    expect(r.disponible).toBe(0);
    expect(r.estado).toBe('alcanza');
  });
});
