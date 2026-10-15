import knexFactory, { Knex } from 'knex';
import request from 'supertest';
import { CanActivate, ExecutionContext, ForbiddenException, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  PERMISSIONS_KEY, Permission, RolesGuard, TenantContextService, TenantKnexService,
} from '@megadulces/platform-core';
import { CashLedgerController } from './cash-ledger.controller';
import { CashCutService } from './cash-cut.service';
import { CashLedgerService } from './cash-ledger.service';
import { CajaAutofillService } from './caja-autofill.service';
import { CajaFechaFuturaScannerService } from './caja-fecha-futura-scanner.service';

/**
 * `[CGP-E.1b]` **EL PROCESO POR HTTP: lo que la pantalla realmente recibe.**
 *
 * `[CGP-E.1]` ejerce el mismo flujo a nivel de SERVICIO y el plan dejó esta capa pendiente «hasta
 * tener la API levantada en el CI». **No hace falta levantarla**: `@nestjs/testing` + `supertest`
 * arman la aplicación **en proceso** y le hablan por HTTP sin abrir un puerto ni construir nada.
 * Eso respeta la regla dura de `CLAUDE.md` —nada de `nx serve` ni `node dist/...`— y encima corre
 * en local y en el job `caja-db` con el mismo comando que el resto.
 *
 * ── Qué agrega sobre la prueba de servicio, MEDIDO con mutaciones ─────────────────────────────
 *  1. ⭐⭐ **Qué permiso declara cada ruta.** Es lo ÚNICO que ninguna capa de abajo puede ver: el
 *     servicio no sabe de permisos. Mutación: quitarle el `@RequirePermissions` a `POST cortes`
 *     → un usuario de sólo lectura **abre un corte** (201 donde iba 403). Es lo que `[CGP-V.6]`
 *     tuvo que leer a mano del controlador para saber qué botón apagar.
 *  2. **El código HTTP y la frase** de cada regla, tal como los recibe la pantalla: el 400 de
 *     `[CGP-L.1]`, y el 403 de la doble llave **con su motivo** y no el genérico del guardia —que
 *     es exactamente lo que `[CGP-V.5]` vino a arreglar.
 *  3. El pegamento del propio controlador: de dónde saca el usuario, la sucursal por omisión, el
 *     `body ?? {}`.
 *
 * ⛔ **Lo que NO aporta, y conviene decirlo porque lo medí:** la serialización de `[CGP-L.7]`. Acá
 * se afirma igual (el dinero como número, la jornada sin hora), pero **la prueba de servicio ya la
 * atrapa**: mutando `abrir()` para que devuelva la fila cruda, las dos se ponen rojas. El DTO
 * convierte antes de salir del servicio, así que esta capa lo confirma de punta a punta — no lo
 * descubre. *Una prueba nueva tiene que decir qué agrega, no suponerlo.*
 *
 * ── Lo que esta prueba NO ejerce, declarado ───────────────────────────────────────────────────
 * ⛔ `RolesGuard` **de verdad** no corre: resuelve los permisos contra `role_permissions` de la base
 * de IDENTIDAD, que la base de caja no trae (`preparar-base-caja.js` sólo arma el corte). Se
 * reemplaza por un guardia que lee **la misma metadata de los mismos decoradores** y la compara con
 * los permisos del usuario de la prueba: eso comprueba el CABLEADO ruta → permiso, no la resolución
 * de permisos. El guardia real tiene sus propias pruebas en `platform-core`.
 * ⛔ Tampoco corre la autenticación (JWT): el usuario se inyecta, como hace el guardia real al
 * poblar `req.user`.
 */
const URL = process.env.CAJA_TEST_DB_URL;
const T = '00000000-0000-0000-0000-00000000d01c';
const CORRIDA = Date.now().toString(36);

type UsuarioDePrueba = {
  id: string; username: string; role_name: string; permissions: Record<string, boolean>;
};
const CAPTURA: UsuarioDePrueba = {
  id: '00000000-0000-0000-0000-0000000000e1', username: 'captura_http', role_name: 'cajero',
  permissions: { [Permission.FINANCE_CAJA_VER]: true, [Permission.FINANCE_CAJA_GESTIONAR]: true },
};
const AUTORIZA: UsuarioDePrueba = {
  id: '00000000-0000-0000-0000-0000000000e2', username: 'autoriza_http', role_name: 'direccion',
  permissions: { [Permission.FINANCE_CAJA_VER]: true, [Permission.FINANCE_CAJA_AUTORIZAR]: true },
};
const SOLO_VE: UsuarioDePrueba = {
  id: '00000000-0000-0000-0000-0000000000e3', username: 'mira_http', role_name: 'consulta',
  permissions: { [Permission.FINANCE_CAJA_VER]: true },
};
/**
 * ⛔ **Hace falta alguien con LAS DOS llaves, y no es un detalle del andamio.**
 *
 * La primera versión de esta prueba ponía a la capturista a autorizar su propio corte y esperaba el
 * 403 de la doble llave. Llegó un 403, sí — pero **del permiso**: la capturista no tiene
 * `FINANCE_CAJA_AUTORIZAR`, así que el guardia la frena ANTES de que la regla del corte opine. La
 * prueba habría pasado sin ejercer la doble llave ni una vez.
 *
 * Para probarla, quien cierra tiene que **tener** el permiso de autorizar: entonces el único que
 * puede decir que no es la regla de negocio. Es el caso real de dirección, que captura y autoriza.
 */
const JEFE: UsuarioDePrueba = {
  id: '00000000-0000-0000-0000-0000000000e4', username: 'jefe_http', role_name: 'direccion',
  permissions: {
    [Permission.FINANCE_CAJA_VER]: true,
    [Permission.FINANCE_CAJA_GESTIONAR]: true,
    [Permission.FINANCE_CAJA_AUTORIZAR]: true,
  },
};

/** Quién manda la petición. Lo cambia cada prueba antes de llamar. */
let actual: UsuarioDePrueba = CAPTURA;

/**
 * El guardia de la prueba: **lee la metadata real** que ponen los `@RequirePermissions` del
 * controlador. Si una ruta deja de declarar su permiso, o declara otro, las pruebas de 403 se
 * caen — que es justo lo que tiene que vigilar.
 */
class GuardiaDePrueba implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    req.user = actual;
    const pedidos = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY, [ctx.getHandler(), ctx.getClass()],
    ) ?? [];
    const faltan = pedidos.filter((p) => actual.permissions[p] !== true);
    if (faltan.length) throw new ForbiddenException(`Faltan permisos: ${faltan.join(', ')}`);
    return true;
  }
}

/**
 * ⚠️ **Vitest no emite `design:paramtypes`**, y sin esa metadata Nest instancia el controlador con
 * los cuatro parámetros en `undefined`: `compile()` pasa igual (no hay dependencias declaradas que
 * resolver) y el primer `this.cortes.abrir` revienta con un 500 — medido antes de escribir esto.
 *
 * ⭐ Se declara acá, **en la prueba**, en vez de tocar la configuración compartida de vitest o de
 * meterle `@Inject` al controlador para que una prueba ande: el orden es el del constructor real y
 * si alguien lo cambia, esto falla ruidosamente en vez de inyectar el servicio equivocado.
 */
Reflect.defineMetadata(
  'design:paramtypes',
  [CashLedgerService, CajaAutofillService, CashCutService, CajaFechaFuturaScannerService],
  CashLedgerController,
);

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[CGP-E.1b] NO MEDIDO: sin CAJA_TEST_DB_URL no hay base contra la cual ejercer el proceso por HTTP.');
}

describe.skipIf(!URL)('[CGP-E.1b] el proceso del corte POR HTTP, contra Postgres', () => {
  let knex: Knex;
  let app: INestApplication;
  let tk: TenantKnexService;
  let http: () => request.Agent;
  const SUC = `H-${CORRIDA}`;
  let n = 0;

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 4 } });
    const ctx = { requireTenantId: () => T } as unknown as TenantContextService;
    tk = new TenantKnexService(knex, ctx);

    const mod = await Test.createTestingModule({
      controllers: [CashLedgerController],
      providers: [
        { provide: TenantKnexService, useValue: tk },
        { provide: TenantContextService, useValue: ctx },
        // Instanciado a mano por el mismo motivo que la metadata de arriba: el servicio REAL,
        // con el `TenantKnexService` real, sin depender de lo que el transpilador emita.
        { provide: CashCutService, useValue: new CashCutService(tk, ctx) },
        // Los otros tres no participan del corte: se declaran vacíos a propósito, para que una
        // ruta que empiece a usarlos falle de forma ruidosa en vez de probarse a medias.
        { provide: CashLedgerService, useValue: {} },
        { provide: CajaAutofillService, useValue: {} },
        { provide: CajaFechaFuturaScannerService, useValue: {} },
      ],
    })
      .overrideGuard(RolesGuard).useValue(new GuardiaDePrueba(new Reflector()))
      .compile();

    app = mod.createNestApplication();
    await app.init();
    http = () => request(app.getHttpServer());
  });

  afterAll(async () => {
    await app?.close();
    await knex?.destroy();
  });

  /** El día siguiente al último corte de esta sucursal: las jornadas se cierran en orden (`[CGP-L.4]`). */
  async function diaLibre(): Promise<string> {
    const r = await tk.run((trx) => trx.raw(
      `SELECT to_char(greatest(coalesce(max(fecha) + 1, date '2001-02-01'), date '2001-02-01'), 'YYYY-MM-DD') AS d
         FROM finance.cash_ledger_cuts WHERE sucursal = ?`, [SUC]));
    return r.rows[0].d as string;
  }

  async function movimiento(dia: string, tipo: 'ingreso' | 'gasto', monto: number) {
    await tk.run((trx) => trx('finance.cash_ledger').insert({
      tenant_id: T, folio: `CGH-${CORRIDA}-${(n += 1)}`, tipo, fecha: dia, sucursal: SUC,
      kepler_cuenta: '101-001', kepler_concepto: '001', glosa: 'Movimiento de la prueba HTTP',
      monto, created_by: CAPTURA.id,
      // `[CGP-L.12]` La jornada es la del efectivo.
      created_at: trx.raw(`((?::date) + interval '12 hours') AT TIME ZONE 'America/Mexico_City'`, [dia]),
    }));
  }

  it('abrir → contar → cerrar → autorizar, y lo que viaja es el CONTRATO (no la fila cruda)', async () => {
    const dia = await diaLibre();
    await movimiento(dia, 'ingreso', 1000);
    await movimiento(dia, 'gasto', 200);

    // Cierra el JEFE —que SÍ tiene el permiso de autorizar— para que el 403 de abajo sólo pueda
    // venir de la doble llave. Ver el porqué en la definición de `JEFE`.
    actual = JEFE;
    const abierto = await http()
      .post('/finance/cash-ledger/cortes')
      .send({ fecha: dia, sucursal: SUC, fondo_inicial: 500 })
      .expect(201);

    /**
     * `[CGP-L.7]` **De punta a punta: lo que sale por el cable.** Antes de L.7 el servidor devolvía
     * la fila cruda de Postgres: `fondo_inicial` llegaba como el texto `"500.00"` (el repo no fija
     * `setTypeParser`) y `fecha` como un `Date`, que por JSON viaja con hora.
     *
     * ⚠️ **No es exclusivo de esta capa**, y conviene no vendérselo así: mutando `abrir()` para que
     * devuelva la fila cruda, **también** se pone roja la prueba de servicio (el DTO convierte antes
     * de salir del servicio). Acá se confirma que nada entre el servicio y el JSON lo deshace.
     */
    expect(typeof abierto.body.fondo_inicial).toBe('number');
    expect(abierto.body.fondo_inicial).toBe(500);
    expect(abierto.body.fecha).toBe(dia);
    expect(abierto.body.fecha).not.toMatch(/T/);
    expect(abierto.body.estado).toBe('borrador');
    // Lo que no es del contrato no sale: el tenant no viaja al navegador.
    expect(abierto.body.tenant_id).toBeUndefined();

    const id = abierto.body.id as string;

    const contado = await http()
      .post(`/finance/cash-ledger/cortes/${id}/contar`)
      .send({ conteo: [{ denom_key: '1000', denominacion: 1000, piezas: 1 }, { denom_key: '200', denominacion: 200, piezas: 1 }, { denom_key: '100', denominacion: 100, piezas: 1 }], morralla: 0 })
      .expect(201);
    // 500 + 1000 − 200 = 1300
    expect(contado.body.totales).toMatchObject({ esperado: 1300, contado: 1300, veredicto: 'cuadra' });
    expect(typeof contado.body.totales.esperado).toBe('number');

    const cerrado = await http().post(`/finance/cash-ledger/cortes/${id}/cerrar`).send({}).expect(201);
    expect(cerrado.body.estado).toBe('cerrado');
    expect(typeof cerrado.body.esperado).toBe('number');
    expect(cerrado.body.esperado).toBe(1300);
    expect(cerrado.body.fecha).toBe(dia);

    /**
     * ⛔ **Doble llave POR HTTP.** `actual` sigue siendo el JEFE: pasa el permiso y lo frena la
     * REGLA. El servicio lanza y Nest lo traduce a 403.
     *
     * ⭐ Y la frase tiene que sobrevivir al viaje: `[CGP-V.5]` existe porque la pantalla traducía
     * todo 403 a «no tenés permiso» y se perdía el motivo real. Por eso se afirma que el mensaje
     * **no** es el del guardia: si algún día el permiso frenara antes, esta prueba lo dice en vez
     * de pasar en verde sin ejercer la regla.
     */
    const propio = await http().post(`/finance/cash-ledger/cortes/${id}/autorizar`).send().expect(403);
    expect(String(propio.body.message)).toMatch(/autoriz/i);
    expect(String(propio.body.message)).not.toMatch(/Faltan permisos/);

    actual = AUTORIZA;
    const autorizado = await http().post(`/finance/cash-ledger/cortes/${id}/autorizar`).send().expect(201);
    expect(autorizado.body.estado).toBe('autorizado');
    expect(autorizado.body.authorized_by_username).toBe(AUTORIZA.username);
  });

  it('⛔ `[CGP-L.1]` cerrar con otra cifra en la reja: 400 con la frase del sellado', async () => {
    const dia = await diaLibre();
    actual = CAPTURA;
    const { body: c } = await http()
      .post('/finance/cash-ledger/cortes').send({ fecha: dia, sucursal: SUC, fondo_inicial: 100 }).expect(201);
    await http().post(`/finance/cash-ledger/cortes/${c.id}/contar`)
      .send({ conteo: [{ denom_key: '100', denominacion: 100, piezas: 1 }], morralla: 0 }).expect(201);

    const r = await http().post(`/finance/cash-ledger/cortes/${c.id}/cerrar`)
      .send({ conteo: [{ denom_key: '500', denominacion: 500, piezas: 1 }], morralla: 0 }).expect(400);
    expect(String(r.body.message)).toMatch(/sellad/i);

    // Y el cuerpo vacío sí cierra, con lo sellado: la otra mitad de la regla.
    const ok = await http().post(`/finance/cash-ledger/cortes/${c.id}/cerrar`).send({}).expect(201);
    expect(ok.body.contado).toBe(100);
    actual = AUTORIZA;
    await http().post(`/finance/cash-ledger/cortes/${ok.id ?? c.id}/autorizar`).send().expect(201);
  });

  it('⛔ quien sólo tiene VER no abre un corte: 403 que nombra el permiso que falta', async () => {
    actual = SOLO_VE;
    const dia = await diaLibre();
    const r = await http()
      .post('/finance/cash-ledger/cortes').send({ fecha: dia, sucursal: SUC, fondo_inicial: 1 }).expect(403);
    expect(String(r.body.message)).toContain(Permission.FINANCE_CAJA_GESTIONAR);
    // Y la lectura del mismo módulo sí le responde: el 403 es del permiso, no del módulo entero.
    await http().get('/finance/cash-ledger/cortes/jornadas-pendientes').expect(200);
  });
});
