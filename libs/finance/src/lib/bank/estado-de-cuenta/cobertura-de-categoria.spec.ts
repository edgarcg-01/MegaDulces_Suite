import { coberturaDeCategoria, type FilaDeCobertura } from './cobertura-de-categoria';

const HOY = '2026-11-23'; // lunes
const f = (o: Partial<FilaDeCobertura>): FilaDeCobertura =>
  ({ con_categoria: false, motivo: null, responsable: null, fecha: '2026-11-20', n: 1, monto: 100, ...o });

describe('[BFU.7.6] coberturaDeCategoria — con categoría + por qué y de quién', () => {
  it('reparte por motivo y responsable, el de más dinero primero, y declara lo que no tiene motivo', () => {
    const c = coberturaDeCategoria([
      f({ con_categoria: true, n: 10, monto: 1000 }),
      f({ motivo: 'kepler_en_otra_cuenta', responsable: 'tesoreria', n: 2, monto: 300 }),
      f({ motivo: 'cuenta_sin_categoria', responsable: 'contabilidad', n: 3, monto: 900 }),
      f({ motivo: null, n: 1, monto: '50.5' }),
    ], HOY, 16);
    expect(c.evaluados).toBe(16);
    expect(c.con_categoria).toEqual({ n: 10, monto: 1000 });
    expect(c.por_resolver.map((g) => g.motivo)).toEqual(['cuenta_sin_categoria', 'kepler_en_otra_cuenta']);
    expect(c.sin_motivo).toEqual({ n: 1, monto: 50.5 });
    expect(c.suma_cuadra).toBe(true);
  });
  it('⛔ «todavía no» se recalcula al leer: pasado el plazo es «no lo tiene» y del área, aunque el motor no corra', () => {
    const c = coberturaDeCategoria([
      f({ motivo: 'kepler_aun_no_lo_tiene', responsable: 'nadie_todavia', fecha: '2026-11-13', n: 4 }), // 6 días hábiles
      f({ motivo: 'kepler_aun_no_lo_tiene', responsable: 'nadie_todavia', fecha: '2026-11-16', n: 2 }), // 5: dentro
      f({ motivo: 'kepler_no_lo_tiene', responsable: 'area', fecha: '2026-11-03', n: 1 }),
    ], HOY);
    const de = (m: string) => c.por_resolver.find((g) => g.motivo === m);
    expect(de('kepler_no_lo_tiene')).toMatchObject({ responsable: 'area', n: 5 });
    expect(de('kepler_aun_no_lo_tiene')).toMatchObject({ responsable: 'nadie_todavia', n: 2 });
    expect(c.vencidos_al_leer).toBe(4);
  });
  it('[negativa] el conteo independiente que no casa se pone en falso; sin conteo, no medido (null)', () => {
    const filas = [f({ con_categoria: true, n: 3 }), f({ motivo: 'pareo_debil', responsable: 'tesoreria', n: 1 })];
    expect(coberturaDeCategoria(filas, HOY, 5).suma_cuadra).toBe(false);
    expect(coberturaDeCategoria(filas, HOY).suma_cuadra).toBeNull();
  });
  it('un motivo guardado sin responsable toma el de la lista cerrada', () => {
    const c = coberturaDeCategoria([f({ motivo: 'cuenta_sin_categoria', responsable: null })], HOY);
    expect(c.por_resolver[0]).toMatchObject({ motivo: 'cuenta_sin_categoria', responsable: 'contabilidad' });
  });
  it('sin renglones: ceros, no inventa nada', () => {
    expect(coberturaDeCategoria([], HOY, 0)).toEqual({ evaluados: 0, con_categoria: { n: 0, monto: 0 }, por_resolver: [],
      sin_motivo: { n: 0, monto: 0 }, suma_cuadra: true, vencidos_al_leer: 0 });
  });
});
