import {
  PLANTILLAS_CHEQUE,
  PLANTILLA_CHEQUE_BAJIO,
  cajaDeZona,
  camposDelCheque,
  datosDeChequeDePrueba,
  dictamenCheque,
  fechaDelCheque,
  folioDelCheque,
  importeConComas,
  plantillaDeCheque,
  type PagoParaCheque,
  type PlantillaCheque,
  type ZonaCheque,
} from './cheque-impreso';

type Caja = { x: number; x2: number; y: number; y2: number };
const seEnciman = (a: Caja, b: Caja) => a.x < b.x2 && b.x < a.x2 && a.y < b.y2 && b.y < a.y2;

/**
 * Todo lo que choca en una plantilla: un dato fuera del cheque (margen 1 mm), encima de algo que el banco imprimió, o
 * encima de otro dato. Con dos renglones se mide la caja de los dos. Vacío = la plantilla no pisa nada.
 */
function choques(pl: PlantillaCheque): string[] {
  const out: string[] = [];
  const cajas: Array<[string, Caja]> = [];
  for (const [nombre, z] of Object.entries(pl.zonas) as Array<[string, ZonaCheque]>) {
    cajas.push([nombre, cajaDeZona(z)]);
    if (z.renglones === 2) cajas.push([`${nombre}(2)`, cajaDeZona(z, true)]);
  }
  for (const [n, c] of cajas) {
    if (c.x < 1 || c.y < 1 || c.x2 > pl.anchoMm - 1 || c.y2 > pl.altoMm - 1) out.push(`${n} fuera del cheque`);
    for (const r of pl.reservadas) {
      if (seEnciman(c, { x: r.x, x2: r.x + r.ancho, y: r.y, y2: r.y + r.alto })) out.push(`${n} × ${r.nombre}`);
    }
  }
  for (let i = 0; i < cajas.length; i++) {
    for (let j = i + 1; j < cajas.length; j++) {
      const [a, ca] = cajas[i];
      const [b, cb] = cajas[j];
      if (a.split('(')[0] === b.split('(')[0]) continue; // un renglón y dos renglones son alternativas, no vecinos
      if (seEnciman(ca, cb)) out.push(`${a} × ${b}`);
    }
  }
  return out;
}

describe('[PGP.165] los campos del cheque', () => {
  it('el cheque de noviembre: fecha con el mes en letra, importe con asteriscos y la letra entre paréntesis', () => {
    expect(camposDelCheque({ fecha: '2026-11-20', beneficiario: '  dulces   del bajío sa de cv ', centavos: 10_744_693 })).toEqual({
      fecha: '20 DE NOVIEMBRE DE 2026',
      beneficiario: 'DULCES DEL BAJÍO SA DE CV',
      importe: '**107,446.93**',
      letra: '(CIENTO SIETE MIL CUATROCIENTOS CUARENTA Y SEIS PESOS 93/100 M.N.)',
      leyenda: null,
    });
  });

  it('la letra en mayúsculas conserva acentos y la apócope', () => {
    expect(camposDelCheque({ fecha: '2026-11-20', beneficiario: 'x', centavos: 2_100 }).letra).toBe('(VEINTIÚN PESOS 00/100 M.N.)');
    expect(camposDelCheque({ fecha: '2026-11-20', beneficiario: 'x', centavos: 100_000_000 }).letra).toBe('(UN MILLÓN DE PESOS 00/100 M.N.)');
    expect(camposDelCheque({ fecha: '2026-11-20', beneficiario: 'x', centavos: 1_616_00 }).letra).toBe('(MIL SEISCIENTOS DIECISÉIS PESOS 00/100 M.N.)');
  });

  it('la fecha se lee del texto: el 1 de enero no se vuelve 31 de diciembre', () => {
    expect(fechaDelCheque('2026-01-01')).toBe('1 DE ENERO DE 2026');
    expect(fechaDelCheque('2026-12-31T23:59:00')).toBe('31 DE DICIEMBRE DE 2026');
    for (const mala of ['', '2026-13-01', '2026-00-10', '20-11-2026', 'mañana']) expect(() => fechaDelCheque(mala)).toThrow(RangeError);
  });

  it('el importe con comas sale de centavos enteros', () => {
    expect(importeConComas(0)).toBe('0.00');
    expect(importeConComas(5)).toBe('0.05');
    expect(importeConComas(99_999)).toBe('999.99');
    expect(importeConComas(100_000_000)).toBe('1,000,000.00');
    expect(() => importeConComas(10.5)).toThrow(RangeError);
  });

  it('se niega a escribir un cheque dudoso: sin importe, importe negativo o con fracción de centavo, sin beneficiario', () => {
    const base = { fecha: '2026-11-20', beneficiario: 'PROVEEDOR', centavos: 100 };
    expect(() => camposDelCheque({ ...base, centavos: 0 })).toThrow(RangeError);
    expect(() => camposDelCheque({ ...base, centavos: -100 })).toThrow(RangeError);
    expect(() => camposDelCheque({ ...base, centavos: 100.5 })).toThrow(RangeError);
    expect(() => camposDelCheque({ ...base, beneficiario: '   ' })).toThrow(RangeError);
  });

  it('la leyenda (DCH8) sólo sale si se pide', () => {
    const c = camposDelCheque({ fecha: '2026-11-20', beneficiario: 'x', centavos: 100, leyenda: 'para abono en cuenta del beneficiario' });
    expect(c.leyenda).toBe('PARA ABONO EN CUENTA DEL BENEFICIARIO');
  });

  it('el folio es el número que se escribió en «Preparar» (la misma regla de [PGP.173])', () => {
    expect(folioDelCheque('5407')).toBe('5407');
    expect(folioDelCheque('CH-5407')).toBe('5407');
    expect(folioDelCheque('POR LLENAR')).toBeNull();
    expect(folioDelCheque('12')).toBeNull();
    expect(folioDelCheque(null)).toBeNull();
  });

  it('la hoja de prueba sin pago usa un nombre y una cantidad largos, y se pueden escribir', () => {
    const c = camposDelCheque(datosDeChequeDePrueba('2026-11-20'));
    expect(c.beneficiario.length).toBeGreaterThan(70);
    expect(c.letra).toBe('(UN MILLÓN SETECIENTOS SETENTA Y SIETE MIL SETECIENTOS SETENTA Y SIETE PESOS 77/100 M.N.)');
  });
});

describe('[PGP.165] ¿el pago puede salir en cheque impreso?', () => {
  const pago = (o: Partial<PagoParaCheque> = {}): PagoParaCheque => ({
    payment_method: 'cheque', reference_text: '5407', amount_assigned: 107_446.93, banco: 'BBAJIO',
    items: [{ applied_amount: '100000.00', beneficiary: 'Dulces del Bajío' }, { applied_amount: 7_446.93, beneficiary: 'DULCES  DEL BAJÍO' }],
    ...o,
  });

  it('control: un pago con cheque de BanBajío, con número y que cuadra, se imprime con su importe al centavo', () => {
    const d = dictamenCheque(pago());
    expect(d).toMatchObject({ ok: true, folio: '5407', centavos: 10_744_693, beneficiario: 'DULCES DEL BAJÍO' });
    expect(d.ok && d.plantilla.clave).toBe('bajio-conecta');
  });

  it('cada cosa que falta tiene su motivo y su texto', () => {
    const casos: Array<[Partial<PagoParaCheque>, string]> = [
      [{ payment_method: 'transferencia' }, 'no_es_cheque'],
      [{ banco: null }, 'sin_cuenta'],
      [{ banco: 'SANTANDER' }, 'sin_plantilla'],
      [{ reference_text: 'POR LLENAR' }, 'sin_numero'],
      [{ amount_assigned: '107446.935' }, 'importe_invalido'],
      [{ amount_assigned: 0 }, 'importe_invalido'],
      [{ amount_assigned: '-5.00' }, 'importe_invalido'],
      [{ items: [{ applied_amount: 107_446.93, beneficiary: '  ' }] }, 'sin_beneficiario'],
      // El Calendario pinta «—» a la factura sin etiqueta: eso no es un nombre que se pueda imprimir.
      [{ items: [{ applied_amount: 107_446.93, beneficiary: '—' }] }, 'sin_beneficiario'],
      [{ items: [{ applied_amount: 100_000, beneficiary: 'A SA' }, { applied_amount: 7_446.93, beneficiary: 'B SA' }] }, 'varios_beneficiarios'],
    ];
    for (const [cambio, motivo] of casos) {
      const d = dictamenCheque(pago(cambio));
      expect(d.ok ? 'ok' : d.motivo, motivo).toBe(motivo);
      expect(d.ok ? '' : d.texto).not.toBe('');
    }
  });

  it('un centavo de diferencia entre el pago y sus facturas no se imprime (ése es el cheque que se devolvía)', () => {
    expect(dictamenCheque(pago({ amount_assigned: '107446.94' }))).toMatchObject({ ok: false, motivo: 'no_cuadra' });
    expect(dictamenCheque(pago({ items: [] }))).toMatchObject({ ok: false, motivo: 'no_cuadra' });
  });

  it('dos beneficiarios distintos se nombran en el aviso', () => {
    const d = dictamenCheque(pago({ items: [{ applied_amount: 100_000, beneficiary: 'A SA' }, { applied_amount: 7_446.93, beneficiary: 'B SA' }] }));
    expect(d.ok ? '' : d.texto).toContain('A SA · B SA');
  });

  it('no pide la autorización de la Suite: la autoriza la firma de Dirección en el papel', () => {
    // El contrato no tiene ningún campo de autorización: si alguien lo agrega, esta prueba lo obliga a decidirlo aquí.
    expect(Object.keys(pago()).sort()).toEqual(['amount_assigned', 'banco', 'items', 'payment_method', 'reference_text']);
  });
});

describe('[PGP.165] la plantilla no pisa lo que el banco imprimió', () => {
  it('cada plantilla: los datos dentro del cheque, sin pisar lo impreso ni a otro dato', () => {
    for (const pl of PLANTILLAS_CHEQUE) expect(choques(pl), pl.clave).toEqual([]);
  });

  it('prueba negativa: la primera versión (medida a ojo: base en 35 mm, interlínea 2.9) pisaba «PÁGUESE…» con el renglón de arriba', () => {
    const letra = { ...PLANTILLA_CHEQUE_BAJIO.zonas.letra, base: 35, interlinea: 2.9, letraDosRenglones: 2.9 };
    const mala = { ...PLANTILLA_CHEQUE_BAJIO, zonas: { ...PLANTILLA_CHEQUE_BAJIO.zonas, letra } };
    expect(choques(mala)).toContain('letra(2) × rótulo «PÁGUESE…»');
  });

  it('prueba negativa: un beneficiario que llega a la columna del importe pisa el «$»', () => {
    const beneficiario = { ...PLANTILLA_CHEQUE_BAJIO.zonas.beneficiario, ancho: 115 };
    const mala = { ...PLANTILLA_CHEQUE_BAJIO, zonas: { ...PLANTILLA_CHEQUE_BAJIO.zonas, beneficiario } };
    expect(choques(mala)).toContain('beneficiario × $');
  });

  it('cada dato se apoya sobre su línea impresa (0.3 a 1.2 mm arriba) y dentro de su largo', () => {
    for (const pl of PLANTILLAS_CHEQUE) {
      for (const nombre of ['fecha', 'beneficiario', 'letra'] as const) {
        const z = pl.zonas[nombre];
        const g = pl.guias.find((x) => x.nombre === nombre)!;
        expect(g.y - z.base, `${pl.clave} ${nombre}`).toBeGreaterThanOrEqual(0.3);
        expect(g.y - z.base, `${pl.clave} ${nombre}`).toBeLessThanOrEqual(1.2);
        expect(z.x).toBeGreaterThanOrEqual(g.x1);
        expect(z.x + z.ancho).toBeLessThanOrEqual(g.x2);
      }
    }
  });

  it('el importe cabe dentro de su recuadro', () => {
    for (const pl of PLANTILLAS_CHEQUE) {
      const c = cajaDeZona(pl.zonas.importe);
      const k = pl.cajaImporte;
      expect(c.x >= k.x && c.x2 <= k.x + k.ancho && c.y >= k.y && c.y2 <= k.y + k.alto, pl.clave).toBe(true);
    }
  });

  it('la plantilla se elige por el banco de la cuenta; la que no está medida no existe', () => {
    expect(plantillaDeCheque('bbajio')?.clave).toBe('bajio-conecta');
    expect(plantillaDeCheque('SANTANDER')).toBeNull();
    expect(plantillaDeCheque(null)).toBeNull();
  });

  it('ninguna plantilla se declara calibrada sin la hoja de prueba sobre un cheque real', () => {
    // Cuando Tesorería confirme la hoja de prueba, se cambia a `true` aquí y en la plantilla, con la fecha en `medicion`.
    expect(PLANTILLAS_CHEQUE.every((p) => p.calibrada === false)).toBe(true);
  });
});
