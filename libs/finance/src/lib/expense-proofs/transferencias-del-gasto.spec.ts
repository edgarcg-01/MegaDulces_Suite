import {
  agruparTransferencias, leerTransferenciasDelGasto, llaveGasto, paresUnicos, transferenciasDelVale,
  SQL_TRANSFERENCIAS_DEL_GASTO, type FilaTransferencia,
} from './transferencias-del-gasto';

/**
 * `[GX.75]` Las transferencias `XD2601` del expediente. Lo que puede mentir acá no es el SQL
 * sino cómo se pega cada transferencia a su gasto:
 *   · mezclar el folio de dos sucursales (el folio es único POR sucursal);
 *   · perder la marca de cancelada (Kepler conserva su aplicación);
 *   · convertir «no hay ODS» en «nadie pagó».
 */
const fila = (o: Partial<FilaTransferencia>): FilaTransferencia => ({
  sucursal: '00', gasto_folio: '0008602', folio: '0019001', aplicado: '1000.00',
  fecha: '2026-09-05', importe: '1000.00', estado: 'N', ...o,
});

describe('[GX.75] transferencias del gasto', () => {
  it('la llave es el PAR sucursal|folio, con espacios fuera', () => {
    expect(llaveGasto(' 00', '0008602 ')).toBe('00|0008602');
    expect(llaveGasto('00', '0008602')).not.toBe(llaveGasto('01', '0008602'));
  });

  it('paresUnicos quita vacíos y repetidos', () => {
    expect(paresUnicos([
      { sucursal: '00', gasto_folio: '1' }, { sucursal: '00', gasto_folio: '1' },
      { sucursal: '', gasto_folio: '2' }, { sucursal: '01', gasto_folio: null }, { sucursal: '01', gasto_folio: '1' },
    ])).toEqual([{ sucursal: '00', gasto_folio: '1' }, { sucursal: '01', gasto_folio: '1' }]);
  });

  it('agrupa por gasto, ordena por fecha y convierte las cifras', () => {
    const m = agruparTransferencias([
      fila({ folio: '0019002', fecha: '2026-09-10', aplicado: '400' }),
      fila({ folio: '0019001', fecha: '2026-09-05', aplicado: '600.004' }),
      fila({ gasto_folio: '0008700', folio: '0019003' }),
    ]);
    const l = m.get('00|0008602')!;
    expect(l.map((t) => t.folio)).toEqual(['0019001', '0019002']);
    expect(l[0].aplicado).toBe(600);
    expect(l[0].importe).toBe(1000);
    expect(m.get('00|0008700')).toHaveLength(1);
  });

  it('⛔ la cancelada (c43=C) viaja marcada, no se descarta ni se cuenta vigente', () => {
    const l = agruparTransferencias([fila({ estado: 'C ' })]).get('00|0008602')!;
    expect(l[0].cancelada).toBe(true);
  });

  it('⛔ el mismo folio en dos sucursales son dos gastos distintos', () => {
    const m = agruparTransferencias([fila({ sucursal: '00' }), fila({ sucursal: '03', folio: '0000009' })]);
    expect(transferenciasDelVale('00', ['0008602'], m).map((t) => t.folio)).toEqual(['0019001']);
    expect(transferenciasDelVale('03', ['0008602'], m).map((t) => t.folio)).toEqual(['0000009']);
  });

  it('un vale con dos gastos junta las transferencias de ambos, en el orden de sus gastos', () => {
    const m = agruparTransferencias([
      fila({ gasto_folio: 'B', folio: '2', fecha: '2026-09-01' }),
      fila({ gasto_folio: 'A', folio: '1', fecha: '2026-09-09' }),
    ]);
    expect(transferenciasDelVale('00', ['A', 'B'], m).map((t) => `${t.gasto_folio}:${t.folio}`)).toEqual(['A:1', 'B:2']);
    expect(transferenciasDelVale('00', [], m)).toEqual([]);
  });

  it('sin encabezado en kdm1 no inventa fecha ni importe', () => {
    const [t] = agruparTransferencias([fila({ fecha: null, importe: null })]).get('00|0008602')!;
    expect(t.fecha).toBeNull();
    expect(t.importe).toBeNull();
  });

  describe('leerTransferenciasDelGasto', () => {
    const fakeTrx = (existe: boolean, rows: FilaTransferencia[] = []) => {
      const llamadas: { sql: string; bindings: unknown[] }[] = [];
      const trx: any = {
        raw: (sql: string, bindings?: unknown[]) => {
          if (bindings) { llamadas.push({ sql, bindings }); return Promise.resolve({ rows }); }
          return sql;
        },
        select: () => Promise.resolve([{ existe }]),
      };
      return { trx, llamadas };
    };

    it('⛔ sin ODS de Kepler devuelve null (no medido), no un mapa vacío', async () => {
      const { trx, llamadas } = fakeTrx(false);
      expect(await leerTransferenciasDelGasto(trx, [{ sucursal: '00', gasto_folio: '1' }])).toBeNull();
      expect(llamadas).toHaveLength(0);
    });

    it('sin pares no consulta y devuelve mapa vacío (medido)', async () => {
      const { trx, llamadas } = fakeTrx(true);
      const m = await leerTransferenciasDelGasto(trx, []);
      expect(m?.size).toBe(0);
      expect(llamadas).toHaveLength(0);
    });

    it('consulta UNA vez con los pares en orden y agrupa el resultado', async () => {
      const { trx, llamadas } = fakeTrx(true, [fila({})]);
      const m = await leerTransferenciasDelGasto(trx, [
        { sucursal: '00', gasto_folio: '0008602' }, { sucursal: '01', gasto_folio: '0000002' },
      ]);
      expect(llamadas).toHaveLength(1);
      expect(llamadas[0].sql).toBe(SQL_TRANSFERENCIAS_DEL_GASTO);
      expect(llamadas[0].bindings).toEqual([['00', '01'], ['0008602', '0000002'], ['00', '01'], ['0008602', '0000002']]);
      expect(m?.get('00|0008602')).toHaveLength(1);
    });
  });

  it('el SQL exige el par exacto, la sucursal dueña y el tipo XD2601 → XA1001', () => {
    expect(SQL_TRANSFERENCIAS_DEL_GASTO).toContain('IN (SELECT * FROM unnest(?::text[], ?::text[]))');
    expect(SQL_TRANSFERENCIAS_DEL_GASTO).toContain('btrim(m.c1) = m.sucursal');
    expect(SQL_TRANSFERENCIAS_DEL_GASTO).toMatch(/m\.c4 = 26 AND m\.c5 = 1/);
    expect(SQL_TRANSFERENCIAS_DEL_GASTO).toMatch(/m\.c9 = 10 AND m\.c10 = 1/);
    expect((SQL_TRANSFERENCIAS_DEL_GASTO.match(/\?/g) || []).length).toBe(4);
  });
});
