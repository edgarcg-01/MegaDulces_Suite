import { describe, expect, it } from 'vitest';
import type { AutoabastoVieneDoc } from '@megadulces/contracts';
import { COLAS_SUCURSAL, COLAS_VIENE, claveViene, colasDeViene } from './sucursal-pendientes.registry';
import * as Q from './sucursal-pendientes.sql';

const doc = (p: Partial<AutoabastoVieneDoc>): AutoabastoVieneDoc => ({
  tipo: 'embarque', origen: '00', serie: 2, folio: '100', estado: 'EMBARCADO', fecha: '2026-11-01',
  dias: 2, renglones: 3, monto: 1000, se_resta: true, ...p,
});

describe('[AB.45] registro de Pendientes de la sucursal', () => {
  it('cada cola tiene id único (también contra las de «lo que te va a llegar»), ruta absoluta, llave y fuente citada', () => {
    const ids = [...COLAS_SUCURSAL.map((c) => c.id), ...COLAS_VIENE];
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

  it('⛔ velocidad: negativos filtra por kepler_code (baja al GROUP BY de la vista), no por warehouse_id', () => {
    // Por warehouse_id agregaba todo kdil de la red: 130–400 ms contra 21–37 ms (2026-11-03).
    expect(Q.SQL_NEGATIVOS).toContain('v.kepler_code = :kc');
    expect(Q.SQL_NEGATIVOS).not.toContain('v.warehouse_id = :wh');
    expect(Q.SQL_ENTRADAS_SIN_COMPROBANTE).toContain('r.sucursal = :suc');
  });

  it('compras sin vale usa la cascada del Andén (sin ella, Canindo y Morelia Madero salían en 0)', () => {
    expect(Q.SQL_LLEGADAS_SIN_VALE).toContain('COALESCE(m.warehouse_id, r.warehouse_id) = :wh');
    expect(Q.SQL_LLEGADAS_SIN_VALE).toContain('LEFT JOIN commercial.erp_sucursal_warehouse');
  });

  it('⛔ la pantalla la ve toda la sucursal: el arqueo (ciego) no enseña lo contado', () => {
    expect(Q.SQL_ARQUEOS_POR_VALIDAR).not.toContain('total_contado');
    expect(Q.SQL_TURNOS_SIN_ARQUEO).not.toMatch(/c15|c49|total_contado/);
  });

  it('la clave de «lo que te va a llegar» distingue el mismo folio de dos orígenes', () => {
    expect(claveViene(doc({ origen: '00', folio: '7' }))).not.toBe(claveViene(doc({ origen: '01', folio: '7' })));
    expect(claveViene(doc({ tipo: 'requisicion', id: 'r1' }))).toBe('r1');
  });

  it('las colas que leen la vista cara de órdenes de entrada van marcadas como pesadas', () => {
    for (const c of COLAS_SUCURSAL.filter((x) => x.sql.includes('analytics.erp_goods_receipts'))) expect(c.pesada, c.id).toBe(true);
  });

  it('toda consulta devuelve la forma común y filtra por tenant', () => {
    for (const c of COLAS_SUCURSAL) {
      for (const col of ['AS clave', 'AS folio', 'AS detalle', 'AS fecha', 'AS monto', 'AS total']) expect(c.sql, `${c.id} ${col}`).toContain(col);
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
