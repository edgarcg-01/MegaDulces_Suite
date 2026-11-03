import { describe, expect, it } from 'vitest';
import { LLAVES_PENDIENTES_SUCURSAL, type AutoabastoVieneDoc } from '@megadulces/contracts';
import { COLAS_SUCURSAL, LLAVE_VIENE, colasDeViene } from './sucursal-pendientes.registry';
import * as Q from './sucursal-pendientes.sql';

const doc = (p: Partial<AutoabastoVieneDoc>): AutoabastoVieneDoc => ({
  tipo: 'embarque', origen: '00', serie: 2, folio: '100', estado: 'EMBARCADO', fecha: '2026-11-01',
  dias: 2, renglones: 3, monto: 1000, se_resta: true, ...p,
});

describe('[AB.45] registro de Pendientes de la sucursal', () => {
  it('la puerta (LLAVES_PENDIENTES_SUCURSAL) es EXACTAMENTE la unión de las llaves de las colas', () => {
    const union = new Set<string>([LLAVE_VIENE, ...COLAS_SUCURSAL.flatMap((c) => c.anyOf)]);
    expect([...new Set(LLAVES_PENDIENTES_SUCURSAL)].sort()).toEqual([...union].sort());
  });

  it('cada cola tiene id único, ruta absoluta, llave y fuente citada', () => {
    const ids = COLAS_SUCURSAL.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of COLAS_SUCURSAL) {
      expect(c.ruta.startsWith('/'), c.id).toBe(true);
      expect(c.anyOf.length, c.id).toBeGreaterThan(0);
      expect(c.fuente.length, c.id).toBeGreaterThan(10);
    }
  });

  it('allOf incluye la llave de anyOf (si no, la cola se pinta a quien la ruta rechaza)', () => {
    for (const c of COLAS_SUCURSAL.filter((x) => x.allOf)) {
      expect(c.anyOf.every((k) => c.allOf!.includes(k)), c.id).toBe(true);
    }
  });

  it('⛔ ninguna consulta lleva un signo de interrogación: knex lo toma como parámetro y la consulta truena', () => {
    for (const [k, sql] of Object.entries(Q)) {
      if (typeof sql === 'string') expect(sql.includes('?'), k).toBe(false);
    }
  });

  it('toda consulta devuelve la forma común y filtra por tenant', () => {
    for (const c of COLAS_SUCURSAL) {
      for (const col of ['AS folio', 'AS detalle', 'AS fecha', 'AS monto', 'AS total']) expect(c.sql, `${c.id} ${col}`).toContain(col);
      expect(c.sql, c.id).toContain(':t');
    }
  });
});

describe('[AB.45] «lo que te va a llegar», repartido en colas', () => {
  const colas = colasDeViene([
    doc({ tipo: 'embarque', folio: 'E1', dias: 3 }),
    doc({ tipo: 'embarque', folio: 'E2', dias: 9 }),
    doc({ tipo: 'pedido', folio: 'P1', estado: 'AUTORIZADO' }),
    doc({ tipo: 'requisicion', folio: 'R1', estado: 'RECHAZADA', motivo: 'Ya hay en CEDIS', id: 'r1' }),
    doc({ tipo: 'requisicion', folio: 'R2', estado: 'POR APROBAR', id: 'r2' }),
    doc({ tipo: 'plan', folio: 'PL1', estado: 'PLANEADO', id: 'p1' }),
  ], 10);
  const de = (id: string) => colas.find((c) => c.id === id)!;

  it('el embarque sin recibir es de la sucursal, lo más viejo primero', () => {
    expect(de('traspasos-sin-recibir').de).toBe('sucursal');
    expect(de('traspasos-sin-recibir').filas.map((f) => f.folio)).toEqual(['E2', 'E1']);
    expect(de('traspasos-sin-recibir').mas_viejo_dias).toBe(9);
  });

  it('la requisición rechazada es de la sucursal, con su motivo; la que espera a Compras no', () => {
    expect(de('requisiciones-rechazadas').de).toBe('sucursal');
    expect(de('requisiciones-rechazadas').filas[0].detalle).toBe('Motivo: Ya hay en CEDIS');
    expect(de('requisiciones-con-compras').de).toBe('otra_area');
    expect(de('requisiciones-con-compras').total).toBe(2);
  });

  it('el pedido sin embarcar es de otra área y el origen se NOMBRA', () => {
    expect(de('pedidos-sin-embarcar').de).toBe('otra_area');
    expect(de('pedidos-sin-embarcar').filas[0].detalle).not.toMatch(/^00\b/);
  });

  it('el tope recorta las filas, no el total', () => {
    const muchas = colasDeViene(Array.from({ length: 15 }, (_, i) => doc({ folio: `E${i}`, dias: i })), 10);
    const t = muchas.find((c) => c.id === 'traspasos-sin-recibir')!;
    expect(t.total).toBe(15);
    expect(t.filas).toHaveLength(10);
  });
});
