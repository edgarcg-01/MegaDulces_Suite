import { nombreArchivoRequisicion, nombreArchivoRequisicionGlobal, textoParaArchivo } from './pedido-requisicion-pdf';

describe('[RA-PRO.56] nombreArchivoRequisicionGlobal — control de los PDF emitidos', () => {
  const d = new Date(2026, 8, 26, 9, 5, 7);   // 26-sep-2026 09:05:07 hora local

  it('Requisicion-global_<PROVEEDOR>_AAAA-MM-DD-HH-MM.pdf', () => {
    expect(nombreArchivoRequisicionGlobal(['DULCES DE LA ROSA'], d))
      .toBe('Requisicion-global_DULCES-DE-LA-ROSA_2026-09-26-09-05.pdf');
  });

  it('limpia acentos, signos y espacios, y recorta a 40 caracteres sin guion colgando', () => {
    const n = nombreArchivoRequisicionGlobal(['BOLSAS DE LOS ALTOS S. DE R.L DE C.V.'], d);
    expect(n).toBe('Requisicion-global_BOLSAS-DE-LOS-ALTOS-S-DE-R-L-DE-C-V_2026-09-26-09-05.pdf');
    expect(nombreArchivoRequisicionGlobal(['Dulcería Ñandú & Cía, S.A. de C.V. — Sucursal Zamora Centro'], d))
      .toBe('Requisicion-global_DULCERIA-NANDU-CIA-S-A-DE-C-V-SUCURSAL-Z_2026-09-26-09-05.pdf');
  });

  it('varios proveedores → VARIOS-PROVEEDORES; repetidos cuentan como uno', () => {
    expect(nombreArchivoRequisicionGlobal(['A', 'B'], d)).toContain('_VARIOS-PROVEEDORES_');
    expect(nombreArchivoRequisicionGlobal(['A', ' A '], d)).toContain('_A_');
  });

  it('sin proveedor → SIN-PROVEEDOR', () => {
    expect(nombreArchivoRequisicionGlobal([''], d)).toContain('_SIN-PROVEEDOR_');
    expect(nombreArchivoRequisicionGlobal(['***'], d)).toContain('_SIN-PROVEEDOR_');
  });
});

describe('[RA-PRO.58] nombreArchivoRequisicion — PDF por producto', () => {
  const d = new Date(2026, 8, 26, 9, 5, 7);

  it('Requisicion_<CODIGO>_<NOMBRE>_AAAA-MM-DD-HH-MM.pdf', () => {
    expect(nombreArchivoRequisicion('17083', 'ALTOS CAM CHICA COLOR 1KG CLASICA', d))
      .toBe('Requisicion_17083_ALTOS-CAM-CHICA-COLOR-1KG-CLASICA_2026-09-26-09-05.pdf');
  });

  it('el nombre se limpia y se recorta a 40; el código conserva sus letras', () => {
    expect(nombreArchivoRequisicion('ab-12', 'GREENPACK ROLLO ALTA 90X120 C 180 / 10 PZA — Ñ', d))
      .toBe('Requisicion_AB-12_GREENPACK-ROLLO-ALTA-90X120-C-180-10-PZA_2026-09-26-09-05.pdf');
  });

  it('sin nombre legible → sólo el código; sin código → SIN-CODIGO', () => {
    expect(nombreArchivoRequisicion('17083', '***', d)).toBe('Requisicion_17083_2026-09-26-09-05.pdf');
    expect(nombreArchivoRequisicion('', 'MAZAPAN', d)).toBe('Requisicion_SIN-CODIGO_MAZAPAN_2026-09-26-09-05.pdf');
  });
});

describe('[RA-PRO.56] textoParaArchivo', () => {
  it('quita acentos y signos, mayúsculas, sin guiones en los bordes', () => {
    expect(textoParaArchivo('  Dulcería Ñandú & Cía.  ')).toBe('DULCERIA-NANDU-CIA');
  });
  it('recorta sin dejar guion colgando', () => {
    expect(textoParaArchivo('AAAA BBBB', 5)).toBe('AAAA');
  });
  it('vacío o sólo signos → cadena vacía', () => {
    expect(textoParaArchivo('')).toBe('');
    expect(textoParaArchivo('*** ///')).toBe('');
  });
});
