import { preferMaterialized } from '@megadulces/platform-core';
import { UNIT_TRUTH_MV, UNIT_TRUTH_VIEW, unitTruth } from './unit-truth';

/**
 * [CPU.2] Pruebas del primitivo «preferí la copia y declará su edad».
 *
 * ⚠️ VIVEN ACÁ Y NO EN `libs/platform-core`, QUE ES DONDE ESTÁ EL CÓDIGO. Medido: `platform-core`
 * no tiene **ni un `.spec.ts` ni un target `test`** en su `project.json`, así que una prueba puesta
 * allá no la corre nadie — y una prueba que no corre se lee igual que una que pasa. `commercial` sí
 * tiene runner (17 archivos), e importa `platform-core`, así que acá se ejecutan de verdad.
 * Queda DECLARADO como deuda con nombre: `platform-core` necesita su propio runner.
 *
 * ⛔ Lo que estas pruebas NO hacen: validar SQL. El doble de knex no ejecuta nada, y este repo ya
 * pagó esa lección (13 pruebas verdes y el login de prod en 500 porque `SET` no acepta parámetros
 * ligados). Acá se prueba SÓLO lógica pura —a quién elige, qué declara, qué cachea, qué contiene—
 * que es lo que un doble sí puede responder con honestidad.
 */

type RawFake = (sql: string, bindings?: unknown) => Promise<{ rows: unknown[] }>;

function fakeTrx(opts: {
  existe: boolean;
  refreshedAt?: string | null;
  fallaLectura?: boolean;
  isTransaction?: boolean;
}) {
  const sqls: string[] = [];
  const raw: RawFake = async (sql: string) => {
    sqls.push(sql.trim());
    if (sql.includes('to_regclass')) return { rows: [{ ok: opts.existe }] };
    if (/^\s*(SAVEPOINT|RELEASE|ROLLBACK)/.test(sql)) return { rows: [] };
    if (sql.includes('LIMIT 1')) {
      if (opts.fallaLectura) throw new Error('el backend se cayó a mitad de la lectura');
      return { rows: [{ t: opts.refreshedAt ?? null }] };
    }
    return { rows: [] };
  };
  const trx = { isTransaction: opts.isTransaction ?? true, raw } as any;
  return { trx, sqls };
}

/** Nombre distinto por prueba: la caché de existencia es a nivel MÓDULO y se comparte. */
let n = 0;
const mvUnica = () => `analytics.mv_prueba_${++n}`;

describe('preferMaterialized', () => {
  it('sin la copia, cae a la vista viva y lo DECLARA (no finge que leyó la copia)', async () => {
    const { trx } = fakeTrx({ existe: false });
    const r = await preferMaterialized(trx, mvUnica(), 'analytics.v_prueba');

    expect(r.rel).toBe('analytics.v_prueba');
    expect(r.provenance).toEqual({ source: 'view', refreshed_at: null });
  });

  it('con la copia, la elige y trae su edad', async () => {
    const mv = mvUnica();
    const { trx } = fakeTrx({ existe: true, refreshedAt: '2026-09-25 06:34:16' });
    const r = await preferMaterialized(trx, mv, 'analytics.v_prueba');

    expect(r.rel).toBe(mv);
    expect(r.provenance).toEqual({ source: 'mv', refreshed_at: '2026-09-25 06:34:16' });
  });

  it('⭐ el "no existe" VENCE: aplicar la migración no exige reiniciar la API', async () => {
    const mv = mvUnica();
    // Primera pasada: la migración todavía no corrió.
    const a = await preferMaterialized(fakeTrx({ existe: false }).trx, mv, 'analytics.v_prueba');
    expect(a.provenance.source).toBe('view');

    // Alguien aplica la migración. Sin vencimiento, el proceso seguiría leyendo la vista lenta
    // PARA SIEMPRE — que es exactamente lo que hacía la versión de instancia que esto reemplaza.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 61_000); // el TTL del negativo es 60 s
      const b = await preferMaterialized(fakeTrx({ existe: true, refreshedAt: 'x' }).trx, mv, 'analytics.v_prueba');
      expect(b.rel).toBe(mv);
      expect(b.provenance.source).toBe('mv');
    } finally {
      vi.useRealTimers();
    }
  });

  it('el "sí existe" NO se vuelve a preguntar: una sonda por proceso, no por request', async () => {
    const mv = mvUnica();
    const primera = fakeTrx({ existe: true, refreshedAt: 'x' });
    await preferMaterialized(primera.trx, mv, 'analytics.v_prueba');
    expect(primera.sqls.filter((s) => s.includes('to_regclass'))).toHaveLength(1);

    const segunda = fakeTrx({ existe: true, refreshedAt: 'x' });
    await preferMaterialized(segunda.trx, mv, 'analytics.v_prueba');
    expect(segunda.sqls.filter((s) => s.includes('to_regclass'))).toHaveLength(0);
  });

  it('⭐ si la lectura de la edad revienta, NO se lleva puesta la transacción del reporte', async () => {
    const mv = mvUnica();
    const { trx, sqls } = fakeTrx({ existe: true, fallaLectura: true });

    // No lanza: el reporte que venía a describirse sigue vivo.
    const r = await preferMaterialized(trx, mv, 'analytics.v_prueba');

    // Y la edad se reporta como NO MEDIDA, nunca como fresca (ADR-056, regla 2).
    expect(r.rel).toBe(mv);
    expect(r.provenance).toEqual({ source: 'mv', refreshed_at: null });
    // El SAVEPOINT es lo que contiene el daño; sin él el error aborta la tx externa.
    expect(sqls.some((s) => s.startsWith('SAVEPOINT'))).toBe(true);
    expect(sqls.some((s) => s.startsWith('ROLLBACK TO SAVEPOINT'))).toBe(true);
  });

  it('fuera de transacción NO usa SAVEPOINT (ahí falla con 25P01 y tumbaba el endpoint)', async () => {
    const mv = mvUnica();
    const { trx, sqls } = fakeTrx({ existe: true, refreshedAt: 'x', isTransaction: false });
    (trx as any).transaction = (fn: (t: unknown) => unknown) => fn(trx);

    await preferMaterialized(trx, mv, 'analytics.v_prueba');
    expect(sqls.some((s) => s.startsWith('SAVEPOINT'))).toBe(false);
  });

  it('⛔ rechaza identificadores que no son `esquema.tabla` (la relación va sin escapar al SQL)', async () => {
    const { trx } = fakeTrx({ existe: true });
    await expect(preferMaterialized(trx, 'analytics.mv_x; DROP TABLE users', 'analytics.v_x'))
      .rejects.toThrow(/identificador inválido/);
    await expect(preferMaterialized(trx, 'analytics.mv_x', 'sin_esquema'))
      .rejects.toThrow(/identificador inválido/);
    await expect(preferMaterialized(trx, 'analytics.mv_x', 'analytics.v_x', { refreshedAtCol: 'a b' }))
      .rejects.toThrow(/identificador inválido/);
  });
});

describe('unitTruth', () => {
  it('ata el par del resolvedor de unidad: una sola declaración de CUÁL, no una por consumidor', async () => {
    expect(UNIT_TRUTH_MV).toBe('analytics.mv_unit_truth');
    expect(UNIT_TRUTH_VIEW).toBe('analytics.v_unit_truth');

    const { trx } = fakeTrx({ existe: true, refreshedAt: '2026-09-25 13:00:00' });
    const r = await unitTruth(trx);
    expect(r.rel).toBe(UNIT_TRUTH_MV);
    expect(r.provenance.refreshed_at).toBe('2026-09-25 13:00:00');
  });
});
