import knexFactory, { Knex } from 'knex';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
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
// Un año PASADO distinto por corrida: un corte es único por (sucursal, fecha), y desde `[CGP-L.4]`
// no se abre una fecha que todavía no pasa (la primera versión usaba años 2100+ y quedó inválida).
const ANIO = 1990 + Math.floor(Math.random() * 30);
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
  /**
   * El día siguiente al último corte de esa sucursal, y nunca antes del 2000-01-03.
   * ⚠️ El piso es a propósito: la prueba del sensor siembra días de la 00 ANTES de 1990 (un ancla y
   * jornadas sin corte). Sin el piso, esta prueba caía justo en esos días, absorbía sus movimientos,
   * no cuadraba y dejaba el corte abierto — trabando la 00 para todas las corridas siguientes.
   */
  async function diaDespuesDelUltimo(sucursal: string): Promise<string> {
    const r = await tk.run((trx) => trx.raw(
      `SELECT to_char(greatest(coalesce(max(fecha) + 1, date '2000-01-03'), date '2000-01-03'), 'YYYY-MM-DD') AS d
         FROM finance.cash_ledger_cuts WHERE sucursal = ?`, [sucursal]));
    return r.rows[0].d as string;
  }
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

  it('⛔ el arqueo ciego NO se salta: cerrar con otra cifra en la reja es un 400 con su frase', async () => {
    const f = dia('03-03');
    const c = await svc.abrir({ fecha: f, sucursal: suc('L3'), fondo_inicial: 500 }, CAJERA);
    await movimiento(f, suc('L3'), 'ingreso', 1000);
    await svc.contar(c.id, { conteo: conteo(['1000', 1000, 1], ['500', 500, 1]), morralla: 0 }, CAJERA);

    const tecleado = conteo(['1000', 1000, 1], ['500', 500, 1], ['100', 100, 3]);   // $1,800 ≠ $1,500 sellado
    // `[CGP-L.1]` Antes salía como error crudo de la base (un 500). Ahora el servicio lo decide ANTES
    // de escribir y la persona recibe qué está sellado, qué tecleó y cómo se corrige.
    await expect(svc.cerrar(c.id, { conteo: tecleado, morralla: 0 }, CAJERA)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.cerrar(c.id, { conteo: tecleado, morralla: 0 }, CAJERA))
      .rejects.toThrow(/ya está sellado en \$1,500\.00 y la reja trae \$1,800\.00/);

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
    // La 00 es una sola para todas las corridas: desde `[CGP-L.4]` las jornadas se abren EN ORDEN, así
    // que se pide a la base el día siguiente al último corte que ya tenga.
    const f = await diaDespuesDelUltimo('00');
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

  it('`[CGP-L.4]` un segundo corte de la misma sucursal y fecha: 400 que nombra el folio que ya existe', async () => {
    const f = dia('03-01');   // L1 ya tiene su corte de este día (primera prueba), cerrado y autorizado
    const existente = await tk.run((trx) => trx('finance.cash_ledger_cuts').where({ sucursal: suc('L1'), fecha: f }).first());
    await expect(svc.abrir({ fecha: f, sucursal: suc('L1') }, CAJERA)).rejects.toBeInstanceOf(BadRequestException);
    // Antes lo frenaba la base con una frase genérica (`[CGP-L.6]`, sigue de respaldo); ahora la regla
    // lo decide antes y dice CUÁL corte ya existe.
    await expect(svc.abrir({ fecha: f, sucursal: suc('L1') }, CAJERA)).rejects.toThrow(existente.folio);
  });

  it('⛔ `[CGP-L.4]` una fecha que todavía no pasa NO se abre', async () => {
    await expect(svc.abrir({ fecha: '2999-01-01', sucursal: suc('L8') }, CAJERA))
      .rejects.toThrow(/todavía no pasa/);
  });

  it('⛔ `[CGP-L.4]` un día ANTERIOR a un corte que ya existe NO se abre: las jornadas se cierran en orden', async () => {
    // L1 tiene corte el 03-01; el 02-28 es anterior.
    await expect(svc.abrir({ fecha: dia('02-28'), sucursal: suc('L1') }, CAJERA))
      .rejects.toThrow(/Las jornadas se cierran en orden/);
  });

  it('`[CGP-L.4]` las jornadas pendientes: días con movimientos y sin corte, para ofrecerlos en la pantalla', async () => {
    // Un día de L9 no aplica (la consulta es del cajón de la 00); se siembra en la 00 con un ancla
    // cerrada ANTES de todo lo demás de la 00, y un movimiento al día siguiente sin corte.
    const ancla = `${ANIO - 1000}-05-10`;            // ~1000 años atrás: antes de cualquier corte de prueba
    const pendiente = `${ANIO - 1000}-05-11`;
    await tk.run(async (trx) => {
      await trx('finance.cash_ledger_cuts').insert({
        tenant_id: T, folio: `CC-ANCLA-L4-${ANIO}`, fecha: ancla, sucursal: '00', estado: 'cerrado',
        fondo_inicial: 0, fondo_origen: 'contado', esperado: 0, contado: 0, diferencia: 0,
        created_by: CAJERA.id, closed_by: CAJERA.id, closed_at: trx.fn.now(),
      });
    });
    await movimiento(pendiente, '05', 'gasto', 50);
    const r = await svc.jornadasPendientes('00');
    expect(r.jornadas).toEqual(expect.arrayContaining([{ fecha: pendiente, movimientos: 1 }]));
    expect(r.jornadas.map((j) => j.fecha)).not.toContain(ancla);
    expect(r.hoy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('`[CGP-L.4]` el saldo publica la FECHA del corte abierto: el diálogo tiene que decir qué jornada cierra', async () => {
    const f = dia('03-09');
    const c = await svc.abrir({ fecha: f, sucursal: suc('L9'), fondo_inicial: 0 }, CAJERA);
    const s = await svc.saldo(suc('L9'), true);
    expect(s.corte_abierto).toMatchObject({ id: c.id, folio: c.folio, fecha: f });
  });

  it('⛔ `[CGP-L.2]` lo que se firma es lo que se reveló: si el esperado cambió después de contar, 409', async () => {
    const f = dia('03-06');
    const c = await svc.abrir({ fecha: f, sucursal: suc('L6'), fondo_inicial: 500 }, CAJERA);
    await movimiento(f, suc('L6'), 'ingreso', 1000);
    await svc.contar(c.id, { conteo: conteo(['1000', 1000, 1], ['500', 500, 1]), morralla: 0 }, CAJERA);   // reveló $1,500

    await movimiento(f, suc('L6'), 'ingreso', 300);   // se capturó tarde: ahora el esperado da $1,800
    await expect(svc.cerrar(c.id, {}, CAJERA)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.cerrar(c.id, {}, CAJERA))
      .rejects.toThrow(/se mostró \$1,500\.00 y ahora da \$1,800\.00/);
    // Y con DATOS, para que la pantalla ofrezca confirmar sin recalcular nada por su cuenta.
    await expect(svc.cerrar(c.id, {}, CAJERA)).rejects.toMatchObject({
      response: { motivo: 'esperado_cambio', esperado_mostrado: 1500, esperado_actual: 1800 },
    });
    expect((await corte(c.id)).estado).toBe('borrador');   // no firmó nada

    // Quien ya vio el esperado nuevo lo confirma, y entonces sí cierra: falta $300, a la vista.
    const cerrado = await svc.cerrar(c.id, { esperado_visto: 1800 }, CAJERA);
    expect(cerrado.estado).toBe('cerrado');
    expect(Number(cerrado.esperado)).toBe(1800);
    expect(Number(cerrado.diferencia)).toBe(-300);
  });

  it('⛔ `[CGP-L.3]` recontar sin un conteo previo no existe, y se dice en palabras', async () => {
    const f = dia('03-07');
    const c = await svc.abrir({ fecha: f, sucursal: suc('L7'), fondo_inicial: 500 }, CAJERA);
    await expect(svc.recontar(c.id, {
      conteo: conteo(['500', 500, 1]), morralla: 0, motivo: 'Recontar algo que nunca se contó',
    }, CAJERA)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.recontar(c.id, {
      conteo: conteo(['500', 500, 1]), morralla: 0, motivo: 'Recontar algo que nunca se contó',
    }, CAJERA)).rejects.toThrow('Todavía no hay un conteo que recontar');
  });
});
