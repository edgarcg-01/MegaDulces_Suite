import { ordenarParaBarraMovil } from './layout-barra-movil';

/**
 * `[MOV]` La barra inferior del celular. El caso que la motivó: en Tienda, los 4 primeros del
 * menú eran Caja (práctica), Verificador, Monitor en vivo y Sucursales, y la Lista de faltantes
 * —captura de piso, que se usa con el cliente enfrente— quedaba detrás de «Más».
 *
 * Los `movil` del fixture son los de `layout.component.ts`, medidos EN CELULAR
 * (`commercial.portal_telemetry_events`, persona-días, 2026-11-13): Verificador 22 · Monitor 22 ·
 * Arqueo 9 · Faltantes 4. Caja (práctica) 1 y Ritmo del día 1 quedan fuera.
 */
describe('ordenarParaBarraMovil', () => {
  const tienda = [
    { label: 'Caja (práctica)' },
    { label: 'Verificador de precios', movil: 1 },
    { label: 'Monitor en vivo', movil: 2 },
    { label: 'Sucursales' },
    { label: 'Ritmo del día' },
    { label: 'Lista de faltantes', movil: 4 },
    { label: 'Arqueo de caja', movil: 3 },
    { label: 'Etiquetas' },
  ];
  const nombres = (xs: { label: string }[]) => xs.map((x) => x.label);

  it('los 4 lugares son los medidos en celular, en su orden', () => {
    expect(nombres(ordenarParaBarraMovil(tienda).slice(0, 4))).toEqual([
      'Verificador de precios',
      'Monitor en vivo',
      'Arqueo de caja',
      'Lista de faltantes',
    ]);
  });

  it('si el puesto no ve un item con `movil`, el hueco lo rellena el menú (no queda vacío)', () => {
    const sinArqueo = tienda.filter((i) => i.label !== 'Arqueo de caja');
    expect(nombres(ordenarParaBarraMovil(sinArqueo).slice(0, 4))).toEqual([
      'Verificador de precios',
      'Monitor en vivo',
      'Lista de faltantes',
      'Caja (práctica)',
    ]);
  });

  it('sin ningún `movil` deja el orden del menú intacto (las demás áreas no cambian)', () => {
    const sin = tienda.map(({ label }) => ({ label }));
    expect(nombres(ordenarParaBarraMovil(sin))).toEqual(nombres(sin));
  });

  it('es estable: los items sin `movil` conservan su orden relativo', () => {
    const resto = nombres(ordenarParaBarraMovil(tienda)).slice(4);
    expect(resto).toEqual(['Caja (práctica)', 'Sucursales', 'Ritmo del día', 'Etiquetas']);
  });

  it('no muta la lista que recibe (es la del menú lateral)', () => {
    const copia = nombres(tienda);
    ordenarParaBarraMovil(tienda);
    expect(nombres(tienda)).toEqual(copia);
  });
});
