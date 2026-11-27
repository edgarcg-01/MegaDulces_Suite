import { cajasDeRenglon, nombreArchivoOc, referenciaUtil, textoCajasRenglon, textoTasas, textoTotalCajasOc, totalesOc } from './oc-kepler';

describe('[RA-PRO.61] cajasDeRenglon — sólo cuando el costo confirma la unidad', () => {
  it('el caso real: 900 PAQ, 20 por caja, costo 56 y caja 1,120 → 45 cajas', () => {
    expect(cajasDeRenglon({ cantidad: 900, unidades_por_caja: 20, costo_unitario: 56, costo_caja: 1120 })).toBe(45);
  });

  it('tolera redondeo de centavos (±1%)', () => {
    expect(cajasDeRenglon({ cantidad: 24, unidades_por_caja: 12, costo_unitario: 8.3333, costo_caja: 100 })).toBe(2);
  });

  it('⭐ NEGATIVA: si el costo no cuadra (factor en otra unidad) NO se inventan cajas', () => {
    // Costo simbólico: 0.0008 × 12 ≠ 0.01 → el factor no significa "piezas de este renglón".
    expect(cajasDeRenglon({ cantidad: 12, unidades_por_caja: 12, costo_unitario: 0.0008, costo_caja: 0.01 })).toBeNull();
    // Servicio: caja ≠ unitario × 1.
    expect(cajasDeRenglon({ cantidad: 1, unidades_por_caja: 1, costo_unitario: 69312.31, costo_caja: 128434.25 })).toBeNull();
  });

  it('⛔ [PQ.82] el caso real: 5 PZA con 1 por caja NO son «5 cj» (OC 07/0000092, BOCADILLOS NUEZ LICO)', () => {
    const r = { cantidad: 5, unidades_por_caja: 1, costo_unitario: 115.5, costo_caja: 115.5, unidad: 'PZA' };
    expect(cajasDeRenglon(r)).toBeNull();
    expect(textoCajasRenglon(r)).toBeNull();   // el PDF cae a la cantidad en su unidad: «5 pza»
    // control: con caja de verdad sigue diciendo cajas
    expect(textoCajasRenglon({ ...r, cantidad: 100, unidades_por_caja: 20, costo_caja: 2310 })).toBe('5 cj');
  });

  it('cantidad negativa (ajuste capturado como OC) → null, no "-2 cj"', () => {
    expect(cajasDeRenglon({ cantidad: -40, unidades_por_caja: 20, costo_unitario: 5, costo_caja: 100 })).toBeNull();
  });

  it('faltan datos → null', () => {
    expect(cajasDeRenglon({ cantidad: 10, unidades_por_caja: null, costo_unitario: 5, costo_caja: 50 })).toBeNull();
    expect(cajasDeRenglon({ cantidad: 10, unidades_por_caja: 10, costo_unitario: 0, costo_caja: 50 })).toBeNull();
    expect(cajasDeRenglon({ cantidad: 10, unidades_por_caja: 10, costo_unitario: 5, costo_caja: null })).toBeNull();
  });
});

describe('[RA-PRO.61] referencia y nombre de archivo', () => {
  it('la referencia "0" de Kepler no se imprime', () => {
    expect(referenciaUtil('0')).toBeNull();
    expect(referenciaUtil('  ')).toBeNull();
    expect(referenciaUtil('FAC-123')).toBe('FAC-123');
  });

  it('OC_<SUC>-<FOLIO>_<PROVEEDOR>_<PROVEEDOR|INTERNO>_AAAA-MM-DD-HH-MM.pdf', () => {
    expect(nombreArchivoOc('00', '0004409', 'Puro Relajo', new Date(2026, 8, 26, 14, 5), false))
      .toBe('OC_00-0004409_PURO-RELAJO_PROVEEDOR_2026-09-26-14-05.pdf');
    expect(nombreArchivoOc('01', '12', null, new Date(2026, 0, 2, 3, 4), true)).toBe('OC_01-12_SIN-PROVEEDOR_INTERNO_2026-01-02-03-04.pdf');
  });

  it('⭐ NEGATIVA: la versión interna y la del proveedor NUNCA se llaman igual', () => {
    const d = new Date(2026, 8, 26, 14, 5);
    expect(nombreArchivoOc('00', '1', 'X', d, true)).not.toBe(nombreArchivoOc('00', '1', 'X', d, false));
  });
});

describe('[RA-PRO.61] textoCajasRenglon — el resto va en la unidad del renglón', () => {
  const R = (cantidad: number, upc: number, unidad = 'PAQ') => ({ cantidad, unidades_por_caja: upc, costo_unitario: 10, costo_caja: 10 * upc, unidad });
  it('cajas exactas, con resto y menos de una caja', () => {
    expect(textoCajasRenglon(R(900, 20))).toBe('45 cj');
    expect(textoCajasRenglon(R(890, 20))).toBe('44 cj + 10 paq');
    expect(textoCajasRenglon(R(12.5, 25, 'KG'))).toBe('12.5 kg');
  });
  it('sin verificar → null', () => {
    expect(textoCajasRenglon({ cantidad: 12, unidades_por_caja: 12, costo_unitario: 0.0008, costo_caja: 0.01, unidad: 'PAQ' })).toBeNull();
  });
});

describe('[PQ.32] totalesOc — el total es el de Kepler, con sus impuestos', () => {
  it('la OC 00/0007259: renglones $24,996.30 + IEPS $1,999.70 = $26,996.00 (lo que se factura)', () => {
    expect(totalesOc(24996.3, 26996, 0, 1999.7)).toEqual([
      { etiqueta: 'Subtotal', monto: 24996.3 },
      { etiqueta: 'IEPS', monto: 1999.7 },
      { etiqueta: 'Total', monto: 26996, fuerte: true },
    ]);
  });

  it('sin impuestos, Subtotal = Total y no se pinta un IVA en cero', () => {
    expect(totalesOc(1000, 1000, 0, 0).map((x) => x.etiqueta)).toEqual(['Subtotal', 'Total']);
  });

  it('NEGATIVA: si los impuestos no cuadran, no se inventa el desglose; la diferencia se nombra y la tabla suma', () => {
    const t = totalesOc(1000, 1200, 50, 0);
    expect(t.map((x) => x.etiqueta)).toEqual(['Subtotal', 'Impuestos y ajustes según Kepler', 'Total']);
    expect(t[0].monto + t[1].monto).toBe(t[2].monto);
  });

  it('NEGATIVA: sin impuestos leídos, tampoco se dibuja un IVA en 0', () => {
    expect(totalesOc(1000, 1160, null, null).map((x) => x.etiqueta)).toEqual(['Subtotal', 'Impuestos y ajustes según Kepler', 'Total']);
  });
});

describe('[PQ.33] el tratamiento fiscal se DICE, con la tasa de Kepler', () => {
  it('OC 00/0007265: IEPS 8 % y IVA 0 % explícitos (antes el IVA simplemente no aparecía)', () => {
    expect(totalesOc(72052.81, 77817.04, 0, 5764.23, { iva: [0], ieps: [8] })).toEqual([
      { etiqueta: 'Subtotal', monto: 72052.81 },
      { etiqueta: 'IEPS (8 %)', monto: 5764.23 },
      { etiqueta: 'IVA (0 %)', monto: 0 },
      { etiqueta: 'Total', monto: 77817.04, fuerte: true },
    ]);
  });

  it('varias tasas en la misma orden se dicen todas', () => {
    expect(textoTasas([16, 0])).toBe('16 % y 0 %');
    expect(textoTasas([8, 0, 25])).toBe('8 %, 0 % y 25 %');
  });

  it('NEGATIVA: sin tasa conocida, un impuesto en 0 no se pinta (sería afirmar sin fuente)', () => {
    expect(totalesOc(1000, 1000, 0, 0, { iva: null, ieps: [] }).map((x) => x.etiqueta)).toEqual(['Subtotal', 'Total']);
  });
});

describe('[PQ.86] el costo de la OC dice que es sin impuestos', () => {
  it('el PDF para el proveedor y el panel lo rotulan', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const pdf = readFileSync(join(__dirname, 'oc-kepler-pdf.ts'), 'utf8');
    const panel = readFileSync(join(__dirname, 'pages/compras-oc-abiertas.component.ts'), 'utf8');
    expect(pdf).toContain("'Costo sin impuestos', 'Importe sin impuestos'");
    expect(panel).toContain('class="comm-num">Costo sin imp.</th><th scope="col" class="comm-num">Importe sin imp.</th>');
    expect(panel).not.toMatch(/class="comm-num">(Costo|Importe)<\/th>/);
  });
});

describe('[PQ.166] el total de cajas de la OC', () => {
  const caja = (cajas: number) => ({ cantidad: cajas * 20, unidades_por_caja: 20, costo_unitario: 56, costo_caja: 1120 });
  const rota = { cantidad: 12, unidades_por_caja: 12, costo_unitario: 0.0008, costo_caja: 0.01 };
  it('suma las cajas verificadas (la 0007492: 4 × 132 = 528 cj)', () => {
    expect(textoTotalCajasOc([caja(132), caja(132), caja(132), caja(132)])).toBe('528 cj');
  });
  it('[PQ.168] un renglón capturado EN CAJAS (CJA, factor 1) ya son cajas: la OC 00-0007511', () => {
    const cja = (n: number) => ({ cantidad: n, unidades_por_caja: 1, costo_unitario: 1074.03, costo_caja: 1074.03, unidad: 'CJA' });
    expect(textoTotalCajasOc([cja(25), cja(11), cja(15)])).toBe('51 cj');
    expect(cajasDeRenglon(cja(25))).toBe(25);
    // y una PZA con factor 1 SIGUE sin ser caja ([PQ.82])
    expect(cajasDeRenglon({ cantidad: 5, unidades_por_caja: 1, costo_unitario: 115.5, costo_caja: 115.5, unidad: 'PZA' })).toBeNull();
  });
  it('[PQ.168] control con datos REALES: los 15 renglones de la OC 00-0007511 (prod, 2026-11-27) suman 222 cj', () => {
    // [cantidad, unidades_por_caja, costo_unitario, costo_caja, unidad] tal como los da analytics.erp_purchase_doc_lines.
    const reales: [number, number, number, number, string][] = [
      [25, 1, 581.45, 581.45, 'CJA'],
      [11, 1, 1074.03, 1074.03, 'CJA'],
      [15, 1, 1023.71, 1023.71, 'CJA'],
      [50, 1, 603.12, 603.12, 'CJA'],
      [10, 1, 1101.33, 1101.33, 'CJA'],
      [7, 1, 1074.03, 1074.03, 'CJA'],
      [10, 1, 1032.06, 1032.06, 'CJA'],
      [11, 1, 1074.03, 1074.03, 'CJA'],
      [5, 1, 1074.03, 1074.03, 'CJA'],
      [15, 1, 1033.69, 1033.69, 'CJA'],
      [20, 1, 1074.03, 1074.03, 'CJA'],
      [15, 1, 1146.45, 1146.45, 'CJA'],
      [10, 1, 1023.74, 1023.74, 'CJA'],
      [13, 1, 1036.17, 1036.17, 'CJA'],
      [5, 1, 631.11, 631.11, 'CJA'],
    ];
    const lineas = reales.map(([cantidad, unidades_por_caja, costo_unitario, costo_caja, unidad]) => ({ cantidad, unidades_por_caja, costo_unitario, costo_caja, unidad }));
    expect(textoTotalCajasOc(lineas)).toBe('222 cj');
  });
  it('un renglón sin cajas verificadas no se suma como cero: se dice', () => {
    expect(textoTotalCajasOc([caja(10), rota])).toBe('10 cj + 1 renglón(es) sin verificar');
    expect(textoTotalCajasOc([rota])).toBe('1 renglón(es) sin cajas verificadas');
  });
});
