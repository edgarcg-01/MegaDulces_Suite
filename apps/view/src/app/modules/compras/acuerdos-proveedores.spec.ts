import { describe, it, expect } from 'vitest';
import type { AcuerdoVista, ListaAcuerdos } from '@megadulces/contracts';
import {
  conteoPorArea, cuantosMios, dtoDeAcuerdo, faltaAcuerdo, fechaMx, filtrarAcuerdos, plazoAparte, plazoEnPalabras, respuestaAcuerdos, responsableEnPalabras,
  SEVERIDAD_ACUERDO,
} from './acuerdos-proveedores';

/**
 * `[PQ.3.10]` Acuerdos · C3 — lo que la pantalla dice y filtra, sin Angular. Cada regla con su control (un caso que
 * cumple) y su negativa (uno que no).
 */
const HOY = '2026-11-27';

const acuerdo = (o: Partial<AcuerdoVista> = {}): AcuerdoVista => ({
  id: 'a1', meeting_id: 'r1', supplier_code: 'PRV01', supplier_name: 'Dulcería de Prueba', meeting_date: '2026-11-24', area: 'marketing',
  description: 'Armar la exhibición de diciembre', supplier_contact: null, assigned_to: { user_id: 'U-LUIS', nombre: 'Luis Mercadotecnia' },
  due_date: '2026-12-01', status: 'pending', situacion: 'esta_semana', acciones: ['iniciar', 'cumplir', 'cancelar', 'editar'],
  closed_by: null, closed_at: null, closing_note: null, assigned_by: 'Ana Compras', assigned_at: '2026-11-24T17:00:00Z', ...o,
});

const lista = (abiertos: AcuerdoVista[], cerrados: AcuerdoVista[] = [], por = { vencido: 0, vence_hoy: 0, esta_semana: 0, al_dia: 0 }): ListaAcuerdos => ({
  hoy: HOY,
  abiertos: { total: abiertos.length, tope: 500, por_situacion: por, acuerdos: abiertos },
  cerrados: { total: cerrados.length, tope: 100, acuerdos: cerrados },
});

describe('[PQ.3.10] cuándo vence, en palabras', () => {
  it('vencido, hoy, mañana y en N días, contra el día de México', () => {
    expect(plazoEnPalabras(acuerdo({ situacion: 'vencido', due_date: '2026-11-24' }), HOY)).toBe('Venció hace 3 días');
    expect(plazoEnPalabras(acuerdo({ situacion: 'vencido', due_date: '2026-11-26' }), HOY)).toBe('Venció ayer');
    expect(plazoEnPalabras(acuerdo({ situacion: 'vence_hoy', due_date: HOY }), HOY)).toBe('Vence hoy');
    expect(plazoEnPalabras(acuerdo({ situacion: 'esta_semana', due_date: '2026-11-28' }), HOY)).toBe('Vence mañana');
    expect(plazoEnPalabras(acuerdo({ situacion: 'al_dia', due_date: '2026-12-15' }), HOY)).toBe('Vence en 18 días');
  });

  it('cerrado: con el día de MÉXICO en que se cerró (no el de UTC: a las 20:00 de México ya es mañana en UTC)', () => {
    const noche = '2026-11-27T02:30:00Z'; // 26-nov 20:30 en la Ciudad de México
    expect(fechaMx(noche)).toBe('2026-11-26');
    expect(plazoEnPalabras(acuerdo({ situacion: 'cumplido', status: 'done', closed_at: noche }), HOY)).toBe('Cumplido el jue 26 nov');
    expect(plazoEnPalabras(acuerdo({ situacion: 'cancelado', status: 'cancelled', closed_at: '2026-11-25T17:00:00Z' }), HOY)).toBe('Cancelado el mié 25 nov');
  });

  it('aparte de la etiqueta, el plazo sólo cuando agrega algo («Vence hoy» junto a «Vence hoy» no se repite)', () => {
    expect(plazoAparte(acuerdo({ situacion: 'vence_hoy', due_date: HOY }), HOY)).toBeNull();
    expect(plazoAparte(acuerdo({ situacion: 'vencido', due_date: '2026-11-24' }), HOY)).toBe('Venció hace 3 días');
    expect(plazoAparte(acuerdo({ situacion: 'cumplido', status: 'done', closed_at: '2026-11-25T17:00:00Z' }), HOY)).toBe('Cumplido el mié 25 nov');
  });

  it('el color acompaña: vencido rojo, hoy ámbar, cumplido verde; ninguna situación sin color', () => {
    expect(SEVERIDAD_ACUERDO.vencido).toBe('danger');
    expect(SEVERIDAD_ACUERDO.vence_hoy).toBe('warn');
    expect(SEVERIDAD_ACUERDO.cumplido).toBe('success');
    expect(Object.keys(SEVERIDAD_ACUERDO).sort()).toEqual(['al_dia', 'cancelado', 'cumplido', 'esta_semana', 'vence_hoy', 'vencido']);
  });
});

describe('[PQ.3.10] quién responde', () => {
  it('del proveedor: su persona, y quién lo sigue en la Suite (DC43)', () => {
    const r = responsableEnPalabras(acuerdo({ area: 'supplier', supplier_contact: 'Ejecutivo de ventas', assigned_to: { user_id: 'U-ANA', nombre: 'Ana Compras' } }));
    expect(r).toEqual({ quien: 'Ejecutivo de ventas (proveedor)', sub: 'Lo sigue Ana Compras' });
  });
  it('de Mega Dulces: el responsable, sin «lo sigue»', () => {
    expect(responsableEnPalabras(acuerdo())).toEqual({ quien: 'Luis Mercadotecnia', sub: null });
  });
});

describe('[PQ.3.10] la respuesta de arriba (Q.1)', () => {
  it('lo que pide atención hoy y el total', () => {
    const l = lista([acuerdo(), acuerdo({ id: 'a2' }), acuerdo({ id: 'a3' })], [], { vencido: 2, vence_hoy: 1, esta_semana: 0, al_dia: 0 });
    expect(respuestaAcuerdos(l)).toBe('2 acuerdos vencieron sin cumplirse, 1 vence hoy. 3 acuerdos abiertos en total.');
  });
  it('nada urgente: lo dice; nada abierto: distingue «todo cerrado» de «nada capturado»', () => {
    expect(respuestaAcuerdos(lista([acuerdo()], [], { vencido: 0, vence_hoy: 0, esta_semana: 0, al_dia: 1 })))
      .toBe('Ningún acuerdo vence esta semana. 1 acuerdo abierto en total.');
    expect(respuestaAcuerdos(lista([], [acuerdo({ status: 'done', situacion: 'cumplido' })]))).toBe('No hay acuerdos abiertos: todos están cumplidos o cancelados.');
    expect(respuestaAcuerdos(lista([]))).toBe('Todavía no hay acuerdos capturados.');
  });
});

describe('[PQ.3.10] los filtros sobre la lista que llegó entera', () => {
  const xs = [
    acuerdo({ id: 'a1' }),
    acuerdo({ id: 'a2', area: 'supplier', supplier_contact: 'Ejecutivo', description: 'Mandar la lista de PRECIOS', assigned_to: { user_id: 'u-ana', nombre: 'Ana Compras' }, situacion: 'vencido' }),
    acuerdo({ id: 'a3', area: 'finanzas', supplier_name: 'Botanas Piña', description: 'Revisar el plazo de pago', assigned_to: { user_id: 'U-LETY', nombre: 'Lety Tesorería' } }),
  ];
  const cerrado = acuerdo({ id: 'c1', status: 'done', situacion: 'cumplido', assigned_to: { user_id: 'U-ANA', nombre: 'Ana Compras' } });
  const l = lista(xs, [cerrado]);
  const f = (o: Partial<Parameters<typeof filtrarAcuerdos>[1]> = {}) =>
    filtrarAcuerdos(l, { vista: 'abiertos', de: 'todos', area: null, situacion: null, q: '', yo: 'U-ANA', ...o }).map((a) => a.id);

  it('sin filtros, todos los abiertos en el orden de la API (la pantalla no reordena)', () => {
    expect(f()).toEqual(['a1', 'a2', 'a3']);
  });
  it('«Míos» compara el id sin importar mayúsculas; sin sesión, ninguno', () => {
    expect(f({ de: 'mios' })).toEqual(['a2']);
    expect(f({ de: 'mios', yo: null })).toEqual([]);
    expect(cuantosMios(l, 'abiertos', 'U-ANA')).toBe(1);
    expect(cuantosMios(l, 'cerrados', 'U-ANA')).toBe(1);
  });
  it('por área y por situación', () => {
    expect(f({ area: 'finanzas' })).toEqual(['a3']);
    expect(f({ situacion: 'vencido' })).toEqual(['a2']);
    expect(conteoPorArea(xs)).toEqual({ compras: 0, marketing: 1, finanzas: 1, direccion: 0, supplier: 1 });
  });
  it('el buscador común: sin acentos, varias palabras en cualquier orden y en cualquier campo', () => {
    expect(f({ q: 'pina botanas' })).toEqual(['a3']);       // «Piña» sin tilde
    expect(f({ q: 'precios ana' })).toEqual(['a2']);        // un token de lo acordado y otro del responsable
    expect(f({ q: 'proveedor ejecutivo' })).toEqual(['a2']); // el área y la persona del proveedor
    expect(f({ q: 'nadie-tiene-esto' })).toEqual([]);
  });
  it('cerrados: la otra lista', () => {
    expect(f({ vista: 'cerrados' })).toEqual(['c1']);
  });
});

describe('[PQ.3.10] el formulario', () => {
  it('lo que falta, en el orden de la pantalla; completo = null', () => {
    expect(faltaAcuerdo({})).toBe('Elige de qué área es el acuerdo.');
    expect(faltaAcuerdo({ area: 'compras', description: '  ' })).toBe('Escribe qué se acordó.');
    expect(faltaAcuerdo({ area: 'compras', description: 'x' })).toBe('Elige quién de Mega Dulces es responsable.');
    expect(faltaAcuerdo({ area: 'supplier', description: 'x' })).toBe('Escribe quién del proveedor se comprometió.');
    expect(faltaAcuerdo({ area: 'supplier', description: 'x', supplier_contact: 'Ejecutivo' })).toBe('Elige la fecha compromiso.');
    expect(faltaAcuerdo({ area: 'compras', description: 'x', assigned_to: 'U-1', due_date: '2026-12-01' })).toBeNull();
    expect(faltaAcuerdo({ area: 'compras', description: 'x'.repeat(501), assigned_to: 'U-1', due_date: '2026-12-01' })).toBe('Lo acordado, máximo 500 caracteres.');
  });
  it('editar: el del proveedor no manda responsable (lo pone el servidor); el interno no manda persona del proveedor', () => {
    expect(dtoDeAcuerdo(acuerdo({ area: 'supplier', supplier_contact: 'Ejecutivo' }))).toEqual({
      area: 'supplier', description: 'Armar la exhibición de diciembre', due_date: '2026-12-01', assigned_to: null, supplier_contact: 'Ejecutivo',
    });
    expect(dtoDeAcuerdo(acuerdo())).toEqual({
      area: 'marketing', description: 'Armar la exhibición de diciembre', due_date: '2026-12-01', assigned_to: 'U-LUIS', supplier_contact: null,
    });
  });
});
