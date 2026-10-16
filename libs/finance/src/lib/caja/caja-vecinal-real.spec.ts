import knexFactory, { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { refVecinal } from './caja-vecinal.query';

/**
 * `[CGP-VEC.2]` **El vocabulario nuevo, ejercido contra la base real.**
 *
 * Decisión de Edgar (2026-10-16): la bandeja propone los dos caminos y **la persona decide** cuál
 * es el mismo dinero — el pareo automático por importe quedó refutado por placebo. Para que eso
 * funcione, capturar un cierre vecinal tiene que **poder guardarse** y **dejar su llave**.
 *
 * ⛔ **Y no se podía.** `create()` trata a `origen_tipo='cobro'` como anclado a un documento de
 * Kepler y lo rechaza con frase: *«No se registra efectivo contra un documento que el ERP no
 * tiene»*. Esa regla está bien y se conserva. Lo que faltaba era que el cierre vecinal **no sea un
 * `cobro`**: tiene árbitro propio (`v_vecinal_conciliacion`) y no tiene documento. De ahí la
 * migración `20261016081244`, que amplía `cash_ledger_origen_chk` con `cobro_vecinal`.
 *
 * ── Lo que esta prueba ejerce, y lo que NO ────────────────────────────────────────────────────
 * ✅ Que la base **acepte** el valor nuevo y **rechace** uno inventado (`23514`), y que la llave que
 *    se guarda sea exactamente la que publica `refVecinal()` — una definición, no dos.
 * ⛔ **El camino completo por `create()` no se ejerce acá, y se declara:** necesita
 *    `analytics.v_kepler_conceptos` para fotografiar el nombre de la cuenta, y esa vista vive sobre
 *    el ODS de Kepler. ⚠️ No se guardó con un `to_regclass` a propósito: dejar el nombre de la
 *    cuenta en `null` es **exactamente** el incidente `[CG.129]`/`[CG.130]` —el dato correcto con la
 *    etiqueta vacía—, así que es mejor que reviente a que escriba un hueco.
 */
const URL = process.env.CAJA_TEST_DB_URL;
const T = '00000000-0000-0000-0000-00000000d01c';
const CORRIDA = Date.now().toString(36);

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[CGP-VEC.2] NO MEDIDO: sin CAJA_TEST_DB_URL no hay base contra la cual probar el origen nuevo.');
}

describe.skipIf(!URL)('[CGP-VEC.2] `cobro_vecinal` contra Postgres', () => {
  let knex: Knex;
  let tk: TenantKnexService;

  beforeAll(() => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 2 } });
    tk = new TenantKnexService(knex, { requireTenantId: () => T } as unknown as TenantContextService);
  });
  afterAll(async () => { await knex?.destroy(); });

  const fila = (origen: string, ref: string) => ({
    tenant_id: T, folio: `CIV-${CORRIDA}-${origen}`, tipo: 'ingreso',
    fecha: '2001-03-05', sucursal: '08',
    kepler_cuenta: '115', kepler_concepto: '071',
    glosa: 'Ruta vecinal 2V005 · cierre de prueba',
    monto: 6244.5, origen_tipo: origen, origen_ref: ref,
    created_by: '00000000-0000-0000-0000-0000000000e1',
  });

  it('la base ACEPTA `cobro_vecinal`, y la llave guardada es la que publica refVecinal()', async () => {
    const ref = refVecinal('08', '2001-03-05', 9);
    expect(ref).toBe('08|VEC|2001-03-05|9');

    await tk.run((trx) => trx('finance.cash_ledger').insert(fila('cobro_vecinal', ref)));
    const r = await tk.run((trx) => trx('finance.cash_ledger')
      .where({ tenant_id: T, origen_ref: ref }).first('origen_tipo', 'monto'));
    expect(r.origen_tipo).toBe('cobro_vecinal');
    expect(Number(r.monto)).toBe(6244.5);

    await tk.run((trx) => trx('finance.cash_ledger').where({ tenant_id: T, origen_ref: ref }).del());
  });

  /**
   * ⛔ **La prueba negativa, sin la cual el CHECK es decorativo.** Si alguien amplía el CHECK a
   * cualquier texto, esto se pone verde y nadie se entera de que el vocabulario dejó de serlo.
   */
  it('⛔ y RECHAZA un origen inventado, con 23514', async () => {
    const ref = refVecinal('08', '2001-03-06', 9);
    await expect(
      tk.run((trx) => trx('finance.cash_ledger').insert(fila('cobro_inventado', ref))),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
