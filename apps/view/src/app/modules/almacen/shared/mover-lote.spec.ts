import { normalizarCodigo, validarMovimiento, UbicacionConocida } from './mover-lote';

const racks: UbicacionConocida[] = [
  { code: 'R-04', label: 'Rack 4', unidades: 78 },
  { code: 'R-11', label: 'Rack 11', unidades: 12 },
  { code: 'T-03', tipoLabel: 'Tarima', unidades: 0 },
];

const mov = (p: Partial<Parameters<typeof validarMovimiento>[0]> = {}) =>
  validarMovimiento({
    desdeCodigo: 'R-04',
    hastaCodigo: 'R-11',
    disponible: 36,
    cantidad: 36,
    conocidas: racks,
    ...p,
  });

describe('normalizarCodigo — tiene que coincidir con el servidor', () => {
  it('sube a mayúsculas y recorta', () => {
    expect(normalizarCodigo('  r-11  ')).toBe('R-11');
  });

  it('los espacios internos se vuelven guion, como en el alta', () => {
    // Si acá quedara el espacio, la pantalla diría "no existe" sobre un código
    // que el servidor SÍ encuentra, porque él normaliza igual.
    expect(normalizarCodigo('rack 11')).toBe('RACK-11');
    expect(normalizarCodigo('rack   11')).toBe('RACK-11');
  });

  it('tolera nulos', () => {
    expect(normalizarCodigo(null)).toBe('');
    expect(normalizarCodigo(undefined)).toBe('');
  });
});

describe('validarMovimiento', () => {
  it('destino vacío no es un error: todavía no escribió nada', () => {
    const v = mov({ hastaCodigo: '' });
    expect(v.puede).toBe(false);
    expect(v.aviso).toBeNull();
    expect(v.esProblema).toBe(false);
  });

  it('el mismo rack no es un movimiento', () => {
    const v = mov({ hastaCodigo: 'r-04' });
    expect(v.puede).toBe(false);
    expect(v.aviso).toBe('Es el mismo rack de origen.');
    expect(v.esProblema).toBe(true);
  });

  it('un destino que no existe se dice AL TECLEAR, con la salida', () => {
    const v = mov({ hastaCodigo: 'R-99' });
    expect(v.puede).toBe(false);
    expect(v.aviso).toContain('No existe R-99');
    expect(v.aviso).toContain('Creala');
  });

  it('un destino que existe confirma qué es y cuánto tiene', () => {
    const v = mov();
    expect(v.puede).toBe(true);
    expect(v.aviso).toBe('Rack 11 · tiene 12 unidades');
    expect(v.esProblema).toBe(false);
  });

  it('encuentra el destino aunque venga escaneado sucio', () => {
    expect(mov({ hastaCodigo: '  r-11 ' }).puede).toBe(true);
  });

  it('un rack vacío es un destino válido', () => {
    const v = mov({ hastaCodigo: 'T-03' });
    expect(v.puede).toBe(true);
    expect(v.aviso).toBe('Tarima · tiene 0 unidades');
  });

  it('no se puede mover más de lo que hay, y lo dice con los dos números', () => {
    const v = mov({ cantidad: 50, disponible: 36 });
    expect(v.puede).toBe(false);
    expect(v.aviso).toBe('En R-04 hay 36: no podés mover 50.');
    expect(v.esProblema).toBe(true);
  });

  it('mover una parte es válido', () => {
    expect(mov({ cantidad: 10, disponible: 36 }).puede).toBe(true);
  });

  it('mover exactamente todo es válido', () => {
    expect(mov({ cantidad: 36, disponible: 36 }).puede).toBe(true);
  });

  it('cantidad en cero o negativa se frena', () => {
    expect(mov({ cantidad: 0 }).puede).toBe(false);
    expect(mov({ cantidad: -3 }).aviso).toBe('Escribí cuánto vas a mover.');
  });

  it('una cantidad que no es número se frena en vez de mandarse', () => {
    expect(mov({ cantidad: Number.NaN }).puede).toBe(false);
  });
});
