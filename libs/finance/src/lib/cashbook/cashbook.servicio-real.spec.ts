import { randomUUID } from 'node:crypto';
import knexFactory, { Knex } from 'knex';
import { HttpException } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type { HechoDePersona } from '@megadulces/contracts';
import { CashbookService } from './cashbook.service';

/**
 * `[LE.4.7]` — El servicio REAL del libro contra Postgres, con los payloads que manda la API (regla
 * 13: un endpoint que escribe no está probado hasta que una prueba lo ejerció contra base real).
 * Cada rechazo con su código HTTP y su `codigo` exacto.
 *
 * Usa un tenant AL AZAR por corrida: el libro es inmutable, así que lo registrado se queda en la
 * base de prueba (nunca en prod: `CAJA_TEST_DB_URL`).
 */
const URL = process.env['CAJA_TEST_DB_URL'];
const T = randomUUID();
const CAJERA = { id: randomUUID(), username: 'cajera_prueba' };
const MARIAZ = { id: randomUUID(), username: 'autoriza_prueba' };
const HOY = `${2100 + Math.floor(Math.random() * 800)}-07-01`;

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[LE.4.7] NO MEDIDO: sin CAJA_TEST_DB_URL no se ejerce la API del libro contra una base real.');
}

async function rechazo(p: Promise<unknown>): Promise<{ status: number; codigo: string }> {
  try { await p; } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), codigo: (e.getResponse() as { codigo: string }).codigo };
    throw e;
  }
  return { status: 200, codigo: 'sin error' };
}

describe.skipIf(!URL)('[LE.4.7] la API del libro de efectivo contra Postgres', () => {
  let knex: Knex;
  let svc: CashbookService;
  let hay = false;

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 4 } });
    hay = (await knex.raw(`SELECT to_regprocedure('cashbook.register_count(jsonb)') IS NOT NULL AS ok`)).rows[0].ok;
    const ctx = { requireTenantId: () => T } as unknown as TenantContextService;
    svc = new CashbookService(new TenantKnexService(knex, ctx), ctx);
  });
  afterAll(async () => { await knex?.destroy(); });

  it('un día completo: abrir, registrar, cuatro ojos, arqueo, hallazgo y cierre', async () => {
    if (!hay) { console.warn('[LE.4.7] NO MEDIDO: la base no tiene las migraciones del libro'); return; }

    // Sin jornada no se registra; con jornada sí.
    const gasto: HechoDePersona = { tipo: 'gasto', concepto: 'Papelería', desde: { tipo: 'cajon', piezas: { 100: '3' } } };
    expect(await rechazo(svc.registrarHecho(gasto, CAJERA, randomUUID()))).toEqual({ status: 422, codigo: 'cashbook_sin_jornada_abierta' });
    await svc.abrirJornada(HOY, CAJERA);
    expect(await rechazo(svc.abrirJornada(HOY, CAJERA))).toEqual({ status: 409, codigo: 'cashbook_ya_hay_jornada_abierta' });

    // La apertura SIEMPRE la autoriza otra persona.
    const ap = await svc.registrarHecho({ tipo: 'apertura', moneda: 'MXN', fecha: HOY,
      conteos: [{ cuenta: 'BOVEDA_CAOS', piezas: { 500: '200' } }, { cuenta: 'CAJA_MXN', piezas: { 100: '10' } }] }, CAJERA, randomUUID());
    expect(ap.estado).toBe('por_autorizar');
    if (ap.estado !== 'por_autorizar') return;
    expect(await rechazo(svc.autorizar(ap.request_id, CAJERA))).toEqual({ status: 422, codigo: 'cashbook_autoriza_quien_registra' });
    await svc.autorizar(ap.request_id, MARIAZ);
    expect(await rechazo(svc.autorizar(ap.request_id, MARIAZ))).toEqual({ status: 409, codigo: 'cashbook_solicitud_no_pendiente' });

    // Idempotency-Key: obligatoria; el reintento idéntico es el mismo asiento; otro contenido, 409.
    expect(await rechazo(svc.registrarHecho(gasto, CAJERA, undefined))).toEqual({ status: 400, codigo: 'sin_idempotency_key' });
    const key = randomUUID();
    const g1 = await svc.registrarHecho(gasto, CAJERA, key);
    const g2 = await svc.registrarHecho(gasto, CAJERA, key);
    expect(g1).toEqual(g2);
    expect(g1.estado).toBe('asentado');
    const otro: HechoDePersona = { tipo: 'gasto', concepto: 'Papelería', desde: { tipo: 'cajon', piezas: { 100: '4' } } };
    expect(await rechazo(svc.registrarHecho(otro, CAJERA, key))).toEqual({ status: 409, codigo: 'cashbook_peticion_reusada' });

    // Lo que la regla rechaza llega con su nombre, no como 500.
    expect(await rechazo(svc.registrarHecho({ tipo: 'gasto', concepto: 'x', desde: { tipo: 'cajon', piezas: { 300: '1' } } }, CAJERA, randomUUID())))
      .toEqual({ status: 400, codigo: 'denominacion_fuera_de_catalogo' });
    expect(await rechazo(svc.registrarHecho({ tipo: 'gasto', concepto: 'x', desde: { tipo: 'cajon', piezas: { 500: '1' } } }, CAJERA, randomUUID())))
      .toEqual({ status: 422, codigo: 'cashbook_piezas_no_negativas' });

    // El faltante queda por autorizar.
    const f = await svc.registrarHecho({ tipo: 'faltante', de: { tipo: 'ruta', ruta: '27', monto_minor: '10000' }, empleado: 'e-27', nombre: 'Vendedor 27' }, CAJERA, randomUUID());
    expect(f.estado).toBe('por_autorizar');
    expect((await svc.pendientes()).length).toBe(1);

    // Arqueo de cierre con un faltante de $100: hallazgo. El sorpresa es ciego.
    const c = await svc.contar({ cuenta: 'CAJA_MXN', tipo: 'cierre', piezas: { 100: '6' }, contado_en: new Date(Date.now() - 1000).toISOString() }, CAJERA);
    expect(c).toMatchObject({ ciego: false, esperado_minor: '70000', diferencia_minor: '-10000' });
    expect(await rechazo(svc.contar({ cuenta: 'CAJA_MXN', tipo: 'sorpresa', piezas: { 100: '7' }, contado_en: new Date().toISOString() }, MARIAZ)))
      .toEqual({ status: 422, codigo: 'cashbook_conteo_sorpresa_con_testigo' });
    const s = await svc.contar({ cuenta: 'CAJA_MXN', tipo: 'sorpresa', piezas: { 100: '7' }, testigo: CAJERA.id, contado_en: new Date().toISOString() }, MARIAZ);
    expect(s).toEqual({ ciego: true, count_id: expect.any(String), total_minor: '70000' });

    // El hallazgo: con nota, no lo firma quien lo registró; lo firma otra persona.
    if (c.ciego || !c.hallazgo_id) throw new Error('el conteo debía dejar hallazgo');
    expect(await rechazo(svc.cerrarHallazgo(c.hallazgo_id, { nota: 'se recontó' }, CAJERA))).toEqual({ status: 422, codigo: 'cashbook_hallazgo_se_cierra_con_algo' });
    await svc.cerrarHallazgo(c.hallazgo_id, { nota: 'el billete estaba en el sobre de la ruta 27; se recontó' }, MARIAZ);
    expect((await svc.hallazgos()).length).toBe(0);

    // La reversa del gasto: la pide la cajera, la autoriza otra persona.
    if (g1.estado !== 'asentado') return;
    const rv = await svc.pedirReversa(g1.entry_id, 'se capturó el gasto de otro día', CAJERA, randomUUID());
    if (rv.estado !== 'por_autorizar') throw new Error('la reversa debía quedar por autorizar');
    await svc.autorizar(rv.request_id, MARIAZ);

    // El cierre: lo autoriza la sesión; cierra quien hizo el arqueo de cierre (nunca la misma persona).
    expect(await rechazo(svc.cerrarJornada(HOY, CAJERA))).toEqual({ status: 422, codigo: 'cashbook_cierre_cuatro_ojos' });
    expect(await svc.cerrarJornada(HOY, MARIAZ)).toEqual({ cerro: CAJERA.id, autorizo: MARIAZ.id });
    expect(await rechazo(svc.registrarHecho(gasto, CAJERA, randomUUID()))).toEqual({ status: 422, codigo: 'cashbook_sin_jornada_abierta' });

    // Lo que queda: el libro íntegro, la caja con lo que se reconoció.
    const saldos = await svc.saldos(true);
    expect(saldos.integridad).toEqual({ integra: true, problemas: [] });
    expect(saldos.jornada_abierta).toBeNull();
    const caja = saldos.cuentas.find((x) => x.code === 'CAJA_MXN');
    expect(caja).toMatchObject({ balance_minor: '100000', piezas: { 100: '10' } });
    expect((await svc.saldos(false)).cuentas.every((x) => x.piezas === undefined)).toBe(true);
    expect((await svc.mayor(0, 1000)).length).toBeGreaterThanOrEqual(6);
  });

  it('[LE.4.8] la alerta de un permiso de caja: llega a la bandeja y la cierra otra persona', async () => {
    const t = (await knex.raw(`SELECT to_regprocedure('cashbook.alerta_de_permiso()') IS NOT NULL AS ok`)).rows[0].ok;
    if (!t) { console.warn('[LE.4.8] NO MEDIDO: la base no tiene la migración de la alerta'); return; }
    const BENEFICIARIA = randomUUID();
    // Como lo escribe la pantalla de usuarios: con quién lo dio. Sin tenant en la sesión (lo pone el trigger).
    await knex.raw(`INSERT INTO identity.user_permissions (tenant_id, user_id, permission_key, allow, granted_by, created_at, updated_at)
      VALUES (?, ?, 'FINANCE_CAJA_AUTORIZAR', true, ?, now(), now())`, [T, BENEFICIARIA, CAJERA.id]);
    const alerta = (await svc.hallazgos()).find((h) => h['source'] === 'permiso');
    expect(alerta).toMatchObject({ source: 'permiso', amount_minor: '0', detail: { usuario: BENEFICIARIA, actor: CAJERA.id } });
    const id = String(alerta?.['id']);
    expect(await rechazo(svc.cerrarHallazgo(id, { nota: 'yo lo di' }, CAJERA))).toEqual({ status: 422, codigo: 'cashbook_permiso_lo_revisa_otro' });
    expect(await rechazo(svc.cerrarHallazgo(id, { nota: 'me lo dieron' }, { id: BENEFICIARIA, username: 'beneficiaria' })))
      .toEqual({ status: 422, codigo: 'cashbook_permiso_lo_revisa_otro' });
    await svc.cerrarHallazgo(id, { nota: 'Visto: lo pidió Dirección por la ausencia de María' }, MARIAZ);
    expect((await svc.hallazgos()).some((h) => h['id'] === id)).toBe(false);
  });
});
