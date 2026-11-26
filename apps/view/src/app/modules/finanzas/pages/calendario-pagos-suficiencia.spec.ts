import { armarSuficiencia, type EntradaDeSuficiencia, type PaymentCalendarSuficiencia, type SerieEsperada } from '@megadulces/contracts';
import { avisoDelOrigen, cargosDelDesglose, cuentasCortas, lineaDeLaSemana, nombreCuenta } from './calendario-pagos-suficiencia';

const HOY = '2026-11-25';
const f = { dinero: (n: number) => `$${n.toFixed(2)}`, dia: (iso: string) => iso.slice(5) };
const SANT = { id: 's', bank: 'SANTANDER', account_label: '2169', alias: null };
const BAJ = { id: 'b', bank: 'BBAJIO', account_label: '4166', alias: 'Pagos' };
const serie = (cuenta: string, fecha: string, importe: number, extra: Partial<SerieEsperada> = {}): SerieEsperada => ({
  bank_account_id: cuenta, series_key: `${cuenta}|${importe}`, rule: 'fixed_amount', concept_head: 'DOMICILIACION PAGO SERVICIO',
  latest_concept: null, next_expected_date: fecha, expected_monthly_amount: importe, ...extra,
});
function suf(p: Partial<EntradaDeSuficiencia> = {}): PaymentCalendarSuficiencia {
  return armarSuficiencia({
    hoy: HOY, hasta: '2026-12-02', cuentas: [SANT, BAJ],
    saldos: new Map([['s', { saldo: 5183.91, fecha: '2026-11-24', fuente: 'banco' as const }], ['b', { saldo: 139837.39, fecha: '2026-11-24', fuente: 'banco' as const }]]),
    series: [serie('s', '2026-11-24', 21490), serie('s', '2026-11-24', 14397)], pagos: [], sinCuenta: { pagos: 0, importe: 0 }, ...p,
  });
}

describe('[PGP.218] lo que el Calendario dice del dinero de cada cuenta de origen', () => {
  it('el nombre de la cuenta es el del selector de origen', () => {
    expect(nombreCuenta(SANT)).toBe('SANTANDER 2169');
    expect(nombreCuenta(BAJ)).toBe('Pagos (BBAJIO)');
  });

  it('el caso de hoy: una cuenta no cubre el cargo de la arrendadora → la línea nombra cuenta, día y lo que falta', () => {
    const l = lineaDeLaSemana(suf(), false, f);
    expect(l).toEqual({ tipo: 'aviso', texto: 'SANTANDER 2169 no cubre el cargo del banco del 11-24: faltan $16306.09' });
  });

  it('NEGATIVA: si todo alcanza no hay línea', () => {
    expect(lineaDeLaSemana(suf({ series: [] }), false, f)).toBeNull();
  });

  it('no se pudo leer o no se midió: se dice, nunca se calla como si alcanzara', () => {
    expect(lineaDeLaSemana(null, true, f)?.tipo).toBe('quieta');
    expect(lineaDeLaSemana(suf({ series: null }), false, f)).toMatchObject({ tipo: 'quieta' });
    expect(lineaDeLaSemana(null, false, f)).toBeNull();
  });

  it('sin los cargos medidos, la cuenta que no cubre lo preparado SE NOMBRA igual (el caso de la prueba visual del 26-nov)', () => {
    const p = [{ allocation_id: 'p1', bank_account_id: 'b', fecha: '2026-11-26', importe: 750744.33, ejecutado: false }];
    expect(lineaDeLaSemana(suf({ series: null, pagos: p }), false, f)).toEqual({
      tipo: 'aviso', texto: 'Pagos (BBAJIO): lo preparado pasa su saldo por $610906.94 · sin contar los cargos del banco, que no se pudieron revisar',
    });
    // NEGATIVA: con los cargos medidos, la misma cuenta no lleva la nota.
    expect(lineaDeLaSemana(suf({ series: [], pagos: p }), false, f)?.texto).not.toContain('no se pudieron revisar');
  });

  it('un cargo con más de un mes de atraso no hace saltar la línea (el IVA del 1-ago de Santander 5565)', () => {
    const saldos = new Map([['s', { saldo: 0, fecha: '2026-08-03', fuente: 'libro' as const }], ['b', { saldo: 139837.39, fecha: '2026-11-24', fuente: 'banco' as const }]]);
    expect(lineaDeLaSemana(suf({ saldos, series: [serie('s', '2026-08-01', 83.2)] }), false, f)).toBeNull();
    // NEGATIVA: el mismo cargo esperado hace una semana sí la hace saltar.
    expect(lineaDeLaSemana(suf({ saldos, series: [serie('s', '2026-11-18', 83.2)] }), false, f)?.tipo).toBe('aviso');
  });

  it('varias cuentas: las cuenta, suma lo que falta y dice cuántas dejan cargos sin cubrir; primero las de cargo', () => {
    const s = suf({ pagos: [{ allocation_id: 'p1', bank_account_id: 'b', fecha: '2026-11-26', importe: 750744.33, ejecutado: false }] });
    expect(cuentasCortas(s).map((c) => c.bank_account_id)).toEqual(['s', 'b']);
    expect(lineaDeLaSemana(s, false, f)?.texto).toBe('2 cuentas no alcanzan para lo que sale en 7 días: faltan $641610.03 · 1 con cargos del banco sin cubrir');
    // 2169: 21,490 + 14,397 − 5,183.91 = 30,703.09 · 4166: 750,744.33 − 139,837.39 = 610,906.94
  });

  it('lo preparado arriba del saldo, sin cargo, también se dice', () => {
    const s = suf({ series: [], pagos: [{ allocation_id: 'p1', bank_account_id: 'b', fecha: '2026-11-26', importe: 750744.33, ejecutado: false }] });
    expect(lineaDeLaSemana(s, false, f)?.texto).toBe('Pagos (BBAJIO): lo preparado pasa su saldo por $610906.94');
  });

  it('el saldo viejo se dice en la línea', () => {
    const s = suf({ saldos: new Map([['s', { saldo: 5183.91, fecha: '2026-11-19', fuente: 'banco' as const }], ['b', null]]) });
    expect(lineaDeLaSemana(s, false, f)?.texto).toContain('(saldo de hace 6 días)');
  });

  it('el desglose pone primero los cargos de las cuentas cortas; los de las que alcanzan van aparte, con su total', () => {
    // 2169 no cubre sus 2 cargos; 4166 alcanza y tiene 1 cargo.
    const s = suf({ series: [serie('s', '2026-11-24', 21490), serie('s', '2026-11-24', 14397), serie('b', '2026-11-27', 830), serie('b', '2026-11-26', 132.8)] });
    const d = cargosDelDesglose(s);
    expect(d.deCortas.map((x) => [x.cuenta, x.importe])).toEqual([['SANTANDER 2169', 21490], ['SANTANDER 2169', 14397]]);
    expect(d.otros.map((x) => x.importe)).toEqual([132.8, 830]);
    expect(d.otrosTotal).toBe(962.8);
    // NEGATIVA: si ninguna cuenta se queda corta, no hay «de cortas» y todos van aparte.
    const todas = cargosDelDesglose(suf({ series: [serie('b', '2026-11-27', 830)] }));
    expect(todas.deCortas).toHaveLength(0);
    expect(todas.otros).toHaveLength(1);
    expect(cargosDelDesglose(null)).toEqual({ deCortas: [], otros: [], otrosTotal: 0 });
  });

  describe('Preparar pago: lo que pasa con ESTE pago en la cuenta elegida', () => {
    const pago = (importe: number, fecha = '2026-11-26') => ({ allocation_id: 'nuevo', fecha, importe });
    it('deja sin cubrir un cargo: lo nombra con su concepto, su importe y lo que falta', () => {
      const s = suf({ series: [serie('b', '2026-11-27', 30000)] });
      const a = avisoDelOrigen(s, false, 'b', pago(120000), f);
      expect(a?.mal).toBe(true);
      expect(a?.texto).toBe('Con este pago, Pagos (BBAJIO) no cubre el cargo del banco del 11-27 (DOMICILIACION PAGO SERVICIO, $30000.00): faltan $10162.61. Saldo $139837.39 al 11-24.');
    });
    it('cabe: lo dice en voz baja, con lo que queda', () => {
      const a = avisoDelOrigen(suf({ series: [] }), false, 'b', pago(100000), f);
      expect(a).toEqual({ mal: false, texto: 'Pagos (BBAJIO): saldo $139837.39 al 11-24. Con este pago quedan $39837.39.' });
    });
    it('queda corta sin cargo de por medio', () => {
      const a = avisoDelOrigen(suf({ series: [] }), false, 'b', pago(150000), f);
      expect(a).toEqual({ mal: true, texto: 'Con este pago, Pagos (BBAJIO) queda corta por $10162.61: saldo $139837.39 al 11-24.' });
    });
    it('NEGATIVA: sin saldo medido no dice que cabe', () => {
      const s = suf({ saldos: new Map([['s', null], ['b', null]]) });
      expect(avisoDelOrigen(s, false, 'b', pago(1), f)).toEqual({ mal: false, texto: 'Pagos (BBAJIO): sin saldo medido; no se sabe si cubre este pago ni sus cargos del banco.' });
    });
    it('sin cuenta elegida no dice nada; una cuenta sin saldo llevado se dice', () => {
      expect(avisoDelOrigen(suf(), false, null, pago(1), f)).toBeNull();
      expect(avisoDelOrigen(suf(), false, 'caja', pago(1), f)?.texto).toContain('no se lleva saldo');
    });
    it('re-preparar desde la misma cuenta no cuenta el pago dos veces', () => {
      const s = suf({ series: [], pagos: [{ allocation_id: 'nuevo', bank_account_id: 'b', fecha: '2026-11-26', importe: 100000, ejecutado: false }] });
      expect(avisoDelOrigen(s, false, 'b', pago(100000), f)).toEqual({ mal: false, texto: 'Pagos (BBAJIO): saldo $139837.39 al 11-24. Con este pago quedan $39837.39.' });
    });
    it('sin los cargos medidos lo dice', () => {
      expect(avisoDelOrigen(suf({ series: null }), false, 'b', pago(1), f)?.texto).toContain('no se midieron');
    });
  });
});
