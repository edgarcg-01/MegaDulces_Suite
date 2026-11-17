import {
  agruparPorEmisor, asignarPorCercania, avisosSinRegistro, fueraDeLaBandeja, laVeLaSucursal, motivoSinRegistro, numerosDeReferencia,
  pistasSinRegistro, referenciaFuerte, referenciaIdentifica, registroDeFacturas, serieFolio, sucursalPropuesta, sucursalesQueLaVen,
  textoDeLaSucursal, type DocumentoDeGasto, type FacturaPorRegistrar, type FacturaSat, type FuentesDelRegistro, type PagoDeGasto,
} from './factura-sat.contract';

/** Datos de prueba: RFC, claves y UUID sintéticos (repo público). */
const RFC = 'AAA010101AA1';
const OTRO_RFC = 'BBB010101BB2';
const UUID_A = '11111111-2222-3333-4444-5c4f8a9b0c1d';
const UUID_B = '99999999-8888-7777-6666-0a1b2c3d4e5f';
/** Las sucursales que ven la factura de prueba (su acreedor es de la 06): la 06 y la 00. */
const LA_VEN: ReadonlySet<string> = new Set(['06', '00']);

const factura = (p: Partial<FacturaSat> = {}): FacturaSat => ({
  uuid: UUID_A, emisor_rfc: RFC, emisor_nombre: 'ACREEDOR DE PRUEBA', serie: 'A', folio: '1234', fecha: '2026-11-02',
  total: 500, subtotal: 431.03, descuento: 0, iva: 68.97, retenido: 0, moneda: 'MXN', uso: 'G03', metodo_pago: 'PUE',
  forma_pago: '01', contabilizada: false, ...p,
});
const doc = (p: Partial<DocumentoDeGasto> = {}): DocumentoDeGasto => ({
  sucursal: '06', tipo: 15, folio: '0000100', solicitud: '0000100', acreedor: 'GZP001', total: 500, fecha: '2026-11-03', referencia: '', ...p,
});
const pago = (p: Partial<PagoDeGasto> = {}): PagoDeGasto => ({ sucursal: '06', folio: '0000900', acreedor: 'GZP001', total: 500, fecha: '2026-11-04', ...p });
const fuentes = (p: Partial<FuentesDelRegistro> = {}): FuentesDelRegistro => ({
  acreedoresDe: new Map([[RFC, new Set(['GZP001'])], [OTRO_RFC, new Set(['GZQ002'])]]), vales: [], documentos: [], pagos: [], ...p,
});

describe('[PGP.122] S.13 — qué entra a la bandeja (DS18)', () => {
  it('gasto en pesos, sin retención, uso G03: entra', () => {
    expect(fueraDeLaBandeja(factura())).toBeNull();
    expect(fueraDeLaBandeja(factura({ moneda: null }))).toBeNull();
  });
  it('⛔ mercancía (G01), activo fijo (I03), retención o dólares: fuera, y dice por qué', () => {
    expect(fueraDeLaBandeja(factura({ uso: 'G01' }))).toMatch(/mercancía/);
    expect(fueraDeLaBandeja(factura({ uso: 'I03' }))).toMatch(/activo fijo/);
    expect(fueraDeLaBandeja(factura({ retenido: 12.5 }))).toMatch(/retención/);
    expect(fueraDeLaBandeja(factura({ moneda: 'USD' }))).toMatch(/USD/);
  });
  it('serie-folio como lo escribe la Suite en c11', () => {
    expect(serieFolio({ serie: 'A', folio: '1234' })).toBe('A-1234');
    expect(serieFolio({ serie: '', folio: '77' })).toBe('77');
    expect(serieFolio({ serie: null, folio: null })).toBeNull();
  });
});

describe('[PGP.122] S.13 — la referencia que teclea la gente (señal 1)', () => {
  const f = factura();
  it('la cola del UUID de 5+ caracteres identifica la factura, en c11 o en c24', () => {
    expect(referenciaIdentifica('TARJ 4512 5c4f8a9b0c1d', f, 999)).toBe('uuid');
    expect(referenciaIdentifica('GASOLINA 0c1d MAGNA', f, 500)).toBe('uuid'); // 4 caracteres + total que cuadra
  });
  it('el folio de 4+ dígitos identifica la factura (sin ceros a la izquierda), aunque venga pegado a la serie', () => {
    expect(referenciaIdentifica('FACT 001234', f, 999)).toBe('folio');
    expect(referenciaIdentifica('A1234', f, 999)).toBe('folio');
    expect(referenciaIdentifica('F-1234 TARJ 4512', f, 999)).toBe('folio');
  });
  it('el folio de 3 dígitos —«467», «F-467», «FAC 467»— identifica si el total cuadra', () => {
    const f3 = factura({ folio: '467' });
    for (const ref of ['467', 'F-467', 'FAC 467', 'factura 0467']) expect(referenciaIdentifica(ref, f3, 500)).toBe('folio');
  });
  it('⛔ NEGATIVAS: folio de 3 dígitos sin total que cuadre, 4 caracteres de UUID sin total, un pedazo EN MEDIO del UUID, folio de 2 dígitos', () => {
    expect(referenciaIdentifica('FAC 467', factura({ folio: '467' }), 999)).toBeNull();
    expect(referenciaIdentifica('0c1d', f, 999)).toBeNull();
    expect(referenciaIdentifica('22223333', f, 500)).toBeNull();
    expect(referenciaIdentifica('A012', factura({ folio: '12' }), 500)).toBeNull();
  });
  it('⛔ PLACEBO: el UUID y el folio de OTRA factura no identifican nada', () => {
    expect(referenciaIdentifica('0a1b2c3d4e5f', f, 500)).toBeNull();
    expect(referenciaIdentifica('FACT 9876', f, 500)).toBeNull();
  });
  it('las corridas de dígitos de la referencia', () => {
    expect(numerosDeReferencia('F-0467 TARJ 4512, 000')).toEqual(['467', '4512']);
  });
  it('la referencia FUERTE (la única que vale en el gasto de otro acreedor): cola de 5+, o folio de 4+ con el total', () => {
    expect(referenciaFuerte('X 5c4f8a9b0c1d', f, 999)).toBe(true);
    expect(referenciaFuerte('FACT 1234', f, 500)).toBe(true);
    expect(referenciaFuerte('FACT 1234', f, 999)).toBe(false);
    expect(referenciaFuerte('0c1d', f, 500)).toBe(false);
    expect(referenciaFuerte('FAC 467', factura({ folio: '467' }), 500)).toBe(false);
  });
});

describe('[PGP.122] S.13 — uno a uno por cercanía, de cardinalidad máxima (DS20)', () => {
  it('gana el más cercano; a igual distancia, el documento posterior; cada lado una vez', () => {
    const m = asignarPorCercania([
      { a: 'f1', b: 'd1', dias: 3 }, { a: 'f1', b: 'd2', dias: 1 }, { a: 'f2', b: 'd2', dias: 0 },
      { a: 'f3', b: 'd3', dias: -2 }, { a: 'f3', b: 'd4', dias: 2 },
    ]);
    expect(m.get('f2')).toEqual({ b: 'd2', dias: 0 });
    expect(m.get('f1')).toEqual({ b: 'd1', dias: 3 }); // d2 ya se usó
    expect(m.get('f3')).toEqual({ b: 'd4', dias: 2 });
  });
  it('determinista: el mismo resultado sin importar el orden de entrada', () => {
    const pares = [{ a: 'x', b: 'p', dias: 1 }, { a: 'y', b: 'p', dias: 1 }, { a: 'y', b: 'q', dias: 5 }];
    expect(new Map(asignarPorCercania(pares))).toEqual(new Map(asignarPorCercania([...pares].reverse())));
  });
  it('⛔ cardinalidad máxima: si las dos facturas pueden quedar cubiertas, quedan las dos (el codicioso dejaba una fuera)', () => {
    // B tomaría G1 (0 días); A sólo alcanza G1 (+4). El camino aumentante: B cede G1 a A y toma G2 (+15).
    const m = asignarPorCercania([{ a: 'B', b: 'G1', dias: 0 }, { a: 'A', b: 'G1', dias: 4 }, { a: 'B', b: 'G2', dias: 15 }]);
    expect(m.get('A')).toEqual({ b: 'G1', dias: 4 });
    expect(m.get('B')).toEqual({ b: 'G2', dias: 15 });
  });
});

describe('[PGP.122] S.13 — ¿ya está registrada? (DS19)', () => {
  it('señal 0: un vale vivo de la Suite con ese UUID (sin importar mayúsculas); uno rechazado no cuenta', () => {
    const r = registroDeFacturas([factura()], fuentes({ vales: [{ id: 'v1', uuid: UUID_A.toUpperCase(), sucursal: '06', folio_solicitud: null, status: 'validada' }] }));
    expect(r.get(UUID_A)?.senal).toBe('suite');
    const r2 = registroDeFacturas([factura()], fuentes({ vales: [{ id: 'v1', uuid: UUID_A, sucursal: '06', folio_solicitud: null, status: 'rechazada' }] }));
    expect(r2.get(UUID_A)).toBeUndefined();
  });

  it('⛔ señal 0: el gasto que escribió el vale queda consumido: no cubre otra factura del mismo importe', () => {
    const r = registroDeFacturas([factura(), factura({ uuid: UUID_B, folio: '1300', fecha: '2026-11-02' })], fuentes({
      vales: [{ id: 'v1', uuid: UUID_A, sucursal: '06', folio_solicitud: '0000100', status: 'validada' }],
      documentos: [doc({ folio: '0000100', solicitud: '0000100', fecha: '2026-11-03' })],
    }));
    expect(r.get(UUID_A)).toMatchObject({ senal: 'suite', gasto: '06|0000100' });
    expect(r.get(UUID_B)).toBeUndefined();
  });

  it('señal 0b: el vale de la Suite capturado con ticket (sin la factura ligada), mismo acreedor y total', () => {
    const r = registroDeFacturas([factura()], fuentes({ valesSinFactura: [{ id: 'v9', sucursal: '06', folio_solicitud: null, acreedor: 'GZP001', total: 500.4, fecha: '2026-11-02' }] }));
    expect(r.get(UUID_A)).toMatchObject({ senal: 'suite_ticket', vale: { id: 'v9' }, dias: 0 });
  });

  it('⛔ señal 0b: otro acreedor, otro total o un ticket de 16 días después no cuentan', () => {
    const v = { id: 'v9', sucursal: '06', folio_solicitud: null, acreedor: 'GZP001', total: 500, fecha: '2026-11-02' };
    expect(registroDeFacturas([factura()], fuentes({ valesSinFactura: [{ ...v, acreedor: 'GZQ002' }] })).size).toBe(0);
    expect(registroDeFacturas([factura()], fuentes({ valesSinFactura: [{ ...v, total: 507 }] })).size).toBe(0);
    expect(registroDeFacturas([factura()], fuentes({ valesSinFactura: [{ ...v, fecha: '2026-11-18' }] })).size).toBe(0);
  });

  it('señal 1: la X-A-10 trae la cola del UUID y cubre la factura por el gasto de su X-A-15, aunque el total no cuadre', () => {
    const r = registroDeFacturas([factura()], fuentes({ documentos: [
      doc({ tipo: 15, folio: '0000100', total: 480, fecha: '2026-10-30' }),
      doc({ tipo: 10, folio: '0000555', solicitud: '0000100', total: 480, fecha: '2026-11-05', referencia: 'TARJ 5c4f8a9b0c1d' }),
    ] }));
    expect(r.get(UUID_A)).toMatchObject({ senal: 'referencia', documento: { tipo: 'X-A-10', folio: '0000555' }, dias: 3, gasto: '06|0000100' });
  });

  it('señal 1: el folio de 3 dígitos en c11, con el total, a +16 días (fuera de la difusa)', () => {
    const r = registroDeFacturas([factura({ folio: '467' })], fuentes({ documentos: [doc({ fecha: '2026-11-18', referencia: '467' })] }));
    expect(r.get(UUID_A)?.senal).toBe('referencia');
  });

  it('⛔ señal 1: fuera de −30..+120 días no cuenta', () => {
    const r = registroDeFacturas([factura()], fuentes({ documentos: [doc({ fecha: '2027-03-03', total: 999, referencia: '5c4f8a9b0c1d' })] }));
    expect(r.get(UUID_A)).toBeUndefined();
  });

  it('señal 1b: la cola del UUID en el gasto de OTRO acreedor (un reembolso): registrada, y dice de quién', () => {
    const r = registroDeFacturas([factura()], fuentes({ documentos: [doc({ acreedor: 'GEMPL01', total: 512, fecha: '2026-11-06', referencia: 'REEMB 9b0c1d' })] }));
    expect(r.get(UUID_A)).toMatchObject({ senal: 'referencia_otro', acreedor: 'GEMPL01', documento: { folio: '0000100' } });
  });

  it('⛔ señal 1b: en el gasto de otro acreedor la referencia débil NO basta (4 caracteres, folio de 3, folio sin el total)', () => {
    const otro = (referencia: string, total = 500) => doc({ acreedor: 'GEMPL01', total, fecha: '2026-11-06', referencia });
    expect(registroDeFacturas([factura()], fuentes({ documentos: [otro('0c1d')] })).size).toBe(0);
    expect(registroDeFacturas([factura({ folio: '467' })], fuentes({ documentos: [otro('467')] })).size).toBe(0);
    expect(registroDeFacturas([factura()], fuentes({ documentos: [otro('FAC 1234', 999)] })).size).toBe(0);
  });

  it('señal 2: mismo acreedor y total, de 0 a +15 días', () => {
    expect(registroDeFacturas([factura()], fuentes({ documentos: [doc({ fecha: '2026-11-02' })] })).get(UUID_A)?.senal).toBe('difusa');
    expect(registroDeFacturas([factura()], fuentes({ documentos: [doc({ fecha: '2026-11-17' })] })).get(UUID_A)?.senal).toBe('difusa');
  });

  it('⛔ señal 2: un día ANTES de la factura, 16 días después u otro acreedor no cuentan', () => {
    expect(registroDeFacturas([factura()], fuentes({ documentos: [doc({ fecha: '2026-11-01' })] })).get(UUID_A)).toBeUndefined();
    expect(registroDeFacturas([factura()], fuentes({ documentos: [doc({ fecha: '2026-11-18' })] })).get(UUID_A)).toBeUndefined();
    expect(registroDeFacturas([factura()], fuentes({ documentos: [doc({ acreedor: 'GZQ002' })] })).get(UUID_A)).toBeUndefined();
  });

  it('⛔ PLACEBO del importe (+$7) y de la fecha (−120 días): nada se registra', () => {
    expect(registroDeFacturas([factura()], fuentes({ documentos: [doc({ total: 507 })] })).size).toBe(0);
    expect(registroDeFacturas([factura({ fecha: '2026-07-05' })], fuentes({ documentos: [doc()] })).size).toBe(0);
  });

  it('⛔ UN gasto (la X-A-15 con su X-A-10) cubre UNA factura: dos del mismo importe dejan una sin registro', () => {
    const r = registroDeFacturas(
      [factura(), factura({ uuid: UUID_B, folio: '1300', fecha: '2026-11-03' })],
      fuentes({ documentos: [
        doc({ tipo: 15, folio: '0000100', fecha: '2026-11-03' }),
        doc({ tipo: 10, folio: '0000556', solicitud: '0000100', fecha: '2026-11-06' }),
      ] }),
    );
    expect(r.size).toBe(1);
    expect(r.get(UUID_B)?.senal).toBe('difusa'); // la más cercana se lo queda (0 días)
    expect(r.get(UUID_A)).toBeUndefined();
  });

  it('⛔ … y el PAGO de ese gasto tampoco esconde a la otra como «pagada»: ya explica el gasto usado', () => {
    const r = registroDeFacturas(
      [factura(), factura({ uuid: UUID_B, folio: '1300', fecha: '2026-11-03' })],
      fuentes({
        documentos: [doc({ tipo: 15, folio: '0000100', fecha: '2026-11-03' }), doc({ tipo: 10, folio: '0000556', solicitud: '0000100', fecha: '2026-11-06' })],
        pagos: [pago({ fecha: '2026-11-07' })],
      }),
    );
    expect(r.get(UUID_B)?.senal).toBe('difusa');
    expect(r.get(UUID_A)).toBeUndefined();
  });

  it('dos gastos del mismo importe cubren a las dos facturas, cada una con el más cercano', () => {
    const r = registroDeFacturas(
      [factura(), factura({ uuid: UUID_B, folio: '1300', fecha: '2026-11-09' })],
      fuentes({ documentos: [doc({ folio: '0000100', solicitud: '0000100', fecha: '2026-11-03' }), doc({ folio: '0000101', solicitud: '0000101', fecha: '2026-11-10' })] }),
    );
    expect(r.get(UUID_A)?.documento?.folio).toBe('0000100');
    expect(r.get(UUID_B)?.documento?.folio).toBe('0000101');
  });

  it('señal 3: pagada con un X-D-26 de 0 a +7 días cuando ningún gasto la cubre; a +8 no', () => {
    expect(registroDeFacturas([factura()], fuentes({ pagos: [pago({ fecha: '2026-11-09' })] })).get(UUID_A))
      .toMatchObject({ senal: 'pagada', documento: { tipo: 'X-D-26', folio: '0000900' }, dias: 7 });
    expect(registroDeFacturas([factura()], fuentes({ pagos: [pago({ fecha: '2026-11-10' })] })).get(UUID_A)).toBeUndefined();
  });

  it('señal 3: el pago de un ticket contra un gasto AGRUPADO (otro total) sí la marca pagada', () => {
    const r = registroDeFacturas([factura()], fuentes({ documentos: [doc({ total: 2000, fecha: '2026-11-01' })], pagos: [pago({ fecha: '2026-11-03' })] }));
    expect(r.get(UUID_A)?.senal).toBe('pagada');
  });

  it('la referencia gana a la difusa: un gasto con la cola del UUID se lo queda aunque otro esté más cerca', () => {
    const r = registroDeFacturas([factura()], fuentes({ documentos: [
      doc({ folio: '0000200', solicitud: '0000200', fecha: '2026-11-02' }),
      doc({ folio: '0000201', solicitud: '0000201', fecha: '2026-11-12', referencia: 'X 5c4f8a9b0c1d' }),
    ] }));
    expect(r.get(UUID_A)).toMatchObject({ senal: 'referencia', documento: { folio: '0000201' } });
  });
});

describe('[PGP.122] S.13 — por qué está aquí, sin afirmar de más', () => {
  it('⛔ si el gasto del mismo importe cubre OTRA factura más cercana, el motivo lo dice (no «no hay gasto»)', () => {
    const fs = fuentes({ documentos: [doc({ tipo: 15, folio: '0000100', fecha: '2026-11-03' })] });
    const facturas = [factura(), factura({ uuid: UUID_B, folio: '1300', fecha: '2026-11-03' })];
    const r = registroDeFacturas(facturas, fs);
    const p = pistasSinRegistro(facturas[0], fs, r, LA_VEN);
    expect(p.ocupados).toEqual([{ documento: expect.objectContaining({ folio: '0000100' }), cubre: UUID_B }]);
    expect(motivoSinRegistro(facturas[0], ['GZP001'], p)).toMatch(/hay un gasto de GZP001 por \$500\.00.*la solicitud 0000100 de la 06, del 3-nov.*ya cubre otra factura/);
  });
  it('sin nada alrededor, dice la ventana que se buscó', () => {
    expect(motivoSinRegistro({ fecha: '2026-11-02', total: 500 }, ['GZP001'])).toMatch(/GZP001 por \$500\.00 del 2-nov al 17-nov/);
  });
  it('un documento de OTRO acreedor por el mismo importe se AVISA (posible reembolso), sin esconder la factura', () => {
    const fs = fuentes({ documentos: [doc({ acreedor: 'GEMPL01', fecha: '2026-11-04' })] });
    const r = registroDeFacturas([factura()], fs);
    expect(r.size).toBe(0);
    const avisos = avisosSinRegistro(pistasSinRegistro(factura(), fs, r, LA_VEN));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatch(/^Puede estar registrada como reembolso: .* es de otro acreedor \(GEMPL01\) por el mismo importe\.$/);
  });
  // [PGP.123] S.13 (H11): la prueba visual vio 5 avisos en la 05, todos de otras sucursales (3 sobre una de $200.00).
  it('⛔ el aviso de reembolso sólo cuenta documentos de las sucursales que VEN la factura (y la 00)', () => {
    const fs = fuentes({ documentos: [
      doc({ sucursal: '03', folio: '0000301', solicitud: '0000301', acreedor: 'GEMPL03', fecha: '2026-11-04' }),
      doc({ sucursal: '00', folio: '0000001', solicitud: '0000001', acreedor: 'GEMPL00', fecha: '2026-11-04' }),
    ] });
    const r = registroDeFacturas([factura()], fs);
    const otros = pistasSinRegistro(factura(), fs, r, LA_VEN).otros.map((o) => o.acreedor);
    expect(otros).toEqual(['GEMPL00']);
    // Si la factura la viera la 03 (su historia), el de la 03 sí cuenta.
    expect(pistasSinRegistro(factura(), fs, r, sucursalesQueLaVen(sucursalPropuesta(new Map([['03', 4]])))).otros.map((o) => o.acreedor))
      .toEqual(['GEMPL00', 'GEMPL03']);
  });
  it('sucursalesQueLaVen: las mismas que laVeLaSucursal (la propuesta o sus dos, y siempre la 00)', () => {
    const con = sucursalPropuesta(new Map([['06', 5]]));
    const sin = sucursalPropuesta(new Map([['06', 2], ['08', 2]]));
    expect([...sucursalesQueLaVen(con)].sort()).toEqual(['00', '06']);
    expect([...sucursalesQueLaVen(sin)].sort()).toEqual(['00', '06', '08']);
    expect([...sucursalesQueLaVen(sucursalPropuesta(new Map()))]).toEqual(['00']);
    for (const p of [con, sin]) for (const s of ['00', '01', '03', '05', '06', '07', '08']) expect(sucursalesQueLaVen(p).has(s)).toBe(laVeLaSucursal(p, s));
  });

  /**
   * `[PGP.123]` S.13 — Lo que decía la prueba visual del 2026-11-15: «X-A-15… X-D-26», «$1234.50» y «2026-10-08»
   * mientras la misma pantalla dice «$1,234.50» y «08-oct». Se dice con el formato de la pantalla y sin jerga.
   */
  it('⛔ el motivo no usa la jerga de Kepler ni el formato crudo del monto y la fecha', () => {
    const m = motivoSinRegistro({ fecha: '2026-10-08', total: 1234.5 }, ['GZP001']);
    expect(m).toContain('$1,234.50');
    expect(m).toContain('del 8-oct al 23-oct');
    expect(m).not.toMatch(/X-A-1[05]|X-D-26|\$1234\.5|2026-10-08/);
  });
});

describe('[PGP.122] S.13 — a qué sucursal (DS21, regla B)', () => {
  it('3+ documentos y la líder con 80 %+: se propone, con su origen', () => {
    const p = sucursalPropuesta(new Map([['08', 8], ['00', 1]]));
    expect(p).toMatchObject({ propuesta: '08', via: 'historia', opciones: ['08', '00'], documentos: 9 });
    expect(textoDeLaSucursal(p)).toMatch(/^08: 9 documentos/);
    // Con el nombre que le pone la vista (branchLabel), la clave no queda sola.
    expect(textoDeLaSucursal(p, (s) => `${s} Sucursal de prueba`)).toMatch(/^08 Sucursal de prueba: 9 documentos/);
  });

  it('⛔ repartida dice el porcentaje UNA vez entre paréntesis (salía «(la líder tiene (33 %))»)', () => {
    const t = textoDeLaSucursal(sucursalPropuesta(new Map([['05', 2], ['07', 2], ['00', 2]])));
    const r = textoDeLaSucursal(sucursalPropuesta(new Map([['06', 3], ['07', 1]])));
    expect(r).toBe('Su historia está repartida (la que más tiene, 75 %): elige la sucursal');
    expect(r).not.toMatch(/\(\s*\(|\)\s*\)/);
    expect(t).not.toMatch(/\(\s*\(|\)\s*\)/);
  });
  it('⛔ se pregunta: sin historia, menos de 3, repartida (75 %) o empate — y ofrece las 2 de su historia', () => {
    expect(sucursalPropuesta(new Map())).toMatchObject({ propuesta: null, via: 'sin_historia', opciones: [] });
    expect(sucursalPropuesta(new Map([['05', 2]]))).toMatchObject({ propuesta: null, via: 'poca_historia', opciones: ['05'] });
    expect(sucursalPropuesta(new Map([['06', 3], ['07', 1]]))).toMatchObject({ propuesta: null, via: 'repartida', opciones: ['06', '07'] });
    expect(sucursalPropuesta(new Map([['01', 2], ['02', 2]]))).toMatchObject({ propuesta: null, via: 'empate', opciones: ['01', '02'] });
  });
  it('quién la ve: la propuesta; sin propuesta, las 2 de su historia; 00 todas', () => {
    const con = sucursalPropuesta(new Map([['08', 9]]));
    const sin = sucursalPropuesta(new Map([['06', 3], ['07', 1]]));
    expect(laVeLaSucursal(con, '08')).toBe(true);
    expect(laVeLaSucursal(con, '07')).toBe(false);
    expect(laVeLaSucursal(con, '00')).toBe(true);
    expect(laVeLaSucursal(sin, '07')).toBe(true);
    expect(laVeLaSucursal(sin, '05')).toBe(false);
    expect(laVeLaSucursal(sucursalPropuesta(new Map()), '05')).toBe(false);
    expect(laVeLaSucursal(sucursalPropuesta(new Map()), '00')).toBe(true);
  });
});

describe('[PGP.122] S.13 — lo que ve la persona', () => {
  const item = (p: Partial<FacturaPorRegistrar>): FacturaPorRegistrar => ({
    uuid: 'u', emisor_rfc: RFC, emisor_nombre: 'A', serie_folio: null, fecha: '2026-11-05', dias: 1, total: 100, subtotal: 86.21,
    descuento: 0, iva: 13.79, metodo_pago: null, forma_pago: null, acreedores: [], sucursal: sucursalPropuesta(new Map()),
    contabilizada: null, motivo: '', avisos: [], ...p,
  });
  it('agrupa por emisor: primero el de la factura más antigua, y dentro por fecha', () => {
    const g = agruparPorEmisor([
      item({ uuid: 'b1', emisor_rfc: OTRO_RFC, fecha: '2026-11-08' }),
      item({ uuid: 'a2', fecha: '2026-11-06', total: 50 }),
      item({ uuid: 'a1', fecha: '2026-11-03', total: 25.5 }),
    ]);
    expect(g.map((x) => x.emisor_rfc)).toEqual([RFC, OTRO_RFC]);
    expect(g[0]).toMatchObject({ total: 75.5, mas_antigua: '2026-11-03' });
    expect(g[0].facturas.map((x) => x.uuid)).toEqual(['a1', 'a2']);
  });
});
