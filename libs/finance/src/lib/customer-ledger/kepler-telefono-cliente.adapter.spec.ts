import 'reflect-metadata';
import type { Pool } from 'pg';
import { PATH_METADATA } from '@nestjs/common/constants';
import {
  KeplerTelefonoClienteAdapter, SERVIDORES_TELEFONO, escribirTelefonoEnBase, normalizarTelefono, type ClienteSql,
} from './kepler-telefono-cliente.adapter';
import { FinanceCustomerLedgerModule } from './finance-customer-ledger.module';
import { CarteraTelefonosController } from './cartera-telefonos.controller';
import { CarteraTelefonosService } from './cartera-telefonos.service';

/**
 * `[CXC.48]` El teléfono del cliente en Kepler. Lo que se fija sin tocar Kepler: qué SQL corre en cada base y en qué
 * orden; que una base donde la clave no está no se toca; que el mismo número con otro formato no se reescribe; que la
 * bitácora lleva la columna 7 con el nuevo y el anterior (como la forma de Kepler); y que si UNA de las 10 bases no
 * contesta, no se escribe en ninguna. El ensayo contra las bases vivas (ROLLBACK) es de Edgar (FASE CXC.48 / ALC §13).
 */

/** Un cliente de Postgres de mentira: guarda el SQL y contesta la fila de `kdud` que le digan. */
function base(c7: string | null | undefined, opts: { caida?: boolean } = {}) {
  const sql: { q: string; v?: unknown[] }[] = [];
  const cliente: ClienteSql & { release(): void } = {
    async query(q: string, v?: unknown[]) {
      sql.push({ q: q.replace(/\s+/g, ' ').trim(), v });
      if (q.includes('FROM md.kdud WHERE btrim(c2)')) return { rows: c7 === undefined ? [] : [{ c7 }] };
      return { rows: [], rowCount: 1 };
    },
    release() { /* nada */ },
  };
  return { sql, cliente, caida: !!opts.caida };
}

describe('[CXC.48] teléfono del cliente en Kepler', () => {
  it('normaliza a 10 dígitos: espacios, guiones, +52 y 521; rechaza lo demás', () => {
    expect(normalizarTelefono('469 110 81 28')).toEqual({ ok: true, valor: '4691108128' });
    expect(normalizarTelefono('+52 (33) 1485-5906')).toEqual({ ok: true, valor: '3314855906' });
    expect(normalizarTelefono('5213314855906')).toEqual({ ok: true, valor: '3314855906' });
    expect(normalizarTelefono('35240082').ok).toBe(false);
    expect(normalizarTelefono('').ok).toBe(false);
  });

  it('escribe c7 y deja en kdlogmov la columna 7 con el nuevo y el anterior, como la forma de Kepler', async () => {
    const b = base('3511420007');
    const r = await escribirTelefonoEnBase(b.cliente, '06', 'C3099', '3314855906');
    expect(r).toEqual({ servidor: '06', estado: 'escrita', anterior: '3511420007', motivo: null });
    expect(b.sql[0].q).toContain('FOR UPDATE');
    expect(b.sql[1]).toEqual({ q: 'UPDATE md.kdud SET c7 = $2 WHERE btrim(c2) = $1', v: ['C3099', '3314855906'] });
    expect(b.sql[2].q).toContain("'7', $2, $3, 'kdud', $4");
    expect(b.sql[2].v).toEqual(['SUITE', '3314855906', '3511420007', "'C3099'"]);
  });

  it('NEGATIVA — donde la clave no está, no escribe nada (no da de alta a nadie)', async () => {
    const b = base(undefined);
    expect((await escribirTelefonoEnBase(b.cliente, '04', 'C3099', '3314855906')).estado).toBe('no_esta');
    expect(b.sql).toHaveLength(1);
  });

  it('NEGATIVA — el mismo número con otro formato no se reescribe ni se anota', async () => {
    const b = base('331 485 5906');
    expect((await escribirTelefonoEnBase(b.cliente, '01', 'C3099', '3314855906')).estado).toBe('ya_estaba');
    expect(b.sql).toHaveLength(1);
  });

  describe('las 10 bases', () => {
    const ENV = Object.fromEntries(SERVIDORES_TELEFONO.map((s) => [`KEPLER_PUSH_URL_${s}`, `postgres://k/${s}`]));
    class Prueba extends KeplerTelefonoClienteAdapter {
      constructor(private readonly e: Record<string, string>, readonly bases: Record<string, ReturnType<typeof base>>) { super(); }
      protected override get env() { return this.e; }
      protected override poolDe(url: string): Pool {
        const b = this.bases[url.split('/').pop() as string];
        return { connect: async () => { if (b.caida) throw new Error('ECONNREFUSED'); return b.cliente; } } as unknown as Pool;
      }
    }
    const diez = (over: Record<string, ReturnType<typeof base>> = {}) =>
      Object.fromEntries(SERVIDORES_TELEFONO.map((s) => [s, over[s] ?? base('')]));

    it('escribe en cada base donde está la clave, el concentrador primero, y confirma sólo las escritas', async () => {
      const bases = diez({ '04': base(undefined), '05': base('3314855906') });
      const r = await new Prueba(ENV, bases).escribir('C3099', '3314855906');
      expect(r.map((x) => x.servidor)).toEqual([...SERVIDORES_TELEFONO]);
      expect(r.find((x) => x.servidor === '04')?.estado).toBe('no_esta');
      expect(r.find((x) => x.servidor === '05')?.estado).toBe('ya_estaba');
      expect(r.filter((x) => x.estado === 'escrita')).toHaveLength(8);
      expect(bases['SC'].sql.map((x) => x.q)).toContain('COMMIT');
      expect(bases['04'].sql.map((x) => x.q)).not.toContain('COMMIT');
    });

    it('⛔ NEGATIVA — si UNA base no contesta, no escribe en NINGUNA', async () => {
      const bases = diez({ '07': base('', { caida: true }) });
      await expect(new Prueba(ENV, bases).escribir('C3099', '3314855906')).rejects.toThrow(/Kepler 07 no contestó.*ninguna/);
      for (const s of SERVIDORES_TELEFONO) expect(bases[s].sql.some((x) => x.q.startsWith('UPDATE'))).toBe(false);
    });

    it('⛔ NEGATIVA — sin las 10 conexiones (falta el concentrador) no intenta nada', async () => {
      const sinSc = { ...ENV }; delete sinSc['KEPLER_PUSH_URL_SC'];
      const bases = diez();
      await expect(new Prueba(sinSc, bases).escribir('C3099', '3314855906')).rejects.toThrow(/KEPLER_PUSH_URL_SC/);
      for (const s of SERVIDORES_TELEFONO) expect(bases[s].sql).toHaveLength(0);
    });
  });

  it('arranque: el módulo provee el servicio y el adaptador, y monta el controlador (aridad, no tipos: vitest no emite metadatos)', () => {
    const providers = Reflect.getMetadata('providers', FinanceCustomerLedgerModule) as unknown[];
    const controllers = Reflect.getMetadata('controllers', FinanceCustomerLedgerModule) as unknown[];
    expect(providers).toContain(CarteraTelefonosService);
    expect(providers).toContain(KeplerTelefonoClienteAdapter);
    expect(controllers).toContain(CarteraTelefonosController);
    expect(CarteraTelefonosController.length).toBe(1);
    expect(CarteraTelefonosService.length).toBe(3);
    expect(KeplerTelefonoClienteAdapter.length).toBe(0);
    expect(Reflect.getMetadata(PATH_METADATA, CarteraTelefonosController)).toBe('finance/cartera-telefonos');
  });
});
