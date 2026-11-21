import type { CeroEnFicha } from '@megadulces/contracts';
import { dondeEnCero, etiquetasEnCero, queEstaEnCero } from './en-ceros';

const z = (sucursal: string, unidad: string, costo: CeroEnFicha['costo'], precio_cero = false): CeroEnFicha => ({
  sucursal, sucursal_nombre: `Suc ${sucursal}`, unidad, costo, precio_cero,
});

describe('[CAT-PRECIO.6] costo o precio en cero, en palabras', () => {
  it('dice qué está en cero: costo $0, costo vacío, precio $0 o ambos', () => {
    expect(queEstaEnCero({ costo: 'cero', precio_cero: false })).toBe('costo $0');
    expect(queEstaEnCero({ costo: 'vacio', precio_cero: false })).toBe('costo vacío');
    expect(queEstaEnCero({ costo: null, precio_cero: true })).toBe('precio $0');
    expect(queEstaEnCero({ costo: 'cero', precio_cero: true })).toBe('costo $0 y precio $0');
  });

  it('el mismo error en todas las sucursales de la ficha se dice en una línea', () => {
    const ceros = ['01', '02', '03'].map((s) => z(s, 'PZA', 'vacio'));
    expect(dondeEnCero({ ceros, plazas: 3 })).toEqual(['En sus 3 sucursales · PZA: costo vacío']);
  });

  it('si no está en todas, se nombran las sucursales; grupos distintos van aparte', () => {
    const ceros = [z('01', 'PZA', 'vacio'), z('02', 'PZA', 'vacio'), z('01', 'CJA', 'cero', true)];
    expect(dondeEnCero({ ceros, plazas: 5 })).toEqual([
      'Suc 01, Suc 02 · PZA: costo vacío',
      'Suc 01 · CJA: costo $0 y precio $0',
    ]);
  });

  it('una sola sucursal se nombra aunque sea la única de la ficha', () => {
    expect(dondeEnCero({ ceros: [z('07', 'PZA', 'cero')], plazas: 1 })).toEqual(['Suc 07 · PZA: costo $0']);
  });

  it('las etiquetas del renglón: precio $0 primero (es lo grave), sin repetir', () => {
    const ceros = [z('01', 'PZA', 'vacio'), z('02', 'PZA', 'cero', true), z('03', 'PZA', 'cero')];
    expect(etiquetasEnCero({ ceros })).toEqual([
      { texto: 'Precio $0', grave: true },
      { texto: 'Costo $0', grave: false },
      { texto: 'Costo vacío', grave: false },
    ]);
  });
});
