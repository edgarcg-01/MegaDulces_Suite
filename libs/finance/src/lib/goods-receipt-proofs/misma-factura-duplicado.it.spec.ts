/**
 * `[RE.88]` El PDF repetido que es la MISMA factura de otra entrada, contra Postgres real como `app_runtime`, en una
 * transacción revertida. El método REAL (`mismaFacturaDeDuplicado`) y, al final, la liga REAL de RE.86 que habilita.
 * Caso de CEDIS (2026-11-25, Relámpago): 0010285 trae el PDF de la factura `0-F-1979` y 0010295 cita la misma. Importes
 * reales de la entrada; el RFC equivocado de Kepler (un dígito de menos) es la primera negativa.
 *
 * ⛔ Sólo corre con `TP_IT_DB` LOCAL que no sea prod (se compara el `system_identifier`), con la migración de RE.86.
 */
import knexFactory, { type Knex } from 'knex';
import type { MismaFacturaDuplicado } from '@megadulces/contracts';
import { GoodsReceiptProofsService } from './goods-receipt-proofs.service';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const T = '00000000-0000-0000-0000-00000000d01c';
const RFC_SAT = 'TZW141008RS4';
const RFC_KEPLER_MALO = 'TZW14108RS4';
const UUID = '7C0FA3CC-0000-4000-8000-000000001979';

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[RE.88] NO MEDIDO: sin TP_IT_DB la prueba de la misma factura no corre.');

type Metodo = (...a: unknown[]) => Promise<unknown>;

suite('[RE.88] el PDF repetido que es la misma factura, contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  const proto = GoodsReceiptProofsService.prototype as unknown as { mismaFacturaDeDuplicado: Metodo; ligarFacturaCompartida: Metodo };
  const ctx = () => ({
    tenantCtx: { requireTenantId: () => T, get: () => ({ userId: null, username: 'prueba' }) },
    tk: { run: (fn: (t: Knex.Transaction) => Promise<unknown>) => trx.transaction((sp) => fn(sp)) },
    exigirAlcance: async () => undefined,
    objCache: new Map<string, boolean>(),
    existeCol: (GoodsReceiptProofsService.prototype as unknown as { existeCol: Metodo }).existeCol,
  });
  const misma = (destino: string, otra = '0010285') => trx.transaction((sp) =>
    proto.mismaFacturaDeDuplicado.call(ctx(), sp, T, { sucursal: '00', folio: destino }, { sucursal: '00', folio: otra }, 165618.07),
  ) as Promise<MismaFacturaDuplicado | null>;
  const rfcDeKepler = (rfc: string) => trx.raw(`UPDATE kepler_ods.kdm1 SET c22 = ? WHERE sucursal = '00' AND c10 = 'CP050'`, [rfc]);

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
    // La base desechable trae una versión vieja de la vista, sin `referencia` (RE.32, prod sí la tiene). Se le agrega
    // con la MISMA fuente que documenta RE.32 (`kdm1.c11` de la cabecera XA2001), sólo dentro de esta transacción.
    if (!(await trx.schema.withSchema('analytics').hasColumn('erp_goods_receipts', 'referencia'))) {
      await trx.raw('ALTER VIEW analytics.erp_goods_receipts RENAME TO erp_goods_receipts_sin_ref');
      await trx.raw(`CREATE VIEW analytics.erp_goods_receipts AS SELECT o.*, NULLIF(btrim(k.c11), '') AS referencia
        FROM analytics.erp_goods_receipts_sin_ref o LEFT JOIN kepler_ods.kdm1 k
          ON k.sucursal = o.sucursal AND k.c2 = 'X' AND k.c3 = 'A' AND k.c4 = 20 AND btrim(k.c6) = o.folio`);
      await trx.raw('GRANT SELECT ON analytics.erp_goods_receipts TO app_runtime');
    }
    const ap = (folio: string, total: number, prov: string, rfc: string, ref: string) =>
      trx.raw(`INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c10, c11, c16, c22, c24, c32, c43)
               VALUES ('00', '00', 'X', 'A', 20, 1, ?, '2026-11-12'::timestamp, ?, ?, ?, ?, 'INCLUIDOS YA EN FACTURA', 'PRUEBA', 'N')`,
      [folio, prov, ref, total, rfc]);
    await ap('0010285', 165618.07, 'CP050', RFC_KEPLER_MALO, '0-F-1979');
    await ap('0010295', 530.31, 'CP050', RFC_KEPLER_MALO, '0-F-1979');
    await ap('0010296', 99.0, 'CP050', RFC_KEPLER_MALO, '0-F-2000');
    await ap('0010297', 10.0, 'CB011', 'XAXX010101000', '0-F-1979');
    // El PDF de la 0010285: el UUID sólo lo trae la lectura del OCR (en prod no tenía liga por el RFC equivocado).
    await trx('finance.goods_receipt_proofs').insert({ tenant_id: T, sucursal: '00', folio: '0010285', ocr_raw: { uuid: UUID.toLowerCase(), total: 165618.07 }, status: 'recibido' });
    await trx('fiscal.cfdis').insert({
      tenant_id: T, uuid: UUID, folio: '9890161979', fecha: '2026-11-11', emisor_rfc: RFC_SAT, emisor_nombre: 'RELAMPAGO',
      total: 165618.07, subtotal: 163980.1, rol: 'recibidas', tipo_comprobante: 'I', estatus_sat: 'vigente',
    });
    await trx.raw('SET LOCAL ROLE app_runtime');
  }, 120_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
  });

  it('el caso de CEDIS: misma factura, la suma contra el SAT, y NO se puede ligar por el RFC de Kepler', async () => {
    const m = (await misma('0010295'))!;
    expect(m.referencia).toBe('0-F-1979');
    expect(m.hermana).toEqual({ sucursal: '00', folio: '0010285', monto: 165618.07 });
    expect(m.cfdi_uuid).toBe(UUID);
    expect(m.factura_fuente).toBe('sat');
    expect(m.diferencia).toBe(530.31);
    expect(m.no_se_puede).toContain(RFC_KEPLER_MALO);
  });

  it('NEGATIVAS: otra referencia u otro proveedor no son la misma factura', async () => {
    expect(await misma('0010296')).toBeNull();
    expect(await misma('0010297')).toBeNull();
  });

  it('con el RFC corregido en Kepler se puede; la liga real de RE.86 pasa, y después ya no se ofrece otra', async () => {
    await trx.raw('RESET ROLE');
    await rfcDeKepler(RFC_SAT);
    await trx.raw('SET LOCAL ROLE app_runtime');
    expect((await misma('0010295'))!.no_se_puede).toBeNull();
    await trx.transaction((sp) => proto.ligarFacturaCompartida.call(
      { ...ctx(), tk: { run: (fn: (t: Knex.Transaction) => Promise<unknown>) => sp.transaction((x) => fn(x)) } },
      '00', '0010295', { cfdi_uuid: UUID, motivo: 'Las 50 gelatinas Jerez vienen en la factura 1979 (revisado en el papel)' }, 'prueba'));
    expect((await misma('0010295'))!.no_se_puede).toMatch(/ya tiene una factura/);
  });
});
