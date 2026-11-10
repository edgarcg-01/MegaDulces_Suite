import {
  armarComisionesKepler, bloquesDeTarjeta, cargoDeTarjeta, cruzarConKepler, depositoDeTarjeta, diaDeVentaDelTexto, gruposPorDiaDeVenta, resolverBloque, revisarBloque,
  type CargoTarjeta, type DepositoKepler, type GrupoComisiones, type PagoKeplerCapturado, type PlantillaComisiones, type RenglonDescarga,
} from './comisiones-kepler.armador';

/**
 * `[CB.62]` Las comisiones de la terminal en el idioma de Kepler. Los dos controles son casos reales medidos en
 * `kepler_ods`: la venta del 1-oct de Morelia Madero (`07`, gasto `X-A-10 0000063`, capturado a mano el 22-oct)
 * y el lunes 3-nov de BBVA 4885, que Finanzas repartió en los gastos del 30-oct, 31-oct y 2-nov.
 */
const cargo = (id: string, importe: number, tipo: 'comision' | 'iva', o: Partial<CargoTarjeta> = {}): CargoTarjeta => ({
  id, cuenta: '4176', fecha: '2026-10-02', seq: Number(id.replace(/\D/g, '')) || 0, importe, tipo, ...o,
});

// Los 8 cargos del 2-oct en BBVA 4176, terminal 175096833 (Madero), en el orden en que Kepler los pagó.
const MADERO: CargoTarjeta[] = [
  cargo('c1', 22.13, 'comision'), cargo('c2', 3.54, 'iva'), cargo('c3', 40.9, 'comision'), cargo('c4', 6.54, 'iva'),
  cargo('c5', 63.03, 'comision'), cargo('c6', 10.08, 'iva'), cargo('c7', 538.68, 'comision'), cargo('c8', 86.19, 'iva'),
];
const grupo = (o: Partial<GrupoComisiones> = {}): GrupoComisiones => ({ sucursal: '07', diaVenta: '2026-10-01', acreedor: 'GB004', cargos: MADERO, ...o });
const plantilla = (o: Partial<PlantillaComisiones> = {}): PlantillaComisiones => ({
  acreedor: 'GB004', nombre: 'BBVA MEXICO SA', domicilio: ['PASEO DE LA REFORMA 510', 'COL JUAREZ ALCANDIA CUAHUTEMOC', 'CIUDAD DE MEXICO MEXICO'],
  referenciaGasto: 'M.M.', areaGasto: 'FINANZAS', proyecto: '9-04-26-10', departamento: '1-02-32-00', conceptoPago: '012',
  sucursalTexto: 'MADERO', sucursalNombre: 'MORELIA MADERO', cuentaAcreedor: '201', ...o,
});

describe('[CB.62] armarComisionesKepler — lo que Finanzas captura a mano', () => {
  it('Madero, venta del 1-oct: el mismo total, IVA, renglones e IVA proporcional que Kepler', () => {
    const r = armarComisionesKepler(grupo(), plantilla());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // kdm1 del gasto 0000063 y su solicitud 0000067: c14 106.35, c16 771.09.
    expect(r.plan.total).toBe(771.09);
    expect(r.plan.iva).toBe(106.35);
    expect(r.plan.gasto.kdm1).toMatchObject({ c9: '2026-10-01', c10: 'GB004', c14: 106.35, c16: 771.09, c42: 771.09, c31: 'Gas', c36: 'A', c37: 15, c38: 1, c43: 'N', c90: '01', c67: 'SUITE' });
    expect(r.plan.solicitud.kdm1).toMatchObject({ c9: '2026-10-01', c14: 106.35, c16: 771.09, c31: 'Sol', c43: 'F', c24: 'COMISIONES MORELIA MADERO VTA 01/10/2026' });
    // kdm6: un renglón por comisión, en ese orden; el IVA no hace renglón.
    expect(r.plan.gasto.kdm6.map((x) => x.c11)).toEqual([22.13, 40.9, 63.03, 538.68]);
    expect(r.plan.gasto.kdm6[0]).toEqual({ c7: 1, c8: '611-003', c9: 'COMISIONES BANCARIAS POR VENTA', c10: 'C', c11: 22.13, c12: '199', c13: '9-04-26-10', c16: '1-02-32-00' });
    expect(r.plan.solicitud.kdm6).toEqual(r.plan.gasto.kdm6);
    // Un X-D-26 por cargo: los pagos 0000232 (22.13 → c81 3.05, c82 3.0522059682) y 0000233 (IVA 3.54 → 0.49, 0.4882426176).
    expect(r.plan.pagos).toHaveLength(8);
    expect(r.plan.pagos[0].kdm1).toMatchObject({ c9: '2026-10-02', c11: 'COMISIONES', c12: '012', c16: 22.13, c42: 22.13, c45: '4176', c31: 'Tra', c43: 'N', c81: 3.05, c82: 3.0522059682, c48: 'MADERO' });
    expect(r.plan.pagos[1].kdm1).toMatchObject({ c11: 'IVA', c16: 3.54, c81: 0.49, c82: 0.4882426176 });
    expect(r.plan.pagos.reduce((s, p) => s + Math.round(Number(p.kdm1.c16) * 100), 0)).toBe(77109);
  });

  it('Madero: la póliza D del gasto (1275), la E de cada pago (207, 208), su CxP y su aplicación, como en kdc22610/kdxe/kdxf', () => {
    const r = armarComisionesKepler(grupo(), plantilla());
    if (!r.ok) throw new Error(r.motivos.join('; '));
    const pol = r.plan.gasto.poliza;
    expect(pol.tipo).toBe('D');
    expect(pol.fecha).toBe('2026-10-01');
    expect(pol.renglones.map((x) => [x.c10, x.c3, x.c4, x.c5])).toEqual([
      [1, '201', 'A', 771.09], [2, '122-001', 'C', 106.35], [3, '611-003', 'C', 22.13], [4, '611-003', 'C', 40.9], [5, '611-003', 'C', 63.03], [6, '611-003', 'C', 538.68],
    ]);
    expect(pol.renglones[0]).toMatchObject({ c6: 'BBVA MEXICO SA', c7: 'M.M.', c9: 771.09 });
    expect(pol.renglones[2]).toMatchObject({ c6: 'COMISIONES BANCARIAS POR VENTA', c7: 'M.M.', c13: '1-02-32-00', c20: '199', c21: '9-04-26-10' });
    expect(r.plan.gasto.kdxe).toEqual({ c2: 'GB004', c3: 'A', c4: 10, c5: 1, c7: '2026-10-01', c8: 'PESOS', c10: '2026-10-01', c11: 771.09, c13: 106.35, c16: 'M.M.', c17: 771.09, c20: 0, c28: 'X', c29: 'A' });
    const [com, iva] = r.plan.pagos;
    expect(com.poliza).toEqual({ tipo: 'E', fecha: '2026-10-02', renglones: [
      { c10: 1, c3: '201', c4: 'C', c5: 22.13, c9: 22.13, c6: 'BBVA MEXICO SA', c7: 'COMISIONES' },
      { c10: 2, c3: '102', c4: 'A', c5: 22.13, c9: 22.13, c6: 'BBVA MEXICO SA', c7: 'COMISIONES' },
    ] });
    expect(iva.poliza.renglones[0]).toMatchObject({ c7: 'IVA', c5: 3.54 });
    expect(iva.kdxe).toEqual({ c2: 'GB004', c3: 'D', c4: 26, c5: 1, c7: '2026-10-02', c8: 'PESOS', c11: 3.54, c16: 'IVA', c17: 3.54, c18: '012', c20: 0, c22: '4176', c28: 'X', c29: 'C' });
    expect(com.kdxf).toEqual({ c1: '07', c2: 'GB004', c3: '2026-10-02', c4: 26, c5: 1, c7: 10, c8: 1, c10: 22.13, c11: 22.13 });
    // Cuadra: cargos = abonos en cada póliza.
    for (const p of [pol, ...r.plan.pagos.map((x) => x.poliza)]) {
      const s = (ca: string) => p.renglones.filter((x) => x.c4 === ca).reduce((t, x) => t + Math.round(Number(x.c5) * 100), 0);
      expect(s('C')).toBe(s('A'));
    }
  });

  it('⛔ la cuenta del acreedor sólo es 201 o 203 (una plantilla con 511 no se copia)', () => {
    expect(armarComisionesKepler(grupo(), plantilla({ cuentaAcreedor: '511' })).ok).toBe(false);
    expect(armarComisionesKepler(grupo(), plantilla({ cuentaAcreedor: '' })).ok).toBe(false);
  });

  it('⛔ falta un IVA (el banco lo mandó en otra descarga): no se arma un gasto que no cuadra al 16 %', () => {
    const r = armarComisionesKepler(grupo({ cargos: MADERO.filter((c) => c.id !== 'c8') }), plantilla());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivos.join(' ')).toMatch(/16 %/);
  });

  it('⛔ un IVA solo no hace gasto', () => {
    const r = armarComisionesKepler(grupo({ cargos: [MADERO[1]] }), plantilla());
    expect(r.ok).toBe(false);
  });

  it('⛔ la plantilla de otro banco o sin departamento no se usa', () => {
    expect(armarComisionesKepler(grupo(), plantilla({ acreedor: 'GB001' })).ok).toBe(false);
    expect(armarComisionesKepler(grupo(), plantilla({ departamento: '' })).ok).toBe(false);
    expect(armarComisionesKepler(grupo({ acreedor: 'CA041' }), plantilla({ acreedor: 'CA041' })).ok).toBe(false);
  });

  it('⛔ un cargo anterior al día de venta o sin cuenta', () => {
    expect(armarComisionesKepler(grupo({ diaVenta: '2026-10-03' }), plantilla()).ok).toBe(false);
    expect(armarComisionesKepler(grupo({ cargos: MADERO.map((c, i) => (i === 0 ? { ...c, cuenta: '' } : c)) }), plantilla()).ok).toBe(false);
  });
});

describe('[CB.62] reconocer la tarjeta en el texto del banco', () => {
  const r = (concepto: string, entra: number, sale: number) => ({ concepto, entra, sale });

  it('BBVA: comisión e IVA de crédito, débito, internacional y AMEX, con la terminal sin su prefijo', () => {
    expect(cargoDeTarjeta(r('APLI TASA DE DES CREDITO/175096809 TERMINALES PUNTO DE VENTA', 0, 9.35))).toEqual({ tipo: 'comision', terminal: '5096809', clase: 'CREDITO' });
    expect(cargoDeTarjeta(r('IVA TASA DE DESC DEBITO/175096809 TERMINALES PUNTO DE VENTA', 0, 0.56))).toEqual({ tipo: 'iva', terminal: '5096809', clase: 'DEBITO' });
    expect(cargoDeTarjeta(r('COM VTAS TDC INTER/175096833 175096833', 0, 4))).toMatchObject({ tipo: 'comision', clase: 'INTER' });
    expect(cargoDeTarjeta(r('IVA COM. VTA. NAL. AMEX/175096833 175096833', 0, 1))).toMatchObject({ tipo: 'iva', clase: 'AMEX_NAL' });
    expect(depositoDeTarjeta(r('VENTAS CREDITO/145096809 TERMINALES PUNTO DE VENTA', 465.62, 0))).toEqual({ terminal: '5096809', clase: 'CREDITO' });
  });

  it('Banorte: la afiliación con su letra', () => {
    expect(cargoDeTarjeta(r('COMISION 08991964CAPLICACION DE TASAS DE DESCUENTO DE CREDITO; FAMILIA:VENT', 0, 355.52))).toEqual({ tipo: 'comision', terminal: '08991964C', clase: 'BTE' });
    expect(cargoDeTarjeta(r('IVA COMISION 08991964D', 0, 58.82))).toEqual({ tipo: 'iva', terminal: '08991964D', clase: 'BTE' });
    expect(depositoDeTarjeta(r('DULCERIA LOS ALTOS 08991964C', 47404.28, 0))).toEqual({ terminal: '08991964C', clase: 'BTE' });
  });

  it('⛔ el depósito de la venta NO es comisión (672 movs / $5M que una regla por «TERMINALES PUNTO DE VENTA» volvería gasto)', () => {
    expect(cargoDeTarjeta(r('VENTAS CREDITO/145096809 TERMINALES PUNTO DE VENTA', 13812.98, 0))).toBeNull();
    // Una reversa del depósito (sale) tampoco es comisión ni depósito.
    expect(cargoDeTarjeta(r('VENTAS DEBITO/145096809 TERMINALES PUNTO DE VENTA', 0, 208.2))).toBeNull();
    expect(depositoDeTarjeta(r('VENTAS DEBITO/145096809 TERMINALES PUNTO DE VENTA', 0, 208.2))).toBeNull();
    // Cuotas fijas de Santander: fuera de este armador.
    expect(cargoDeTarjeta(r('RENTA TERMINAL PUNTO DE VENTA', 0, 200))).toBeNull();
    expect(cargoDeTarjeta(r('COMISION', 0, 8.97))).toBeNull();
  });
});

describe('[CB.62] bloques y día de venta — el lunes 3-nov de BBVA 4885', () => {
  const L = (seq: number, concepto: string, entra: number, sale: number): RenglonDescarga => ({ id: `s${seq}`, cuenta: '4885', fecha: '2026-11-03', seq, concepto, entra, sale });
  const V = (k: string, t = '145096809') => `VENTAS ${k}/${t} TERMINALES PUNTO DE VENTA`;
  const C = (k: string) => `APLI TASA DE DES ${k}/175096809 TERMINALES PUNTO DE VENTA`;
  const I = (k: string) => `IVA TASA DE DESC ${k}/175096809 TERMINALES PUNTO DE VENTA`;
  // Tres de los cinco bloques reales (seq de la descarga); Kepler los puso en 2-nov, 30-oct y 31-oct.
  const DESCARGA = [
    L(0, V('CREDITO'), 465.62, 0), L(1, C('CREDITO'), 0, 9.35), L(2, I('CREDITO'), 0, 1.5),
    L(3, V('DEBITO'), 208.2, 0), L(4, C('DEBITO'), 0, 3.51), L(5, I('DEBITO'), 0, 0.56),
    L(57, V('CREDITO'), 2948.05, 0), L(58, C('CREDITO'), 0, 59.25), L(59, I('CREDITO'), 0, 9.48),
    L(108, V('CREDITO'), 23141.78, 0), L(109, C('CREDITO'), 0, 465.06), L(110, I('CREDITO'), 0, 74.41),
    L(200, 'SPEI ENVIADO PROVEEDOR', 0, 465.06),
  ];
  // El texto con que la sucursal 06 capturó cada depósito en Kepler (U-A-5).
  const UA5: Record<string, string> = { s0: 'VTA 02-11-26', s3: 'VTA 02-11-26', s57: 'VENTA DEL 30-10-26', s108: 'VTA 31-10-26' };

  it('cada comisión y su IVA van con el depósito anterior de su terminal y clase', () => {
    const { bloques, huerfanos } = bloquesDeTarjeta(DESCARGA);
    expect(huerfanos).toEqual([]);
    expect(bloques.map((b) => [b.deposito.id, b.cargos.map((c) => c.id)])).toEqual([
      ['s0', ['s1', 's2']], ['s3', ['s4', 's5']], ['s57', ['s58', 's59']], ['s108', ['s109', 's110']],
    ]);
  });

  it('los cargos del lunes se reparten en los días de venta que dice su depósito, como lo hizo Finanzas', () => {
    const { bloques } = bloquesDeTarjeta(DESCARGA);
    const { grupos, sinResolver } = gruposPorDiaDeVenta(bloques, (b) => {
      const dia = diaDeVentaDelTexto(UA5[b.deposito.id], b.deposito.fecha);
      return dia ? { sucursal: '06', diaVenta: dia, acreedor: 'GB004' } : { motivo: 'sin depósito en Kepler' };
    });
    expect(sinResolver).toEqual([]);
    expect(grupos.map((g) => [g.diaVenta, g.cargos.map((c) => c.importe)])).toEqual([
      ['2026-10-30', [59.25, 9.48]], ['2026-10-31', [465.06, 74.41]], ['2026-11-02', [9.35, 1.5, 3.51, 0.56]],
    ]);
  });

  it('⛔ un bloque sin su depósito en Kepler no cae en ningún día', () => {
    const { bloques } = bloquesDeTarjeta(DESCARGA);
    const { grupos, sinResolver } = gruposPorDiaDeVenta(bloques, (b) => (b.deposito.id === 's57' ? { motivo: 'sin depósito en Kepler' } : { sucursal: '06', diaVenta: '2026-11-02', acreedor: 'GB004' }));
    expect(sinResolver.map((x) => x.bloque.deposito.id)).toEqual(['s57']);
    expect(grupos.flatMap((g) => g.cargos.map((c) => c.id))).not.toContain('s58');
  });

  it('⛔ una segunda comisión de la misma terminal sin depósito nuevo es huérfana, no se suma', () => {
    const { huerfanos } = bloquesDeTarjeta([...DESCARGA.slice(0, 3), L(6, C('CREDITO'), 0, 7)]);
    expect(huerfanos.map((h) => h.id)).toEqual(['s6']);
  });

  it('⛔ el bloque no cruza de día ni de cuenta', () => {
    const otroDia = { ...L(1, C('CREDITO'), 0, 9.35), fecha: '2026-11-04' };
    expect(bloquesDeTarjeta([L(0, V('CREDITO'), 465.62, 0), otroDia]).huerfanos).toHaveLength(1);
    const otraCuenta = { ...L(1, C('CREDITO'), 0, 9.35), cuenta: '4176' };
    expect(bloquesDeTarjeta([L(0, V('CREDITO'), 465.62, 0), otraCuenta]).huerfanos).toHaveLength(1);
  });
});

describe('[CB.62] revisarBloque — una comisión y su IVA al 16 %', () => {
  const R = (seq: number, concepto: string, entra: number, sale: number): RenglonDescarga => ({ id: `b${seq}`, cuenta: '7744', fecha: '2026-11-03', seq, concepto, entra, sale });
  const bloque = (com: number | null, iva: number | null) => bloquesDeTarjeta([
    R(0, 'DULCERIA LOS ALTOS 08991964D', 49053.36, 0),
    ...(com == null ? [] : [R(1, 'COMISION 08991964DAPLICACION DE TASAS DE DESCUENTO DE DEBITO; FAMILIA:VENTA', 0, com)]),
    ...(iva == null ? [] : [R(2, 'IVA COMISION 08991964D', 0, iva)]),
  ]).bloques[0];

  it('Banorte real del 3-nov: $367.88 con IVA $58.82 (4 centavos bajo el 16 %) es un bloque completo', () => {
    expect(revisarBloque(bloque(367.88, 58.82))).toBeNull();
  });
  it('y el día de Banorte que antes se rechazaba ahora se arma', () => {
    const g = grupo({ sucursal: '08', acreedor: 'GB001', cargos: [cargo('x1', 367.88, 'comision', { cuenta: '7744', fecha: '2026-11-03' }), cargo('x2', 58.82, 'iva', { cuenta: '7744', fecha: '2026-11-03' })], diaVenta: '2026-11-01' });
    expect(armarComisionesKepler(g, plantilla({ acreedor: 'GB001' })).ok).toBe(true);
  });
  it('⛔ sin su IVA (aunque fuera de centavos), o sólo el IVA: se revisa', () => {
    expect(revisarBloque(bloque(0.85, null))).toMatch(/1 comisión\(es\) y 0 IVA/);
    expect(revisarBloque(bloque(null, 0.14))).toMatch(/0 comisión\(es\) y 1 IVA/);
  });
  it('⛔ un IVA a más de 5 centavos del 16 % de su comisión: se revisa', () => {
    expect(revisarBloque(bloque(367.88, 58.80))).toMatch(/no es el 16 %/);
  });
  it('⛔ y ese bloque no entra a ningún día: va a revisión con su motivo', () => {
    const { grupos, sinResolver } = gruposPorDiaDeVenta([bloque(0.85, null)], () => ({ sucursal: '08', diaVenta: '2026-11-02', acreedor: 'GB001' }));
    expect(grupos).toEqual([]);
    expect(sinResolver[0].motivo).toMatch(/0 IVA/);
  });
});

describe('[CB.62] resolverBloque — el depósito en Kepler dice sucursal y día', () => {
  const bloque = bloquesDeTarjeta([
    { id: 'd', cuenta: '4885', fecha: '2026-11-03', seq: 0, concepto: 'VENTAS CREDITO/145096809 TERMINALES PUNTO DE VENTA', entra: 465.62, sale: 0 },
    { id: 'c', cuenta: '4885', fecha: '2026-11-03', seq: 1, concepto: 'APLI TASA DE DES CREDITO/175096809 TERMINALES PUNTO DE VENTA', entra: 0, sale: 9.35 },
  ]).bloques[0];
  const ua5 = (o: Partial<DepositoKepler> = {}): DepositoKepler => ({ sucursal: '06', folio: '0000281', cuenta: '4885', importe: 465.62, fecha: '2026-11-03', concepto: 'VTA 02-11-26', ...o });
  const acreedor = new Map([['4885', 'GB004']]);

  it('misma cuenta, importe exacto, ±3 días → sucursal, día de venta y banco', () => {
    expect(resolverBloque(bloque, [ua5()], acreedor)).toEqual({ sucursal: '06', diaVenta: '2026-11-02', acreedor: 'GB004' });
  });
  it('⛔ otro importe, otra cuenta o a más de 3 días: no hay depósito', () => {
    for (const u of [ua5({ importe: 465.63 }), ua5({ cuenta: '4176' }), ua5({ fecha: '2026-10-30' })]) {
      expect(resolverBloque(bloque, [u], acreedor)).toEqual({ motivo: 'el depósito no está en Kepler (U-A-5)' });
    }
  });
  it('⛔ dos U-A-5 distintos con el mismo importe: no se elige uno', () => {
    expect(resolverBloque(bloque, [ua5(), ua5({ sucursal: '02', concepto: 'VENTAS 2/11/2026 LPA' })], acreedor)).toEqual({ motivo: 'dos U-A-5 con el mismo importe' });
  });
  it('⛔ la cuenta sin banco acreedor en Kepler, o el texto sin día', () => {
    expect('motivo' in resolverBloque(bloque, [ua5()], new Map())).toBe(true);
    expect('motivo' in resolverBloque(bloque, [ua5({ concepto: 'VENTAS TARJETA' })], acreedor)).toBe(true);
  });
});

describe('[CB.62] cruzarConKepler — el candado contra duplicados', () => {
  const pago = (o: Partial<PagoKeplerCapturado> = {}): PagoKeplerCapturado => ({ sucursal: '07', folio: '0000232', cuenta: '4176', importe: 22.13, fecha: '2026-10-02', ...o });

  it('el cargo con su X-D-26 ya capturado (misma cuenta, importe, ±3 días) se marca y no se escribe', () => {
    const m = cruzarConKepler([MADERO[0]], [pago()]);
    expect(m.get('c1')?.folio).toBe('0000232');
  });
  it('uno a uno: dos cargos iguales y un solo pago → sólo uno queda capturado', () => {
    const m = cruzarConKepler([MADERO[0], { ...MADERO[0], id: 'c1b' }], [pago()]);
    expect(m.size).toBe(1);
  });
  it('entre pagos del mismo importe gana la sucursal del cargo (un IVA de $10.91 en dos sucursales)', () => {
    const m = cruzarConKepler([{ ...MADERO[0], sucursal: '03' }], [pago({ sucursal: '01', folio: 'X' }), pago({ sucursal: '03', folio: 'Y', fecha: '2026-10-04' })]);
    expect(m.get('c1')?.folio).toBe('Y');
  });
  it('⛔ otra cuenta, otro importe o a más de 3 días: no es su pago', () => {
    expect(cruzarConKepler([MADERO[0]], [pago({ cuenta: '4885' }), pago({ importe: 22.14 }), pago({ fecha: '2026-10-06' })]).size).toBe(0);
  });
});

describe('[CB.62] diaDeVentaDelTexto', () => {
  it('las formas medidas en los U-A-5', () => {
    expect(diaDeVentaDelTexto('VTA DEL 02-11-26', '2026-11-03')).toBe('2026-11-02');
    expect(diaDeVentaDelTexto('VENTA DEL 30-10-26 EN TERMINAL', '2026-11-03')).toBe('2026-10-30');
    expect(diaDeVentaDelTexto('COMISIONES MORELIA MADERO VTA 01/10/2026', '2026-10-02')).toBe('2026-10-01');
  });
  it('⛔ el mismo día que el banco abonó: dedazo (la terminal liquida al día siguiente)', () => {
    expect(diaDeVentaDelTexto('VENTAS 3/11/2026 8E', '2026-11-03')).toBeNull();
  });
  it('⛔ sin fecha, fecha imposible, posterior al banco o a más de 7 días: null', () => {
    expect(diaDeVentaDelTexto('VENTAS TARJETA', '2026-11-03')).toBeNull();
    expect(diaDeVentaDelTexto('VTA 31-02-26', '2026-03-03')).toBeNull();
    expect(diaDeVentaDelTexto('VTA 04-11-26', '2026-11-03')).toBeNull();
    expect(diaDeVentaDelTexto('VTA 20-10-26', '2026-11-03')).toBeNull();
    expect(diaDeVentaDelTexto(null, '2026-11-03')).toBeNull();
  });
});
