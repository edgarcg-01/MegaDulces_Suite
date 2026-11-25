import type { PoolClient } from 'pg';
import {
  KeplerAjusteAbonoSinkAdapter, escrituraDeAjusteAbonoEncendida, type EntregaAjusteAbono,
} from './kepler-ajuste-abono-sink.adapter';

/**
 * `[GP.R.3]` El adaptador contra un Kepler **simulado**: los candados, la plantilla, el folio, la secuencia de
 * escrituras y el control del efecto. No toca ninguna base.
 *
 * El SQL real contra Kepler ya lo probó el **ensayo con ROLLBACK** del 2026-11-24 desde `md`
 * (`ops/prod/ensayo-ajuste-abono/`): folio `0000002` del contador real, tres tablas escritas, y la factura
 * `8-1-0000470` pasó de $7.20 a $0.00; control: 0 documentos, contador igual, saldos iguales.
 */

interface Escenario {
  /** Lo que la Suite ya escribió con esa referencia (idempotencia). */
  previos?: string[];
  /** Si existe un `U-A-30` vivo que clonar. */
  plantilla?: boolean;
  /** Cuántas filas trae cada plantilla (kdm1 · kdue · kdm5). Por omisión, una cada una. */
  filas?: { kdm1?: number; kdue?: number; kdm5?: number };
  importe?: number;
  resto?: number;
  /** El saldo que queda DESPUÉS de aplicar. 0 = el resto se cerró completo. */
  restoDespues?: number;
  /** Las filas que devuelve cada INSERT a `md`. */
  insertadas?: number;
}

function clienteFalso(s: Escenario) {
  const sql: string[] = [];
  let escrito = false;
  const q = async (text: string, _params?: unknown[]) => {
    const t = text.replace(/\s+/g, ' ').trim();
    sql.push(t);
    if (/btrim\(c11\) = \$3 AND btrim\(c67\) = 'SUITE'/.test(t)) {
      return { rows: (s.previos ?? []).map((folio) => ({ folio })), rowCount: (s.previos ?? []).length };
    }
    // El saldo derivado: el resto antes de escribir, y lo que quedó después.
    if (/FROM md\.kdm1 k WHERE k\.c1 = \$1 AND k\.c2 = 'U' AND k\.c3 = 'D'/.test(t)) {
      const saldo = escrito ? (s.restoDespues ?? 0) : (s.resto ?? 7.2);
      return { rows: [{ importe: s.importe ?? 1589.12, saldo }], rowCount: 1 };
    }
    if (/ORDER BY c9 DESC LIMIT 1/.test(t)) {
      return (s.plantilla ?? true) ? { rows: [{ folio: '0000001' }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/CREATE TEMP TABLE/.test(t)) return { rows: [], rowCount: 1 };
    if (/count\(\*\)::int AS n FROM _kdm10/.test(t)) return { rows: [{ n: s.filas?.kdm1 ?? 1 }], rowCount: 1 };
    if (/count\(\*\)::int AS n FROM _kdue0/.test(t)) return { rows: [{ n: s.filas?.kdue ?? 1 }], rowCount: 1 };
    if (/count\(\*\)::int AS n FROM _kdm50/.test(t)) return { rows: [{ n: s.filas?.kdm5 ?? 1 }], rowCount: 1 };
    // El folio, con el contador real de Kepler.
    if (/FROM md\.sqliov/.test(t)) return { rows: [{ c4: '0000002' }], rowCount: 1 };
    if (/max\(c6\)/.test(t) || /max\(btrim\(c6\)\)/.test(t)) return { rows: [{ m: '0000001' }], rowCount: 1 };
    if (/UPDATE md\.sqliov/.test(t)) return { rows: [], rowCount: 1 };
    if (/RETURNING ctid/.test(t)) return { rows: [{ t: '(0,1)' }], rowCount: 1 };
    if (/INSERT INTO md\.(kdm1|kdue|kdm5) SELECT/.test(t)) { escrito = true; return { rows: [], rowCount: s.insertadas ?? 1 }; }
    return { rows: [], rowCount: 0 };
  };
  return { cliente: { query: q, release: () => undefined } as unknown as PoolClient, sql };
}

class AdaptadorDePrueba extends KeplerAjusteAbonoSinkAdapter {
  constructor(private readonly e: Record<string, string>) { super(); }
  protected override get env() { return this.e; }
  protected override get hoy() { return '2026-11-25'; }
  protected override get ahora() { return '10:30'; }
}

const ENV = { KEPLER_AJUSTE_ABONO_ESCRITURA: 'encendida', KEPLER_PUSH_URL_08: 'postgres://x' };
const entrega = (o: Partial<EntregaAjusteAbono> = {}): EntregaAjusteAbono => ({
  sucursal: '08', cliente: 'C2043', referencia: 'RC08MH1K2J3L',
  facturas: [{ tipo: 8, serie: 1, folio: '0000470' }], ...o,
});

function adaptador(env: Record<string, string>, s: Escenario = {}) {
  const f = clienteFalso(s);
  const a = new AdaptadorDePrueba(env);
  // `poolDe` es privado: se sustituye por uno que devuelve el cliente falso.
  (a as unknown as { poolDe: () => { connect: () => Promise<PoolClient> } }).poolDe = () => ({ connect: async () => f.cliente });
  return { a, sql: f.sql };
}

describe('[GP.R.3] el interruptor de proceso', () => {
  it('apagado salvo que diga exactamente «encendida»', () => {
    expect(escrituraDeAjusteAbonoEncendida({ KEPLER_AJUSTE_ABONO_ESCRITURA: 'encendida' })).toBe(true);
    expect(escrituraDeAjusteAbonoEncendida({ KEPLER_AJUSTE_ABONO_ESCRITURA: ' encendida ' })).toBe(true);
    for (const v of [undefined, '', 'true', '1', 'si', 'ENCENDIDA', 'apagada']) {
      expect(escrituraDeAjusteAbonoEncendida({ KEPLER_AJUSTE_ABONO_ESCRITURA: v })).toBe(false);
    }
  });

  it('⛔ apagado NO abre ninguna conexión a Kepler', async () => {
    const { a, sql } = adaptador({});
    const r = await a.entregar(entrega());
    expect(r.estado).toBe('apagado');
    expect(sql).toEqual([]);
  });

  it('sin la URL de esa sucursal queda apagado, no roto', async () => {
    const { a } = adaptador({ KEPLER_AJUSTE_ABONO_ESCRITURA: 'encendida' });
    expect((await a.entregar(entrega())).estado).toBe('apagado');
  });
});

describe('[GP.R.3] escribir el Ajuste Abono', () => {
  it('el camino feliz: plantilla, folio, tres escrituras y el saldo en cero', async () => {
    const { a, sql } = adaptador(ENV, { resto: 7.2, restoDespues: 0 });
    const r = await a.entregar(entrega());
    expect(r.estado).toBe('escrito');
    if (r.estado !== 'escrito') return;
    expect(r.kepler.folio).toBe('0000002');
    expect(r.kepler.total).toBe(7.2);
    expect(r.kepler.saldos).toEqual([{ factura: '8-1-0000470', antes: 7.2, despues: 0 }]);
    // Las tres tablas, y NINGUNA más: kdm2 no (no hay renglones) y la póliza tampoco (D-R2).
    const inserts = sql.filter((x) => /^INSERT INTO md\./.test(x));
    expect(inserts).toEqual(['INSERT INTO md.kdm1 SELECT * FROM _kdm1', 'INSERT INTO md.kdue SELECT * FROM _kdue', 'INSERT INTO md.kdm5 SELECT * FROM _kdm5']);
    expect(sql.filter((x) => /md\.(kdm2|kdc2)/.test(x))).toEqual([]);
    expect(sql).toContain('COMMIT');
    expect(sql).not.toContain('ROLLBACK');
  });

  it('idempotencia: si la Suite ya lo escribió con esa referencia, no escribe otro', async () => {
    const { a, sql } = adaptador(ENV, { previos: ['0000007'] });
    const r = await a.entregar(entrega());
    expect(r.estado).toBe('escrito');
    if (r.estado !== 'escrito') return;
    expect(r.ya_estaba).toBe(true);
    expect(r.kepler.folio).toBe('0000007');
    expect(sql.filter((x) => /^INSERT INTO md\./.test(x))).toEqual([]);
    expect(sql).not.toContain('BEGIN');
  });

  /** ⭐ El control del efecto, el mismo con el que el ensayo vio bajar la factura de $7.20 a $0.00. */
  it('⛔ si el saldo NO queda en cero, revierte: algo más se movió', async () => {
    const { a, sql } = adaptador(ENV, { resto: 7.2, restoDespues: 3.1 });
    const r = await a.entregar(entrega());
    expect(r.estado).toBe('rechazado');
    if (r.estado !== 'rechazado') return;
    expect(r.motivo).toContain('algo más se movió');
    expect(sql).toContain('ROLLBACK');
    expect(sql).not.toContain('COMMIT');
  });

  it('⛔ sin plantilla viva no se inventa un documento (las 200 columnas de kdm1 son NOT NULL)', async () => {
    const { a, sql } = adaptador(ENV, { plantilla: false });
    const r = await a.entregar(entrega());
    expect(r.estado).toBe('rechazado');
    if (r.estado !== 'rechazado') return;
    expect(r.motivo).toContain('sin plantilla no se inventa un documento');
    expect(r.reintentable).toBe(false);
    expect(sql).toContain('ROLLBACK');
  });

  it('⛔ una plantilla incompleta tampoco sirve: no se inventan sus columnas', async () => {
    for (const filas of [{ kdue: 0 }, { kdm5: 0 }, { kdm1: 2 }]) {
      const { a } = adaptador(ENV, { filas });
      const r = await a.entregar(entrega());
      expect(r.estado).toBe('rechazado');
      if (r.estado === 'rechazado') expect(r.motivo).toContain('está incompleta');
    }
    expect((await adaptador(ENV, { restoDespues: 0 }).a.entregar(entrega())).estado).toBe('escrito');   // el control
  });

  it('negativo: más del tope es deuda, no redondeo (lo decide el armador, con el saldo VIVO)', async () => {
    const { a, sql } = adaptador(ENV, { resto: 25, importe: 1589.12 });
    const r = await a.entregar(entrega());
    expect(r.estado).toBe('rechazado');
    if (r.estado !== 'rechazado') return;
    expect(r.motivo).toContain('es deuda, no redondeo');
    expect(sql).not.toContain('BEGIN');                       // ni siquiera abre la transacción
  });

  it('negativo: una factura que nunca tuvo cobro no es un resto, aunque deba centavos', async () => {
    const { a } = adaptador(ENV, { importe: 7.2, resto: 7.2 });
    const r = await a.entregar(entrega());
    expect(r.estado).toBe('rechazado');
    if (r.estado === 'rechazado') expect(r.motivo).toContain('nunca recibió un cobro');
  });

  it('un INSERT que no toca filas revierte', async () => {
    const { a, sql } = adaptador(ENV, { insertadas: 0 });
    expect((await a.entregar(entrega())).estado).toBe('rechazado');
    expect(sql).toContain('ROLLBACK');
  });
});
