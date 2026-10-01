import { agruparPorSucursal, dia, evidenciaLabel, nombreArchivoEntrega, periodoPorDefecto, receiptKey, sumar } from './compras-entrega';

/**
 * `[RE.32]` — La entrega es un papel que se FIRMA: el orden, los subtotales y las fechas que salen
 * de acá tienen que coincidir con la pantalla y con lo que guardó el servidor.
 */
describe('compras-entrega', () => {
  it('agrupa por sucursal respetando el orden del servidor (no reordena)', () => {
    const rows = [
      { sucursal: '00', folio: 'a', amount: 10.1 },
      { sucursal: '00', folio: 'b', amount: 20.2 },
      { sucursal: '01', folio: 'c', amount: 5 },
    ];
    const g = agruparPorSucursal(rows);
    expect(g.map((x) => x.sucursal)).toEqual(['00', '01']);
    expect(g[0].rows.map((r) => r.folio)).toEqual(['a', 'b']);
    expect(g[0].total).toBe(30.3);
    expect(g[0].nombre).toBe('CEDIS (00)');
  });

  it('una sucursal que reaparece más abajo se suma a su grupo, no abre otro', () => {
    const g = agruparPorSucursal([
      { sucursal: '00', amount: 1 }, { sucursal: '01', amount: 1 }, { sucursal: '00', amount: 1 },
    ]);
    expect(g).toHaveLength(2);
    expect(g[0].rows).toHaveLength(2);
  });

  it('suma dinero sin error de flotante (0.1 + 0.2)', () => {
    expect(sumar([{ amount: 0.1 }, { amount: 0.2 }])).toBe(0.3);
    // numeric llega como texto desde pg
    expect(sumar([{ amount: '1069.01' as unknown as number }, { amount: 43307.45 }])).toBe(44376.46);
  });

  it('sucursal sin nombre conocido se declara, no se inventa', () => {
    expect(agruparPorSucursal([{ sucursal: '99', amount: 1 }])[0].nombre).toBe('Sucursal 99');
  });

  it('la fecha no se corre de día (no pasa por Date)', () => {
    expect(dia('2026-09-01')).toBe('01/09/2026');
    expect(dia(null)).toBe('—');
  });

  it('periodo por defecto: 7 días incluyendo hoy', () => {
    expect(periodoPorDefecto(new Date(2026, 8, 29), 7)).toEqual({ from: '2026-09-23', to: '2026-09-29' });
    expect(periodoPorDefecto(new Date(2026, 9, 2), 7)).toEqual({ from: '2026-09-26', to: '2026-10-02' });
  });

  it('llave de la entrada = la del índice único (sucursal|prefijo|folio)', () => {
    expect(receiptKey({ sucursal: '00', doc_prefix: 'XA2001', folio: '0009716' })).toBe('00|XA2001|0009716');
  });

  it('evidencia desconocida o vacía se lee como "Sin foto"', () => {
    expect(evidenciaLabel(null)).toBe('Sin foto');
    expect(evidenciaLabel('validado')).toBe('Validada');
  });

  it('nombre del archivo del PDF', () => {
    expect(nombreArchivoEntrega('ENT-2026-00001')).toBe('Entrega-ENT-2026-00001.pdf');
  });
});
