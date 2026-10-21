import { trazoSparkline } from './sparkline.component';

/**
 * `[CGA-A.47]` La sparkline acepta huecos (`null`) — y la extensión es ADITIVA: con datos sin
 * huecos tiene que dibujar exactamente lo mismo que antes. La referencia de abajo es el algoritmo
 * anterior COPIADO TAL CUAL (no reescrito), para que la comparación no pruebe una función contra sí
 * misma.
 */
function legado(d: number[]): { linea: string; area: string } {
  if (d.length === 0) return { linea: '', area: '' };
  const points = d.length === 1
    ? [{ x: 0, y: 20 }, { x: 100, y: 20 }]
    : (() => {
        const min = Math.min(...d);
        const max = Math.max(...d);
        const span = max - min || 1;
        const n = d.length - 1;
        return d.map((v, i) => ({ x: (i / n) * 100, y: 39 - ((v - min) / span) * 38 }));
      })();
  const linea = points.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(2)},${pt.y.toFixed(2)}`).join(' ');
  return { linea, area: `${linea} L100,40 L0,40 Z` };
}

describe('trazoSparkline — sin huecos dibuja lo mismo que antes', () => {
  it.each([
    [[5]],
    [[3, 3, 3]],
    [[56856.5, 5712.5, 52643, 197748, 3327.5, 14128.5]],
    [[-2, 0, 7.5, 1e6]],
  ])('%j', (serie) => {
    const t = trazoSparkline(serie);
    const l = legado(serie);
    expect(t.linea).toBe(l.linea);
    expect(t.area).toBe(l.area);
    expect(t.huecos).toEqual([]);
  });

  it('serie vacía: nada', () => {
    expect(trazoSparkline([])).toEqual({ puntos: [], linea: '', area: '', huecos: [] });
  });
});

describe('trazoSparkline — un día sin medir es un HUECO, no un cero', () => {
  // Efectivo real del cajón, 05→10-oct-2026, con el 09-oct sin conteo.
  const serie = [56856.5, 5712.5, 52643, 197748, null, 3327.5];

  it('la línea se corta en el hueco: dos tramos', () => {
    const t = trazoSparkline(serie);
    expect(t.linea.match(/M/g)?.length).toBe(2);
    expect(t.huecos).toEqual([80]);
    expect(t.puntos[4]).toBeNull();
  });

  it('⛔ el hueco NO se dibuja como cero (si se hiciera, la escala y la línea cambiarían)', () => {
    const conCero = trazoSparkline(serie.map((v) => v ?? 0));
    const conHueco = trazoSparkline(serie);
    expect(conHueco.linea).not.toBe(conCero.linea);
    // El mínimo de la escala es el menor valor MEDIDO ($3,327.50), no un 0 inventado.
    const yUltimo = conHueco.puntos[5]!.y;
    expect(yUltimo).toBeCloseTo(39, 5);
  });

  it('el área no rellena el hueco: una por tramo de más de un punto', () => {
    const t = trazoSparkline(serie);
    expect(t.area.match(/Z/g)?.length).toBe(1);   // el tramo final tiene un solo punto: sin área
  });

  it('todo sin medir: sin línea, todos huecos', () => {
    const t = trazoSparkline([null, null, null]);
    expect(t.linea).toBe('');
    expect(t.huecos).toEqual([0, 50, 100]);
  });
});
