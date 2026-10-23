import knexFactory, { Knex } from 'knex';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CajaFirmaService } from './caja-firma.service';
import { CashLedgerService } from './cash-ledger.service';

/**
 * ⭐⭐ `[CG.201]`/`[CG.202]` **La firma por teléfono contra Postgres real**, con el servicio que corre
 * en prod y el alta del movimiento que la consume. Regla 13: un endpoint que escribe no está
 * probado hasta que se ejerció contra base real con el payload de la pantalla.
 *
 * Los cinco escenarios del plan (`FASE_CG_FIRMA_TELEFONO_2026-10-23.md` §3, E2), cada uno termina
 * con la firma guardada UNA sola vez:
 *   (a) reinicio del API entre tomar y enviar → instancias NUEVAS del servicio entre paso y paso;
 *   (b) el teléfono vuelve después (bloqueo, sin red) → el mismo teléfono re-abre y firma;
 *   (c) se cae el socket de la PC / (d) la PC recarga → la PC lee el estado por id, sin socket;
 *   (e) doble toque en Enviar → dos envíos simultáneos, una sola firma.
 *
 * ⚠️ PRUEBA NEGATIVA (corrida el 2026-10-23, 8/8 verdes antes): anulando `decidirUsar` en
 * `tomarFirmaParaMovimiento`, se pone roja «una firma se usa UNA vez…» (1 de 8).
 *
 * Base: la de `database/tests/caja/preparar-base-caja.js`, conectada COMO `app_runtime` (con un
 * superusuario RLS no se aplica). Sin `CAJA_TEST_DB_URL` se SALTA y lo dice.
 *
 *     CAJA_TEST_DB_URL=postgresql://app_runtime:app_runtime@127.0.0.1:5432/postgres_platform \
 *       npx vitest run --config libs/finance/vitest.config.ts libs/finance/src/lib/caja/caja-firma.servicio-real.spec.ts
 */
const URL = process.env.CAJA_TEST_DB_URL;
const T = '00000000-0000-0000-0000-00000000d01c';
const CAJERA = { id: '00000000-0000-0000-0000-0000000000c1', username: 'cajera_firma' };
const CORRIDA = Date.now().toString(36);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8DwnwEJMCIIAAy7Afy0b3ZHAAAAAElFTkSuQmCC';
const TEL = `tel_${CORRIDA}_A`;
const OTRO = `tel_${CORRIDA}_B`;

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[CG.201] NO MEDIDO: sin CAJA_TEST_DB_URL no hay base contra la cual ejercer la firma por teléfono.');
}

/** El fallo que viaja en el cuerpo de la excepción, y su código HTTP. */
async function falla(p: Promise<unknown>): Promise<{ status: number; fallo: string }> {
  try { await p; } catch (e) {
    if (e instanceof HttpException) {
      const r = e.getResponse() as { fallo?: string };
      return { status: e.getStatus(), fallo: String(r?.fallo ?? '') };
    }
    throw e;
  }
  throw new Error('se esperaba un fallo y la llamada pasó');
}

describe.skipIf(!URL)('[CG.201] la firma por teléfono contra Postgres', () => {
  let knex: Knex;
  let ctx: TenantContextService;
  const jwt = new JwtService({ secret: `secreto-de-prueba-${CORRIDA}`, signOptions: { algorithm: 'HS256' } });
  let n = 0;

  /** Una instancia NUEVA cada vez: lo que sobrevive entre llamadas sólo puede estar en la base. */
  const nuevoServicio = () => new CajaFirmaService(new TenantKnexService(knex, ctx), ctx, jwt);
  const libro = () => new CashLedgerService(new TenantKnexService(knex, ctx), ctx);
  const contexto = (monto: number) => ({ tipo: 'gasto', monto, beneficiario: 'Proveedor de prueba', documento: `X-D-26 ${CORRIDA}` });

  /** El alta con el payload de la pantalla: gasto sin documento, sin clasificar, con el pedido. */
  const alta = (monto: number, solicitud: string | undefined, extra: Record<string, unknown> = {}) => libro().create({
    tipo: 'gasto',
    client_uuid: randomUUID(),
    fecha: '1987-04-15',
    sucursal: `FT-${CORRIDA}`,
    monto,
    kepler_cuenta: '',
    kepler_concepto: '',
    sin_clasificar_motivo: 'Prueba de la firma por teléfono',
    sin_documento_motivo: 'Prueba de la firma por teléfono [CG.202]',
    glosa: `Gasto de la prueba de firma ${CORRIDA}-${(n += 1)}`,
    beneficiario: 'Proveedor de prueba',
    firma_solicitud_id: solicitud,
    ...extra,
  } as never, CAJERA);

  const fila = (id: string) => new TenantKnexService(knex, ctx).run((trx) =>
    trx('finance.cash_signature_requests').where({ id }).first());

  // ⚠️ El candado de captura (`[CGS.14]`: no se captura con jornadas sin corte) es OTRA regla, con
  // sus propias pruebas. La base de prueba acumula jornadas abiertas de otras corridas y lo dispara;
  // acá se apaga con su propio interruptor para que lo único que se mida sea la firma.
  let candadoAntes: string | undefined;
  beforeAll(() => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 6 } });
    ctx = { requireTenantId: () => T } as unknown as TenantContextService;
    candadoAntes = process.env['CAJA_CANDADO_CAPTURA'];
    process.env['CAJA_CANDADO_CAPTURA'] = 'off';
  });
  afterAll(async () => {
    if (candadoAntes === undefined) delete process.env['CAJA_CANDADO_CAPTURA'];
    else process.env['CAJA_CANDADO_CAPTURA'] = candadoAntes;
    await knex?.destroy();
  });

  it('⭐ (a)(c)(d) de punta a punta, con el API "reiniciado" entre cada paso: la firma se guarda UNA vez', async () => {
    const pedido = await nuevoServicio().abrir(contexto(250), CAJERA);
    expect(pedido.token.split('.')).toHaveLength(3);

    // El teléfono abre el QR: ve SÓLO el contexto, y el pedido queda tomado por él.
    const vista = await nuevoServicio().verPorToken(pedido.token, TEL);
    expect(vista).toEqual({ estado: 'tomada', contexto: contexto(250) });
    expect((await nuevoServicio().estado(pedido.id)).estado).toBe('tomada');

    // Firma con OTRA instancia (el pod que lo tomó ya no existe).
    expect(await nuevoServicio().firmarPorToken(pedido.token, TEL, PNG, ' Juan Pérez ')).toEqual({ ok: true, repetida: false });

    // La PC lo ve sin socket, por id (se cayó su socket o recargó la pestaña).
    const e = await nuevoServicio().estado(pedido.id);
    expect(e).toMatchObject({ estado: 'firmada', monto: 250, firma_png: PNG, firma_nombre: 'Juan Pérez' });

    // `[CG.202]` El alta toma la firma de la FILA: la PC no manda imagen.
    const mov = await alta(250, pedido.id) as { id: string; firma_estado: string; firma_png: string; firma_nombre: string };
    expect(mov.firma_estado).toBe('firmado');
    expect(mov.firma_png).toBe(PNG);
    expect(mov.firma_nombre).toBe('Juan Pérez');
    const f = await fila(pedido.id);
    expect(f).toMatchObject({ estado: 'usada', usada_en: mov.id, intentos_envio: 1, ultimo_fallo: null });
    expect((await nuevoServicio().estado(pedido.id)).estado).toBe('usada');
  });

  it('⭐ (b) el MISMO teléfono que vuelve no es un segundo uso; después de firmar oye «ya quedó»', async () => {
    const pedido = await nuevoServicio().abrir(contexto(90), CAJERA);
    await nuevoServicio().verPorToken(pedido.token, TEL);
    // bloqueo de pantalla / recarga: vuelve a abrir el mismo QR
    expect((await nuevoServicio().verPorToken(pedido.token, TEL)).estado).toBe('tomada');
    await nuevoServicio().firmarPorToken(pedido.token, TEL, PNG, null);
    expect((await nuevoServicio().verPorToken(pedido.token, TEL)).estado).toBe('firmada');
  });

  it('⭐ (e) doble toque: dos envíos SIMULTÁNEOS → una sola firma, la primera manda, los dos contestan OK', async () => {
    const pedido = await nuevoServicio().abrir(contexto(75.5), CAJERA);
    await nuevoServicio().verPorToken(pedido.token, TEL);
    const [r1, r2] = await Promise.all([
      nuevoServicio().firmarPorToken(pedido.token, TEL, PNG, 'Uno'),
      nuevoServicio().firmarPorToken(pedido.token, TEL, PNG_2, 'Dos'),
    ]);
    expect([r1.repetida, r2.repetida].sort()).toEqual([false, true]);
    const f = await fila(pedido.id);
    expect(f.estado).toBe('firmada');
    // la imagen es la del envío que ganó el candado, y es UNA
    expect([PNG, PNG_2]).toContain(f.firma_png);
    expect(f.intentos_envio).toBe(1);
  });

  it('⛔ otro teléfono no ve el contexto ni firma (409)', async () => {
    const pedido = await nuevoServicio().abrir(contexto(60), CAJERA);
    await nuevoServicio().verPorToken(pedido.token, TEL);
    expect(await falla(nuevoServicio().verPorToken(pedido.token, OTRO))).toEqual({ status: 409, fallo: 'otro_telefono' });
    expect(await falla(nuevoServicio().firmarPorToken(pedido.token, OTRO, PNG, null))).toEqual({ status: 409, fallo: 'otro_telefono' });
  });

  it('⛔ una firma se usa UNA vez; con otro monto o sin firmar no se guarda', async () => {
    const usada = await nuevoServicio().abrir(contexto(40), CAJERA);
    await nuevoServicio().firmarPorToken(usada.token, TEL, PNG, null);
    await alta(40, usada.id);
    expect(await falla(alta(40, usada.id))).toEqual({ status: 410, fallo: 'ya_usada' });

    const otroMonto = await nuevoServicio().abrir(contexto(41), CAJERA);
    await nuevoServicio().firmarPorToken(otroMonto.token, TEL, PNG, null);
    expect(await falla(alta(41.01, otroMonto.id))).toEqual({ status: 422, fallo: 'monto_distinto' });
    // y el pedido NO quedó consumido por el intento fallido: la transacción se revirtió entera
    expect((await fila(otroMonto.id)).estado).toBe('firmada');

    const sinFirmar = await nuevoServicio().abrir(contexto(42), CAJERA);
    expect(await falla(alta(42, sinFirmar.id))).toEqual({ status: 422, fallo: 'no_firmada' });
  });

  it('⛔ cancelada y vencida no se abren; un JWT que no es de firma no entra', async () => {
    const cancelada = await nuevoServicio().abrir(contexto(10), CAJERA);
    await nuevoServicio().cancelar(cancelada.id, CAJERA);
    expect(await falla(nuevoServicio().verPorToken(cancelada.token, TEL))).toEqual({ status: 410, fallo: 'cancelada' });

    const vieja = await nuevoServicio().abrir(contexto(11), CAJERA);
    await new TenantKnexService(knex, ctx).run((trx) =>
      trx('finance.cash_signature_requests').where({ id: vieja.id }).update({ expira_at: trx.raw(`now() - interval '1 minute'`) }));
    expect(await falla(nuevoServicio().verPorToken(vieja.token, TEL))).toEqual({ status: 410, fallo: 'vencida' });
    expect((await nuevoServicio().estado(vieja.id)).estado).toBe('vencida');

    // Un token de SESIÓN firmado con el mismo secreto: verifica, pero no es un pase de firma.
    const sesion = jwt.sign({ sub: CAJERA.id, tenant_id: T, sid: vieja.id });
    expect(await falla(nuevoServicio().verPorToken(sesion, TEL))).toEqual({ status: 404, fallo: 'no_existe' });
  });

  it('el fallo deja RASTRO en la fila aunque la petición falle (es lo que mide el canal)', async () => {
    const pedido = await nuevoServicio().abrir(contexto(12), CAJERA);
    await nuevoServicio().verPorToken(pedido.token, TEL);
    expect(await falla(nuevoServicio().firmarPorToken(pedido.token, TEL, 'data:text/html,<script>', null)))
      .toEqual({ status: 422, fallo: 'no_es_firma' });
    expect(await fila(pedido.id)).toMatchObject({ estado: 'tomada', intentos_envio: 1, ultimo_fallo: 'no_es_firma' });
  });

  it('⛔ RLS forzada: sin tenant la tabla no muestra ninguna fila', async () => {
    await nuevoServicio().abrir(contexto(13), CAJERA);
    const sinTenant = await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', '', true)`);
      const r = await trx.raw(`SELECT count(*)::int AS n FROM finance.cash_signature_requests`);
      return r.rows[0].n as number;
    });
    expect(sinTenant).toBe(0);
  });
});
