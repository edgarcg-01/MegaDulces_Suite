import knexFactory, { Knex } from 'knex';
import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CashLedgerService } from './cash-ledger.service';
import { CashCutService } from './cash-cut.service';
import { CajaArqueoService } from './caja-arqueo.service';

/**
 * ⭐⭐ `[CGS.60]` **Un movimiento que se hace con cheque o con papel (crédito), contra Postgres real**,
 * con los servicios que corren en prod: el alta del movimiento, el corte y la lista de lo que hay en
 * la caja. Regla 13: un endpoint que escribe no está probado hasta que se ejerció contra base real
 * con el payload de la pantalla.
 *
 * Edgar, 2026-10-30: «y si un movimiento se quiere hacer con cheque, o papel (crédito)» → «sí, hazlo».
 *
 * El recorrido: un cobro entra en parte en cheque; otro, todo en papel; un pago sale con ese cheque y
 * después se cancela. En cada paso, el esperado del cajón es SÓLO el efectivo, y la lista de la caja
 * dice qué documentos hay. Las negativas: lo que la pantalla no debe poder hacer, y lo que la base
 * no deja aunque se le llegue directo.
 *
 * Base: la de `database/tests/caja/preparar-base-caja.js`, COMO `app_runtime`. Sin `CAJA_TEST_DB_URL`
 * se SALTA y lo dice.
 *
 *     CAJA_TEST_DB_URL=postgresql://app_runtime:app_runtime@127.0.0.1:5432/postgres_platform \
 *       npx vitest run --config libs/finance/vitest.config.ts libs/finance/src/lib/caja/cash-ledger.documentos-real.spec.ts
 */
const URL = process.env.CAJA_TEST_DB_URL;
const T = '00000000-0000-0000-0000-00000000d01c';
const CAJERA = { id: '00000000-0000-0000-0000-0000000000c1', username: 'cajera_cheques' };
const CORRIDA = Date.now().toString(36);
const S = `D60-${CORRIDA}`;

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[CGS.60] NO MEDIDO: sin CAJA_TEST_DB_URL no hay base contra la cual ejercer los cobros y pagos con cheque o papel.');
}

describe.skipIf(!URL)('[CGS.60] cobros y pagos con cheque o papel contra Postgres', () => {
  let knex: Knex;
  let ctx: TenantContextService;
  let hoy = '';
  let n = 0;
  const tk = () => new TenantKnexService(knex, ctx);
  const libro = () => new CashLedgerService(tk(), ctx);
  const cortes = () => new CashCutService(tk(), ctx);
  const arqueos = () => new CajaArqueoService(tk(), ctx);

  /** El payload de la pantalla: un movimiento sin documento de Kepler, sin clasificar, de la sucursal de la prueba. */
  const alta = (tipo: 'ingreso' | 'gasto', monto: number, extra: Record<string, unknown> = {}) => libro().createTraducido({
    tipo,
    client_uuid: randomUUID(),
    fecha: hoy,
    sucursal: S,
    monto,
    kepler_cuenta: '',
    kepler_concepto: '',
    sin_clasificar_motivo: 'Prueba de cheques y papeles',
    sin_documento_motivo: 'Prueba de cobros y pagos con cheque o papel [CGS.60]',
    glosa: `Movimiento de la prueba de cheques ${CORRIDA}-${(n += 1)}`,
    beneficiario: 'Cliente de prueba',
    ...extra,
  } as never, CAJERA) as Promise<{ id: string; monto: string }>;

  const enCaja = async (numero: string) => (await arqueos().documentosEnCaja()).cheques.piezas.find((p) => p.numero === numero) ?? null;
  const esperado = async () => (await cortes().saldo(S, true)).saldo;

  let candadoAntes: string | undefined;
  let origenAntes: string | undefined;
  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 4 } });
    ctx = { requireTenantId: () => T } as unknown as TenantContextService;
    // El candado de captura (`[CGS.14]`) es otra regla con sus pruebas: la base de prueba acumula
    // jornadas abiertas de otras corridas. Y el origen del egreso se ENCIENDE: el pago con cheque
    // tiene que pasar sin origen porque no sacó efectivo, no porque la regla esté apagada.
    candadoAntes = process.env['CAJA_CANDADO_CAPTURA'];
    origenAntes = process.env['CAJA_EGRESO_ORIGEN_DESDE'];
    process.env['CAJA_CANDADO_CAPTURA'] = 'off';
    process.env['CAJA_EGRESO_ORIGEN_DESDE'] = '1900-01-01';
    hoy = (await knex.raw(`SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;
  });
  afterAll(async () => {
    for (const [k, v] of [['CAJA_CANDADO_CAPTURA', candadoAntes], ['CAJA_EGRESO_ORIGEN_DESDE', origenAntes]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await knex?.destroy();
  });

  it('⭐ un cobro en cheque y otro en papel: el cajón sólo recibe el efectivo, y los documentos quedan en la caja', async () => {
    await cortes().abrir({ fecha: hoy, sucursal: S, fondo_inicial: 0 }, CAJERA);
    expect(await esperado()).toBe(0);

    // $10,000: $2,000 en billetes y $8,000 en un cheque.
    await alta('ingreso', 10000, {
      denominaciones: [{ denominacion: 500, piezas: 4, denom_key: '500', flujo: 'recibido' }],
      documentos: { entran: [{ tipo: 'cheque', monto: 8000, banco: 'Banamex', numero: `A-${CORRIDA}`, de_quien: 'Abarrotes La Luz' }] },
    });
    expect(await esperado()).toBe(2000);
    expect(await enCaja(`A-${CORRIDA}`)).toMatchObject({ banco: 'Banamex', monto: 8000, de_quien: 'Abarrotes La Luz', visto_desde: hoy });

    // $1,952 todo en papel: un cliente quedó a deber. Ni un peso al cajón.
    await alta('ingreso', 1952, {
      documentos: { entran: [{ tipo: 'papel', monto: 1952, de_quien: 'Tienda Lupita', concepto: 'venta de la ruta 27' }] },
    });
    expect(await esperado()).toBe(2000);
    const papeles = (await arqueos().documentosEnCaja()).papeles.piezas;
    expect(papeles.find((p) => p.de_quien === 'Tienda Lupita' && p.monto === 1952)).toMatchObject({ clase: 'credito', concepto: 'venta de la ruta 27' });
  });

  it('⭐ un pago con un cheque de la caja: no saca efectivo, no pide origen, y el cheque sale', async () => {
    // Control: la regla del origen está encendida (un pago en efectivo sin origen se frena).
    await expect(alta('gasto', 500, { denominaciones: [{ denominacion: 500, piezas: 1, denom_key: '500', flujo: 'recibido' }] }))
      .rejects.toBeInstanceOf(BadRequestException);

    const cheque = await enCaja(`A-${CORRIDA}`);
    expect(cheque).not.toBeNull();
    const pago = await alta('gasto', 8000, { documentos: { salen: [{ pieza: cheque!.pieza }] } });
    expect(Number(pago.monto)).toBe(8000);
    expect(await esperado()).toBe(2000);
    expect(await enCaja(`A-${CORRIDA}`)).toBeNull();

    // ⛔ [negativa] El mismo cheque no paga dos veces: ya no está en la caja.
    await expect(alta('gasto', 8000, { documentos: { salen: [{ pieza: cheque!.pieza }] } }))
      .rejects.toThrow(/ya no está en la caja/);

    // ⛔ [negativa] Un movimiento cancelado deja de contar: el cheque vuelve a la caja.
    await cortes().cancelarMovimiento(pago.id, 'Prueba: se canceló el pago con cheque', CAJERA);
    expect(await enCaja(`A-${CORRIDA}`)).toMatchObject({ pieza: cheque!.pieza, monto: 8000 });
    expect(await esperado()).toBe(2000);
  });

  it('[negativa] lo que la pantalla no debe poder hacer', async () => {
    // Un cheque que ya está en la caja no vuelve a entrar.
    await expect(alta('ingreso', 8000, {
      documentos: { entran: [{ tipo: 'cheque', monto: 8000, banco: ' banamex ', numero: `A-${CORRIDA}`, de_quien: 'Otro Cliente' }] },
    })).rejects.toThrow(/ya está en la caja/);
    // Los documentos no pasan del monto: el arqueo del movimiento no cuadra.
    await expect(alta('ingreso', 100, {
      documentos: { entran: [{ tipo: 'cheque', monto: 500, banco: 'BBVA', numero: `B-${CORRIDA}`, de_quien: 'Cliente Grande' }] },
    })).rejects.toBeInstanceOf(BadRequestException);
    // Con un papel no se paga.
    const papel = (await arqueos().documentosEnCaja()).papeles.piezas.find((p) => p.de_quien === 'Tienda Lupita');
    await expect(alta('gasto', 1952, { documentos: { salen: [{ pieza: papel!.pieza }] } })).rejects.toBeInstanceOf(BadRequestException);
    // Un pago no «entra» en cheque, ni un cobro «sale» con uno.
    await expect(alta('gasto', 300, {
      documentos: { entran: [{ tipo: 'cheque', monto: 300, banco: 'BBVA', numero: `C-${CORRIDA}`, de_quien: 'Cliente Grande' }] },
    })).rejects.toThrow(/Sólo un cobro entra/);
  });

  it('⛔ [negativa] la BASE exige las reglas aunque se le llegue directo', async () => {
    const cheque = await enCaja(`A-${CORRIDA}`);
    const pago = await alta('gasto', 8000, { documentos: { salen: [{ pieza: cheque!.pieza }] } });
    // $9,000 en efectivo: alcanza para que un renglón de $8,000 no choque con «no pasan del monto»
    // y la regla que se mide sea la que se quiere medir.
    const otro = await alta('ingreso', 9000, { denominaciones: [{ denominacion: 500, piezas: 18, denom_key: '500', flujo: 'recibido' }] });
    const fila = (cash_ledger_id: string, extra: Record<string, unknown>) => ({
      tenant_id: T, cash_ledger_id, pieza: randomUUID(), sentido: 'entra', tipo: 'cheque', monto: 1,
      banco: 'BBVA', numero: `D-${CORRIDA}-${(n += 1)}`, de_quien: 'Alguien Más', created_by: CAJERA.id, ...extra,
    });

    // El mismo cheque, saliendo con otro movimiento vivo.
    await expect(tk().run((trx) => trx('finance.cash_ledger_documentos').insert(fila(otro.id, {
      pieza: cheque!.pieza, sentido: 'sale', monto: 8000, banco: 'Banamex', numero: `A-${CORRIDA}`,
    })))).rejects.toMatchObject({ constraint: 'cash_ledger_documentos_sale_dos_veces' });
    // Un cheque que nunca entró no puede salir.
    await expect(tk().run((trx) => trx('finance.cash_ledger_documentos').insert(fila(otro.id, { sentido: 'sale' }))))
      .rejects.toMatchObject({ constraint: 'cash_ledger_documentos_sin_entrada' });
    // Documentos de más: el efectivo del movimiento quedaría negativo.
    await expect(tk().run((trx) => trx('finance.cash_ledger_documentos').insert(fila(otro.id, { monto: 9001 }))))
      .rejects.toMatchObject({ constraint: 'cash_ledger_documentos_exceden' });
    // Un renglón no se corrige: app_runtime no tiene UPDATE.
    await expect(tk().run((trx) => trx('finance.cash_ledger_documentos').where({ cash_ledger_id: pago.id }).update({ monto: 1 })))
      .rejects.toThrow(/permission denied/);
  });
});
