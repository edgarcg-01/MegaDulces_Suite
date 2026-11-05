import { randomUUID } from 'crypto';
import knexFactory, { Knex } from 'knex';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type { DocumentoArqueoInput, DocumentosArqueoInput } from '@megadulces/contracts';
import { CashCutService } from './cash-cut.service';
import { CajaArqueoService } from './caja-arqueo.service';
import { leerPosicion } from './caja-posicion.query';

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
// `[CGS.17]` Estos cortes son de años pasados y se cierran HOY: V1 («se cerró el mismo día») no
// cumple, y una verificación que falla exige nota para autorizar. La nota no afloja nada: dice por qué.
const CON_NOTA = { nota: 'Corte de prueba del servicio real, cerrado fuera de su día' };
// Un año PASADO distinto por corrida: un corte es único por (sucursal, fecha), y desde `[CGP-L.4]`
// no se abre una fecha que todavía no pasa (la primera versión usaba años 2100+ y quedó inválida).
// El año lo elige `anioLibre()` en `beforeAll`, entre 1100 y 2019; la ancla de L.4 va 1000 años antes
// (100–1019). Con 30 años el rango se agotó en un día de corridas sobre la misma base.
let ANIO = 0;
// Una marca por corrida en las sucursales y los folios sembrados: dos corridas nunca comparten sucursal.
const CORRIDA = Date.now().toString(36);
const dia = (mmdd: string) => `${ANIO}-${mmdd}`;
// Y una sucursal distinta por corrida: sólo puede haber UN borrador por sucursal, sin importar la
// fecha, y la prueba del arqueo ciego deja el suyo abierto a propósito (es el cierre rechazado).
// Es el mismo mecanismo que trabó prod tres días: un borrador viejo bloquea los cortes que siguen.
const suc = (k: string) => `${k}-${ANIO}-${CORRIDA}`;
const conteo = (...pares: Array<[string, number, number]>) =>
  pares.map(([denom_key, denominacion, piezas]) => ({ denom_key, denominacion, piezas }));

/**
 * `[CGS.59]` Los cheques y papeles de un arqueo de la prueba. La base escribe y no deshace, así que
 * lo que dejaron corridas anteriores sigue «en la caja»: se marca como salido (con su nota) y se
 * agregan los nuevos. El arqueo queda determinista sin borrar nada — como lo haría la pantalla.
 */
async function documentosQueCierran(arqueos: CajaArqueoService,
  nuevos: { cheques: DocumentoArqueoInput[]; papeles: DocumentoArqueoInput[] }): Promise<DocumentosArqueoInput> {
  const d = await arqueos.documentosEnCaja();
  const fuera = (piezas: Array<{ pieza: string }>): DocumentoArqueoInput[] =>
    piezas.map((p) => ({ pieza: p.pieza, estado: 'salio', salida: 'otro', salida_nota: 'lo dejó otra corrida de la prueba' }));
  return { base: d.base, cheques: [...fuera(d.cheques.piezas), ...nuevos.cheques], papeles: [...fuera(d.papeles.piezas), ...nuevos.papeles] };
}

/**
 * Un año sin cortes en la 00 y sin movimientos de ninguna plaza (desplazado -1000 años, donde siembra su ancla).
 * `ux_cash_cut_sucursal_fecha` admite un corte por (sucursal, fecha) y esta prueba escribe sin
 * deshacer: con un año al azar, dos corridas sobre la misma base terminaban chocando (pasó el
 * 2026-10-15 con el 2013). Si se agotan, falla con frase en vez de chocar a mitad.
 */
async function anioLibre(tk: TenantKnexService, desde: number, cuantos: number): Promise<number> {
  const usados = new Set<number>(await tk.run(async (trx) => {
    const r = await trx.raw(`SELECT extract(year FROM fecha)::int AS y FROM finance.cash_ledger_cuts WHERE sucursal = '00' UNION SELECT extract(year FROM fecha)::int FROM finance.cash_ledger`);
    return r.rows.map((x: { y: number }) => Number(x.y));
  }));
  const libres = Array.from({ length: cuantos }, (_, i) => desde + i).filter((y) => !usados.has(y + -1000));
  if (!libres.length) {
    throw new Error(`La base de prueba ya usó los ${cuantos} años desde ${desde}: reconstrúyela con database/tests/caja/preparar-base-caja.js.`);
  }
  return libres[Math.floor(Math.random() * libres.length)];
}

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[CGP-L.0] NO MEDIDO: sin CAJA_TEST_DB_URL no hay base contra la cual ejercer el servicio real del corte.');
}

describe.skipIf(!URL)('[CGP-L.0] el servicio REAL del corte contra Postgres', () => {
  let knex: Knex;
  let tk: TenantKnexService;
  let svc: CashCutService;
  let n = 0;

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 4 } });
    const ctx = { requireTenantId: () => T } as unknown as TenantContextService;
    tk = new TenantKnexService(knex, ctx);
    svc = new CashCutService(tk, ctx);
    ANIO = await anioLibre(tk, 1100, 920);
  });
  afterAll(async () => {
    await knex?.destroy();
  });

  /** Un movimiento del libro, escrito directo: lo que se prueba acá es el CORTE, no la captura. */
  /**
   * ⚠️ `[CGP-L.12]` **`created_at` se siembra, no se deja en `now()`.** La jornada de un movimiento
   * es el día en que se movió el efectivo (`created_at` en hora de México), no el del papel. Estas
   * pruebas fechan en años históricos, así que un `created_at` en el día de la corrida dejaría a
   * TODOS sus movimientos fuera de su propio corte. Por omisión el efectivo se movió el día que dice
   * `fecha` —que es el caso normal, capturar el mismo día—; `diaEfectivo` separa los dos a propósito.
   * Se siembra a mediodía para no depender del desplazamiento horario (en años previos a 1922 la
   * zona de México es LMT, −06:36:36).
   */
  async function movimiento(
    fecha: string, sucursal: string, tipo: 'ingreso' | 'gasto', monto: number, diaEfectivo?: string,
    creadoPor: string = CAJERA.id,
  ) {
    await tk.run((trx) => trx('finance.cash_ledger').insert({
      tenant_id: T, folio: `CGL-${ANIO}-${Date.now()}-${(n += 1)}`, tipo, fecha, sucursal,
      kepler_cuenta: '101-001', kepler_concepto: '001', glosa: 'Movimiento de prueba del servicio',
      monto, created_by: creadoPor,
      created_at: trx.raw(`((?::date) + interval '12 hours') AT TIME ZONE 'America/Mexico_City'`, [diaEfectivo ?? fecha]),
    }));
  }

  /** Una pierna del cajero (CAOS) en su jornada: `accounting_date` es el día FÍSICO. */
  async function caos(accounting_date: string, typeId: number, total: number) {
    await tk.run((trx) => trx('analytics.caos_cash_movements').insert({
      tenant_id: T, device: 'CAOS-PRUEBA', external_id: Date.now() * 10 + (n += 1),
      type_id: typeId, type_label: typeId === 4 ? 'Dispensar' : 'Deposito',
      occurred_at: trx.raw(`((?::date) + interval '12 hours') AT TIME ZONE 'America/Mexico_City'`, [accounting_date]),
      accounting_date, total, _row_hash: `prueba-${ANIO}-${CORRIDA}-${n}`,
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
    const autorizado = await svc.autorizar(c.id, AUTORIZA, CON_NOTA);
    expect(autorizado.estado).toBe('autorizado');
  });

  it('⛔ `[CGS.16]` quien capturó un movimiento del corte NO lo autoriza: 403 con su frase, no un 500 de la base', async () => {
    // D3 (Edgar, 2026-10-21): la supervisora captura, pero no firma lo suyo.
    const SUPERVISORA = { id: '00000000-0000-0000-0000-0000000000c5', username: 'supervisora_prueba' };
    const f = dia('03-11');
    const c = await svc.abrir({ fecha: f, sucursal: suc('S16'), fondo_inicial: 500 }, CAJERA);
    await movimiento(f, suc('S16'), 'ingreso', 1000, undefined, SUPERVISORA.id);
    await svc.contar(c.id, { conteo: conteo(['1000', 1000, 1], ['500', 500, 1]), morralla: 0 }, CAJERA);
    await svc.cerrar(c.id, { conteo: [], morralla: 0 }, CAJERA);

    const rechazo = svc.autorizar(c.id, SUPERVISORA);
    await expect(rechazo).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.autorizar(c.id, SUPERVISORA)).rejects.toThrow(/Capturaste o cancelaste/);
    expect((await corte(c.id)).estado).toBe('cerrado');

    const autorizado = await svc.autorizar(c.id, AUTORIZA, CON_NOTA);
    expect(autorizado.estado).toBe('autorizado');
  });

  it('⭐ `[CGS.17][CGS.18]` con diferencia: sin nota no se autoriza; se observa, la caja responde y se autoriza con nota', async () => {
    const SUPERVISORA = { id: '00000000-0000-0000-0000-0000000000c6', username: 'supervisora_revisa' };
    const f = dia('03-14');
    const c = await svc.abrir({ fecha: f, sucursal: suc('S18'), fondo_inicial: 500 }, CAJERA);
    await movimiento(f, suc('S18'), 'ingreso', 1000);
    // Se cuentan $1,000: faltan $500.
    await svc.contar(c.id, { conteo: conteo(['1000', 1000, 1]), morralla: 0 }, CAJERA);
    await svc.cerrar(c.id, { conteo: [], morralla: 0 }, CAJERA);

    await expect(svc.autorizar(c.id, SUPERVISORA)).rejects.toThrow(/escribe una nota/);
    await expect(svc.observar(c.id, { motivo: 'corto' }, SUPERVISORA)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.observar(c.id, { motivo: 'Faltan 500 y nadie lo explica' }, CAJERA))
      .rejects.toBeInstanceOf(ForbiddenException);

    const obs = await svc.observar(c.id, { motivo: 'Faltan 500 y nadie lo explica' }, SUPERVISORA);
    expect(obs).toMatchObject({ estado: 'observado', observacion: 'Faltan 500 y nadie lo explica', observed_by_username: 'supervisora_revisa' });
    // Observado: no se autoriza, y sus cifras no se movieron.
    await expect(svc.autorizar(c.id, AUTORIZA, { nota: 'Autorizo con faltante' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(Number((await corte(c.id)).diferencia)).toBe(-500);

    await expect(svc.responder(c.id, { respuesta: 'Me respondo a mí misma' }, SUPERVISORA)).rejects.toBeInstanceOf(ForbiddenException);
    const res = await svc.responder(c.id, { respuesta: 'Se pagó un flete de 500 sin capturarlo; va como ajuste hoy' }, CAJERA);
    expect(res).toMatchObject({ estado: 'cerrado', responded_by_username: CAJERA.username });

    const aut = await svc.autorizar(c.id, SUPERVISORA, { nota: 'Flete de 500 explicado, ajuste en la jornada siguiente' });
    expect(aut).toMatchObject({ estado: 'autorizado', authorization_note: 'Flete de 500 explicado, ajuste en la jornada siguiente' });
  });

  it('⭐ `[CGS.36]` el arqueo trae la diferencia contra sus testigos y V12 en la lista; sin Control se DECLARA sin testigo', async () => {
    const f = dia('03-15');
    const s = suc('S36');
    const c = await svc.abrir({ fecha: f, sucursal: s, fondo_inicial: 500 }, CAJERA);
    await movimiento(f, s, 'ingreso', 1000);
    await svc.contar(c.id, { conteo: conteo(['1000', 1000, 1]), morralla: 0 }, CAJERA);
    await svc.cerrar(c.id, { conteo: [], morralla: 0 }, CAJERA);

    const r = await svc.arqueos({ sucursal: s, desde: f, hasta: f });
    const a = r.rows.find((x) => x.corte_id === c.id);
    // ⛔ `verdad: null` sería que la lectura de testigos FALLÓ y el SAVEPOINT la escondió como «sin
    // medir». Esta prueba es la que obliga a que su SQL corra de verdad contra Postgres.
    expect(r.limites.join(' ')).not.toContain('No se pudo arbitrar');
    expect(a?.verdad).toMatchObject({ estado: 'sin_confirmar', publicada: -500, verdadera: -500 });
    expect(a?.verdad?.testigos.map((t) => [t.id, t.estado])).toEqual([
      ['conteo', 'sin_testigo'], ['fondo', 'sin_testigo'], ['libro', 'confirma'], ['caja_fuerte', 'sin_testigo'],
    ]);
    expect(a?.verificacion.find((v) => v.id === 'V12')).toMatchObject({ estado: 'no_medido' });
  });

  it('⭐ `[CGS.45]` el arqueo completo: la supervisora recuenta a ciegas el corte cerrado; quien lo cerró, no', async () => {
    const arqueos = new CajaArqueoService(tk, { requireTenantId: () => T } as unknown as TenantContextService);
    const SUPERVISORA = { id: '00000000-0000-0000-0000-0000000000c7', username: 'supervisora_recuenta' };
    const f = dia('03-16');
    const s = suc('S45');
    const c = await svc.abrir({ fecha: f, sucursal: s, fondo_inicial: 0 }, CAJERA);
    await movimiento(f, s, 'ingreso', 1000);
    await svc.contar(c.id, { conteo: conteo(['1000', 1000, 1]), morralla: 0 }, CAJERA);
    await svc.cerrar(c.id, { conteo: [], morralla: 0 }, CAJERA);

    // El payload que manda la pantalla del recuento: piezas + los otros cuatro rubros. `[CGS.59]`
    // Los cheques y los papeles van uno por uno; su importe sale de los renglones.
    const payload = {
      tipo: 'recuento' as const, corte_id: c.id,
      piezas: [{ denom_key: '500', piezas: 1 }], morralla: 500,
      caja_fuerte: 502640, caja_fuerte_fuente: 'pantalla de la máquina',
      documentos: await documentosQueCierran(arqueos, {
        cheques: [{ estado: 'esta', monto: 10121, banco: 'Banamex', numero: `45-${CORRIDA}`, de_quien: 'Abarrotes La Luz' }],
        papeles: [{ estado: 'esta', clase: 'vale', monto: 20782, de_quien: 'Pedro Ramírez', concepto: 'anticipo de viáticos' }],
      }),
      usd: 12059, tipo_cambio: 19.101, tipo_cambio_fuente: 'DOF 2026-03-16',
    };
    // ⛔ Quien cerró el corte no lo recuenta: 403 con su frase.
    await expect(arqueos.registrar(payload, CAJERA)).rejects.toBeInstanceOf(ForbiddenException);
    // ⛔ Dólares sin fuente del tipo de cambio: 400.
    await expect(arqueos.registrar({ ...payload, tipo_cambio_fuente: '' }, SUPERVISORA)).rejects.toBeInstanceOf(BadRequestException);

    const g = await arqueos.registrar(payload, SUPERVISORA);
    expect(g.contra_corte).toEqual({ folio: c.folio, contado: 1000, diferencia: 0 });
    expect(g.arqueo).toMatchObject({ origen: 'suite', tipo: 'recuento', completo: true, efectivo: 1000, usd: 12059, tipo_cambio: 19.101 });
    expect(g.arqueo.total_mxn).toBe(Math.round((1000 + 502640 + 10121 + 20782 + 12059 * 19.101) * 100) / 100);

    // Sale por la vista única, que es lo que leen Arqueos y la posición.
    const l = await arqueos.listar({ limit: 200 });
    expect(l.rows.find((x) => x.folio === g.arqueo.folio)).toMatchObject({ origen: 'suite', corte_id: c.id });
    // `[CGS.59]` Y la posición abre los cheques y los papeles de ese arqueo, documento por documento.
    const p = await tk.run((trx) => leerPosicion(trx, T, false));
    expect(p.rubros.find((x) => x.rubro === 'cheques')?.piezas)
      .toEqual([expect.objectContaining({ texto: `Banamex 45-${CORRIDA} · Abarrotes La Luz`, monto: 10121 })]);
    expect(p.rubros.find((x) => x.rubro === 'papeles')?.piezas)
      .toEqual([expect.objectContaining({ texto: 'Vale · Pedro Ramírez: anticipo de viáticos', monto: 20782 })]);

    // ⛔ Un arqueo no se corrige: app_runtime no tiene UPDATE.
    await expect(tk.run((trx) => trx('finance.cash_arqueos').where({ id: g.arqueo.folio }).update({ efectivo: 1 })))
      .rejects.toThrow(/permission denied/);
  });

  it('⭐ `[CGS.59]` cheques y papeles uno por uno: lo que había se marca, lo nuevo entra, el importe es la suma y la base lo exige', async () => {
    const arqueos = new CajaArqueoService(tk, { requireTenantId: () => T } as unknown as TenantContextService);
    const base = { tipo: 'intermedio' as const, piezas: [{ denom_key: '500', piezas: 0 }] };
    const numero = `59-${CORRIDA}`;

    // 1. Primer conteo: un cheque y un vale nuevos (lo de otras corridas, fuera).
    const g1 = await arqueos.registrar({ ...base, documentos: await documentosQueCierran(arqueos, {
      cheques: [{ estado: 'esta', monto: 10121, banco: 'Banamex', numero, de_quien: 'Abarrotes La Luz', fecha: '2026-10-19' }],
      papeles: [{ estado: 'esta', clase: 'vale', monto: 20782, de_quien: 'Pedro Ramírez', concepto: 'anticipo de viáticos' }],
    }) }, CAJERA);
    expect(g1.arqueo).toMatchObject({ cheques: 10121, papeles: 20782 });
    expect(g1.documentos.cheques).toMatchObject({ total: 10121, entraron: 1, siguen: 0 });

    // 2. Lo que la pantalla pide marcar ahora: esos dos, con el día en que se vieron.
    const d = await arqueos.documentosEnCaja();
    // La llave es el último arqueo y `[CGS.60]` la huella de los movimientos con cheques o papeles.
    expect(d.instalado).toBe(true);
    expect(d.base?.split('|')[0]).toBe(g1.arqueo.folio);
    expect(d.cheques.piezas).toEqual([expect.objectContaining({ banco: 'Banamex', numero, monto: 10121, fecha: '2026-10-19' })]);
    expect(d.papeles.piezas).toEqual([expect.objectContaining({ clase: 'vale', de_quien: 'Pedro Ramírez', monto: 20782 })]);
    const [ch] = d.cheques.piezas;
    const [va] = d.papeles.piezas;

    // ⛔ [negativa] Un documento que había no desaparece sin marcarse.
    await expect(arqueos.registrar({ ...base, documentos: { base: d.base, cheques: [], papeles: [{ pieza: va.pieza, estado: 'esta' }] } }, CAJERA))
      .rejects.toThrow(/Marca cada documento/);
    // ⛔ [negativa] Un importe tecleado sin sus renglones.
    await expect(arqueos.registrar({ ...base, cheques: 10121 as unknown as null }, CAJERA)).rejects.toBeInstanceOf(BadRequestException);

    // 3. Segundo conteo: el cheque se depositó, el vale sigue, entra un crédito.
    const g2 = await arqueos.registrar({ ...base, documentos: { base: d.base,
      cheques: [{ pieza: ch.pieza, estado: 'salio', salida: 'depositado' }],
      papeles: [{ pieza: va.pieza, estado: 'esta' },
        { estado: 'esta', clase: 'credito', monto: 1952, de_quien: 'Tienda Lupita', concepto: 'venta de la ruta 27' }] } }, CAJERA);
    expect(g2.arqueo).toMatchObject({ cheques: 0, papeles: 22734 });
    expect(g2.documentos.cheques?.salieron).toEqual([{ texto: `Banamex ${numero} · Abarrotes La Luz`, monto: 10121, salida: 'depositado', nota: null }]);
    expect(g2.documentos.papeles).toMatchObject({ total: 22734, siguen: 1, entraron: 1 });

    // ⛔ [negativa] Dos conteos a la vez: quien abrió antes del segundo guardado ya no ve lo de ahora (409).
    await expect(arqueos.registrar({ ...base, documentos: { base: d.base, cheques: [], papeles: [] } }, CAJERA))
      .rejects.toBeInstanceOf(ConflictException);

    // El vale es la misma pieza y conserva el día en que se vio por primera vez.
    const d2 = await arqueos.documentosEnCaja();
    expect(d2.cheques.piezas).toEqual([]);
    expect(d2.papeles.piezas.find((p) => p.pieza === va.pieza)?.visto_desde).toBe(va.visto_desde);

    // ⛔ [negativa] La BASE exige que el importe sea la suma de sus renglones, aunque se le llegue directo…
    await expect(tk.run((trx) => trx('finance.cash_arqueos').insert({
      tenant_id: T, tipo: 'intermedio', piezas: '[]', efectivo: 0, cheques: 100, created_by: CAJERA.id,
    }))).rejects.toMatchObject({ constraint: 'cash_arqueo_cheques_no_suman' });
    // …y no deja agregarle renglones a un arqueo ya guardado.
    await expect(tk.run((trx) => trx('finance.cash_arqueo_documentos').insert({
      tenant_id: T, arqueo_id: g2.arqueo.folio, pieza: randomUUID(), tipo: 'cheque', estado: 'esta', monto: 5,
      banco: 'BBVA', numero: `X-${CORRIDA}`, de_quien: 'Alguien Más', created_by: CAJERA.id,
    }))).rejects.toMatchObject({ constraint: 'cash_arqueo_cheques_no_suman' });
    // ⛔ Un renglón no se corrige: app_runtime no tiene UPDATE.
    await expect(tk.run((trx) => trx('finance.cash_arqueo_documentos').where({ arqueo_id: g2.arqueo.folio }).update({ monto: 1 })))
      .rejects.toThrow(/permission denied/);
  });

  it('⛔ `[CGS.3]` (D2) con dos cortes cerrados sin revisar no se cierra el tercero; revisado uno, sí', async () => {
    const antes = process.env['CAJA_CANDADO_REVISION_DESDE'];
    process.env['CAJA_CANDADO_REVISION_DESDE'] = dia('04-01');
    try {
      const S = suc('C3');
      const cierra = async (mmdd: string) => {
        const c = await svc.abrir({ fecha: dia(mmdd), sucursal: S, fondo_inicial: 500 }, CAJERA);
        await svc.contar(c.id, { conteo: conteo(['500', 500, 1]), morralla: 0 }, CAJERA);
        return c;
      };
      const c1 = await cierra('04-02'); await svc.cerrar(c1.id, {}, CAJERA);
      const c2 = await cierra('04-03'); await svc.cerrar(c2.id, {}, CAJERA);
      const c3 = await cierra('04-04');
      await expect(svc.cerrar(c3.id, {}, CAJERA)).rejects.toThrow(/2 cerrados sin revisar/);
      expect((await corte(c3.id)).estado).toBe('borrador');

      await svc.autorizar(c1.id, AUTORIZA, CON_NOTA);
      expect((await svc.cerrar(c3.id, {}, CAJERA)).estado).toBe('cerrado');
    } finally {
      if (antes === undefined) delete process.env['CAJA_CANDADO_REVISION_DESDE'];
      else process.env['CAJA_CANDADO_REVISION_DESDE'] = antes;
    }
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

  /**
   * ⛔⛔ `[CGP-L.12]` **LA JORNADA ES LA DEL EFECTIVO, Y SI NO LO ES SE INVENTA UN FALTANTE.**
   *
   * Edgar, 2026-10-15: *«al corte de Caja General no se le considera lo dispensado en CAOS, al menos
   * en ingreso; si es egreso y existe un sobrante, se le carga a Caja General»*. El motor ya lo hace:
   * la dispensación y su gasto **se cancelan**, y al cajón sólo le llega la morralla. Pero eso exige
   * que las dos piernas caigan en la MISMA jornada.
   *
   * Acá se reproduce el caso real: un gasto pagado el día D con billetes que CAOS entregó el día D,
   * con el papel de Kepler fechado D−3 (su rezago medido es de 3 días, `[CG.82]`).
   *
   * **Antes del arreglo** el corte filtraba el libro por `fecha` y el cajero por `accounting_date`:
   * sumaba `+2,000` de dispensación **sin su gasto** y publicaba un faltante de $2,000 que nadie
   * perdió. Mutación: devolver `sueltosDe()` a `.where('fecha', dia)` pone esta prueba en rojo.
   */
  it('`[CGP-L.12]` la dispensación y su gasto caen en el mismo corte aunque el papel sea de otro día', async () => {
    const d = await diaDespuesDelUltimo('00');
    const papel = `${String(Number(d.slice(0, 4))).padStart(4, '0')}-${d.slice(5, 7)}-01`; // el documento, de otro día
    expect(papel).not.toBe(d);

    // El gasto: el papel es del día `papel`, pero el efectivo salió del cajón el día `d`.
    await movimiento(papel, '00', 'gasto', 2000, d);
    // ⚠️ La bóveda se siembra DESPUÉS de abrir, no antes. Si `abrir` falla (la 00 es una sola para
    // todas las corridas y un borrador viejo la traba), una dispensación huérfana queda en ese día
    // y la levanta el corte de la corrida SIGUIENTE: medido, le sumó $2,000 al esperado de
    // `[CG.160]` y lo dejó en 3,300. El corte ya existe cuando `contar` lee la bóveda.
    const c = await svc.abrir({ fecha: d, sucursal: '00', fondo_inicial: 500 }, CAJERA);
    // Los billetes con los que se pagó salieron de la bóveda ESE día.
    await caos(d, 4 /* DISPENSAR */, 2000);
    const sellado = await svc.contar(c.id, { conteo: conteo(['500', 500, 1]), morralla: 0 }, CAJERA);

    // +2,000 de la bóveda − 2,000 del gasto = 0. En el cajón sólo quedó el fondo.
    expect(sellado.totales).toMatchObject({ esperado: 500, contado: 500, veredicto: 'cuadra' });
    expect(Number((await svc.cerrar(c.id, {}, CAJERA)).esperado)).toBe(500);
    await svc.autorizar(c.id, AUTORIZA, CON_NOTA);
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
    // ~1000 años atrás: antes de cualquier corte de prueba. ⚠️ El año va RELLENO a 4 dígitos: el
    // servidor responde "0995-05-11" y con ANIO < 2000 la prueba sembraba "995-05-11" y fallaba una
    // de cada tres corridas (lo destapó elegir el año entre los libres).
    const y = String(ANIO - 1000).padStart(4, '0');
    const ancla = `${y}-05-10`;
    const pendiente = `${y}-05-11`;
    await tk.run(async (trx) => {
      await trx('finance.cash_ledger_cuts').insert({
        tenant_id: T, folio: `CC-ANCLA-L4-${ANIO}-${CORRIDA}`, fecha: ancla, sucursal: '00', estado: 'cerrado',
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

  it('`[CGP-V.2]` el saldo publica lo SELLADO pieza por pieza, y después del reconteo, el del reconteo', async () => {
    const f = dia('03-10');
    const c = await svc.abrir({ fecha: f, sucursal: suc('V2'), fondo_inicial: 500 }, CAJERA);
    await movimiento(f, suc('V2'), 'ingreso', 1000);

    // ⛔ [negativa] Sin conteo no hay nada sellado que mostrar: el arqueo sigue ciego.
    expect((await svc.saldo(suc('V2'), false)).corte_abierto?.conteo_sellado).toBeNull();

    await svc.contar(c.id, { conteo: conteo(['1000', 1000, 1], ['200', 200, 2]), morralla: 3.5 }, CAJERA);
    const s1 = (await svc.saldo(suc('V2'), false)).corte_abierto?.conteo_sellado;
    expect(s1).toMatchObject({ contado: 1403.5, morralla: 3.5 });
    expect(s1?.desglose).toEqual([
      { denom_key: '1000', denominacion: 1000, piezas: 1 },
      { denom_key: '200', denominacion: 200, piezas: 2 },
    ]);

    await svc.recontar(c.id, {
      conteo: conteo(['1000', 1000, 1], ['500', 500, 1]), morralla: 0, motivo: 'Faltó contar el billete de 500',
    }, CAJERA);
    const s2 = (await svc.saldo(suc('V2'), false)).corte_abierto?.conteo_sellado;
    expect(s2).toMatchObject({ contado: 1500, morralla: 0, ya_reconto: true });
    expect(s2?.desglose?.map((d) => d.denom_key)).toEqual(['1000', '500']);

    // Y lo que se publica es lo que cerrar() firma: cerrar con la reja vacía usa ESE desglose.
    const cerrado = await svc.cerrar(c.id, { conteo: [], morralla: 0 }, CAJERA);
    expect(Number(cerrado.contado)).toBe(1500);
  });

  it('`[CGP-V.9]` contar CERO declarado: se sella, saldo() lo publica, no se re-sella, y se cierra', async () => {
    const f = dia('03-11');
    const c = await svc.abrir({ fecha: f, sucursal: suc('V9'), fondo_inicial: 0 }, CAJERA);
    // ⛔ [negativa] la reja vacía SIN declarar sigue siendo «no se contó»
    await expect(svc.contar(c.id, { conteo: [], morralla: 0 }, CAJERA)).rejects.toBeInstanceOf(BadRequestException);

    const r = await svc.contar(c.id, { conteo: [], morralla: 0, cero_declarado: true }, CAJERA);
    expect(r.totales).toMatchObject({ contado: 0, veredicto: 'cuadra' });
    // El cero sellado se publica: sin esto la pantalla volvía a ofrecer «Guardar conteo».
    const s0 = (await svc.saldo(suc('V9'), false)).corte_abierto?.conteo_sellado;
    expect(s0).toMatchObject({ contado: 0, desglose: [], morralla: 0 });
    // ⛔ [negativa] un cero sellado NO se vuelve a sellar por la puerta de atrás
    await expect(svc.contar(c.id, { conteo: conteo(['100', 100, 1]), morralla: 0 }, CAJERA))
      .rejects.toThrow(/ya tiene un conteo sellado/);

    const cerrado = await svc.cerrar(c.id, { conteo: [], morralla: 0 }, CAJERA);
    expect(cerrado.estado).toBe('cerrado');
    expect(Number((await corte(c.id)).contado)).toBe(0);
  });

  it('⛔ `[CGP-V.9]` declarar cero con piezas en la reja es una contradicción: 400 con frase', async () => {
    const c = await svc.abrir({ fecha: dia('03-12'), sucursal: suc('V9b'), fondo_inicial: 0 }, CAJERA);
    await expect(svc.contar(c.id, { conteo: conteo(['100', 100, 1]), morralla: 0, cero_declarado: true }, CAJERA))
      .rejects.toThrow(/no hay efectivo/);
    expect((await corte(c.id)).contado).toBeNull();   // nada quedó sellado
  });

  it('`[CGP-L.7]` abrir, cerrar, autorizar y listar responden con el dinero como número y la fecha como día', async () => {
    const f = dia('03-13');
    const c = await svc.abrir({ fecha: f, sucursal: suc('T7'), fondo_inicial: 500 }, CAJERA);
    // Antes: '500.00' (texto) y un Date que por JSON viajaba con hora.
    expect(c.fondo_inicial).toBe(500);
    expect(c.fecha).toBe(f);
    await movimiento(f, suc('T7'), 'ingreso', 1000);
    await svc.contar(c.id, { conteo: conteo(['1000', 1000, 1], ['500', 500, 1]), morralla: 0 }, CAJERA);
    const cerrado = await svc.cerrar(c.id, {}, CAJERA);
    expect(cerrado.esperado).toBe(1500);
    expect(cerrado.contado).toBe(1500);
    const aut = await svc.autorizar(c.id, AUTORIZA, CON_NOTA);
    expect(aut.estado).toBe('autorizado');
    expect(typeof aut.authorized_at).toBe('string');
    const l = await svc.listar({ sucursal: suc('T7') });
    expect(l.rows[0]).toMatchObject({ folio: c.folio, fecha: f, esperado: 1500, diferencia: 0 });
    // Lo que no es del contrato no sale.
    expect((l.rows[0] as unknown as Record<string, unknown>)['tenant_id']).toBeUndefined();
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
  /**
   * `[CGP-E.1]` **El proceso, no la pantalla: tres jornadas seguidas, con un oráculo independiente.**
   *
   * Cada esperado lo calcula ESTA prueba con la fórmula escrita aparte —fondo + ingresos − gastos −
   * depósitos—, no el motor: un árbitro que repite al motor es un espejo (R5). En una plaza que no es
   * la 00 no hay bóveda ni cajero, así que la fórmula es exacta.
   *
   * ⚠️ El plan lo pide por HTTP con la API levantada en el CI. Acá va a nivel de servicio (el mismo
   * código, la misma base): levantar el backend en local está prohibido. La capa HTTP queda para el CI.
   * ⚠️ El fondo del primer día se DECLARA: el arqueo de Control no existe en la base de prueba.
   */
  describe('[CGP-E.1] el proceso de tres jornadas', () => {
    const oraculo = (fondo: number, movs: Array<['ingreso' | 'gasto' | 'deposito', number]>) =>
      Math.round((fondo + movs.reduce((a, [t, m]) => a + (t === 'ingreso' ? m : -m), 0)) * 100) / 100;

    it('abrir, mover, contar a ciegas, cerrar, autorizar otra persona; heredar; y jornadas en orden', async () => {
      const S = suc('E1');

      // ── Jornada 1: fondo declarado, tres tipos de movimiento, cuadra al centavo ──
      const d1 = dia('04-01');
      const c1 = await svc.abrir({ fecha: d1, sucursal: S, fondo_inicial: 500 }, CAJERA);
      const movs1: Array<['ingreso' | 'gasto' | 'deposito', number]> = [['ingreso', 1000], ['ingreso', 250.5], ['gasto', 200], ['deposito', 300]];
      for (const [t, m] of movs1) await movimiento(d1, S, t as 'ingreso' | 'gasto', m);
      const esp1 = oraculo(500, movs1);                                   // 1,250.50
      const r1 = await svc.contar(c1.id, { conteo: conteo(['1000', 1000, 1], ['200', 200, 1], ['50', 50, 1]), morralla: 0.5 }, CAJERA);
      expect(r1.totales).toMatchObject({ esperado: esp1, contado: esp1, veredicto: 'cuadra' });
      const k1 = await svc.cerrar(c1.id, {}, CAJERA);
      expect(k1.esperado).toBe(esp1);
      await expect(svc.autorizar(c1.id, CAJERA)).rejects.toBeInstanceOf(ForbiddenException);   // doble llave
      expect((await svc.autorizar(c1.id, AUTORIZA, CON_NOTA)).estado).toBe('autorizado');

      // ── Jornada 2: el fondo se HEREDA del contado anterior; falta, se recuenta con motivo ──
      const d2 = dia('04-02');
      const c2 = await svc.abrir({ fecha: d2, sucursal: S }, CAJERA);
      expect(c2).toMatchObject({ fondo_inicial: esp1, fondo_origen: 'cierre_anterior' });
      const movs2: Array<['ingreso' | 'gasto' | 'deposito', number]> = [['gasto', 100], ['ingreso', 500]];
      for (const [t, m] of movs2) await movimiento(d2, S, t as 'ingreso' | 'gasto', m);
      const esp2 = oraculo(esp1, movs2);                                  // 1,650.50
      const primero = await svc.contar(c2.id, { conteo: conteo(['1000', 1000, 1], ['500', 500, 1], ['100', 100, 1]), morralla: 0.5 }, CAJERA);
      expect(primero.totales).toMatchObject({ esperado: esp2, veredicto: 'falta', diferencia: -50 });
      const re = await svc.recontar(c2.id, {
        conteo: conteo(['1000', 1000, 1], ['500', 500, 1], ['100', 100, 1], ['50', 50, 1]), morralla: 0.5,
        motivo: 'Faltó contar un billete de 50',
      }, CAJERA);
      expect(re.totales).toMatchObject({ contado: esp2, veredicto: 'cuadra' });
      expect((await svc.cerrar(c2.id, {}, CAJERA)).esperado).toBe(esp2);
      await svc.autorizar(c2.id, AUTORIZA, CON_NOTA);

      // ── Jornadas 3 y 4: hay movimientos en las dos; se cierran EN ORDEN y cada una ata sólo lo suyo ──
      const d3 = dia('04-03');
      const d4 = dia('04-04');
      await movimiento(d3, S, 'ingreso', 400);
      await movimiento(d4, S, 'gasto', 150);
      const c3 = await svc.abrir({ fecha: d3, sucursal: S }, CAJERA);
      expect(c3.fondo_inicial).toBe(esp2);
      // Mientras la 3 está abierta, no se abre otra: un borrador por sucursal.
      await expect(svc.abrir({ fecha: d4, sucursal: S }, CAJERA)).rejects.toBeInstanceOf(BadRequestException);
      const esp3 = oraculo(esp2, [['ingreso', 400]]);                     // 2,050.50
      await svc.contar(c3.id, { conteo: conteo(['1000', 1000, 2], ['50', 50, 1]), morralla: 0.5 }, CAJERA);
      const k3 = await svc.cerrar(c3.id, {}, CAJERA);
      expect(k3.esperado).toBe(esp3);                                     // el gasto del día 4 NO entró
      await svc.autorizar(c3.id, AUTORIZA, CON_NOTA);

      const c4 = await svc.abrir({ fecha: d4, sucursal: S }, CAJERA);
      expect(c4.fondo_inicial).toBe(esp3);
      const esp4 = oraculo(esp3, [['gasto', 150]]);                       // 1,900.50
      await svc.contar(c4.id, { conteo: conteo(['1000', 1000, 1], ['500', 500, 1], ['200', 200, 2]), morralla: 0.5 }, CAJERA);
      expect((await svc.cerrar(c4.id, {}, CAJERA)).esperado).toBe(esp4);

      // Y un día anterior a todo lo cerrado ya no se abre: las jornadas se cierran en orden.
      await expect(svc.abrir({ fecha: dia('03-31'), sucursal: S }, CAJERA)).rejects.toThrow(/en orden/);
    });
  });
});
