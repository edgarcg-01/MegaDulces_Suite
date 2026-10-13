import {
  FilaCatalogo, coberturaAncho, coberturaTexto, contarFiltros, dineroCorto, filtrarYOrdenar, nombrePropio, nombreProveedor, pasaFiltro,
} from './catalogo-proveedor';

const f = (id: string, over: Partial<FilaCatalogo> = {}): FilaCatalogo => ({
  product_id: id, sku: id, nombre: id, mes: 0, variacion: null, cobertura_dias: null, veredicto: 'esperar', titulo: '',
  motivo: '', lider: null, margen_real: null, caducidad: null, ...over,
});

describe('[PF.9] nombres legibles', () => {
  it('Kepler en mayúsculas → nombre propio; los conectores en minúscula y lo que trae números como viene', () => {
    expect(nombrePropio('PALETA DE DULCE LA ROSA 40G C/50')).toBe('Paleta de Dulce la Rosa 40G C/50');
    expect(nombrePropio('  MAZAPÁN   GIGANTE ')).toBe('Mazapán Gigante');
    expect(nombrePropio('DE LA ROSA')).toBe('De la Rosa');
    expect(nombrePropio(null)).toBe('');
  });

  it('al proveedor se le quita la razón social, en sus formas comunes', () => {
    expect(nombreProveedor('DULCES LA ROSA, S.A. DE C.V.')).toBe('Dulces la Rosa');
    expect(nombreProveedor('BARCEL SA DE CV')).toBe('Barcel');
    expect(nombreProveedor('DISTRIBUIDORA DEL CENTRO S DE RL DE CV')).toBe('Distribuidora del Centro');
    expect(nombreProveedor('GRUPO DULCERO SAPI DE CV')).toBe('Grupo Dulcero');
    // Lo que no termina en razón social no se toca.
    expect(nombreProveedor('MARINELA')).toBe('Marinela');
  });

  it('dinero corto para la barra', () => {
    expect(dineroCorto(1_250_000)).toMatch(/^\$1\.3\s?M$/);
    expect(dineroCorto(null)).toBe('—');
  });
});

describe('[PF.9] filtros y orden', () => {
  const xs = [
    f('a', { veredicto: 'comprar', mes: 100, cobertura_dias: 3, lider: { rank: 1, participacion: 0.01 }, nombre: 'Zeta' }),
    f('b', { veredicto: 'traspasar', mes: 300, cobertura_dias: 30, nombre: 'Alfa' }),
    f('c', { veredicto: 'sobra', mes: 50, cobertura_dias: 200, nombre: 'Beta' }),
    f('d', { veredicto: 'no_comprar', mes: 0, cobertura_dias: null, nombre: 'Gamma' }),
    f('e', { veredicto: 'sin_movimiento', mes: 0, cobertura_dias: null, nombre: 'Ñandú' }),
  ];

  it('⭐ "No comprar" junta lo que sobra, lo que no se vende y lo que no se mueve', () => {
    expect(contarFiltros(xs)).toEqual({ todos: 5, comprar: 1, mover: 1, esperar: 0, no_comprar: 3, lideres: 1 });
    expect(pasaFiltro(xs[2], 'no_comprar')).toBe(true);
    expect(pasaFiltro(xs[0], 'no_comprar')).toBe(false);
  });

  it('busca por nombre sin acentos y por SKU', () => {
    expect(filtrarYOrdenar(xs, 'todos', 'nandu', 'venta').map((x) => x.product_id)).toEqual(['e']);
    expect(filtrarYOrdenar(xs, 'todos', 'B', 'venta').map((x) => x.product_id)).toEqual(['b', 'c']);
  });

  it('⭐ "Se acaba primero": lo de menos días arriba y lo que no se vende al final (no como cero)', () => {
    expect(filtrarYOrdenar(xs, 'todos', '', 'cobertura').map((x) => x.product_id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(filtrarYOrdenar(xs, 'todos', '', 'venta').map((x) => x.product_id).slice(0, 3)).toEqual(['b', 'a', 'c']);
    expect(filtrarYOrdenar(xs, 'todos', '', 'nombre').map((x) => x.nombre)).toEqual(['Alfa', 'Beta', 'Gamma', 'Ñandú', 'Zeta']);
  });

  it('no muta la lista que recibe', () => {
    const copia = xs.map((x) => x.product_id);
    filtrarYOrdenar(xs, 'todos', '', 'nombre');
    expect(xs.map((x) => x.product_id)).toEqual(copia);
  });
});

describe('[PF.9] cobertura', () => {
  it('la barra se topa en el umbral de "sobra"; sin venta no hay barra', () => {
    expect(coberturaAncho(30, 60)).toBe(50);
    expect(coberturaAncho(600, 60)).toBe(100);
    expect(coberturaAncho(0, 60)).toBe(0);
    expect(coberturaAncho(null, 60)).toBeNull();
  });
  it('en palabras', () => {
    expect(coberturaTexto(null)).toBe('No se vende');
    expect(coberturaTexto(0)).toBe('Sin existencia');
    expect(coberturaTexto(0.4)).toBe('Menos de un día');
    expect(coberturaTexto(1)).toBe('1 día');
    expect(coberturaTexto(17.6)).toBe('18 días');
    expect(coberturaTexto(500)).toBe('Más de un año');
  });
});
