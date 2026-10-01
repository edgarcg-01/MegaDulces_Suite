import { FilaDeZona, opcionesDeZona, zonaGuardadaQueNoEsZona } from './zona-opciones';

/**
 * `[ZN.6]` — El catálogo es el REAL de prod (medido el 2026-09-30), no uno inventado: 11 filas
 * vivas de las que sólo 3 son zonas. Un fixture de laboratorio con 3 zonas limpias no habría
 * detectado nada, porque el defecto vive justo en las otras 8.
 */
const ZONAS: FilaDeZona[] = [
  { id: 'lp', value: 'LA PIEDAD RD', kind: 'zona' },
  { id: 'zam', value: 'ZAMORA', kind: 'zona' },
  { id: 'mor', value: 'MORELIA', kind: 'zona' },
  { id: 'ma', value: 'MORELIA ABASTOS', kind: 'sucursal', kind_motivo: 'Es la sucursal 08 (MA). Su zona es Morelia.' },
  { id: 'mm', value: 'MORELIA MADERO', kind: 'sucursal', kind_motivo: 'Es la sucursal 07 (MM). Su zona es Morelia.' },
  { id: 'can', value: 'CANINDO', kind: 'sucursal', kind_motivo: 'Es la sucursal 06. Su zona es Zamora.' },
  { id: 'yur', value: 'YURECUARO VECINAL', kind: 'sucursal', kind_motivo: 'Es la sucursal 04.' },
  { id: 'lpv', value: 'LA PIEDAD VECINAL', kind: 'canal', kind_motivo: 'Canal vecinal de la zona La Piedad.' },
  { id: 'zv', value: 'ZAMORA VECINAL', kind: 'canal', kind_motivo: 'Canal vecinal de la zona Zamora.' },
  { id: 'ofi', value: 'OFICINAS', kind: 'oficina', kind_motivo: 'No es un lugar de venta: es la actividad.' },
  { id: 'lpm', value: 'LA PIEDAD MAYOREO', kind: null },
];

const etiquetas = (o: ReturnType<typeof opcionesDeZona>) => o.map((x) => x.label);

describe('[ZN.6] opciones del selector de zona', () => {
  it('ofrece las 3 zonas y ninguna de las 8 filas que no lo son', () => {
    const opts = opcionesDeZona(ZONAS, null);
    expect(etiquetas(opts)).toEqual(['Ninguna', 'LA PIEDAD RD', 'ZAMORA', 'MORELIA']);
  });

  it('⛔ el contra-ejemplo: sin el filtro se ofrecían las 11, y por ahí entró el defecto', () => {
    // La lista completa NO debe poder salir de esta función bajo ninguna entrada.
    const conCadaGuardada = ZONAS.map((z) => opcionesDeZona(ZONAS, z.id).length);
    // Peor caso: las 3 zonas + «Ninguna» + a lo sumo UNA fila marcada.
    expect(Math.max(...conCadaGuardada)).toBe(5);
    expect(ZONAS.length + 1).toBe(12); // lo que ofrecía antes
  });

  it('conserva lo guardado cuando NO es una zona, y lo marca', () => {
    const opts = opcionesDeZona(ZONAS, 'ma');
    expect(etiquetas(opts)).toContain('MORELIA ABASTOS — no es una zona');
    expect(opts.find((o) => o.value === 'ma')?.fueraDelCatalogo).toBe(true);
    // Y no arrastra a sus compañeras: MORELIA MADERO no se cuela.
    expect(etiquetas(opts)).not.toContain('MORELIA MADERO');
  });

  it('una zona legítima guardada NO se marca', () => {
    const opts = opcionesDeZona(ZONAS, 'mor');
    expect(opts.find((o) => o.value === 'mor')?.fueraDelCatalogo).toBeUndefined();
    expect(etiquetas(opts)).toEqual(['Ninguna', 'LA PIEDAD RD', 'ZAMORA', 'MORELIA']);
  });

  it('una fila SIN clasificar no cuenta como zona — fail-closed', () => {
    expect(etiquetas(opcionesDeZona(ZONAS, null))).not.toContain('LA PIEDAD MAYOREO');
    // Pero si alguien la tiene guardada, se ve marcada en vez de desaparecer.
    expect(etiquetas(opcionesDeZona(ZONAS, 'lpm'))).toContain('LA PIEDAD MAYOREO — no es una zona');
  });

  it('⛔ si el servidor no mandara `kind`, se nota al instante en vez de fallar abierto', () => {
    const sinKind = ZONAS.map(({ id, value }) => ({ id, value }));
    expect(etiquetas(opcionesDeZona(sinKind, null))).toEqual(['Ninguna']);
  });

  it('una zona guardada que ya no está en el catálogo no inventa una opción', () => {
    const opts = opcionesDeZona(ZONAS, 'borrada-hace-meses');
    expect(etiquetas(opts)).toEqual(['Ninguna', 'LA PIEDAD RD', 'ZAMORA', 'MORELIA']);
  });
});

describe('[ZN.6] lo guardado que no es una zona se DECLARA con su motivo', () => {
  it('devuelve el nombre y el motivo que trae la propia fila', () => {
    expect(zonaGuardadaQueNoEsZona(ZONAS, 'ma')).toEqual({
      nombre: 'MORELIA ABASTOS',
      motivo: 'Es la sucursal 08 (MA). Su zona es Morelia.',
    });
  });

  it('OFICINAS también se declara: es una actividad, no un lugar', () => {
    expect(zonaGuardadaQueNoEsZona(ZONAS, 'ofi')?.nombre).toBe('OFICINAS');
  });

  it('sin motivo escrito devuelve null en el motivo, NO una cadena vacía que parezca explicación', () => {
    expect(zonaGuardadaQueNoEsZona(ZONAS, 'lpm')).toEqual({ nombre: 'LA PIEDAD MAYOREO', motivo: null });
  });

  it('no declara nada cuando la zona es legítima, ni cuando no tiene', () => {
    expect(zonaGuardadaQueNoEsZona(ZONAS, 'mor')).toBeNull();
    expect(zonaGuardadaQueNoEsZona(ZONAS, null)).toBeNull();
  });
});
