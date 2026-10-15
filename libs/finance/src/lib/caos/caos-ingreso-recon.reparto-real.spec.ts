import knexFactory, { Knex } from 'knex';
import { diaDeFecha } from '@megadulces/contracts';
import {
  repartirIngresosCaos, resumirReparto, CaosFechaIlegibleError,
  type CobroDisponible, type DepositoCaos,
} from '../caja/caja-caos-ingreso.engine';

/**
 * ⭐⭐ `[CG.162]` **El reparto de ingresos de CAOS, contra las filas REALES y el driver REAL.**
 *
 * ── Por qué esta prueba existe ──────────────────────────────────────────────────────────────
 *
 * `caja-caos-ingreso.engine.spec.ts` estaba verde con 12 casos mientras producción declaraba
 * **755 depósitos / $18,500,100 «sin respaldo»** y el cron `caos_ingreso_conciliar` latía en
 * `error` cada hora. Las dos cosas eran ciertas a la vez porque esas pruebas alimentan
 * `fecha: '2026-09-09'` —strings ya limpios— y el defecto vivía en el paso que convierte la fila
 * del driver en ese string: `String(r.fecha_valor).slice(0, 10)` sobre una columna `date`, que
 * node-pg entrega como objeto `Date`, daba `"Wed May 27"`.
 *
 * Una prueba con datos de laboratorio no puede ver un defecto de adaptador. Ésta sí: arma los
 * cobros **con la misma línea que usa el servicio** y los pasa al motor de verdad.
 *
 * ── Cómo se corre ───────────────────────────────────────────────────────────────────────────
 *
 *     CAOS_REAL_DB_URL=postgresql://…  npx vitest run --config libs/finance/vitest.config.ts \
 *       libs/finance/src/lib/caos/caos-ingreso-recon.reparto-real.spec.ts
 *
 * ⛔ **Sólo SELECT.** No inserta, no borra y no llama a `conciliar()` (que sí escribe), así que
 * es seguro apuntarla a producción para medir — que es como se verificó el arreglo. Sin la
 * variable se salta y lo DECLARA: un `skip` silencioso se lee como un aprobado.
 */
const URL = process.env.CAOS_REAL_DB_URL;
const T = '00000000-0000-0000-0000-00000000d01c';
const PISO = '2026-05-27'; // el primer depósito que existe; el mismo piso que usa el servicio

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[CG.162] NO MEDIDO: sin CAOS_REAL_DB_URL no hay filas reales contra las cuales ejercer el reparto.');
}

describe.skipIf(!URL)('[CG.162] el reparto de ingresos de CAOS contra filas reales', () => {
  let knex: Knex;
  let depositos: DepositoCaos[];
  let cobros: CobroDisponible[];
  let crudoFechaValor: unknown;

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 2 } });

    depositos = (await knex('analytics.caos_cash_movements as m')
      .where('m.tenant_id', T)
      .where('m.type_id', 0)
      .whereRaw('m.occurred_at::date >= ?', [PISO])
      .orderBy('m.occurred_at', 'asc').orderBy('m.external_id', 'asc')
      .select('m.device', 'm.external_id', 'm.occurred_at', 'm.total'))
      .map((r: any) => ({
        device: r.device,
        external_id: Number(r.external_id),
        occurred_at: new Date(r.occurred_at).toISOString(),
        total: Number(r.total),
      }));

    const filas = await knex('finance.v_caja_movimientos_pendientes as k')
      .where('k.tenant_id', T)
      .where('k.tipo', 'ingreso')
      .where('k.fecha_valor', '>=', PISO)
      .orderBy('k.fecha_valor', 'asc').orderBy('k.origen_ref', 'asc')
      .select('k.origen_ref', 'k.fecha_valor', 'k.monto');

    crudoFechaValor = filas[0]?.fecha_valor;
    // ⭐ La MISMA línea del servicio. Si alguien la cambia por un `String(...).slice(0,10)`,
    // esta prueba se pone roja antes de que el cron vuelva a acusar a nadie.
    cobros = filas.map((r: any) => ({
      origen_ref: r.origen_ref,
      fecha: diaDeFecha(r.fecha_valor) ?? r.fecha_valor,
      monto: Number(r.monto),
      consumido: 0,
    }));
  }, 60_000);

  afterAll(async () => { await knex?.destroy(); });

  it('⛔ node-pg devuelve `fecha_valor` como objeto Date — el supuesto que rompió todo', () => {
    expect(crudoFechaValor).toBeInstanceOf(Date);
    // Y así se veía lo que el motor comparaba antes del arreglo:
    expect(String(crudoFechaValor).slice(0, 10)).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('la línea del servicio normaliza TODOS los cobros a YYYY-MM-DD', () => {
    expect(cobros.length).toBeGreaterThan(0);
    const malas = cobros.filter((c) => !/^\d{4}-\d{2}-\d{2}$/.test(String(c.fecha)));
    expect(malas.slice(0, 3)).toEqual([]);
  });

  it('⭐ la ley se cumple: NINGÚN depósito real queda sin respaldo', () => {
    expect(depositos.length).toBeGreaterThan(0);
    const r = resumirReparto(repartirIngresosCaos(depositos, cobros));
    // eslint-disable-next-line no-console
    console.log(`[CG.162] ${r.depositos} depósitos · ${r.cubiertos} cubiertos · ${r.sin_respaldo} sin respaldo `
      + `· depositado $${r.monto_depositado} · respaldado $${r.monto_respaldado} `
      + `· sin depositar $${r.monto_sin_depositar}`);
    expect(r.sin_respaldo).toBe(0);
    expect(r.monto_respaldado).toBeCloseTo(r.monto_depositado, 2);
  });

  /**
   * El rojo a propósito, sobre las filas reales: se rehace el mapeo defectuoso y se comprueba
   * que **ya no puede pasar en silencio**. Antes devolvía un reparto con 100% «sin respaldo»;
   * ahora el motor se niega, que es la diferencia entre una acusación y un error.
   */
  it('⛔ el mapeo viejo sobre las MISMAS filas ya no devuelve un veredicto: grita', () => {
    const comoAntes = cobros.map((c) => ({ ...c, fecha: String(crudoFechaValor).slice(0, 10) }));
    expect(() => repartirIngresosCaos(depositos, comoAntes)).toThrow(CaosFechaIlegibleError);
  });
});
