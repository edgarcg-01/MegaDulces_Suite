import { ordenarParaBarraMovil } from './layout-barra-movil';

/**
 * `[MOV]` La barra inferior del celular. El caso que la motivó: en Tienda, los 4 primeros del
 * menú eran Caja (práctica), Verificador, Monitor en vivo y Sucursales, y el Arqueo —abierto
 * por el encargado los 31 días del mes— quedaba fuera, detrás de «Más».
 */
describe('ordenarParaBarraMovil', () => {
  const tienda = [
    { label: 'Caja (práctica)' },
    { label: 'Verificador de precios' },
    { label: 'Monitor en vivo', movil: 2 },
    { label: 'Sucursales' },
    { label: 'Ritmo del día', movil: 3 },
    { label: 'Arqueo de caja', movil: 1 },
    { label: 'Etiquetas' },
  ];
  const nombres = (xs: { label: string }[]) => xs.map((x) => x.label);

  it('el Arqueo entra a la barra y va primero; el 4º lugar lo rellena el menú', () => {
    expect(nombres(ordenarParaBarraMovil(tienda).slice(0, 4))).toEqual([
      'Arqueo de caja',
      'Monitor en vivo',
      'Ritmo del día',
      'Caja (práctica)',
    ]);
  });

  it('sin ningún `movil` deja el orden del menú intacto (las demás áreas no cambian)', () => {
    const sin = tienda.map(({ label }) => ({ label }));
    expect(nombres(ordenarParaBarraMovil(sin))).toEqual(nombres(sin));
  });

  it('es estable: los items sin `movil` conservan su orden relativo', () => {
    const resto = nombres(ordenarParaBarraMovil(tienda)).slice(3);
    expect(resto).toEqual(['Caja (práctica)', 'Verificador de precios', 'Sucursales', 'Etiquetas']);
  });

  it('no muta la lista que recibe (es la del menú lateral)', () => {
    const copia = nombres(tienda);
    ordenarParaBarraMovil(tienda);
    expect(nombres(tienda)).toEqual(copia);
  });
});
