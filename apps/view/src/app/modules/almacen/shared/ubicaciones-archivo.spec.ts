import { csvATabla, decodificarCsv, leerTablaUbicaciones } from './ubicaciones-archivo';

describe('[UB.2] leer archivo de ubicaciones', () => {
  it('reconoce encabezados con acentos, mayúsculas y en cualquier orden', () => {
    const r = leerTablaUbicaciones([
      ['Nombre', 'CÓDIGO', 'Tipo'],
      ['Rack de dulces', 'BA053', 'surtido'],
    ]);
    expect(r).toEqual({ ok: true, vacias: 0, filas: [{ fila: 2, code: 'BA053', tipo: 'surtido', label: 'Rack de dulces' }] });
  });

  it('la fila es la del archivo (para señalar el error exacto), saltando renglones vacíos', () => {
    const r = leerTablaUbicaciones([['codigo'], ['BA011'], [''], ['BA012']]);
    expect(r.ok && r.filas.map((f) => f.fila)).toEqual([2, 4]);
    expect(r.ok && r.vacias).toBe(1);
  });

  it('el código mal escrito NO se corrige aquí: lo valida el servidor con su motivo', () => {
    const r = leerTablaUbicaciones([['Código'], ['BA5 3']]);
    expect(r.ok && r.filas[0].code).toBe('BA5 3');
  });

  it('sin columna de código no adivina: lo dice', () => {
    const r = leerTablaUbicaciones([['producto', 'cantidad'], ['x', '1']]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('columna del código');
  });

  it('celdas de exceljs con texto enriquecido o fórmula', () => {
    const r = leerTablaUbicaciones([['codigo'], [{ richText: [{ text: 'BA' }, { text: '053' }] }], [{ result: 'TA021' }]]);
    expect(r.ok && r.filas.map((f) => f.code)).toEqual(['BA053', 'TA021']);
  });

  it('vacío o sólo encabezados = error declarado, no cero renglones en silencio', () => {
    expect(leerTablaUbicaciones([]).ok).toBe(false);
    expect(leerTablaUbicaciones([['codigo']]).ok).toBe(false);
  });
});

describe('[UB.2] CSV', () => {
  it('detecta ; como separador y respeta comillas', () => {
    expect(csvATabla('Código;Nombre\nBA053;"Rack; esquina"\n')).toEqual([['Código', 'Nombre'], ['BA053', 'Rack; esquina']]);
  });

  it('la fila reportada es la del archivo aunque haya líneas en blanco', () => {
    const r = leerTablaUbicaciones(csvATabla('codigo\nBA011\n\nBA012\n'));
    expect(r.ok && r.filas.map((f) => [f.fila, f.code])).toEqual([[2, 'BA011'], [4, 'BA012']]);
    expect(r.ok && r.vacias).toBe(1);
  });

  it('Excel en español guarda el CSV en Windows-1252: el acento se respeta', () => {
    const ansi = new Uint8Array([0x43, 0xf3, 0x64, 0x69, 0x67, 0x6f]); // "Código" en 1252
    expect(decodificarCsv(ansi.buffer)).toBe('Código');
    expect(decodificarCsv(new TextEncoder().encode('Código').buffer as ArrayBuffer)).toBe('Código');
  });

  it('una celda de error de Excel se ve como tal', () => {
    const r = leerTablaUbicaciones([['codigo'], [{ error: '#N/A' }]]);
    expect(r.ok && r.filas[0].code).toBe('#N/A');
  });

  it('coma por default y BOM de Excel', () => {
    expect(csvATabla('\uFEFFcodigo,tipo\r\nBA011,reserva')).toEqual([['codigo', 'tipo'], ['BA011', 'reserva']]);
  });
});
