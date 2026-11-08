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
import { LEVANTAMIENTO_CARAS, type CoberturaLevantamiento } from '@megadulces/contracts';
import { RevisionService } from './revision.service';
import { CONTEOS_LEVANTAMIENTO_SQL, EN_CURSO_SQL, NO_FISICO_REGEX } from './levantamiento.sql';
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
/** Las 5 caras y los 3 acercamientos (tabla nutrimental, información, código de barras; 2026-11-07). */
const CARAS: string[] = [...LEVANTAMIENTO_CARAS];

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

  it('escanear el código de la pieza → aparta la ficha y pide las 8 fotos (5 caras + 3 acercamientos)', async () => {
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

  it('⭐ las 8 fotos con el payload de FormData → fotos_tomadas, con sha256 y la medición de calidad', async () => {
    let ultima = null as Awaited<ReturnType<Prueba['foto']>> | null;
    for (const c of CARAS) ultima = await svc.foto(ANA, sheet, jpeg(), meta(c));
    expect(ultima).toMatchObject({ status: 'fotos_tomadas', complete: true });
    const fila = await trx('catalog.product_sheets').where({ id: sheet }).first('status', 'photos', 'sheet');
    expect(fila.status).toBe('fotos_tomadas');
    expect(fila.photos).toHaveLength(8);
    expect(fila.photos[0]).toMatchObject({ peldano: 'base', captured_by: ANA.userId, saltada_motivo: null, calidad: { nitidez: 812.4, contraste: 61.2 }, ancho: 3024, alto: 4032 });
    expect(new Set(fila.photos.map((p: { sha256: string }) => p.sha256)).size).toBe(8);
    expect(fila.sheet.peldanos.base.apartado).toBeNull();
    // [NP.7.0.9] El peso se mide en el servidor, sobre lo que de verdad llegó al bucket (sin metadatos),
    // y la llave lleva el tenant.
    for (const p of fila.photos as Array<{ storage_key: string; bytes: number }>) {
      expect(p.storage_key.startsWith(`levantamiento/${M}/`)).toBe(true);
      expect(p.bytes).toBe(bytes.get(p.storage_key)!.length);
      expect(p.bytes).toBeGreaterThan(0);
    }
  });

  it('⭐ detalles (2026-11-07): quien terminó agrega hasta 3 SIN cambiar el estado; nadie más, nunca a media captura ni fuera de la ventana', async () => {
    const det = (kind: string, note?: string) => ({ ...meta('detalle_1'), detail_kind: kind, ...(note ? { detail_note: note } : {}) });
    // Otra persona: 403. Un tipo que no existe o un salto de detalle: 400.
    await expect(svc.foto(LUIS, sheet, jpeg(), det('caducidad'))).rejects.toThrow(/Sólo quien terminó/);
    await expect(svc.foto(ANA, sheet, jpeg(), det('cualquiera'))).rejects.toThrow(/Elige qué muestra/);
    await expect(svc.saltar(ANA, sheet, { face: 'detalle_1' as never, reason: 'otro' })).rejects.toThrow(/no se salta/);
    const r1 = await svc.foto(ANA, sheet, jpeg(), det('otro', '  hecho en\nColombia  '));
    expect(r1).toMatchObject({ face: 'detalle_1', status: 'fotos_tomadas', complete: true, details_done: ['detalle_1'] });
    expect(r1.faces_done).toHaveLength(8); // el detalle no cuenta como cara
    const fila = await trx('catalog.product_sheets').where({ id: sheet }).first('status', 'photos', 'sheet');
    expect(fila.status).toBe('fotos_tomadas');
    expect(fila.photos).toHaveLength(9);
    expect(fila.photos.find((p: { cara: string }) => p.cara === 'detalle_1')).toMatchObject({ detalle: { tipo: 'otro', nota: 'hecho en Colombia' }, captured_by: ANA.userId });
    // Fuera de la ventana de 30 min: 409 (se restaura `capturo.at` para las pruebas que siguen).
    const at = fila.sheet.capturo.at;
    await trx('catalog.product_sheets').where({ id: sheet }).update({ sheet: JSON.stringify({ ...fila.sheet, capturo: { ...fila.sheet.capturo, at: '2026-01-01T00:00:00.000Z' } }) });
    await expect(svc.foto(ANA, sheet, jpeg(), det('sellos'))).rejects.toThrow(/Pasaron más de 30 minutos/);
    await trx('catalog.product_sheets').where({ id: sheet }).update({ sheet: JSON.stringify({ ...fila.sheet, capturo: { ...fila.sheet.capturo, at } }) });
    expect((await trx('catalog.product_sheets').where({ id: sheet }).first('photos')).photos).toHaveLength(9);
  });

  it('volver a escanear un producto ya levantado → «en revisión», no se duplica', async () => {
    expect((await svc.escanear(LUIS, { code: '7622210571403' })).action).toBe('en_revision');
    expect(Number((await trx('catalog.product_sheets').where({ sku: 'NP7IT1' }).count('* as n'))[0].n)).toBe(1);
  });

  it('saltar una cara con motivo cuenta como resuelta; sin motivo válido → 400', async () => {
    const r = await svc.escanear(LUIS, { code: '9990000000017' });
    expect(r.action).toBe('capturar');
    await expect(svc.saltar(LUIS, String(r.sheet_id), { face: 'base', reason: 'porque si' as never })).rejects.toThrow(/Elige por qué/);
    // A media captura no se agregan detalles (van al final).
    await expect(svc.foto(LUIS, String(r.sheet_id), jpeg(), { ...meta('detalle_1'), detail_kind: 'sellos' })).rejects.toThrow(/Termina primero/);
    for (const c of CARAS.slice(0, 7)) await svc.foto(LUIS, String(r.sheet_id), jpeg(), meta(c));
    const fin = await svc.saltar(LUIS, String(r.sheet_id), { face: 'codigo_barras', reason: 'no_tiene_esa_cara' });
    expect(fin).toMatchObject({ status: 'fotos_tomadas', complete: true, faces_skipped: ['codigo_barras'] });
    const fila = await trx('catalog.product_sheets').where({ id: r.sheet_id }).first('photos');
    expect(fila.photos.find((p: { cara: string }) => p.cara === 'codigo_barras')).toMatchObject({ storage_key: null, saltada_motivo: 'no_tiene_esa_cara' });
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

  it('⭐ un salto VIEJO del frente (de antes de la regla) no cuenta: con las otras 7 saltadas la ficha NO se envía y se vuelve a pedir el frente', async () => {
    const id = await idDe('NP7IT13');
    // Así quedó en prod la ficha 31054: el frente saltado antes de que existiera la regla.
    const f = await trx('catalog.product_sheets').where({ id }).first('photos');
    await trx('catalog.product_sheets').where({ id }).update({ photos: JSON.stringify([salto('frente', PEPE.userId), ...f.photos]) });
    let ult: unknown;
    for (const c of CARAS.slice(2)) ult = await svc.saltar(PEPE, id, { face: c as never, reason: 'otro' });
    expect(ult).toMatchObject({ status: 'en_captura', complete: false, faces_done: CARAS.slice(1) });
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
    expect(f.photos).toHaveLength(9); // 8 fotos + el detalle que agregó Ana
    expect(f.photos.map((p) => p.face)).toEqual([...CARAS, 'detalle_1']);
    expect(f.photos[8].detail).toEqual({ kind: 'otro', note: 'hecho en Colombia' });
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

  // ── `[NP.7.L.5]` Catálogo digital › Publicadas y la cobertura ────────────────────────────────────────
  // Corre al final, sobre lo que dejaron las pruebas de arriba: NP7IT1 y NP7IT10 publicadas, NP7IT13 en
  // revisión, NP7IT14 descartada, NP7IT11 apartada en la sucursal 05.
  /** En las pruebas de la LISTA la cobertura se fija (lee vistas materializadas); más abajo se ejerce de verdad. */
  class RevisionPrueba extends RevisionService {
    protected override async cobertura(_tenant: string, branch: string): Promise<CoberturaLevantamiento> {
      return { branch_code: branch, branch_name: null, universe: 12, published: 3, missing: 9, sales_share_pct: 1.5, measured_at: '2026-11-04T00:00:00.000Z' };
    }
  }
  const pub = () => new RevisionPrueba(
    { run: <T>(fn: (t: Knex.Transaction) => Promise<T>) => fn(trx) } as never,
    { requireTenantId: () => M } as never,
    { signedUrl: async (k: string) => `https://firmada.invalid/${k}` } as never,
  );
  const nuestras = (r: { rows: Array<{ sku: string }> }) => r.rows.map((x) => x.sku).filter((s) => /^NP7IT\d+$/.test(s));
  const fijarPublicada = (sku: string, at: string) =>
    trx.raw(`UPDATE catalog.product_sheets SET sheet = jsonb_set(sheet, '{publicada,at}', to_jsonb(?::text))
              WHERE sku = ? AND origin = 'levantamiento' AND deleted_at IS NULL`, [at, sku]);

  it('⭐ Publicadas: la publicada aparece con sus fotos y quién la publicó; en revisión y descartada NO; de toda la red; lo más reciente primero', async () => {
    // Fechas fijas: `decidir` estampa la hora real y dos publicaciones del mismo milisegundo empatarían.
    await fijarPublicada('NP7IT1', '2026-11-02T10:00:00.000Z');
    await fijarPublicada('NP7IT10', '2026-11-03T10:00:00.000Z');
    // Una publicada en OTRA sucursal (05), por otra persona de Catálogo.
    await trx.raw(
      `UPDATE catalog.product_sheets
          SET status = 'publicada',
              sheet = sheet || jsonb_build_object('publicada', jsonb_build_object('by', ?::text, 'at', '2026-11-01T10:00:00.000Z'),
                                                  'revisiones', jsonb_build_array(jsonb_build_object('decision', 'publicar', 'by_username', 'np7_it_catalogo05')))
        WHERE sku = 'NP7IT11' AND origin = 'levantamiento' AND deleted_at IS NULL`, [CATALOGO.userId]);
    // Una publicada ANTES de que existiera el registro (sin `publicada` ni `revisiones`): ordena por updated_at.
    await trx('kepler_ods.kdii').insert({ sucursal: '01', c1: 'NP7IT15', c2: 'PRODUCTO LEGADO NP7IT15 (IT)', c11: 'PZA', c80: 'PAQ', c83: 'CJA', c7: '9990000000280' });
    await trx('catalog.product_sheets').insert({
      tenant_id: M, origin: 'levantamiento', status: 'publicada', sku: 'NP7IT15', branch_code: '01',
      photos: JSON.stringify([]), sheet: JSON.stringify({ principal: 'base' }), created_by_username: 'np7_it_legado',
      created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    });
    // Publicada y luego DESCARTADA (borrado lógico): no se lista.
    await trx('catalog.product_sheets').where({ sku: 'NP7IT14', origin: 'levantamiento' }).whereNotNull('deleted_at').update({ status: 'publicada' });

    const antes = process.env['NP7_AI_ENABLED'];
    delete process.env['NP7_AI_ENABLED'];
    try {
      const r = await pub().publicadas({ q: '(it)', limit: 100 });
      expect(nuestras(r)).toEqual(['NP7IT10', 'NP7IT1', 'NP7IT11', 'NP7IT15']);
      expect(r.total).toBeGreaterThanOrEqual(4);
      const f = r.rows.find((x) => x.sku === 'NP7IT1')!;
      expect(f).toMatchObject({
        branch_code: '01', name: 'TRIDENT XTRA CARE MENTA /12 (IT)', rung: 'base', unit_label: 'PZA', unit_factor: 1,
        scanned_code: '7622210571403', captured_by: ANA.username,
        published_by: CATALOGO.username, published_at: '2026-11-02T10:00:00.000Z', ai_reading: 'apagada',
      });
      expect(f.photos).toHaveLength(9);
      expect(f.photos.every((p) => String(p.url).startsWith('https://firmada.invalid/levantamiento/'))).toBe(true);
      // La de la 05 sale con el nombre de Kepler de SU sucursal y quien la publicó.
      expect(r.rows.find((x) => x.sku === 'NP7IT11')).toMatchObject({ branch_code: '05', name: 'PRODUCTO NP7IT11 (IT)', published_by: 'np7_it_catalogo05' });
      // La de antes del registro: sin fecha ni autor inventados.
      expect(r.rows.find((x) => x.sku === 'NP7IT15')).toMatchObject({ published_by: null, published_at: null, photos: [], captured_by: 'np7_it_legado' });
      // ⛔ Lista blanca: exactamente las claves del contrato (ni costo, ni precio, ni margen, ni venta por SKU).
      expect(Object.keys(f).sort()).toEqual([
        'ai_reading', 'branch_code', 'branch_name', 'captured_at', 'captured_by', 'id', 'kepler_codes', 'name', 'photos',
        'published_at', 'published_by', 'rung', 'scanned_code', 'sku', 'unit_factor', 'unit_label',
      ]);
      expect(r.coverage).toMatchObject({ branch_code: '01', universe: 12, published: 3, missing: 9 });
    } finally {
      if (antes === undefined) delete process.env['NP7_AI_ENABLED']; else process.env['NP7_AI_ENABLED'] = antes;
    }
  });

  it('Publicadas · q: SKU exacto o nombre sin acentos ni mayúsculas, con los comodines de LIKE escapados; total cuenta lo filtrado, no la página', async () => {
    const skus = async (q: string) => nuestras(await pub().publicadas({ q, limit: 100 }));
    expect(await skus('np7it1')).toContain('NP7IT1'); // SKU exacto: su nombre no lo contiene
    expect(await skus('tríDent')).toEqual(['NP7IT1']); // sin acentos ni mayúsculas, como el buscador
    expect(await skus('menta')).toEqual(['NP7IT1']); // CONTROL del siguiente
    expect(await skus('men_a')).toEqual([]); // sin escapar, «_» encontraría «menta»
    expect(await skus('trident%care')).toEqual([]); // sin escapar, «%» encontraría «trident xtra care»
    expect(await skus('PRODUCTO NP7IT13')).toEqual([]); // en revisión: no es publicada
    const p1 = await pub().publicadas({ q: '(it)', limit: 1 });
    expect(p1.rows).toHaveLength(1);
    expect(p1.total).toBeGreaterThanOrEqual(4);
    const p2 = await pub().publicadas({ q: '(it)', limit: 1, offset: 1 });
    expect(p2.rows[0].id).not.toBe(p1.rows[0].id);
    const fuera = await pub().publicadas({ q: '(it)', limit: 1, offset: 10_000 });
    expect(fuera).toMatchObject({ rows: [], total: p1.total });
  });

  it('Publicadas · prueba negativa: una sucursal que no es de dos dígitos → 400 (no «universo 0»)', async () => {
    await expect(pub().publicadas({ branch: '1' })).rejects.toMatchObject({ status: 400 });
    await expect(pub().publicadas({ branch: "01' OR '1'='1" })).rejects.toMatchObject({ status: 400 });
  });

  it('Publicadas · la lectura de la IA: «leída» sólo con propuesta VIGENTE (todas sus fotos leídas ok), «sin leer» sin ella (con la IA encendida)', async () => {
    // Las lecturas `ok` de las fotos reales de la unidad principal de NP7IT10, como las deja el worker.
    const f10 = await trx('catalog.product_sheets').where({ sku: 'NP7IT10', origin: 'levantamiento' }).whereNull('deleted_at')
      .first('photos', trx.raw(`sheet->>'principal' AS principal`)) as { photos: Array<{ peldano: string | null; storage_key: string | null; sha256: string | null }>; principal: string };
    const reales = f10.photos.filter((p) => p.peldano === f10.principal && p.storage_key && p.sha256);
    expect(reales.length).toBeGreaterThan(0); // CONTROL: si no hubiera fotos reales, «sin leer» saldría por otra razón
    const lecturas = Object.fromEntries(reales.map((p) => [p.sha256, { estado: 'ok', lectura: { version: 'prueba' }, cara: 'frente', peldano: f10.principal }]));
    await trx('catalog.product_sheets').where({ sku: 'NP7IT10', origin: 'levantamiento' }).whereNull('deleted_at')
      .update({ ai_raw: JSON.stringify({ propuesta: { nombre: 'propuesta de prueba' }, lecturas }) });
    // Así deja `ai_raw` el worker con una lectura nueva: `propuesta` en null JSON.
    await trx('catalog.product_sheets').where({ sku: 'NP7IT1', origin: 'levantamiento' }).whereNull('deleted_at')
      .update({ ai_raw: JSON.stringify({ propuesta: null, lecturas: {} }) });
    const antes = process.env['NP7_AI_ENABLED'];
    process.env['NP7_AI_ENABLED'] = 'true';
    try {
      const r = await pub().publicadas({ q: '(it)', limit: 100 });
      const ia = (sku: string) => r.rows.find((x) => x.sku === sku)?.ai_reading;
      expect([ia('NP7IT10'), ia('NP7IT1'), ia('NP7IT15')]).toEqual(['leida', 'sin_leer', 'sin_leer']);

      // ⭐ Recapturada: `apartar` cambia `photos` y NO toca `ai_raw`. Una foto nueva sin lectura → la propuesta es de
      // las fotos viejas: «sin leer», no «leída». En un SAVEPOINT: las pruebas de abajo ven NP7IT10 como estaba.
      await trx.raw('SAVEPOINT recaptura');
      try {
        await trx.raw(
          `UPDATE catalog.product_sheets
              SET photos = photos || jsonb_build_array(jsonb_build_object('peldano', ?::text, 'cara', 'frente',
                             'storage_key', 'levantamiento/np7it/nueva.jpg', 'sha256', 'np7it-sha-foto-nueva'))
            WHERE sku = 'NP7IT10' AND origin = 'levantamiento' AND deleted_at IS NULL`, [f10.principal]);
        const r2 = await pub().publicadas({ q: 'NP7IT10', limit: 100 });
        expect(r2.rows.find((x) => x.sku === 'NP7IT10')?.ai_reading).toBe('sin_leer');
      } finally {
        await trx.raw('ROLLBACK TO SAVEPOINT recaptura');
      }
    } finally {
      if (antes === undefined) delete process.env['NP7_AI_ENABLED']; else process.env['NP7_AI_ENABLED'] = antes;
    }
    // Apagada manda aunque haya propuesta guardada (D6).
    expect((await pub().publicadas({ q: 'NP7IT10', limit: 100 })).rows.find((x) => x.sku === 'NP7IT10')?.ai_reading).toBe('apagada');
  });

  /**
   * Sustituye una relación de `analytics` (vista materializada, vista o tabla) por una TABLA con las columnas
   * que lee el universo, para poder sembrarla. Sólo dentro de un SAVEPOINT: el ROLLBACK la devuelve intacta.
   */
  const sustituir = async (rel: string, columnas: string) => {
    const k = (await trx.raw(
      `SELECT c.relkind::text AS k FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname = ?`,
      [rel],
    )).rows[0]?.k as string | undefined;
    if (k) await trx.raw(`ALTER ${k === 'm' ? 'MATERIALIZED VIEW' : k === 'v' ? 'VIEW' : 'TABLE'} analytics.${rel} RENAME TO ${rel}_np7it`);
    await trx.raw(`CREATE TABLE analytics.${rel} (${columnas})`);
  };

  it('⭐ la cobertura de verdad: universo, publicadas y faltan cuadran; faltan = universo − publicadas = el «faltan» de la pantalla A; el % es en pesos y «en revisión» nunca suma', async () => {
    await trx.raw('SAVEPOINT np7_cob');
    try {
      await trx.raw('CREATE SCHEMA IF NOT EXISTS analytics');
      await sustituir('mv_kepler_sales_daily', 'tenant_id uuid, warehouse_code text, business_date date, sku text, monto numeric');
      await sustituir('v_erp_stock_on_hand', 'tenant_id uuid, warehouse_code text, sku text, qty_stock_units numeric');
      await sustituir('mv_kepler_sold_rung', 'sucursal text, sku text, rung_modal numeric');
      await trx('kepler_ods.kdii').insert({ sucursal: '01', c1: 'NP7IT16', c2: '1 CHICLE = GRATIS 1 PALETA (IT)', c11: 'PZA', c80: 'PAQ', c83: 'CJA', c7: '9990000000290' });
      const dia = (atras: number) => trx.raw(`(now() AT TIME ZONE 'America/Mexico_City')::date - ${atras}`);
      const venta = (sku: string, monto: number, atras = 1, wh = '01') => ({ tenant_id: M, warehouse_code: wh, business_date: dia(atras), sku, monto });
      await trx('analytics.mv_kepler_sales_daily').insert([
        venta('NP7IT1', 300), // publicada
        venta('NP7IT10', 100), // publicada
        venta('NP7IT2', 600), // pedida otra foto y vuelta a capturar: no publicada
        venta('NP7IT13', 200), // en revisión: NUNCA suma
        venta('NP7IT14', 100), // publicada y DESCARTADA: no suma
        venta('NP7IT16', 999), // promoción: fuera del universo
        venta('NP7IT6', 500, 120), // fuera de la ventana de 90 d
        venta('NP7IT11', 700, 1, '05'), // otra sucursal (publicada allá)
      ]);
      await trx('analytics.v_erp_stock_on_hand').insert([
        { tenant_id: M, warehouse_code: '01', sku: 'NP7IT5', qty_stock_units: 4 }, // sólo existencia: entra
        { tenant_id: M, warehouse_code: '01', sku: 'NP7IT7', qty_stock_units: 0 }, // existencia 0: no entra
      ]);

      const r = await rev().publicadas({ branch: '01', limit: 1 });
      // Universo = NP7IT1, NP7IT10, NP7IT2, NP7IT13, NP7IT14 (venta) + NP7IT5 (existencia) = 6; publicadas 2.
      expect(r.coverage).toMatchObject({ branch_code: '01', universe: 6, published: 2, missing: 4 });
      expect(r.coverage.missing).toBe(r.coverage.universe - r.coverage.published);
      // MÉTRICA L en pesos: (300 + 100) / (300 + 100 + 600 + 200 + 100), calculado a mano.
      expect(r.coverage.sales_share_pct).toBeCloseTo((100 * 400) / 1300, 6);
      expect(Number.isNaN(Date.parse(r.coverage.measured_at))).toBe(false);
      // «Faltan» da el mismo número en A y en E: los dos envuelven el mismo universo.
      const a = (await trx.raw(CONTEOS_LEVANTAMIENTO_SQL, { tenant: M, branch: '01', no_fisico: NO_FISICO_REGEX })).rows[0];
      expect({ universe: a.universe, missing: a.missing }).toEqual({ universe: r.coverage.universe, missing: r.coverage.missing });
      // Una sucursal sin venta ni existencia: universo 0 y el % NO MEDIBLE (null), nunca «0 %».
      expect((await rev().publicadas({ branch: '09', limit: 1 })).coverage).toMatchObject({ universe: 0, published: 0, missing: 0, sales_share_pct: null });
      // Ningún cubierto que venda: 0 %, no null (el numerador va con coalesce).
      await trx('analytics.mv_kepler_sales_daily').whereIn('sku', ['NP7IT1', 'NP7IT10']).del();
      expect((await rev().publicadas({ branch: '01', limit: 1 })).coverage).toMatchObject({ universe: 4, published: 0, sales_share_pct: 0 });
    } finally {
      await trx.raw('ROLLBACK TO SAVEPOINT np7_cob');
    }
  });
});
