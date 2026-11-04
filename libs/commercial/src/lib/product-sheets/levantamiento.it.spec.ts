/**
 * `[NP.7.L.2]` Regla 13: el levantamiento ESCRIBE (aparta, guarda fotos, salta caras) y no está probado
 * hasta que una prueba lo ejerce contra un Postgres real con el payload de la pantalla. Esto ejerce el
 * SERVICIO REAL (`LevantamientoService`) sobre `catalog.product_sheets` de verdad: CHECKs, índice único,
 * jsonb de fotos, UPDATE condicional del apartado. Los cuerpos son los que manda `/levantamiento`:
 * `{ code }` al escanear y los campos de `FormData` (todos texto) al subir una foto.
 *
 * Se sustituye sólo lo que la base vacía del CI no puede dar: la unidad más vendida y los conteos de la
 * pantalla de inicio (vistas materializadas, no admiten filas sembradas) y la sucursal del perfil
 * (`identity.users`), con métodos `protected` del servicio, y el bucket (un doble que cuenta lo que se sube
 * y lo que se borra).
 *
 * ⚠️ No cubre la capa HTTP (multer, guard, `design:paramtypes`): eso se declara en el PR.
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL que NO sea prod (`system_identifier`). Sin la
 * variable se salta y lo DICE en el título. TODO en una transacción que se revierte.
 */
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import knexFactory, { type Knex } from 'knex';
import { LevantamientoService, type ArchivoSubido, type Quien } from './levantamiento.service';
import { RevisionService } from './revision.service';
import { EN_CURSO_SQL } from './levantamiento.sql';
import { nuevoApartado } from './levantamiento.rules';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const MIG = '../../../../../database/migrations-newdb/20261102224652_np7_product_sheets.js';
const ANA: Quien = { userId: '00000000-0000-0000-0000-0000000a0a0a', username: 'np7_it_ana' };
const LUIS: Quien = { userId: '00000000-0000-0000-0000-0000000b0b0b', username: 'np7_it_luis' };
/** Alguien de OTRA sucursal (la 05). */
const OTRA: Quien = { userId: '00000000-0000-0000-0000-0000000e0e0e', username: 'np7_it_otra' };
/** Sin apartados de las otras pruebas: el tope de 3 no le libera nada a media prueba. */
const PEPE: Quien = { userId: '00000000-0000-0000-0000-0000000f0f0f', username: 'np7_it_pepe' };

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
const titulo = URL && local
  ? '[NP.7.L.2] Levantamiento contra Postgres real (transacción revertida)'
  : '[NP.7.L.2] NO MEDIDO — sin TP_IT_DB local la prueba de integración del levantamiento no corre';

/** Un segmento JPEG: marcador + largo (incluye sus 2 bytes) + datos. */
const seg = (m: number, datos: string): Buffer => {
  const d = Buffer.from(datos, 'latin1');
  return Buffer.concat([Buffer.from([0xff, m, (d.length + 2) >> 8, (d.length + 2) & 0xff]), d]);
};
/**
 * Una «foto»: un JPEG que se puede recorrer (SOI, JFIF, EXIF CON GPS, tablas, escaneo, EOI), distinta en
 * cada llamada para que su sha256 cambie. El GPS va a propósito: lo que se guarda tiene que salir sin él.
 */
let n = 0;
const jpeg = (): ArchivoSubido => {
  n += 1;
  const buffer = Buffer.concat([
    Buffer.from([0xff, 0xd8]), seg(0xe0, 'JFIF\0\x01\x01\0\0\x01\0\x01\0\0'),
    seg(0xe1, 'Exif\0\0GPSLatitude 20.6597 GPSLongitude -103.3496'),
    seg(0xdb, '\0' + 'x'.repeat(64)), seg(0xda, '\x01\x01\0\0\x3f\0'), Buffer.from(`np7-it-foto-${n}`, 'latin1'), Buffer.from([0xff, 0xd9]),
  ]);
  return { buffer, size: buffer.length, originalname: 'frente.jpg', mimetype: 'image/jpeg' };
};
/** Los campos de FormData, como texto (así llegan del navegador). */
const meta = (face: string) => ({ face, sharpness: '812.4', contrast: '61.2', quality_version: 'lap4-v1-provisional', width: '3024', height: '4032' });
const CARAS = ['frente', 'reverso', 'lateral_izq', 'lateral_der', 'base'];

class Prueba extends LevantamientoService {
  rungs = new Map<string, number>();
  perfiles = new Map<string, string>();
  protected override async rungModal(_trx: Knex.Transaction, _branch: string, sku: string): Promise<number | null> {
    return this.rungs.get(sku) ?? null;
  }
  protected override async sucursalDelPerfil(userId: string): Promise<string> {
    return this.perfiles.get(userId) ?? '';
  }
  protected override async conteos(): Promise<{ universe: number; missing: number }> {
    return { universe: 12, missing: 9 };
  }
}

suite(titulo, () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  let svc: Prueba;
  const subidas: string[] = [];
  const borradas: string[] = [];
  /** Lo que de verdad llegó al bucket, por llave: para comprobar que se guardó SIN metadatos. */
  const bytes = new Map<string, Buffer>();
  let falloAlGuardar = false;

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
    if (!(await trx.raw(`SELECT to_regclass('catalog.product_sheets') AS r`)).rows[0].r) {
      const m = createRequire(__filename)(resolvePath(__dirname, MIG)) as { up: (k: Knex) => Promise<void> };
      await m.up(trx);
    }
    // Fichas REALES de Kepler (sucursal 01, 2026-11-02) con un sufijo para no chocar con datos de la base.
    const kdii = (sku: string, o: Record<string, unknown>) => ({ sucursal: '01', c1: sku, c11: 'PZA', c80: 'PAQ', c83: 'CJA', ...o });
    await trx('kepler_ods.kdii').insert([
      kdii('NP7IT1', { c2: 'TRIDENT XTRA CARE MENTA /12 (IT)', c7: '7622210571403', c82: '7501056960216', c81: 12, c84: 384, c85: 'CNP7IT1' }),
      kdii('NP7IT2', { c2: 'TIC TAC CANELA /12 (IT)', c7: '9990000000017', c81: 12, c84: 144 }),
      kdii('NP7IT3', { c2: 'COMPARTIDO A (IT)', c7: '9990000000024' }),
      kdii('NP7IT4', { c2: 'COMPARTIDO B (IT)', c93: '9990000000024' }),
      ...['NP7IT5', 'NP7IT6', 'NP7IT7', 'NP7IT8'].map((s, i) => kdii(s, { c2: `PRODUCTO ${s} (IT)`, c7: `99900000001${i}0` })),
      // Los casos de la revisión del PR: uno por producto, para que no se pisen entre sí.
      ...['NP7IT9', 'NP7IT10', 'NP7IT11', 'NP7IT12'].map((s, i) => kdii(s, { c2: `PRODUCTO ${s} (IT)`, c7: `99900000002${i + 1}0` })),
      kdii('NP7IT11', { sucursal: '05', c2: 'PRODUCTO NP7IT11 (IT)', c7: '9990000000230' }),
      // La primera captura en prod (2026-11-03): el frente saltado y una ficha sin fotos en «Por revisar».
      kdii('NP7IT13', { c2: 'PRODUCTO NP7IT13 (IT)', c7: '9990000000250' }),
      kdii('NP7IT14', { c2: 'PRODUCTO NP7IT14 (IT)', c7: '9990000000260' }),
    ]);
    svc = new Prueba(
      { run: <T>(fn: (t: Knex.Transaction) => Promise<T>) => fn(trx) } as never,
      { requireTenantId: () => M } as never,
      { assertCanWrite: async () => { throw new Error('sin alcance'); } } as never,
      {
        putBuffer: async (b: Buffer, _t: string, folder: string) => { const key = `${folder}/${subidas.length + 1}.jpg`; subidas.push(key); bytes.set(key, b); return { key }; },
        remove: async (key: string) => { borradas.push(key); },
      } as never,
    );
    for (const s of ['NP7IT1', 'NP7IT2', 'NP7IT5', 'NP7IT6', 'NP7IT7', 'NP7IT8', 'NP7IT9', 'NP7IT10', 'NP7IT11', 'NP7IT12', 'NP7IT13', 'NP7IT14']) svc.rungs.set(s, 1);
    svc.perfiles.set(ANA.userId, '01');
    svc.perfiles.set(LUIS.userId, '01');
    svc.perfiles.set(PEPE.userId, '01');
    svc.perfiles.set(OTRA.userId, '05');
    // El fallo al guardar se simula rompiendo la transacción corta del guardado UNA vez.
    const run = (svc as unknown as { tk: { run: <T>(fn: (t: Knex.Transaction) => Promise<T>) => Promise<T> } }).tk;
    const original = run.run;
    run.run = async <T>(fn: (t: Knex.Transaction) => Promise<T>) => {
      if (falloAlGuardar && fn.toString().includes('guardarCara')) { falloAlGuardar = false; throw new Error('guardado falló (simulado)'); }
      return original(fn);
    };
  }, 120_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
  });

  let sheet = '';

  it('escanear el código de la pieza → aparta la ficha y pide las 5 caras', async () => {
    const r = await svc.escanear(ANA, { code: '7622210571403' });
    expect(r).toMatchObject({ action: 'capturar', sku: 'NP7IT1', faces: CARAS, faces_done: [], scanned: { rung: 'base' }, principal: { rung: 'base' } });
    sheet = String(r.sheet_id);
    const fila = await trx('catalog.product_sheets').where({ id: sheet }).first('origin', 'status', 'sku', 'branch_code', 'sheet', 'tenant_id');
    expect(fila).toMatchObject({ origin: 'levantamiento', status: 'en_captura', sku: 'NP7IT1', branch_code: '01', tenant_id: M });
    expect(fila.sheet).toMatchObject({ principal: 'base', sucursal_por: 'perfil', peldanos: { base: { apartado: { by: ANA.userId }, codigo_escaneado: '7622210571403' } } });
  });

  it('⭐ el mismo producto escaneado por otra persona mientras está apartado → «apartado por otro»', async () => {
    expect((await svc.escanear(LUIS, { code: '7622210571403' })).action).toBe('apartado_por_otro');
  });

  it('⭐ D23: el código del paquete cuando la unidad principal es la pieza → otra_unidad, sin apartar', async () => {
    const r = await svc.escanear(LUIS, { code: '7501056960216' });
    expect(r.action).toBe('otra_unidad');
    expect(r.sheet_id).toBeNull();
  });

  it('código compartido y código que nadie tiene → no se captura ni se crea ficha', async () => {
    const antes = Number((await trx('catalog.product_sheets').count('* as n'))[0].n);
    expect((await svc.escanear(ANA, { code: '9990000000024' })).action).toBe('codigo_compartido');
    expect((await svc.escanear(ANA, { code: '7500000000000' })).action).toBe('no_registrado');
    expect(Number((await trx('catalog.product_sheets').count('* as n'))[0].n)).toBe(antes);
  });

  it('prueba negativa: un archivo que no es foto → 400, y nada sube al bucket', async () => {
    const pdf = Buffer.from('%PDF-1.4 no soy foto');
    await expect(svc.foto(ANA, sheet, { buffer: pdf, size: pdf.length }, meta('frente'))).rejects.toThrow(/no es una foto/);
    expect(subidas).toHaveLength(0);
  });

  it('⛔ otra persona no puede subir fotos a una captura apartada por alguien más', async () => {
    await expect(svc.foto(LUIS, sheet, jpeg(), meta('frente'))).rejects.toThrow(/Alguien más/);
  });

  it('⭐ si el guardado falla, la foto ya subida se BORRA del bucket (sin huérfanas)', async () => {
    falloAlGuardar = true;
    await expect(svc.foto(ANA, sheet, jpeg(), meta('frente'))).rejects.toThrow(/simulado/);
    expect(borradas).toEqual([subidas[subidas.length - 1]]);
  });

  it('⭐ las 5 caras con el payload de FormData → fotos_tomadas, con sha256 y la medición de calidad', async () => {
    let ultima = null as Awaited<ReturnType<Prueba['foto']>> | null;
    for (const c of CARAS) ultima = await svc.foto(ANA, sheet, jpeg(), meta(c));
    expect(ultima).toMatchObject({ status: 'fotos_tomadas', complete: true });
    const fila = await trx('catalog.product_sheets').where({ id: sheet }).first('status', 'photos', 'sheet');
    expect(fila.status).toBe('fotos_tomadas');
    expect(fila.photos).toHaveLength(5);
    expect(fila.photos[0]).toMatchObject({ peldano: 'base', captured_by: ANA.userId, saltada_motivo: null, calidad: { nitidez: 812.4, contraste: 61.2 }, ancho: 3024, alto: 4032 });
    expect(new Set(fila.photos.map((p: { sha256: string }) => p.sha256)).size).toBe(5);
    expect(fila.sheet.peldanos.base.apartado).toBeNull();
  });

  it('volver a escanear un producto ya levantado → «en revisión», no se duplica', async () => {
    expect((await svc.escanear(LUIS, { code: '7622210571403' })).action).toBe('en_revision');
    expect(Number((await trx('catalog.product_sheets').where({ sku: 'NP7IT1' }).count('* as n'))[0].n)).toBe(1);
  });

  it('saltar una cara con motivo cuenta como resuelta; sin motivo válido → 400', async () => {
    const r = await svc.escanear(LUIS, { code: '9990000000017' });
    expect(r.action).toBe('capturar');
    await expect(svc.saltar(LUIS, String(r.sheet_id), { face: 'base', reason: 'porque si' as never })).rejects.toThrow(/Elige por qué/);
    for (const c of CARAS.slice(0, 4)) await svc.foto(LUIS, String(r.sheet_id), jpeg(), meta(c));
    const fin = await svc.saltar(LUIS, String(r.sheet_id), { face: 'base', reason: 'no_se_puede_girar' });
    expect(fin).toMatchObject({ status: 'fotos_tomadas', complete: true });
    const fila = await trx('catalog.product_sheets').where({ id: r.sheet_id }).first('photos');
    expect(fila.photos.find((p: { cara: string }) => p.cara === 'base')).toMatchObject({ storage_key: null, saltada_motivo: 'no_se_puede_girar' });
  });

  it('⭐ un cuarto apartado libera el más viejo SIN fotos', async () => {
    // 5 ms entre escaneos: el desempate es por vencimiento, y dos apartados del mismo milisegundo empatarían.
    const pausa = () => new Promise((r) => setTimeout(r, 5));
    const a = await svc.escanear(ANA, { code: '9990000000100' }); await pausa();
    const b = await svc.escanear(ANA, { code: '9990000000110' }); await pausa();
    const c = await svc.escanear(ANA, { code: '9990000000120' }); await pausa();
    expect([a.action, b.action, c.action]).toEqual(['capturar', 'capturar', 'capturar']);
    const d = await svc.escanear(ANA, { code: '9990000000130' });
    expect(d.action).toBe('capturar');
    const liberada = await trx('catalog.product_sheets').where({ id: a.sheet_id }).first('sheet');
    expect(liberada.sheet.peldanos.base.apartado).toBeUndefined();
  });

  it('soltar el apartado propio deja el producto libre para otra persona', async () => {
    const r = await svc.escanear(ANA, { code: '9990000000120' });
    await svc.soltar(ANA, String(r.sheet_id));
    expect((await svc.escanear(LUIS, { code: '9990000000120' })).action).toBe('capturar');
  });

  it('⭐ la pantalla de inicio carga su contexto (en prod daba 500: pedía `identity.users.full_name`, que no existe)', async () => {
    // En un savepoint: si la consulta truena, la transacción compartida por toda la suite sigue viva.
    await trx.raw('SAVEPOINT np7_ctx');
    try {
      // Ana existe en identity.users (dentro del savepoint): el nombre que ve la pantalla sale de `nombre`.
      const rol = (await trx('identity.role_permissions').where({ tenant_id: M }).first('role_name'))?.role_name;
      await trx('identity.users').insert({ id: ANA.userId, tenant_id: M, username: ANA.username, nombre: 'Ana de la Prueba', role_name: rol, password_hash: 'np7-it' });
      const c = await svc.contexto(ANA);
      expect(c).toMatchObject({
        branch_code: '01', branch_source: 'perfil', universe: 12, missing: 9, ai_enabled: false,
        user: { id: ANA.userId, username: ANA.username, name: 'Ana de la Prueba' },
      });
    } finally {
      await trx.raw('ROLLBACK TO SAVEPOINT np7_ctx');
    }
  });

  /** Una cara saltada con la forma que guarda el servicio (para sembrar fichas de ANTES de una regla). */
  const salto = (cara: string, by: string) => ({
    peldano: 'base', cara, storage_key: null, sha256: null, captured_by: by, captured_at: new Date().toISOString(),
    saltada_motivo: 'otro', calidad: null, ancho: null, alto: null, por_busqueda: false,
  });

  it('⛔ el frente no se salta (400): así toda ficha completa trae al menos una foto real (la primera captura en prod llegó a «Por revisar» con las 5 caras saltadas)', async () => {
    const r = await svc.escanear(PEPE, { code: '9990000000250' });
    expect(r.action).toBe('capturar');
    const id = String(r.sheet_id);
    await expect(svc.saltar(PEPE, id, { face: 'frente', reason: 'no_tiene_esa_cara' })).rejects.toThrow(/El frente siempre se fotografía/);
    expect((await trx('catalog.product_sheets').where({ id }).first('photos')).photos).toEqual([]);
    // Control: las demás caras sí se saltan.
    expect(await svc.saltar(PEPE, id, { face: 'reverso', reason: 'no_se_puede_girar' })).toMatchObject({ faces_done: ['reverso'], complete: false });
  });

  it('⭐ un salto VIEJO del frente (de antes de la regla) no cuenta: con las otras 4 saltadas la ficha NO se envía y se vuelve a pedir el frente', async () => {
    const id = await idDe('NP7IT13');
    // Así quedó en prod la ficha 31054: el frente saltado antes de que existiera la regla.
    const f = await trx('catalog.product_sheets').where({ id }).first('photos');
    await trx('catalog.product_sheets').where({ id }).update({ photos: JSON.stringify([salto('frente', PEPE.userId), ...f.photos]) });
    let ult: unknown;
    for (const c of ['lateral_izq', 'lateral_der', 'base']) ult = await svc.saltar(PEPE, id, { face: c as never, reason: 'otro' });
    expect(ult).toMatchObject({ status: 'en_captura', complete: false, faces_done: ['reverso', 'lateral_izq', 'lateral_der', 'base'] });
    expect((await svc.escanear(PEPE, { code: '9990000000250' })).faces_done).not.toContain('frente');
    // Con la foto del frente, se completa.
    expect(await svc.foto(PEPE, id, jpeg(), meta('frente'))).toMatchObject({ status: 'fotos_tomadas', complete: true });
  });

  it('D25: sin sucursal en el perfil y sin elegir → SUCURSAL_REQUERIDA', async () => {
    const sinSucursal: Quien = { userId: '00000000-0000-0000-0000-0000000c0c0c', username: 'np7_it_sin' };
    await expect(svc.escanear(sinSucursal, { code: '7622210571403' })).rejects.toMatchObject({ response: { code: 'SUCURSAL_REQUERIDA' } });
  });

  // ── `[NP.7.L.3b]` La bandeja «por revisar»: las decisiones también ESCRIBEN (regla 13) ──────────────
  const CATALOGO: Quien = { userId: '00000000-0000-0000-0000-0000000d0d0d', username: 'np7_it_catalogo' };
  const rev = () => new RevisionService(
    { run: <T>(fn: (t: Knex.Transaction) => Promise<T>) => fn(trx) } as never,
    { requireTenantId: () => M } as never,
    { signedUrl: async (k: string) => `https://firmada.invalid/${k}` } as never,
  );

  it('la bandeja trae lo levantado con su conteo por motivo y las fotos firmadas (sin costo ni precio)', async () => {
    const b = await rev().bandeja({ branch: '01' });
    const f = b.rows.find((x) => x.sku === 'NP7IT1')!;
    expect(f).toMatchObject({ status: 'fotos_tomadas', rung: 'base', scanned_code: '7622210571403', captured_by: ANA.username });
    expect(f.reasons).toContain('sin_analizar');
    expect(f.photos).toHaveLength(5);
    expect(String(f.photos[0].url).startsWith('https://firmada.invalid/')).toBe(true);
    expect(b.counts.sin_analizar).toBeGreaterThanOrEqual(2);
    expect(b.counts.caras_saltadas).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(b)).not.toMatch(/price|precio|cost|costo|margin|margen/i);
  });

  it('⭐ publicar deja la ficha publicada con su fecha; una SEGUNDA decisión sobre la misma ficha choca (409)', async () => {
    const id = sheet;
    expect(await rev().decidir(CATALOGO, id, { decision: 'publicar' })).toEqual({ id, status: 'publicada' });
    const fila = await trx('catalog.product_sheets').where({ id }).first('status', 'sheet');
    expect(fila.status).toBe('publicada');
    expect(fila.sheet.publicada.by).toBe(CATALOGO.userId);
    expect(fila.sheet.revisiones[0]).toMatchObject({ decision: 'publicar', by: CATALOGO.userId });
    await expect(rev().decidir(CATALOGO, id, { decision: 'publicar' })).rejects.toMatchObject({ status: 409 });
  });

  it('una ficha publicada responde «ya está» al escanearla', async () => {
    expect((await svc.escanear(LUIS, { code: '7622210571403' })).action).toBe('ya_esta');
  });

  it('prueba negativa: pedir otra foto SIN nota → 400; con nota → recapturar y vuelve a poder levantarse', async () => {
    const f = (await rev().bandeja({ branch: '01' })).rows.find((x) => x.sku === 'NP7IT2')!;
    await expect(rev().decidir(CATALOGO, f.id, { decision: 'recapturar', note: '  ' })).rejects.toMatchObject({ status: 400 });
    expect((await rev().decidir(CATALOGO, f.id, { decision: 'recapturar', note: 'el reverso salió cortado' })).status).toBe('recapturar');
    expect((await svc.escanear(LUIS, { code: '9990000000017' })).action).toBe('capturar');
  });

  it('descartar (con nota) es borrado lógico: sale de la bandeja y el producto se puede levantar otra vez', async () => {
    const r = await svc.escanear(ANA, { code: '9990000000130' });
    for (const c of CARAS) await svc.foto(ANA, String(r.sheet_id), jpeg(), meta(c));
    expect((await rev().decidir(CATALOGO, String(r.sheet_id), { decision: 'descartar', note: 'no es este producto' })).status).toBe('descartada');
    const fila = await trx('catalog.product_sheets').where({ id: r.sheet_id }).first('deleted_at', 'deleted_by');
    expect(fila.deleted_at).not.toBeNull();
    expect(fila.deleted_by).toBe(CATALOGO.userId);
    expect((await rev().bandeja({ branch: '01' })).rows.some((x) => x.id === r.sheet_id)).toBe(false);
    expect((await svc.escanear(LUIS, { code: '9990000000130' })).action).toBe('capturar');
  });

  // ── Lo que encontró la revisión independiente del PR (2026-11-03), contra la misma base ──────────────
  // ⚠️ Toda la prueba corre en UNA transacción: now() queda fijo al inicio. Un apartado «vencido» se fecha
  // en el año 2000, no se espera.
  const enCurso = async (id: string): Promise<boolean> =>
    (await trx.raw(`SELECT (${EN_CURSO_SQL}) AS v FROM catalog.product_sheets WHERE id = ?`, [id])).rows[0].v;
  type Semana = { published: number; in_review: number };
  const semana = (q: Quien): Promise<Semana> =>
    (svc as unknown as { semana: (t: Knex.Transaction, tn: string, b: string, u: string) => Promise<Semana> }).semana(trx, M, '01', q.userId);
  const vencer = (id: string) =>
    trx.raw(`UPDATE catalog.product_sheets SET sheet = jsonb_set(sheet, '{peldanos,base,apartado,until}', '"2000-01-01T00:00:00.000Z"') WHERE id = ?`, [id]);
  const idDe = async (sku: string): Promise<string> =>
    String((await trx('catalog.product_sheets').where({ sku, origin: 'levantamiento' }).whereNull('deleted_at').first('id')).id);

  it('⭐ una captura SOLTADA vuelve a los sugeridos (antes se quedaba «en curso» para siempre)', async () => {
    const r = await svc.escanear(ANA, { code: '9990000000210' });
    expect(r.action).toBe('capturar');
    const id = String(r.sheet_id);
    expect(await enCurso(id)).toBe(true);
    await svc.soltar(ANA, id);
    expect(await enCurso(id)).toBe(false);
  });

  it('⛔ sin apartado no se sube ni se salta nada: hay que escanear otra vez (el escaneo valida la sucursal)', async () => {
    const id = await idDe('NP7IT9');
    const antes = subidas.length;
    await expect(svc.foto(LUIS, id, jpeg(), meta('frente'))).rejects.toThrow(/Escanéalo otra vez/);
    await expect(svc.foto(ANA, id, jpeg(), meta('frente'))).rejects.toThrow(/Escanéalo otra vez/);
    await expect(svc.saltar(LUIS, id, { face: 'base', reason: 'otro' })).rejects.toThrow(/Escanéalo otra vez/);
    expect(subidas.length).toBe(antes);
  });

  it('⭐ el apartado VENCIDO lo retoma otra persona; el crédito es de quien TERMINÓ, no de quien empezó', async () => {
    const id = String((await svc.escanear(ANA, { code: '9990000000220' })).sheet_id);
    await svc.foto(ANA, id, jpeg(), meta('frente'));
    await vencer(id);
    const [ana0, luis0] = [await semana(ANA), await semana(LUIS)];
    expect(await svc.escanear(LUIS, { code: '9990000000220' })).toMatchObject({ action: 'capturar', sheet_id: id, faces_done: ['frente'], faces_skipped: [] });
    await expect(svc.foto(ANA, id, jpeg(), meta('reverso'))).rejects.toThrow(/Alguien más/);
    for (const c of CARAS.slice(1)) await svc.foto(LUIS, id, jpeg(), meta(c));
    const fila = await trx('catalog.product_sheets').where({ id }).first('status', 'created_by', 'sheet');
    expect(fila).toMatchObject({ status: 'fotos_tomadas', created_by: ANA.userId });
    expect(fila.sheet.capturo).toMatchObject({ by: LUIS.userId, username: LUIS.username });
    expect((await semana(LUIS)).in_review).toBe(luis0.in_review + 1);
    expect((await semana(ANA)).in_review).toBe(ana0.in_review);
    const enBandeja = (await rev().bandeja({ branch: '01' })).rows.find((x) => x.id === id);
    expect(enBandeja?.captured_by).toBe(LUIS.username);
    // La fecha es la de quien TERMINÓ, no la de cuando ANA creó la fila.
    expect(enBandeja?.captured_at).toBe(new Date(fila.sheet.capturo.at).toISOString());
  });

  it('⛔ nadie publica lo que capturó (403); otra persona de Catálogo sí', async () => {
    const id = await idDe('NP7IT10');
    await expect(rev().decidir(LUIS, id, { decision: 'publicar' })).rejects.toMatchObject({ status: 403 });
    // ANA no la terminó, pero tomó el frente: tampoco la publica.
    await expect(rev().decidir(ANA, id, { decision: 'publicar' })).rejects.toMatchObject({ status: 403 });
    expect((await rev().decidir(CATALOGO, id, { decision: 'publicar' })).status).toBe('publicada');
  });

  it('⭐ retomar desde OTRA sucursal empieza de cero: las fotos de la primera se guardan aparte', async () => {
    const id = String((await svc.escanear(ANA, { code: '9990000000230' })).sheet_id);
    await svc.foto(ANA, id, jpeg(), meta('frente'));
    await vencer(id);
    expect(await svc.escanear(OTRA, { code: '9990000000230' })).toMatchObject({ action: 'capturar', sheet_id: id, faces_done: [] });
    const fila = await trx('catalog.product_sheets').where({ id }).first('branch_code', 'photos', 'sheet');
    expect(fila.branch_code).toBe('05');
    expect(fila.photos).toEqual([]);
    expect(fila.sheet.fotos_anteriores).toHaveLength(1);
    expect(fila.sheet.sucursal_por).toBe('perfil');
  });

  it('⭐ repetir una cara BORRA del bucket la foto que reemplaza; y se guarda SIN EXIF (sin GPS)', async () => {
    const id = await idDe('NP7IT11');
    expect(jpeg().buffer.toString('latin1')).toMatch(/GPS/); // CONTROL: lo que manda el teléfono sí lo trae
    await svc.foto(OTRA, id, jpeg(), meta('frente'));
    const primera = subidas[subidas.length - 1];
    const b0 = borradas.length;
    await svc.foto(OTRA, id, jpeg(), meta('frente'));
    expect(borradas.slice(b0)).toEqual([primera]);
    const guardada = bytes.get(subidas[subidas.length - 1])!;
    expect([...guardada.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect(guardada.toString('latin1')).not.toMatch(/Exif|GPS/);
  });

  it('saltar una cara que ya tenía foto borra esa foto y la declara SALTADA (no cuenta como foto)', async () => {
    const id = await idDe('NP7IT11');
    await svc.foto(OTRA, id, jpeg(), meta('reverso'));
    const foto = subidas[subidas.length - 1];
    const r = await svc.saltar(OTRA, id, { face: 'reverso', reason: 'otro' });
    expect(borradas).toContain(foto);
    expect(r).toMatchObject({ faces_done: ['frente', 'reverso'], faces_skipped: ['reverso'] });
    expect((await svc.escanear(OTRA, { code: '9990000000230' })).faces_skipped).toEqual(['reverso']);
  });

  it('⛔ Catálogo no PUBLICA una ficha sin ninguna foto (la del agua en prod): se descarta o se pide otra', async () => {
    const id = String((await svc.escanear(PEPE, { code: '9990000000260' })).sheet_id);
    // La forma exacta de la ficha 59000 en prod: 5 caras saltadas, cero fotos, en «Por revisar».
    await trx('catalog.product_sheets').where({ id }).update({ photos: JSON.stringify(CARAS.map((c) => salto(c, PEPE.userId))), status: 'fotos_tomadas' });
    await expect(rev().decidir(CATALOGO, id, { decision: 'publicar' })).rejects.toThrow(/no tiene ninguna foto/);
    expect((await trx('catalog.product_sheets').where({ id }).first('status')).status).toBe('fotos_tomadas');
    // Control: descartarla sí se puede (con nota).
    expect((await rev().decidir(CATALOGO, id, { decision: 'descartar', note: 'sin fotos' })).status).toBe('descartada');
  });

  it('⭐ dos escaneos a la vez de un producto SIN ficha: el índice único deja ganar a uno (23505 → «apartado por otro») y la transacción sigue viva', async () => {
    expect((await svc.escanear(ANA, { code: '9990000000240' })).action).toBe('capturar');
    // El segundo llega sin haber visto la ficha (lev = null): su INSERT choca con el índice único.
    const apartar = (svc as unknown as { apartar: (t: Knex.Transaction, a: Record<string, unknown>) => Promise<string | null> }).apartar.bind(svc);
    const id = await apartar(trx, {
      tenant: M, branch: '01', source: 'perfil', sku: 'NP7IT12', principal: 'base', lev: null, reiniciar: false,
      apartado: nuevoApartado(LUIS.userId, new Date()), quien: LUIS, code: '9990000000240', porBusqueda: false,
    });
    expect(id).toBeNull();
    expect(Number((await trx('catalog.product_sheets').where({ sku: 'NP7IT12' }).count('* as n'))[0].n)).toBe(1);
  });
});
