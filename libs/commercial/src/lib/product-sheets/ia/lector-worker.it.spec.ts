/**
 * `[NP.7.L.11d]` Regla 13: el worker del lector ESCRIBE (`ai_raw`) y no está probado hasta que una prueba lo
 * ejerce contra un Postgres real. Esto corre el WORKER REAL (`LectorFotosWorker` con `RepoLectorFotos`) sobre
 * `catalog.product_sheets` de verdad: la selección de pendientes (jsonb de fotos, peldaño principal, estados),
 * el `jsonb_set` de `ai_raw.lecturas`, la idempotencia por `sha256` entre fichas, el conteo del tope diario en
 * hora de México y la escritura de propuesta + auditoría (con `kepler_ods.kdii` sembrado).
 *
 * Se sustituye sólo lo que no es de la base: el bucket (devuelve un JPEG sintético), el lector (un doble: ⛔
 * NINGUNA llamada a Anthropic, D6 sin firmar) y la espera entre reintentos.
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL que NO sea prod (`system_identifier`). Sin la
 * variable se salta y lo DICE en el título. TODO en una transacción que se revierte; dentro de ella se
 * apartan (soft-delete y `ai_raw` en null) las fichas que la base ya tuviera, para que los conteos sean
 * de esta prueba.
 */
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import knexFactory, { type Knex } from 'knex';
import sharp from 'sharp';
import { LectorFotosWorker, RepoLectorFotos } from './lector-worker.service';
import type { ConfigLector } from './lector.config';
import { NOMBRES_CAMPOS, type CamposLeidos, type LecturaFotoV1, type LecturaGuardada, type ResultadoLectura } from './lectura-foto.contract';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const MIG = '../../../../../../database/migrations-newdb/20261102224652_np7_product_sheets.js';
const CARAS = ['frente', 'reverso', 'lateral_izq', 'lateral_der', 'base'];

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
const titulo = URL && local
  ? '[NP.7.L.11d] Worker del lector contra Postgres real (transacción revertida)'
  : '[NP.7.L.11d] NO MEDIDO — sin TP_IT_DB local la prueba de integración del worker del lector no corre';

const CAMPOS_NULOS = Object.fromEntries(NOMBRES_CAMPOS.map((k) => [k, null])) as unknown as CamposLeidos;
const lectura = (): LecturaFotoV1 => ({
  version: 'lectura-foto-v1', nivel_fisico: { valor: 'pieza', confianza: 'alta', evidencia: 'una pieza' },
  persona_visible: false, rostro_visible: false, legible: 'si', motivo_no_legible: null, texto_literal: ['TRIDENT', 'MENTA'],
  campos: { ...CAMPOS_NULOS, marca: { valor: 'Trident', confianza: 'alta', evidencia: 'TRIDENT' }, variante: { valor: 'Menta', confianza: 'alta', evidencia: 'MENTA' } },
});
const USO = { modelo: 'modelo-de-prueba', input_tokens: 1200, output_tokens: 600, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, costo_usd: 0.02, precio_fuente: 'prueba' };
const guardada = (leida_en: string, conUso: boolean): LecturaGuardada => ({
  estado: 'ok', lectura: lectura(), uso: conUso ? { ...USO } : null, error: null, cara: 'frente', peldano: 'base', leida_en, preparacion: null,
});

/** Una foto como la guarda `LevantamientoService` (todos los campos de `FotoFicha`). */
const foto = (sku: string, i: number, sha256: string | null, peldano = 'base') => ({
  peldano, cara: CARAS[i], storage_key: sha256 ? `levantamiento/01/${sku}/${i}.jpg` : null, sha256,
  captured_by: '00000000-0000-0000-0000-0000000a0a0a', captured_at: '2026-11-04T16:00:00.000Z',
  saltada_motivo: sha256 ? null : 'no_tiene_esa_cara', calidad: null, ancho: 1080, alto: 1440, por_busqueda: false,
});

class LectorFalso {
  llamadas = 0;
  /** Sin esto el worker sale en `sin_llave` antes de tocar la base (como el LectorFotoService real sin llave). */
  readonly tieneLlave = true;
  async leerFoto(): Promise<ResultadoLectura> {
    this.llamadas++;
    return { estado: 'ok', lectura: lectura(), uso: { ...USO }, error: null };
  }
}

class WorkerIT extends LectorFotosWorker {
  cfg: ConfigLector = {
    habilitada: true, concurrencia: 1, topeDiario: 50, modelo: 'modelo-de-prueba', effort: 'low', maxTokens: 8000, recorte: 'silueta', advertencias: [],
  };
  protected override config(): ConfigLector { return this.cfg; }
  protected override esperar(): Promise<void> { return Promise.resolve(); }
}

suite(titulo, () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  let worker: WorkerIT;
  const lector = new LectorFalso();
  const repo = new RepoLectorFotos();
  const ids: Record<string, string> = {};
  let jpegUri = '';

  const fila = (sku: string) => trx('catalog.product_sheets').where({ id: ids[sku] })
    .first('status', 'photos', 'sheet', 'ai_raw', 'updated_at', 'updated_by');

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
    if (!(await trx.raw(`SELECT to_regclass('catalog.product_sheets') AS r`)).rows[0].r) {
      const m = createRequire(__filename)(resolvePath(__dirname, MIG)) as { up: (k: Knex) => Promise<void> };
      await m.up(trx);
    }
    // Lo que la base ya tuviera no cuenta en esta prueba (se revierte al final).
    await trx.raw(`UPDATE catalog.product_sheets SET deleted_at = coalesce(deleted_at, now()), ai_raw = NULL WHERE tenant_id = ?`, [M]);

    await trx('kepler_ods.kdii').insert({ sucursal: '01', c1: 'NP7LW1', c2: 'TRIDENT XTRA CARE MENTA /12 (IT)', c11: 'PZA', c80: 'PAQ', c81: 12, c83: 'CJA', c84: 384, c7: '9990000009001' });

    const insertar = async (sku: string, status: string, photos: unknown[], extra: Record<string, unknown> = {}) => {
      const [r] = await trx('catalog.product_sheets').insert({
        tenant_id: M, origin: 'levantamiento', status, sku, branch_code: '01',
        photos: JSON.stringify(photos), sheet: JSON.stringify({ schema_version: 1, principal: 'base', peldanos: { base: {} } }), ...extra,
      }).returning('id');
      ids[sku] = String(r.id ?? r);
    };
    // LW1: 3 fotos reales de la Base, una cara saltada y una foto de OTRO peldaño → 3 pendientes.
    await insertar('NP7LW1', 'fotos_tomadas', [foto('NP7LW1', 0, 's1'), foto('NP7LW1', 1, 's2'), foto('NP7LW1', 2, 's3'), foto('NP7LW1', 3, null), foto('NP7LW1', 4, 'de-la-caja', 'dos')],
      { created_at: trx.raw(`now() - interval '10 minutes'`) });
    // LW2: todavía en captura → no se lee.
    await insertar('NP7LW2', 'en_captura', [foto('NP7LW2', 0, 'lw2')]);
    // LW3: borrada → no se lee.
    await insertar('NP7LW3', 'fotos_tomadas', [foto('NP7LW3', 0, 'lw3')], { deleted_at: trx.raw('now()') });
    // LW4: publicada, con LA MISMA foto que LW1 (mismos bytes) → pendiente en su ficha, pero una sola llamada.
    await insertar('NP7LW4', 'publicada', [foto('NP7LW4', 0, 's1')], { created_at: trx.raw(`now() - interval '5 minutes'`) });
    // LW5: su foto ya tiene lectura → no es pendiente. Trae lecturas para el conteo del tope (hora de México).
    const lecturas = {
      s5: guardada('2026-11-04T17:00:00.000Z', true),
      'noche-del-3': guardada('2026-11-04T05:30:00.000Z', true), // 3-nov 23:30 en México: NO es del 4
      'madrugada-del-4': guardada('2026-11-04T06:30:00.000Z', true), // 4-nov 00:30 en México
      'copia-del-4': guardada('2026-11-04T18:00:00.000Z', false), // copiada: no se cobró
      'cierre-del-4': guardada('2026-11-05T05:00:00.000Z', true), // 4-nov 23:00 en México
    };
    await insertar('NP7LW5', 'fotos_tomadas', [foto('NP7LW5', 0, 's5')], {
      ai_raw: JSON.stringify({ version: 'ai-raw-v1', lecturas, propuesta: null, auditoria: null, actualizado_en: '2026-11-04T18:00:00.000Z' }),
    });

    const jpeg = await sharp({ create: { width: 120, height: 160, channels: 3, background: { r: 200, g: 30, b: 30 } } }).jpeg().toBuffer();
    jpegUri = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    // El knex del worker: cada transacción corta es un SAVEPOINT de la transacción de la prueba; el candado
    // se toma sobre ella misma (se suelta con el rollback final).
    const candado = { raw: (sql: string, b: readonly unknown[]) => trx.raw(sql, b as never), isCompleted: () => false, commit: async () => undefined };
    const knexDelWorker = { transaction: (fn?: (t: Knex.Transaction) => Promise<unknown>) => (fn ? trx.transaction(fn) : Promise.resolve(candado)) };
    worker = new WorkerIT(knexDelWorker as never, { getDataUri: async () => jpegUri } as never, lector as never);
  }, 120_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
  });

  it('pendientes: sólo fotos reales del peldaño principal, de fichas leíbles y sin lectura en SU ficha', async () => {
    const { fotos, total } = await repo.pendientes(trx, M, 50);
    expect(total).toBe(4);
    expect(fotos.map((f) => [f.sheet_id, f.sha256, f.cara])).toEqual([
      [ids['NP7LW1'], 's1', 'frente'], [ids['NP7LW1'], 's2', 'reverso'], [ids['NP7LW1'], 's3', 'lateral_izq'], [ids['NP7LW4'], 's1', 'frente'],
    ]);
    const uno = await repo.pendientes(trx, M, 1);
    expect([uno.fotos.length, uno.total]).toEqual([1, 4]);
  });

  it('tope diario: llamadas reales del día en hora de MÉXICO (ni copias ni la noche anterior)', async () => {
    // 4-nov 12:00 en México. Cuentan s5, madrugada-del-4 y cierre-del-4; no noche-del-3 ni la copia.
    expect(await repo.llamadasDeHoy(trx, M, new Date('2026-11-04T18:00:00.000Z'))).toBe(3);
    // 3-nov 12:00 en México: sólo noche-del-3.
    expect(await repo.llamadasDeHoy(trx, M, new Date('2026-11-03T18:00:00.000Z'))).toBe(1);
  });

  it('una corrida: una llamada por foto distinta, copia a la otra ficha, propuesta y auditoría; sin tocar sheet/status/photos', async () => {
    const antes = { lw1: await fila('NP7LW1'), lw4: await fila('NP7LW4') };
    const hoyAntes = await repo.llamadasDeHoy(trx, M, new Date());

    const r = await worker.procesar('manual');
    expect(lector.llamadas).toBe(3);
    expect(r).toMatchObject({ estado: 'completa', llamadas: 3, leidas: 3, reusadas: 1, fallidas: 0, pendientes_restantes: 0 });
    expect(r.costo_usd).toBeCloseTo(3 * USO.costo_usd, 6);

    const lw1 = await fila('NP7LW1');
    const lw4 = await fila('NP7LW4');
    expect(Object.keys(lw1.ai_raw.lecturas).sort()).toEqual(['s1', 's2', 's3']);
    expect(lw1.ai_raw.version).toBe('ai-raw-v1');
    expect(lw1.ai_raw.lecturas.s1.uso).toMatchObject({ modelo: 'modelo-de-prueba', costo_usd: USO.costo_usd });
    expect(lw1.ai_raw.lecturas.s1.preparacion.recorte).not.toBeNull();
    expect(lw4.ai_raw.lecturas.s1.uso).toBeNull();
    expect(lw4.ai_raw.lecturas.s1.lectura).toEqual(lw1.ai_raw.lecturas.s1.lectura);
    // Propuesta (fusión) y auditoría contra la ficha de Kepler sembrada.
    expect(lw1.ai_raw.propuesta.caras_leidas.sort()).toEqual(['frente', 'lateral_izq', 'reverso']);
    expect(lw1.ai_raw.auditoria).toHaveProperty('hallazgos');
    expect(r.propuestas).toBe(3); // LW1, LW4 y LW5 (que ya tenía su única foto leída ok)
    // ⛔ Sólo ai_raw: ni la ficha, ni el estado, ni las fotos, ni la auditoría de la fila.
    for (const [a, d] of [[antes.lw1, lw1], [antes.lw4, lw4]]) {
      expect(d.status).toBe(a.status);
      expect(d.photos).toEqual(a.photos);
      expect(d.sheet).toEqual(a.sheet);
      expect(new Date(d.updated_at).getTime()).toBe(new Date(a.updated_at).getTime());
      expect(d.updated_by).toBe(a.updated_by);
    }
    // El tope cuenta las 3 llamadas, no la copia.
    expect(await repo.llamadasDeHoy(trx, M, new Date())).toBe(hoyAntes + 3);
  });

  it('otra corrida sin fotos nuevas: cero llamadas', async () => {
    const r = await worker.procesar('manual');
    expect(r.estado).toBe('sin_pendientes');
    expect(lector.llamadas).toBe(3);
  });

  it('una ficha nueva con una foto ya leída en OTRA ficha → se copia de la base, cero llamadas', async () => {
    const [n] = await trx('catalog.product_sheets').insert({
      tenant_id: M, origin: 'levantamiento', status: 'fotos_tomadas', sku: 'NP7LW6', branch_code: '01',
      photos: JSON.stringify([foto('NP7LW6', 0, 's2')]), sheet: JSON.stringify({ schema_version: 1, principal: 'base', peldanos: { base: {} } }),
    }).returning('id');
    ids['NP7LW6'] = String(n.id ?? n);
    const r = await worker.procesar('manual');
    expect(r).toMatchObject({ llamadas: 0, reusadas: 1 });
    expect(lector.llamadas).toBe(3);
    expect((await fila('NP7LW6')).ai_raw.lecturas.s2.uso).toBeNull();
  });

  it('el guardado es condicional: no pisa la lectura que ya se cobró', async () => {
    const otra = { ...guardada(new Date().toISOString(), false), error: 'no debería quedar' };
    expect(await repo.guardarLectura(trx, M, ids['NP7LW1'], 's1', otra, new Date().toISOString())).toBe(false);
    const lw1 = await fila('NP7LW1');
    expect(lw1.ai_raw.lecturas.s1.uso).not.toBeNull();
    expect(lw1.ai_raw.lecturas.s1.error).toBeNull();
  });

  it('una lectura nueva deja la propuesta en null (ya no corresponde) y la propuesta optimista no pisa', async () => {
    const lw1 = await fila('NP7LW1');
    expect(await repo.guardarLectura(trx, M, ids['NP7LW1'], 'nueva', guardada(new Date().toISOString(), false), '2026-11-04T20:00:00.000Z')).toBe(true);
    const despues = await fila('NP7LW1');
    expect(despues.ai_raw.propuesta).toBeNull();
    expect(despues.ai_raw.auditoria).toBeNull();
    // Con el `actualizado_en` viejo, la propuesta no se escribe.
    const vieja = { id: ids['NP7LW1'], sku: 'NP7LW1', branch_code: '01', principal: 'base', photos: lw1.photos, lecturas: lw1.ai_raw.lecturas, actualizado_en: lw1.ai_raw.actualizado_en };
    expect(await repo.guardarPropuesta(trx, M, vieja, lw1.ai_raw.propuesta, lw1.ai_raw.auditoria, new Date().toISOString())).toBe(false);
  });
});
