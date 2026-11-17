import {
  contadorAtrasado, decidirFolio, leerContador, llaveDelContador, reservarFolioKepler, type ConsultaKepler,
} from './kepler-servidor';

const XA15 = { grupo: 'X', naturaleza: 'A', tipo: 15, serie: 1 } as const;

describe('[PGP.122.4] llaveDelContador — la fila de md.sqliov de cada documento', () => {
  it('la solicitud de gasto de 08 es KFXA1501.08; el pago de 00, KFXD2601.00 (medido en el ODS)', () => {
    expect(llaveDelContador({ ...XA15, sucursal: '08' })).toEqual({ ok: true, valor: 'KFXA1501.08' });
    expect(llaveDelContador({ grupo: 'X', naturaleza: 'D', tipo: 26, serie: 1, sucursal: '00' })).toEqual({ ok: true, valor: 'KFXD2601.00' });
    expect(llaveDelContador({ grupo: 'X', naturaleza: 'A', tipo: 30, serie: 1, sucursal: '04' })).toEqual({ ok: true, valor: 'KFXA3001.04' });
  });
  it('⛔ NEGATIVA — una camioneta, un tipo de tres dígitos o un grupo inventado no tienen contador', () => {
    expect(llaveDelContador({ ...XA15, sucursal: '01-005' }).ok).toBe(false);
    expect(llaveDelContador({ ...XA15, sucursal: '08', tipo: 150 }).ok).toBe(false);
    expect(llaveDelContador({ ...XA15, sucursal: '08', grupo: 'Z' as never }).ok).toBe(false);
  });
});

describe('[PGP.122.4] leerContador', () => {
  it('el único c4 con ceros a la izquierda (KFXA3001.00 = «0003161») se lee como número', () => {
    expect(leerContador('0003161')).toBe(3161);
    expect(leerContador('426')).toBe(426);
    expect(leerContador(' 81 ')).toBe(81);
  });
  it('⛔ NEGATIVA — lo que no es un folio no se convierte en uno («149z» es de la fila CUENTAS)', () => {
    expect(leerContador('149z')).toBeNull();
    expect(leerContador('')).toBeNull();
    expect(leerContador(null)).toBeNull();
    expect(leerContador('12345678')).toBeNull();
  });
});

describe('[PGP.122.4] decidirFolio = greatest(contador, MAX+1)', () => {
  it('contador al día (9 de 9 KFXA1501): el folio ES el contador y el contador avanza uno', () => {
    expect(decidirFolio({ contador: 426, maximo: 425 })).toEqual({ ok: true, valor: { folio: '0000426', contadorNuevo: '427', contadorAtrasado: false } });
  });
  it('contador atrasado (el caso KFXA3001.08: 21 contra 89): se respeta el MAX y el contador se repara', () => {
    expect(decidirFolio({ contador: 21, maximo: 89 })).toEqual({ ok: true, valor: { folio: '0000090', contadorNuevo: '91', contadorAtrasado: true } });
  });
  it('contador igual al último folio (el caso KFXA3001.04: 122 = 122): no se repite el folio', () => {
    expect(decidirFolio({ contador: 122, maximo: 122 })).toEqual({ ok: true, valor: { folio: '0000123', contadorNuevo: '124', contadorAtrasado: true } });
  });
  it('contador adelantado (Kepler ya reservó un folio en una pantalla abierta): se respeta el contador', () => {
    expect(decidirFolio({ contador: 430, maximo: 425 })).toEqual({ ok: true, valor: { folio: '0000430', contadorNuevo: '431', contadorAtrasado: false } });
  });
  it('⛔ NEGATIVA — sin contador legible no hay folio, aunque haya MAX', () => {
    expect(decidirFolio({ contador: null, maximo: 425 }).ok).toBe(false);
  });
  it('⛔ NEGATIVA — un folio de ocho dígitos no cabe en kdm1.c6', () => {
    expect(decidirFolio({ contador: 9_999_999, maximo: 9_999_999 }).ok).toBe(false);
  });
});

describe('[PGP.122.4] contadorAtrasado — la compuerta del contador', () => {
  it('suena cuando el contador no apunta al siguiente libre', () => {
    expect(contadorAtrasado(426, 425)).toBe(false);
    expect(contadorAtrasado(3161, 3185)).toBe(true);
    expect(contadorAtrasado(122, 122)).toBe(true);
    expect(contadorAtrasado(null, 0)).toBe(true);
  });
});

/** Un Kepler de mentira que contesta las tres consultas de `reservarFolioKepler` y anota lo que le pidieron. */
function keplerFalso(c4: string | null, max: number, filasUpdate = 1) {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const k: ConsultaKepler = {
    async query(q, p = []) {
      sql.push(q.replace(/\s+/g, ' ').trim());
      params.push(p);
      if (/FROM md\.sqliov/.test(q)) return c4 === null ? { rows: [], rowCount: 0 } : { rows: [{ c4 }], rowCount: 1 };
      if (/FROM md\.kdm1/.test(q)) return { rows: [{ m: max }], rowCount: 1 };
      if (/UPDATE md\.sqliov/.test(q)) return { rows: [], rowCount: filasUpdate };
      throw new Error(`consulta inesperada: ${q}`);
    },
  };
  return { k, sql, params };
}

describe('[PGP.122.4] reservarFolioKepler — el orden y lo que escribe', () => {
  it('candado del contador → MAX del tipo en ESE servidor → avanza el contador; devuelve todo para la bitácora', async () => {
    const f = keplerFalso('426', 425);
    const r = await reservarFolioKepler(f.k, { ...XA15, sucursal: '08' });
    expect(r).toEqual({ ok: true, valor: { folio: '0000426', contadorNuevo: '427', contadorAtrasado: false, llave: 'KFXA1501.08', contadorAntes: '426', maximo: 425 } });
    expect(f.sql[0]).toMatch(/FOR UPDATE$/);
    expect(f.params[1]).toEqual(['08', 'X', 'A', 15, 1]);
    expect(f.params[2]).toEqual(['KFXA1501.08', '427']);
  });
  it('⛔ NEGATIVA — sin fila de contador no avanza nada ni decide folio', async () => {
    const f = keplerFalso(null, 425);
    const r = await reservarFolioKepler(f.k, { ...XA15, sucursal: '08' });
    expect(r.ok).toBe(false);
    expect(f.sql.some((q) => q.startsWith('UPDATE'))).toBe(false);
  });
  it('⛔ NEGATIVA — si el UPDATE del contador no toca exactamente una fila, falla (quien llama hace ROLLBACK)', async () => {
    const f = keplerFalso('426', 425, 0);
    expect((await reservarFolioKepler(f.k, { ...XA15, sucursal: '08' })).ok).toBe(false);
  });
});
