import {
  aplicarMovimientos, cuadrarFotos, efectoDeTipo, importeDeVector, sqlSignoPorTipo,
  type CaosFoto, type CaosMovDenom,
} from './caos-saldo';

/**
 * `[CGA-A.33]` El candado de los signos y del cuadre foto-contra-foto.
 *
 * Los vectores son los REALES: la dotación del 15-oct tras el último vaciado (#1610, $13,860) y
 * el inventario de casetes que el equipo reportó el 2026-10-20 10:04 ($360,020). Los flujos de en
 * medio se resumen en un depósito y una dispensación con el mismo neto por denominación que los
 * 25 depósitos y 18 dispensaciones reales.
 */
const DOTACION_1610 = { 500: 12, 200: 2, 100: 5, 50: 20, 20: 298 };
const FOTO_20OCT = { 500: 507, 200: 383, 100: 252, 50: 46, 20: 121 };
const DEPOSITOS = { 500: 495, 200: 381, 100: 247, 50: 26 };
const DISPENSADO = { 20: 177 };

const foto = (id: string, after: number, v: Record<number, number>): CaosFoto => ({
  id, after_external_id: after, captured_at: `2026-10-20T10:0${id}:00-06:00`, por_denominacion: v,
});
const mov = (id: number, type: number, v: Record<number, number>, total?: number): CaosMovDenom => ({
  external_id: id, type_id: type, por_denominacion: v, total: total ?? importeDeVector(v),
});

describe('los signos por tipo (medidos contra el equipo, no supuestos)', () => {
  it.each([
    [0, 1], [4, -1], [8, 1], [5, -1],
  ])('type_id %i mueve con signo %i', (t, s) => expect(efectoDeTipo(t).signo).toBe(s));

  it('Fin de Dia es una FOTO: no mueve efectivo', () => {
    expect(efectoDeTipo(2)).toMatchObject({ efecto: 'foto', signo: 0 });
  });

  it('Cambio, Contenido Modificado y lo desconocido se DECLARAN indeterminados', () => {
    for (const t of [7, 13, 99]) expect(efectoDeTipo(t)).toMatchObject({ efecto: 'indeterminado', signo: 0 });
  });

  it('el SQL se genera del mapa (una sola fuente)', () => {
    const sql = sqlSignoPorTipo();
    expect(sql).toContain('WHEN 5 THEN -1');
    expect(sql).toContain('WHEN 8 THEN 1');
    expect(sql).toContain('WHEN 2 THEN 0');
    expect(sql).toMatch(/ELSE 0 END\)$/);
  });
});

describe('cuadrarFotos — foto nueva = foto anterior + movimientos, por denominación', () => {
  const movs = [mov(1620, 0, DEPOSITOS), mov(1630, 4, DISPENSADO)];

  it('el caso real cierra: $13,860 + $349,700 − $3,540 = $360,020', () => {
    expect(importeDeVector(FOTO_20OCT)).toBe(360020);
    const [p] = cuadrarFotos([foto('1', 1610, DOTACION_1610), foto('2', 1653, FOTO_20OCT)], movs);
    expect(p).toMatchObject({ estado: 'cuadra', diferencia: 0, movimientos: 2, por_denominacion: [] });
  });

  it('⛔ un billete de $500 que falta en la foto es un DESCUADRE con monto y denominación', () => {
    const falta = { ...FOTO_20OCT, 500: 506 };
    const [p] = cuadrarFotos([foto('1', 1610, DOTACION_1610), foto('2', 1653, falta)], movs);
    expect(p).toMatchObject({ estado: 'descuadre', diferencia: -500, por_denominacion: [{ denom: 500, diferencia: -1 }] });
  });

  it('⛔ con signos invertidos el caso real NO cierra (el candado muerde)', () => {
    const alReves = [mov(1620, 4, DEPOSITOS), mov(1630, 0, DISPENSADO)];
    const [p] = cuadrarFotos([foto('1', 1610, DOTACION_1610), foto('2', 1653, FOTO_20OCT)], alReves);
    expect(p.estado).toBe('descuadre');
  });

  it('el contenido cambia SIN movimientos: descuadre (la máquina se movió sola)', () => {
    const [p] = cuadrarFotos([foto('1', 1653, FOTO_20OCT), foto('2', 1653, { ...FOTO_20OCT, 20: 120 })], []);
    expect(p).toMatchObject({ estado: 'descuadre', diferencia: -20, movimientos: 0 });
  });

  it('un Contenido Modificado en el tramo vuelve el descuadre NO VERIFICABLE, no un faltante', () => {
    const [p] = cuadrarFotos(
      [foto('1', 1610, DOTACION_1610), foto('2', 1653, { ...FOTO_20OCT, 200: 382 })],
      [...movs, mov(1640, 13, {}, -200)],
    );
    expect(p.estado).toBe('no_verificable');
    expect(p.motivo).toContain('Contenido Modificado');
  });

  it('Fin de Dia + Vaciar del mismo vector dejan la máquina en cero (15-oct, #1606/#1607)', () => {
    const fdd = { 500: 292, 200: 412, 100: 258, 50: 339, 20: 398 };
    const [p] = cuadrarFotos([foto('1', 1605, fdd), foto('2', 1607, {})], [mov(1606, 2, fdd), mov(1607, 5, fdd)]);
    expect(p).toMatchObject({ estado: 'cuadra', diferencia: 0 });
  });

  it('un desglose que no suma su total (#1478: declara $20, suma $86,220) se declara ambiguo', () => {
    const { ambiguos } = aplicarMovimientos({}, [mov(1478, 5, { 500: 100, 200: 100, 100: 100, 50: 100, 20: 61 }, 20)]);
    expect(ambiguos[0]).toContain('#1478');
  });
});
