import knexFactory, { Knex } from 'knex';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { CanActivate, ExecutionContext, ForbiddenException, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  PERMISSIONS_KEY, Permission, RolesGuard, TenantContextService, TenantKnexService,
} from '@megadulces/platform-core';
import { CashLedgerController } from './cash-ledger.controller';
import { CashLedgerService } from './cash-ledger.service';
import { CashCutService } from './cash-cut.service';
import { CajaAutofillService } from './caja-autofill.service';
import { CajaFechaFuturaScannerService } from './caja-fecha-futura-scanner.service';
import { CajaAutollenadoService } from './caja-autollenado.service';
import { sqlDisponibleCaos } from './caja-custodia.service';
import { TEXTO_ORIGEN } from './caja-custodia.engine';

/**
 * ⭐⭐ `[CGA-A.56.1]` **El egreso dice de dónde salió el dinero: `POST /finance/cash-ledger` contra
 * Postgres, con el cuerpo de la pantalla.**
 *
 * Regla 13: un endpoint que escribe no está probado hasta que una prueba lo ejerció contra una base
 * real con el payload de la pantalla. `[CGA-A.56]` se dio por cerrado con 30 pruebas del motor y 456
 * de la pantalla, y NINGUNA pasaba por `create()` con `origen_efectivo` ni con un enlace parcial: la
 * única `-real` que toca `caos_cash_links` (`caja-custodia.servicio-real`) escribe directo en la
 * tabla. Es el mismo patrón que escondió 8 días el 500 de `contar()`.
 *
 * Ejerce el controlador real → `createTraducido` → `create`, conectado como `app_runtime`, con el
 * cuerpo que arma `guardar()` de `finanzas-caja-general.component.ts` en los casos de su propia
 * prueba («con dos retiros…»: un gasto de $1,300 con retiros de $1,000 y $5,000 → `caos_links`
 * 1,000 y 300, que es lo que calcula `linksDeEgreso`; y «Cajón» sin enlaces). Las dos pruebas juntas
 * cubren pantalla → cuerpo y cuerpo → base.
 *
 * ── Lo que esta prueba NO ejerce, declarado ─────────────────────────────────────────────────
 * ⛔ El catálogo contable: `resolveConcept` lee `analytics.v_kepler_conceptos`, que vive sobre el ODS
 *    y la base de caja no trae (el mismo hueco que declara `caja-vecinal-real`). Se reemplaza SÓLO
 *    esa lectura, y se comprueba que le llegó el par que mandó la pantalla.
 * ⛔ El candado de captura (`[CGS.14]`) se apaga con su propio interruptor, como en
 *    `caja-firma.servicio-real`: la base acumula jornadas sin corte de las otras pruebas.
 * ⛔ `RolesGuard` y el JWT: un guardia que lee la MISMA metadata de los decoradores (el patrón de
 *    `cash-ledger.http-real`). Comprueba el cableado ruta → permiso, no la resolución de permisos.
 * ⛔ Sucursal, equipo de CAOS y año son propios de la corrida (la pantalla manda la caja, '00'):
 *    `test-newdb-cash-ledger-cuts` mide el saldo corrido de la 00 en absoluto (`[CGP-D.2c]`).
 * ⛔ El lote y el autollenado (`crearLote`) no mandan `origen_efectivo`: no se ejercen acá.
 *
 * ── Probada en ROJO (2026-10-26, base del preparador en `pgvector:pg18` desechable, en UTC) ──
 * Correcta: 7 ✓. `create()` sin escribir el origen → 2 ✗ (los dos gastos que lo declaran) ·
 * `trg_caos_link_no_excede` apagado → 2 ✗ (el retiro que ya no alcanza y el retiro entero) · sin la
 * columna (código por delante de su migración: `create()` guarda SIN origen y contesta 201) → 3 ✗ ·
 * «cajón» con retiros aceptado → 1 ✗ · el freno ignora `CAJA_EGRESO_ORIGEN_DESDE` → 1 ✗ · la ruta sin
 * `@RequirePermissions` → 1 ✗ (201 donde iba 403).
 *
 * Sin `CAJA_TEST_DB_URL` se SALTA y lo dice. Escribe y no deshace (el servicio confirma sus
 * transacciones): sólo contra una base de prueba.
 *
 *     CAJA_TEST_DB_URL=postgresql://app_runtime:app_runtime@127.0.0.1:5432/postgres_platform \
 *       npx vitest run --config libs/finance/vitest.config.ts libs/finance/src/lib/caja/cash-ledger.origen-efectivo.http-real.spec.ts
 */
const URL = process.env['CAJA_TEST_DB_URL'];
const T = '00000000-0000-0000-0000-00000000d01c';
const CORRIDA = Date.now().toString(36);
const DEV = `ORIG-${CORRIDA}`;
const SUC = `OE-${CORRIDA}`;
/** Un año propio (la custodia usa 1300–1899; la firma, 1987; la prueba HTTP del corte, 2001+). */
const ANIO = 1000 + Math.floor(Math.random() * 300);
const DIA = `${ANIO}-05-20`;
const RUTA = '/finance/cash-ledger';

type UsuarioDePrueba = {
  id: string; username: string; role_name: string; permissions: Record<string, boolean>;
};
const CAPTURA: UsuarioDePrueba = {
  id: '00000000-0000-0000-0000-0000000000e5', username: 'captura_origen', role_name: 'cajero',
  permissions: { [Permission.FINANCE_CAJA_VER]: true, [Permission.FINANCE_CAJA_GESTIONAR]: true },
};
const SOLO_VE: UsuarioDePrueba = {
  id: '00000000-0000-0000-0000-0000000000e6', username: 'mira_origen', role_name: 'consulta',
  permissions: { [Permission.FINANCE_CAJA_VER]: true },
};
let actual: UsuarioDePrueba = CAPTURA;

/** El guardia de la prueba: lee la metadata REAL de `@RequirePermissions`, como `cash-ledger.http-real`. */
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
 * ⚠️ Vitest no emite `design:paramtypes`: sin esto Nest arma el controlador con sus dependencias en
 * `undefined` (medido en `cash-ledger.http-real`). El orden es el del constructor real; si cambia,
 * esto falla ruidosamente en vez de inyectar el servicio equivocado.
 */
Reflect.defineMetadata(
  'design:paramtypes',
  [CashLedgerService, CajaAutofillService, CashCutService, CajaFechaFuturaScannerService, CajaAutollenadoService],
  CashLedgerController,
);

type Billete = { denom_key: string; denominacion: number; piezas: number };
type Enlace = { device: string; external_id: number; monto: number; senales: Record<string, unknown> };
const billete = (valor: number, piezas: number): Billete => ({ denom_key: String(valor), denominacion: valor, piezas });
/** Las señales con que la pantalla vincula un candidato (`vincularCaos`). */
const SENALES = { score: 90, confianza: 'alta', motivos: ['mismo día'] };
const enlace = (external_id: number, monto: number): Enlace => ({ device: DEV, external_id, monto, senales: SENALES });

/**
 * El cuerpo que arma `guardar()` para un EGRESO capturado a mano (sin documento de Kepler ni
 * movimiento de CAOS elegido): el formulario (`formVacio` + lo tecleado), el arqueo con su `flujo`,
 * el motivo de «sin documento», los retiros que lo pagaron y el origen. Lo `undefined` no viaja por
 * JSON, igual que desde el navegador.
 */
function cuerpoDeLaPantalla(o: {
  monto: number; billetes: Billete[]; origen_efectivo?: 'caos' | 'cajon'; caos_links?: Enlace[];
}) {
  return {
    tipo: 'gasto', fecha: DIA, sucursal: SUC,
    kepler_cuenta: '601-001', kepler_concepto: 'PAPELERIA',
    glosa: 'pago con el retiro de la semana', beneficiario: '', monto: o.monto, morralla: 0,
    denominaciones: o.billetes.map((d) => ({ ...d, flujo: 'recibido' as const })),
    origen_tipo: null, origen_ref: null, declared_doc_ref: undefined,
    sin_documento_motivo: 'pago en efectivo sin documento en Kepler',
    monto_contado: undefined, firma_solicitud_id: undefined, firma_png: undefined, firma_nombre: undefined,
    venta_credito: undefined,
    caos_links: o.caos_links,
    origen_efectivo: o.origen_efectivo,
    autofill: null,
    client_uuid: randomUUID(),
  };
}

if (!URL) {
  console.warn('[CGA-A.56.1] NO MEDIDO: sin CAJA_TEST_DB_URL no hay base contra la cual ejercer el origen del egreso.');
}

describe.skipIf(!URL)('[CGA-A.56.1] el egreso dice de dónde salió el dinero — POST /finance/cash-ledger contra Postgres', () => {
  let knex: Knex;
  let tk: TenantKnexService;
  let app: INestApplication;
  let http: () => request.Agent;
  let n = 0;
  /** La ÚNICA lectura reemplazada: el catálogo de Kepler (ver el encabezado). */
  const catalogo = vi.fn().mockResolvedValue(
    { concepto_nombre: 'Papelería (catálogo de la prueba)', cuenta_nombre: 'Gastos de la prueba' });
  const antes: Record<string, string | undefined> = {};

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 4 } });
    const ctx = { requireTenantId: () => T } as unknown as TenantContextService;
    tk = new TenantKnexService(knex, ctx);
    const libro = new CashLedgerService(tk, ctx);
    (libro as unknown as { resolveConcept: typeof catalogo }).resolveConcept = catalogo;

    for (const k of ['CAJA_CANDADO_CAPTURA', 'CAJA_EGRESO_ORIGEN_DESDE']) antes[k] = process.env[k];
    process.env['CAJA_CANDADO_CAPTURA'] = 'off';
    // El freno del origen, como en prod: APAGADO. La prueba que lo prende lo prende ella.
    delete process.env['CAJA_EGRESO_ORIGEN_DESDE'];

    const mod = await Test.createTestingModule({
      controllers: [CashLedgerController],
      providers: [
        { provide: TenantKnexService, useValue: tk },
        { provide: TenantContextService, useValue: ctx },
        { provide: CashLedgerService, useValue: libro },
        // No participan del alta: vacíos a propósito, para que una ruta que los empiece a usar
        // falle de forma ruidosa en vez de probarse a medias.
        { provide: CajaAutofillService, useValue: {} },
        { provide: CashCutService, useValue: {} },
        { provide: CajaFechaFuturaScannerService, useValue: {} },
        { provide: CajaAutollenadoService, useValue: {} },
      ],
    })
      .overrideGuard(RolesGuard).useValue(new GuardiaDePrueba(new Reflector()))
      .compile();
    app = mod.createNestApplication();
    await app.init();
    http = () => request(app.getHttpServer());
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(antes)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await app?.close();
    await knex?.destroy();
  });

  /** Un retiro (Dispensar) de CAOS, del equipo y el día de la corrida. */
  const retiro = (total: number) => tk.run(async (trx) => {
    const external_id = 9_100_000 + (n += 1);
    await trx('analytics.caos_cash_movements').insert({
      tenant_id: T, device: DEV, external_id, type_id: 4, type_label: 'Dispensar',
      occurred_at: trx.raw(`((?::date) + interval '12 hours') AT TIME ZONE 'America/Mexico_City'`, [DIA]),
      accounting_date: DIA, user_external: 'Prueba (003)', total, ref: 'pagos semana', _row_hash: `orig-${CORRIDA}-${n}`,
    });
    return external_id;
  });
  /** Lo que al retiro le QUEDA, con la misma expresión con que la pantalla los ofrece (`sqlDisponibleCaos`). */
  const queda = (external_id: number) => tk.run(async (trx) => {
    const r = await trx.raw(`SELECT ${sqlDisponibleCaos('m')} AS disponible FROM analytics.caos_cash_movements m
      WHERE m.tenant_id = ? AND m.device = ? AND m.external_id = ?`, [T, DEV, external_id]);
    return Number(r.rows[0].disponible);
  });
  const movimiento = (id: string) => tk.run(async (trx) => trx('finance.cash_ledger')
    .where({ tenant_id: T, id }).first('tipo', 'monto', 'origen_efectivo', 'kepler_cuenta', 'kepler_concepto', 'created_by'));
  const enlacesDe = (id: string) => tk.run(async (trx) => {
    const filas: Array<{ caos_device: string; caos_external_id: string; monto_enlazado: string; confirmed_by: string }> =
      await trx('finance.caos_cash_links').where({ tenant_id: T, cash_ledger_id: id }).whereNull('deleted_at')
        .orderBy('caos_external_id').select('caos_device', 'caos_external_id', 'monto_enlazado', 'confirmed_by');
    return filas.map((k) => ({
      device: k.caos_device, external_id: Number(k.caos_external_id), monto: Number(k.monto_enlazado), por: k.confirmed_by,
    }));
  });
  const billetesDe = (id: string) => tk.run(async (trx) => {
    const filas: Array<{ denom_key: string; piezas: number | string; flujo: string }> =
      await trx('finance.cash_ledger_denominations').where({ tenant_id: T, cash_ledger_id: id })
        .orderBy('denom_key').select('denom_key', 'piezas', 'flujo');
    return filas.map((d) => ({ denom_key: d.denom_key, piezas: Number(d.piezas), flujo: d.flujo }));
  });
  /** ¿Quedó algo escrito con ese `client_uuid`? */
  const escritos = (uuid: string) => tk.run(async (trx) => {
    const r = await trx.raw('SELECT count(*)::int AS n FROM finance.cash_ledger WHERE tenant_id = ? AND client_uuid = ?', [T, uuid]);
    return Number(r.rows[0].n);
  });
  /** El consecutivo de folios de gasto del año de la corrida (es sólo de esta prueba). */
  const consecutivo = () => tk.run(async (trx) => {
    const r = await trx.raw(`SELECT coalesce(max(current_value), 0)::int AS n FROM finance.cash_ledger_sequences
      WHERE tenant_id = ? AND year = ? AND tipo = 'gasto'`, [T, ANIO]);
    return Number(r.rows[0].n);
  });

  it('⭐ un gasto de $1,300 con dos retiros: toma 1,000 del primero y 300 del segundo, y al segundo le QUEDAN 4,700', async () => {
    actual = CAPTURA;
    const r1 = await retiro(1000);
    const r2 = await retiro(5000);
    const cuerpo = cuerpoDeLaPantalla({
      monto: 1300, billetes: [billete(500, 2), billete(100, 3)],
      origen_efectivo: 'caos', caos_links: [enlace(r1, 1000), enlace(r2, 300)],
    });

    const res = await http().post(RUTA).send(cuerpo).expect(201);
    // Lo que vuelve a la pantalla.
    expect(res.body.origen_efectivo).toBe('caos');
    expect(Number(res.body.monto)).toBe(1300);

    // Lo que quedó en la base: el origen, quién capturó, y el par que mandó la pantalla.
    expect(await movimiento(res.body.id)).toMatchObject({
      tipo: 'gasto', origen_efectivo: 'caos', kepler_cuenta: '601-001', kepler_concepto: 'PAPELERIA', created_by: CAPTURA.id,
    });
    expect(catalogo).toHaveBeenCalledWith(expect.anything(), T, SUC, '601-001', 'PAPELERIA');
    // Los dos pedazos, cada uno por lo que el gasto necesitó — no el retiro entero.
    expect(await enlacesDe(res.body.id)).toEqual([
      { device: DEV, external_id: r1, monto: 1000, por: CAPTURA.id },
      { device: DEV, external_id: r2, monto: 300, por: CAPTURA.id },
    ]);
    // Al primero no le queda nada; el segundo sigue ofreciéndose con lo que le queda.
    expect(await queda(r1)).toBe(0);
    expect(await queda(r2)).toBe(4700);
    // El arqueo del gasto son SUS billetes: los del retiro no se copian (`[CGA-A.56]`).
    expect(await billetesDe(res.body.id)).toEqual([
      { denom_key: '100', piezas: 3, flujo: 'recibido' },
      { denom_key: '500', piezas: 2, flujo: 'recibido' },
    ]);
  });

  it('⭐ lo que le quedó al retiro paga OTRO gasto; si una pantalla vieja pide más de lo que queda, la base lo frena y no queda NADA escrito', async () => {
    actual = CAPTURA;
    const r = await retiro(5000);
    await http().post(RUTA).send(cuerpoDeLaPantalla({
      monto: 2000, billetes: [billete(500, 4)], origen_efectivo: 'caos', caos_links: [enlace(r, 2000)],
    })).expect(201);
    expect(await queda(r)).toBe(3000);

    // Otra pantalla, abierta antes del gasto de arriba, todavía cree que al retiro le quedan 5,000.
    const folioAntes = await consecutivo();
    const tarde = cuerpoDeLaPantalla({
      monto: 3500, billetes: [billete(500, 7)], origen_efectivo: 'caos', caos_links: [enlace(r, 3500)],
    });
    const rechazo = await http().post(RUTA).send(tarde).expect(400);
    expect(String(rechazo.body.message)).toMatch(/ya no alcanza/);
    expect(await escritos(tarde.client_uuid)).toBe(0);
    expect(await queda(r)).toBe(3000);
    // Ni el folio avanzó: la transacción se deshizo entera (folio, movimiento, billetes y enlaces).
    expect(await consecutivo()).toBe(folioAntes);

    // Y lo que de verdad le queda, sí se toma: hasta agotarlo.
    await http().post(RUTA).send(cuerpoDeLaPantalla({
      monto: 3000, billetes: [billete(500, 6)], origen_efectivo: 'caos', caos_links: [enlace(r, 3000)],
    })).expect(201);
    expect(await queda(r)).toBe(0);
  });

  it('⛔ el retiro ENTERO pegado a un gasto chico (lo que hacía la pantalla antes de `[CGA-A.56]`) no se guarda', async () => {
    actual = CAPTURA;
    const r = await retiro(5000);
    const cuerpo = cuerpoDeLaPantalla({
      monto: 1300, billetes: [billete(500, 2), billete(100, 3)], origen_efectivo: 'caos', caos_links: [enlace(r, 5000)],
    });
    const res = await http().post(RUTA).send(cuerpo).expect(400);
    expect(String(res.body.message)).toMatch(/pasa del monto de este movimiento/);
    expect(await escritos(cuerpo.client_uuid)).toBe(0);
    expect(await queda(r)).toBe(5000);
  });

  it('⭐ un gasto que salió del cajón lo dice, y no enlaza ningún retiro', async () => {
    actual = CAPTURA;
    const cuerpo = cuerpoDeLaPantalla({ monto: 100, billetes: [billete(100, 1)], origen_efectivo: 'cajon' });
    expect(cuerpo.caos_links).toBeUndefined();   // «Cajón» suelta los retiros: la pantalla no manda enlaces
    const res = await http().post(RUTA).send(cuerpo).expect(201);
    expect(res.body.origen_efectivo).toBe('cajon');
    expect(await movimiento(res.body.id)).toMatchObject({ tipo: 'gasto', origen_efectivo: 'cajon' });
    expect(await enlacesDe(res.body.id)).toEqual([]);
    expect(await billetesDe(res.body.id)).toEqual([{ denom_key: '100', piezas: 1, flujo: 'recibido' }]);
  });

  it('⛔ es uno u otro: «Cajón» con retiros, o «Retiro de CAOS» sin retiro, no se guardan (400 con su frase)', async () => {
    actual = CAPTURA;
    const r = await retiro(800);
    const cajonConRetiro = cuerpoDeLaPantalla({
      monto: 500, billetes: [billete(500, 1)], origen_efectivo: 'cajon', caos_links: [enlace(r, 500)],
    });
    expect((await http().post(RUTA).send(cajonConRetiro).expect(400)).body.message).toBe(TEXTO_ORIGEN.cajon_con_retiros);
    const caosSinRetiro = cuerpoDeLaPantalla({ monto: 500, billetes: [billete(500, 1)], origen_efectivo: 'caos' });
    expect((await http().post(RUTA).send(caosSinRetiro).expect(400)).body.message).toBe(TEXTO_ORIGEN.caos_sin_retiro);
    expect(await escritos(cajonConRetiro.client_uuid)).toBe(0);
    expect(await escritos(caosSinRetiro.client_uuid)).toBe(0);
    expect(await queda(r)).toBe(800);
  });

  it('⛔ con el freno prendido (`CAJA_EGRESO_ORIGEN_DESDE`) un egreso sin origen no entra; antes del día de arranque sí, y queda NULL', async () => {
    actual = CAPTURA;
    process.env['CAJA_EGRESO_ORIGEN_DESDE'] = `${ANIO}-05-01`;
    try {
      // Sin origen: lo que hoy mandan el lote y el autollenado.
      const sinOrigen = cuerpoDeLaPantalla({ monto: 200, billetes: [billete(200, 1)] });
      expect((await http().post(RUTA).send(sinOrigen).expect(400)).body.message).toBe(TEXTO_ORIGEN.falta_origen);
      expect(await escritos(sinOrigen.client_uuid)).toBe(0);

      const anterior = { ...cuerpoDeLaPantalla({ monto: 200, billetes: [billete(200, 1)] }), fecha: `${ANIO}-04-30` };
      const ok = await http().post(RUTA).send(anterior).expect(201);
      // Lo que no se dijo queda NULL: no se inventa un origen.
      expect(await movimiento(ok.body.id)).toMatchObject({ origen_efectivo: null });
    } finally {
      delete process.env['CAJA_EGRESO_ORIGEN_DESDE'];
    }
  });

  it('⛔ quien sólo tiene VER no registra un egreso: 403 que nombra el permiso, y nada escrito', async () => {
    actual = SOLO_VE;
    try {
      const cuerpo = cuerpoDeLaPantalla({ monto: 100, billetes: [billete(100, 1)], origen_efectivo: 'cajon' });
      const r = await http().post(RUTA).send(cuerpo).expect(403);
      expect(String(r.body.message)).toContain(Permission.FINANCE_CAJA_GESTIONAR);
      expect(await escritos(cuerpo.client_uuid)).toBe(0);
    } finally {
      actual = CAPTURA;
    }
  });
});
