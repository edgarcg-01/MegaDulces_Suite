import {
  algunaSinPrecio,
  armarConteos,
  armarSucursales,
  armarUnidades,
  descripcionDistinta,
  mostrarValido,
  ordenarCodigos,
  precioDeRed,
  diasEntre,
  periodoFicha,
  sucursalDelCatalogo,
  sucursalValida,
  type EscaleraCruda,
  type PrecioCrudo,
} from './catalogo-ficha';
import { N_CODIGOS_LATERAL_SQL, SIN_PRECIO_LATERAL_SQL } from './catalogo-ficha.sql';

const esc = (u1: string | null, u2: string | null, f2: number | string | null, u3: string | null, f3: number | string | null): EscaleraCruda => ({
  u1_label: u1, u2_label: u2, f2_cap: f2, u3_label: u3, f3_cap: f3,
});

const precio = (over: Partial<PrecioCrudo> = {}): PrecioCrudo => ({
  unit_base: null, piece_price: null,
  wholesale_piece_price: null, wholesale_piece_min_qty: null,
  pack_size: null, pack_price: null, wholesale_pack_price: null, wholesale_pack_min_qty: null,
  box_size: null, box_price: null,
  ...over,
});

describe('armarUnidades', () => {
  it('PAQ/PAQ(1)/CJA(20): quita el peldaño repetido; CJA = 20 PAQ con su precio de caja', () => {
    // 70001 LA ROSA MAZAPAN /30, tal como viene la escalera en la base.
    const u = armarUnidades(
      esc('PAQ', 'PAQ', '1.00', 'CJA', '20.00'),
      precio({ unit_base: 'PAQ', piece_price: '86.00', box_size: 20, box_price: '1586.23' }),
    );
    expect(u).toEqual([
      { unidad: 'PAQ', equivale: null, factorBase: 1, precio: 86, mayoreo: null },
      { unidad: 'CJA', equivale: { cantidad: 20, unidad: 'PAQ' }, factorBase: 20, precio: 1586.23, mayoreo: null },
    ]);
  });

  it('PZA/PAQ(10)/CJA(180): CJA se expresa en PAQ (18) y trae factorBase 180', () => {
    const u = armarUnidades(
      esc('PZA', 'PAQ', 10, 'CJA', 180),
      precio({ unit_base: 'PZA', piece_price: 5, pack_size: 10, pack_price: 48, box_size: 180, box_price: 800 }),
    );
    expect(u.map((x) => [x.unidad, x.equivale, x.factorBase, x.precio])).toEqual([
      ['PZA', null, 1, 5],
      ['PAQ', { cantidad: 10, unidad: 'PZA' }, 10, 48],
      ['CJA', { cantidad: 18, unidad: 'PAQ' }, 180, 800],
    ]);
  });

  it('KG/BTO(20) sin precio de bulto: BTO viaja con precio null, nunca 0', () => {
    const u = armarUnidades(esc('KG', 'BTO', 20, null, 0), precio({ unit_base: 'KG', piece_price: 120 }));
    expect(u).toHaveLength(2);
    expect(u[1]).toEqual({ unidad: 'BTO', equivale: { cantidad: 20, unidad: 'KG' }, factorBase: 20, precio: null, mayoreo: null });
  });

  it('sólo KG: una unidad', () => {
    const u = armarUnidades(esc('KG', null, null, null, null), precio({ unit_base: 'KG', piece_price: 99.5 }));
    expect(u).toEqual([{ unidad: 'KG', equivale: null, factorBase: 1, precio: 99.5, mayoreo: null }]);
  });

  it('un precio 0 en la tabla es «sin precio»', () => {
    const u = armarUnidades(esc('PZA', null, null, null, null), precio({ piece_price: '0' }));
    expect(u[0].precio).toBeNull();
  });

  it('sin escalera: la base de la etiqueta; sin nada: []', () => {
    expect(armarUnidades(null, precio({ unit_base: 'pza', piece_price: 3 }))).toEqual([
      { unidad: 'PZA', equivale: null, factorBase: 1, precio: 3, mayoreo: null },
    ]);
    expect(armarUnidades(null, null)).toEqual([]);
  });

  it('factor de caja que no divide al paquete: se expresa contra la base', () => {
    const u = armarUnidades(esc('PZA', 'PAQ', 12, 'CJA', 100), null);
    expect(u[2].equivale).toEqual({ cantidad: 100, unidad: 'PZA' });
  });
});

describe('mayoreo en el peldaño correcto', () => {
  it('base PZA: el mayoreo de pieza va a la base y el de paquete al PAQ (factor = pack_size)', () => {
    const u = armarUnidades(
      esc('PZA', 'PAQ', 10, 'CJA', 180),
      precio({
        unit_base: 'PZA', piece_price: 5, wholesale_piece_price: 4.5, wholesale_piece_min_qty: 6,
        pack_size: 10, pack_price: 48, wholesale_pack_price: 45, wholesale_pack_min_qty: 3,
      }),
    );
    expect(u[0].mayoreo).toEqual({ precio: 4.5, desde: 6 });
    expect(u[1].mayoreo).toEqual({ precio: 45, desde: 3 });
    expect(u[2].mayoreo).toBeNull();
  });

  it('base agrupada (PAQ): el mayoreo de paquete es el de la BASE', () => {
    const u = armarUnidades(
      esc('PAQ', 'PAQ', 1, 'CJA', 20),
      precio({ unit_base: 'PAQ', piece_price: 86, wholesale_pack_price: 82, wholesale_pack_min_qty: 3, box_size: 20, box_price: 1586 }),
    );
    expect(u[0].mayoreo).toEqual({ precio: 82, desde: 3 });
    expect(u[1].mayoreo).toBeNull();
  });

  it('NEGATIVA: base PZA sin peldaño de paquete → el mayoreo de paquete NO se le pega a la pieza', () => {
    const u = armarUnidades(
      esc('PZA', 'CJA', 24, null, null),
      precio({ unit_base: 'PZA', piece_price: 5, wholesale_pack_price: 45, wholesale_pack_min_qty: 3 }),
    );
    expect(u.every((x) => x.mayoreo === null)).toBe(true);
  });

  it('mayoreo «desde 1» no es mayoreo', () => {
    const u = armarUnidades(esc('PZA', null, null, null, null), precio({ piece_price: 5, wholesale_piece_price: 4, wholesale_piece_min_qty: 1 }));
    expect(u[0].mayoreo).toBeNull();
  });
});

describe('descripcionDistinta', () => {
  it('igual al nombre (aun con espacios/mayúsculas distintas) → null', () => {
    expect(descripcionDistinta('LA ROSA MAZAPAN /30', 'LA ROSA MAZAPAN /30')).toBeNull();
    expect(descripcionDistinta('LA ROSA MAZAPAN /30', ' la rosa  mazapan /30 ')).toBeNull();
    expect(descripcionDistinta('X', null)).toBeNull();
  });
  it('distinta → viaja', () => {
    expect(descripcionDistinta('LA ROSA MAZAPAN /30', 'Mazapán de cacahuate, caja 30')).toBe('Mazapán de cacahuate, caja 30');
  });
});

describe('ordenarCodigos / precioDeRed / sucursales', () => {
  it('principal primero, sin repetidos ni vacíos', () => {
    expect(ordenarCodigos('724869100106', ['111', '724869100106 ', '', null, '111'])).toEqual(['724869100106', '111']);
    expect(ordenarCodigos(null, [])).toEqual([]);
  });

  it('red: ignora null y 0; sin precios → 0 sucursales y min/max null', () => {
    expect(precioDeRed(['86', '86.93', null, '0'])).toEqual({ sucursales: 2, min: 86, max: 86.93 });
    expect(precioDeRed([])).toEqual({ sucursales: 0, min: null, max: null });
  });

  it('venta no medible → null; medible sin filas → 0 (no vendió); existencia sin fila → null, con fila en 0 → 0', () => {
    const s = armarSucursales(
      [
        { codigo: '01', nombre: 'Padre Hidalgo', venta_medible: true },
        { codigo: '03', nombre: '8ESQ', venta_medible: false },
        { codigo: '08', nombre: 'Morelia Abastos', venta_medible: false, corte: '2026-09-18' },
        { codigo: '02', nombre: 'Abastos', venta_medible: true },
      ],
      new Map([['01', { monto: '1234.567', unidades: '12' }]]),
      new Map([['01', '40'], ['02', '0']]),
    );
    expect(s[0]).toEqual({ codigo: '01', nombre: 'Padre Hidalgo', vendidoMes: { monto: 1234.57, unidadesBase: 12 }, existenciaBase: 40, corteKepler: null, sinCorte: false });
    // [PF.23] el corte viaja para que la pantalla diga «en Kepler desde…» en vez de un «sin dato» mudo.
    expect(s[2].corteKepler).toBe('2026-09-18');
    expect(s[1].vendidoMes).toBeNull();
    expect(s[1].existenciaBase).toBeNull();
    expect(s[2].vendidoMes).toBeNull();
    expect(s[3].vendidoMes).toEqual({ monto: 0, unidadesBase: 0 });
    expect(s[3].existenciaBase).toBe(0);
  });

  it('sucursal: dos dígitos o 01', () => {
    expect(sucursalValida('05')).toBe('05');
    expect(sucursalValida(undefined)).toBe('01');
    expect(sucursalValida("01' OR 1=1")).toBe('01');
  });

  it('⭐ [PF.21] la sucursal del precio se recorta al ALCANCE (la regla de Precios)', () => {
    const todas = [{ codigo: '01' }, { codigo: '02' }, { codigo: '05' }];
    const sinLa01 = [{ codigo: '03' }, { codigo: '05' }];
    expect(sucursalDelCatalogo(todas, '05')).toBe('05');
    expect(sucursalDelCatalogo(todas, ' 02 ')).toBe('02');
    // sin pedir: la 01 si está en su alcance (el default de siempre); si no, la primera de las suyas
    expect(sucursalDelCatalogo(todas, undefined)).toBe('01');
    expect(sucursalDelCatalogo(sinLa01, '')).toBe('03');
    // ninguna en su alcance: la 01, como antes (el costo lo cuida puedeVerCostoCatalogo)
    expect(sucursalDelCatalogo([], null)).toBe('01');
  });

  it('⛔ [PF.21] [negativa] pedir una sucursal FUERA del alcance (o mal escrita) da null → 403; antes se servía', () => {
    const sinLa01 = [{ codigo: '03' }, { codigo: '05' }];
    expect(sucursalDelCatalogo(sinLa01, '01')).toBeNull();
    expect(sucursalDelCatalogo(sinLa01, "03' OR 1=1")).toBeNull();
    expect(sucursalDelCatalogo([], '02')).toBeNull();
  });
});

describe('[PF.23] periodoFicha — el periodo de la venta de la ficha', () => {
  const HOY = '2026-11-04';
  it('⭐ sin fechas: el mes en curso hasta hoy (lo de siempre)', () => {
    expect(periodoFicha(undefined, undefined, HOY)).toEqual({ desde: '2026-11-01', hasta: HOY });
    expect(periodoFicha('', '  ', HOY)).toEqual({ desde: '2026-11-01', hasta: HOY });
  });
  it('⭐ con fechas válidas las respeta; «hasta» en el futuro se recorta a hoy (el futuro no tiene venta)', () => {
    expect(periodoFicha('2025-01-01', '2025-12-31', HOY)).toEqual({ desde: '2025-01-01', hasta: '2025-12-31' });
    expect(periodoFicha('2026-10-01', '2026-12-31', HOY)).toEqual({ desde: '2026-10-01', hasta: HOY });
    expect(periodoFicha(HOY, HOY, HOY)).toEqual({ desde: HOY, hasta: HOY });
  });
  it('⛔ [negativa] lo que no es un periodo da null (el controlador responde 400, no se adivina)', () => {
    expect(periodoFicha('2026-10-01', undefined, HOY)).toBeNull(); // falta una
    expect(periodoFicha('2026-02-31', '2026-03-01', HOY)).toBeNull(); // fecha que no existe
    expect(periodoFicha('01/10/2026', '2026-10-31', HOY)).toBeNull(); // otro formato
    expect(periodoFicha('2026-10-31', '2026-10-01', HOY)).toBeNull(); // al revés
    expect(periodoFicha('2026-12-01', '2026-12-31', HOY)).toBeNull(); // todo en el futuro
    expect(periodoFicha('2024-01-01', '2026-11-04', HOY)).toBeNull(); // más de dos años
    expect(periodoFicha("2026-10-01' OR 1=1", '2026-10-31', HOY)).toBeNull();
  });
  it('diasEntre cuenta los dos extremos', () => {
    expect(diasEntre('2026-11-01', '2026-11-01')).toBe(1);
    expect(diasEntre('2025-01-01', '2025-12-31')).toBe(365);
  });
});

describe('«Mostrar» de la lista', () => {
  it('opción válida pasa; desconocida, vacía o inyectada → todos', () => {
    expect(mostrarValido('varios_codigos', true)).toBe('varios_codigos');
    expect(mostrarValido('sin_codigo', false)).toBe('sin_codigo');
    expect(mostrarValido(undefined, true)).toBe('todos');
    expect(mostrarValido('', true)).toBe('todos');
    expect(mostrarValido("sin_codigo' OR 1=1", true)).toBe('todos');
  });

  it('sin_precio sin precio por sucursal NO se aplica (no medible) → todos; con precio sí', () => {
    expect(mostrarValido('sin_precio', false)).toBe('todos');
    expect(mostrarValido('sin_precio', true)).toBe('sin_precio');
  });

  it('conteos: strings de postgres → números; sinPrecio null cuando no se pudo medir (nunca 0)', () => {
    const r = { todos: '11008', varios: '1148', sin_codigo: '1389', sin_precio: '12' };
    expect(armarConteos(r, true)).toEqual({ todos: 11008, variosCodigos: 1148, sinCodigo: 1389, sinPrecio: 12 });
    expect(armarConteos({ ...r, sin_precio: null }, false).sinPrecio).toBeNull();
    // Medible y sin ninguno: 0 de verdad.
    expect(armarConteos({ ...r, sin_precio: '0' }, true).sinPrecio).toBe(0);
    expect(armarConteos(undefined, true)).toEqual({ todos: 0, variosCodigos: 0, sinCodigo: 0, sinPrecio: 0 });
  });

  it('algunaSinPrecio: basta una unidad con precio null; sin unidades no cuenta', () => {
    const u = armarUnidades(esc('KG', 'BTO', 20, null, 0), precio({ unit_base: 'KG', piece_price: 120 }));
    expect(algunaSinPrecio(u)).toBe(true);
    const ok = armarUnidades(esc('PAQ', 'PAQ', 1, 'CJA', 20), precio({ piece_price: 86, box_size: 20, box_price: 1586 }));
    expect(algunaSinPrecio(ok)).toBe(false);
    expect(algunaSinPrecio([])).toBe(false);
  });

  it('los LATERAL no duplican filas (agregan a un renglón) y piden exactamente sus parámetros', () => {
    expect(N_CODIGOS_LATERAL_SQL).toMatch(/count\(DISTINCT z\.c\)/);
    expect(N_CODIGOS_LATERAL_SQL.split('?').length - 1).toBe(0);
    expect(SIN_PRECIO_LATERAL_SQL).toMatch(/bool_or\(/);
    // sucursal de la escalera + sucursal del precio; ningún «?» suelto (knex lo toma como binding).
    expect(SIN_PRECIO_LATERAL_SQL.split('?').length - 1).toBe(2);
    expect(N_CODIGOS_LATERAL_SQL).toMatch(/b\.activo IS TRUE/);
  });

  /**
   * `[PF.12.1]` `con_unidades` se agregó al lateral para ORDENAR la lista. Es aditiva: la expresión de
   * `sin_precio` (que alimenta el filtro «Alguna unidad sin precio» y su conteo) queda letra por letra igual,
   * los parámetros siguen siendo dos y el lateral sigue agregando a UN renglón, así que ni el total ni los
   * conteos pueden moverse por ella.
   */
  it('con_unidades es aditiva: sin_precio intacto, mismos parámetros, un renglón por producto', () => {
    const SIN_PRECIO_ORIGINAL = `SELECT coalesce(bool_or(CASE WHEN r.base IS NULL THEN false ELSE
        NOT coalesce(r.piece > 0, false)
        OR (r.f2ok AND NOT coalesce(CASE WHEN r.pack_size = r.f2 THEN r.pack_price WHEN r.box_size = r.f2 THEN r.box_price END > 0, false))
        OR (r.f3ok AND NOT coalesce(CASE WHEN r.pack_size = r.f3 THEN r.pack_price WHEN r.box_size = r.f3 THEN r.box_price END > 0, false))
      END), false) AS sin_precio`;
    expect(SIN_PRECIO_LATERAL_SQL).toContain(SIN_PRECIO_ORIGINAL);
    // con_unidades = «armarUnidades devuelve algo»: hay base (u1 de la escalera o unit_base de la etiqueta).
    expect(SIN_PRECIO_LATERAL_SQL).toContain('coalesce(bool_or(r.base IS NOT NULL), false) AS con_unidades');
    expect(SIN_PRECIO_LATERAL_SQL.split('?').length - 1).toBe(2);
    // ⛔ [negativa] nada de GROUP BY ni de columnas sin agregar: eso sí podría devolver varias filas por producto.
    expect(SIN_PRECIO_LATERAL_SQL).not.toMatch(/GROUP BY/i);
  });
});
