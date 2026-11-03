import { describe, expect, it } from 'vitest';
import type { ColaSucursal } from '@megadulces/contracts';
import { SIN_FILTROS, conteosFiltros, filtrarColas, hayFiltros, porGrupo, repartir, veredicto } from './pendientes-sucursal.util';

const cola = (p: Partial<ColaSucursal>): ColaSucursal => ({
  id: 'x', grupo: 'recibir', de: 'sucursal', label: 'X', accion: '', ruta: '/x', query: null, ventana: null,
  puede_abrir: false, estado: 'ok', total: 0, mas_viejo_dias: null, filas: [], ...p,
});

describe('[AB.45] Pendientes de la sucursal — reparto de colas', () => {
  const colas = [
    cola({ id: 'a', total: 3, mas_viejo_dias: 2 }),
    cola({ id: 'b', total: 1, mas_viejo_dias: 9, grupo: 'caja' }),
    cola({ id: 'c', total: 0 }),
    cola({ id: 'd', estado: 'no_medido', grupo: 'caja' }),
    cola({ id: 'e', de: 'otra_area', total: 300, grupo: 'inventario' }),
    cola({ id: 'f', de: 'otra_area', total: 0 }),
  ];

  it('con trabajo, lo que más espera primero', () => {
    expect(repartir(colas).conTrabajo.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('en cero va a «al día»; la que no se leyó, aparte', () => {
    const r = repartir(colas);
    expect(r.alDia.map((c) => c.id)).toEqual(['c']);
    expect(r.sinLeer.map((c) => c.id)).toEqual(['d']);
  });

  it('lo de otra área se ve pero NO suma al total de la sucursal', () => {
    const v = veredicto(colas);
    expect(v.total).toBe(4);
    expect(v.colas).toBe(2);
    expect(v.masViejo).toBe(9);
    expect(repartir(colas).otraArea.map((c) => c.id)).toEqual(['e']);
  });

  it('una cola que no se pudo leer se cuenta como sin leer, no como cero', () => {
    expect(veredicto(colas).sinLeer).toBe(1);
    expect(porGrupo(colas).find((g) => g.grupo === 'caja')).toEqual({ grupo: 'caja', total: 1, sinLeer: true });
  });

  it('prueba negativa: sin colas sin leer, sinLeer es 0', () => {
    expect(veredicto([cola({ total: 1 })]).sinLeer).toBe(0);
  });
});

describe('[AB.47] filtros de Pendientes de sucursal', () => {
  const fila = (folio: string, detalle: string, resp: null | { nombre: string; soy_yo: boolean }) => ({
    clave: folio, folio, detalle, dias: 1, monto: null,
    responsable: resp ? { user_id: 'u', nombre: resp.nombre, desde: '2026-11-03T10:00:00Z', soy_yo: resp.soy_yo } : null,
  });
  const colas = [
    cola({ id: 'a', grupo: 'recibir', total: 3, mas_viejo_dias: 5, puede_abrir: true,
      filas: [fila('E1', 'Dulces Ánfora', null), fila('E2', 'Cajeta', { nombre: 'Ana', soy_yo: false }), fila('E3', 'Chicle', { nombre: 'Yo', soy_yo: true })] }),
    cola({ id: 'b', grupo: 'caja', total: 1, mas_viejo_dias: 2, puede_abrir: false, filas: [fila('T1', 'Caja 2', null)] }),
    cola({ id: 'c', de: 'otra_area', total: 9 }),
  ];

  it('sin filtros: todas las colas con trabajo, con todas sus filas', () => {
    const r = filtrarColas(colas, SIN_FILTROS);
    expect(r.colas.map((c) => c.cola.id)).toEqual(['a', 'b']);
    expect(r.ocultas).toBe(0);
    expect(hayFiltros(SIN_FILTROS)).toBe(false);
  });

  it('«míos» deja sólo lo que me atribuí; la cola sin nada mío sale y se cuenta como oculta', () => {
    const r = filtrarColas(colas, { ...SIN_FILTROS, quien: 'mios' });
    expect(r.colas.map((c) => c.filas.map((f) => f.folio))).toEqual([['E3']]);
    expect(r.ocultas).toBe(1);
  });

  it('«sin tomar» deja sólo lo que nadie tiene', () => {
    const r = filtrarColas(colas, { ...SIN_FILTROS, quien: 'sin_tomar' });
    expect(r.colas.flatMap((c) => c.filas.map((f) => f.folio))).toEqual(['E1', 'T1']);
  });

  it('el buscador ignora acentos y encuentra por responsable', () => {
    expect(filtrarColas(colas, { ...SIN_FILTROS, texto: 'anfora' }).colas[0].filas.map((f) => f.folio)).toEqual(['E1']);
    expect(filtrarColas(colas, { ...SIN_FILTROS, texto: 'ana' }).colas[0].filas.map((f) => f.folio)).toEqual(['E2']);
  });

  it('proceso y «sólo lo que puedo resolver» filtran colas, no filas', () => {
    expect(filtrarColas(colas, { ...SIN_FILTROS, grupo: 'caja' }).colas.map((c) => c.cola.id)).toEqual(['b']);
    expect(filtrarColas(colas, { ...SIN_FILTROS, soloPuedo: true }).colas.map((c) => c.cola.id)).toEqual(['a']);
  });

  it('los conteos de cada control respetan los OTROS filtros', () => {
    const k = conteosFiltros(colas, { ...SIN_FILTROS, grupo: 'recibir' });
    expect(k.quien).toEqual({ todos: 3, sin_tomar: 1, mios: 1 });
    expect(k.grupo).toEqual({ todos: 4, recibir: 3, caja: 1 });
    expect(conteosFiltros(colas, { ...SIN_FILTROS, quien: 'mios' }).grupo).toEqual({ todos: 1, recibir: 1 });
  });

  it('una cola que trae menos filas que su total se marca recortada', () => {
    const r = filtrarColas([cola({ id: 'x', total: 500, mas_viejo_dias: 1, filas: [fila('Z', 'z', null)] })], SIN_FILTROS);
    expect(r.colas[0].recortada).toBe(true);
  });
});
