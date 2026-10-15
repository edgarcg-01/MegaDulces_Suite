import knexFactory, { Knex } from 'knex';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CashCutService } from './cash-cut.service';

/**
 * `[CGP-L.0]` El SERVICIO REAL del corte —el mismo código que corre en prod— contra una base REAL.
 *
 * Por qué existe: del 12 al 14-oct entraron 33 arreglos de Caja General y cada uno destapó el
 * siguiente en producción. Las pruebas del servicio usaban dobles (mocks) y la de la base escribía
 * directo a la tabla: ninguna ejercía `abrir → contar → cerrar → autorizar` con el payload de la
 * pantalla. Esta sí, y además comprueba que el servicio convive con las reglas que la migración
 * `20261014212702` puso en la base (`[CGP-D.3]`).
 *
 * Base: la que arma `database/tests/caja/preparar-base-caja.js`. Conexión COMO `app_runtime`, el
 * rol de prod: con un superusuario RLS no se aplica y los permisos no se prueban.
 *
 *     CAJA_TEST_DB_URL=postgresql://app_runtime:app_runtime@127.0.0.1:5432/postgres_platform \
 *       npx vitest run --config libs/finance/vitest.config.ts libs/finance/src/lib/caja/cash-cut.servicio-real.spec.ts
 *
 * ⚠️ Sin `CAJA_TEST_DB_URL` se SALTA y lo dice: el job de pruebas del CI no tiene Postgres. Correrla
 *    contra una base que no sea de prueba está prohibido: escribe y no deshace (el servicio abre sus
 *    propias transacciones y las confirma).
 */
const URL = process.env.CAJA_TEST_DB_URL;
const T = '00000000-0000-0000-0000-00000000d01c';
const CAJERA = { id: '00000000-0000-0000-0000-0000000000c1', username: 'cajera_prueba' };
const AUTORIZA = { id: '00000000-0000-0000-0000-0000000000c2', username: 'autoriza_prueba' };
// Un año distinto por corrida: un corte es único por (sucursal, fecha), y así correrla dos veces
// sobre la misma base no choca con lo que dejó la anterior.
const ANIO = 2100 + Math.floor(Math.random() * 800);
const dia = (mmdd: string) => `${ANIO}-${mmdd}`;
// Y una sucursal distinta por corrida: sólo puede haber UN borrador por sucursal, sin importar la
// fecha, y la prueba del arqueo ciego deja el suyo abierto a propósito (es el cierre rechazado).
// Es el mismo mecanismo que trabó prod tres días: un borrador viejo bloquea los cortes que siguen.
const suc = (k: string) => `${k}-${ANIO}`;
const conteo = (...pares: Array<[string, number, number]>) =>
  pares.map(([denom_key, denominacion, piezas]) => ({ denom_key, denominacion, piezas }));

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[CGP-L.0] NO MEDIDO: sin CAJA_TEST_DB_URL no hay base contra la cual ejercer el servicio real del corte.');
}

describe.skipIf(!URL)('[CGP-L.0] el servicio REAL del corte contra Postgres', () => {
  let knex: Knex;
  let tk: TenantKnexService;
  let svc: CashCutService;
  let n = 0;

  beforeAll(() => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 4 } });
    const ctx = { requireTenantId: () => T } as unknown as TenantContextService;
    tk = new TenantKnexService(knex, ctx);
    svc = new CashCutService(tk, ctx);
  });
  afterAll(async () => {
    await knex?.destroy();
  });

  /** Un movimiento del libro, escrito directo: lo que se prueba acá es el CORTE, no la captura. */
  async function movimiento(fecha: string, sucursal: string, tipo: 'ingreso' | 'gasto', monto: number) {
    await tk.run((trx) => trx('finance.cash_ledger').insert({
      tenant_id: T, folio: `CGL-${ANIO}-${Date.now()}-${(n += 1)}`, tipo, fecha, sucursal,
      kepler_cuenta: '101-001', kepler_concepto: '001', glosa: 'Movimiento de prueba del servicio',
      monto, created_by: CAJERA.id,
    }));
  }
  const corte = (id: string) => tk.run((trx) => trx('finance.cash_ledger_cuts').where({ id }).first());
  const desglose = (id: string) => tk.run((trx) => trx('finance.cash_ledger_cut_denominations')
    .where({ cut_id: id, momento: 'cierre' }).select('denom_key', 'piezas'));

  it('abrir → contar → cerrar SIN teclear (lo que manda la pantalla al recargar) → autorizar', async () => {
    const f = dia('03-01');
    const c = await svc.abrir({ fecha: f, sucursal: suc('L1'), fondo_inicial: 500 }, CAJERA);
    await movimiento(f, suc('L1'), 'ingreso', 1000);

    const sellado = await svc.contar(c.id, { conteo: conteo(['1000', 1000, 1], ['500', 500, 1]), morralla: 0 }, CAJERA);
    expect(sellado.totales).toMatchObject({ esperado: 1500, contado: 1500, diferencia: 0, veredicto: 'cuadra' });

    const cerrado = await svc.cerrar(c.id, { conteo: [], morralla: 0 }, CAJERA);
    expect(cerrado.estado).toBe('cerrado');
    const fila = await corte(c.id);
    expect(Number(fila.contado)).toBe(1500);
    expect(Number(fila.diferencia)).toBe(0);
    expect((await desglose(c.id)).length).toBe(2);   // el desglose sellado sigue ahí, no se borró

    await expect(svc.autorizar(c.id, CAJERA)).rejects.toBeInstanceOf(ForbiddenException);
    const autorizado = await svc.autorizar(c.id, AUTORIZA);
    expect(autorizado.estado).toBe('autorizado');
  });

  it('cerrar con el MISMO conteo sellado en el cuerpo (lo que manda la pantalla sin recargar) también cierra', async () => {
    const f = dia('03-02');
    const c = await svc.abrir({ fecha: f, sucursal: suc('L2'), fondo_inicial: 500 }, CAJERA);
    await movimiento(f, suc('L2'), 'ingreso', 1000);
    const contado = conteo(['1000', 1000, 1], ['500', 500, 1]);
    await svc.contar(c.id, { conteo: contado, morralla: 0 }, CAJERA);
    const cerrado = await svc.cerrar(c.id, { conteo: contado, morralla: 0 }, CAJERA);
    expect(cerrado.estado).toBe('cerrado');
  });

  it('⛔ el arqueo ciego NO se salta: cerrar con otra cifra en la reja lo frena la base', async () => {
    const f = dia('03-03');
    const c = await svc.abrir({ fecha: f, sucursal: suc('L3'), fondo_inicial: 500 }, CAJERA);
    await movimiento(f, suc('L3'), 'ingreso', 1000);
    await svc.contar(c.id, { conteo: conteo(['1000', 1000, 1], ['500', 500, 1]), morralla: 0 }, CAJERA);

    const tecleado = conteo(['1000', 1000, 1], ['500', 500, 1], ['100', 100, 3]);   // $1,800 ≠ $1,500 sellado
    const intento = svc.cerrar(c.id, { conteo: tecleado, morralla: 0 }, CAJERA);
    await expect(intento).rejects.toMatchObject({ code: '23514', constraint: 'cut_conteo_sellado_chk' });
    // ⚠️ HOY sale como error crudo (un 500 en la API): `cerrar()` no lo traduce. `[CGP-L.1]`/`[CGP-L.6]`
    //    lo convierten en un 400 con su frase; cuando eso entre, esta aserción se invierte a propósito.
    await expect(svc.cerrar(c.id, { conteo: tecleado, morralla: 0 }, CAJERA))
      .rejects.not.toBeInstanceOf(BadRequestException);

    const fila = await corte(c.id);
    expect(fila.estado).toBe('borrador');            // nada quedó a medias
    expect(Number(fila.contado)).toBe(1500);          // y el conteo sellado sigue siendo el que se contó
  });

  it('recontar como lo hace la pantalla (dos UPDATE en la misma transacción) y después cerrar', async () => {
    const f = dia('03-04');
    const c = await svc.abrir({ fecha: f, sucursal: suc('L4'), fondo_inicial: 500 }, CAJERA);
    await movimiento(f, suc('L4'), 'ingreso', 1000);
    // Primer conteo con un billete de menos: falta $100, así que el reconteo está permitido.
    const primero = await svc.contar(c.id, { conteo: conteo(['1000', 1000, 1], ['200', 200, 2]), morralla: 0 }, CAJERA);
    expect(primero.totales.veredicto).toBe('falta');

    const re = await svc.recontar(c.id, {
      conteo: conteo(['1000', 1000, 1], ['500', 500, 1]), morralla: 0, motivo: 'Faltó contar el billete de 500',
    }, CAJERA);
    expect(re.totales).toMatchObject({ contado: 1500, veredicto: 'cuadra' });
    expect(re.conteo_previo_contado).toBe(1400);

    const cerrado = await svc.cerrar(c.id, {}, CAJERA);
    expect(cerrado.estado).toBe('cerrado');
    const fila = await corte(c.id);
    expect(Number(fila.contado)).toBe(1500);
    expect(fila.conteo_previo?.contado).toBe(1400);   // el primer conteo se conserva, con su motivo
  });

  it('`[CG.160]` el cajón de la 00 ata y suma lo que otras plazas pagaron desde él', async () => {
    const f = dia('03-05');
    const c = await svc.abrir({ fecha: f, sucursal: '00', fondo_inicial: 500 }, CAJERA);
    await movimiento(f, '00', 'ingreso', 1000);
    await movimiento(f, '05', 'gasto', 200);         // nómina de otra plaza, pagada desde este cajón
    const sellado = await svc.contar(c.id, { conteo: conteo(['1000', 1000, 1], ['200', 200, 1], ['100', 100, 1]), morralla: 0 }, CAJERA);
    expect(sellado.totales).toMatchObject({ esperado: 1300, veredicto: 'cuadra' });

    const cerrado = await svc.cerrar(c.id, {}, CAJERA);
    expect(Number(cerrado.esperado)).toBe(1300);      // el cierre mide el MISMO universo que el conteo
    const atados = await tk.run((trx) => trx('finance.cash_ledger').where({ corte_id: c.id }).count<{ n: string }[]>('* as n'));
    expect(Number(atados[0].n)).toBe(2);
  });

  it('un segundo corte de la misma sucursal y fecha lo frena la base', async () => {
    const f = dia('03-01');   // L1 ya tiene su corte de este día (primera prueba), cerrado y autorizado
    await expect(svc.abrir({ fecha: f, sucursal: suc('L1') }, CAJERA))
      .rejects.toMatchObject({ code: '23505', constraint: 'ux_cash_cut_sucursal_fecha' });
  });
});
