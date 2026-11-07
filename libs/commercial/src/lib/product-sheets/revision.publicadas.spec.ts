// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { BadRequestException, RequestMethod } from '@nestjs/common';
import knexFactory, { type Knex } from 'knex';
import { Permission } from '@megadulces/platform-core';
import type { KdiiFila } from '../shared/kdii-codigo';
import { RevisionController } from './revision.controller';
import type { FotoFicha } from './levantamiento.rules';
import type { LecturaGuardada } from './ia/lectura-foto.contract';
import {
  armarFichaComun, escaparLike, lecturaIa, paginaDe, propuestaVigente, publicadaEn, publicadaPor, RevisionService, sucursalDeCobertura,
  type FilaFicha,
} from './revision.service';

/**
 * `[NP.7.L.5]` Catálogo digital › Publicadas: la lógica pura del servicio (sin Nest ni base). Lo que pasa
 * por SQL (el orden por fecha de publicación, el filtro `q` contra `kdii`, la cobertura) se ejerce en
 * `levantamiento.it.spec.ts` contra Postgres real. Al final, el SQL que el servicio MANDA (compilado por knex
 * de verdad, con una conexión que sólo lo anota): la regla 12 sin Postgres local.
 */

const foto = (cara: string, o: Partial<FotoFicha> = {}): FotoFicha => ({
  peldano: 'base', cara, storage_key: `levantamiento/t/${cara}.jpg`, sha256: `sha-${cara}`, captured_by: 'u1',
  captured_at: '2026-11-04T10:00:00.000Z', saltada_motivo: null, calidad: { nitidez: 800, contraste: 60 }, ancho: 1080, alto: 1920,
  por_busqueda: false, ...o,
} as FotoFicha);

const KDII: KdiiFila = {
  sku: '63004', nombre: 'TRIDENT XTRA CARE MENTA /12', u1: 'PZA', u2: 'PAQ', f2: 12, u3: 'CJA', f3: 384,
  base: ['7622210571403', null, '  '], dos: ['7501056960216', null, null], tres: ['C63004', null, null],
};

const FILA: FilaFicha = {
  id: 'f1', sku: '63004', branch_code: '01',
  photos: [foto('frente'), foto('reverso', { storage_key: null, saltada_motivo: 'otro' }), foto('frente', { peldano: 'dos' })],
  sheet: { principal: 'base', peldanos: { base: { codigo_escaneado: '7622210571403' } }, capturo: { username: 'ana', at: '2026-11-04T09:00:00.000Z' } },
  created_by_username: 'quien_creo', created_at: '2026-11-03T08:00:00.000Z',
};

describe('[NP.7.L.5] publicadas · lógica pura', () => {
  describe('publicadaPor: la ÚLTIMA decisión «publicar» de sheet.revisiones', () => {
    it('toma la última publicación, no la primera ni otra decisión posterior', () => {
      expect(publicadaPor([
        { decision: 'publicar', by_username: 'marta' },
        { decision: 'recapturar', by_username: 'luis' },
        { decision: 'publicar', by_username: 'catalogo2' },
        { decision: 'descartar', by_username: 'pepe' },
      ])).toBe('catalogo2');
    });
    it('sin ninguna publicación, sin historial o con basura → null', () => {
      expect(publicadaPor([{ decision: 'recapturar', by_username: 'luis' }])).toBeNull();
      expect(publicadaPor(undefined)).toBeNull();
      expect(publicadaPor('no soy arreglo')).toBeNull();
      expect(publicadaPor([null, 7])).toBeNull();
    });
    it('⛔ si la última publicación no trae usuario, null: no se le acredita a quien publicó antes', () => {
      expect(publicadaPor([{ decision: 'publicar', by_username: 'marta' }, { decision: 'publicar', by_username: null }])).toBeNull();
      expect(publicadaPor([{ decision: 'publicar', by_username: 'marta' }, { decision: 'publicar', by_username: '  ' }])).toBeNull();
    });
  });

  describe('publicadaEn: sólo la fecha REGISTRADA', () => {
    it('sheet.publicada.at → ISO', () => {
      expect(publicadaEn({ publicada: { by: 'u', at: '2026-11-04T12:30:00Z' } })).toBe('2026-11-04T12:30:00.000Z');
    });
    it('⛔ ficha anterior al registro o fecha ilegible → null (no se inventa con updated_at)', () => {
      expect(publicadaEn({})).toBeNull();
      expect(publicadaEn(null)).toBeNull();
      expect(publicadaEn({ publicada: { by: 'u' } })).toBeNull();
      expect(publicadaEn({ publicada: { at: 'ayer' } })).toBeNull();
    });
  });

  describe('escaparLike: el texto se busca TAL CUAL', () => {
    it('escapa %, _ y la propia barra', () => {
      expect(escaparLike('50%')).toBe('50\\%');
      expect(escaparLike('MEN_A')).toBe('MEN\\_A');
      expect(escaparLike('a\\b')).toBe('a\\\\b');
      expect(escaparLike('%_\\')).toBe('\\%\\_\\\\');
    });
    it('lo demás pasa igual (paréntesis, acentos, diagonales)', () => {
      expect(escaparLike('TRIDENT /12 (IT) piñata')).toBe('TRIDENT /12 (IT) piñata');
    });
    it('⭐ contra un LIKE de verdad (mismas reglas que Postgres con ESCAPE \'\\\'): sin escapar, «men_a» encuentra «menta»; escapado, no', () => {
      // Un LIKE mínimo con las reglas de Postgres: % = cualquier cadena, _ = un carácter, \x = x literal.
      const like = (texto: string, patron: string): boolean => {
        let re = '';
        for (let i = 0; i < patron.length; i += 1) {
          const c = patron[i];
          if (c === '\\' && i + 1 < patron.length) { i += 1; re += patron[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
          else if (c === '%') re += '.*';
          else if (c === '_') re += '.';
          else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        return new RegExp(`^${re}$`, 's').test(texto);
      };
      // CONTROL: el LIKE mínimo sí trata «_» como comodín.
      expect(like('trident menta', '%men_a%')).toBe(true);
      expect(like('trident menta', `%${escaparLike('men_a')}%`)).toBe(false);
      expect(like('descuento 50% (it)', `%${escaparLike('50%')}%`)).toBe(true);
      expect(like('descuento 500 (it)', `%${escaparLike('50%')}%`)).toBe(false);
    });
  });

  describe('lecturaIa: nunca dibuja una lectura que no hay', () => {
    it('apagada (D6) manda sobre todo, aunque haya propuesta guardada', () => {
      expect(lecturaIa(false, true)).toBe('apagada');
      expect(lecturaIa(false, false)).toBe('apagada');
    });
    it('encendida: leída sólo con propuesta', () => {
      expect(lecturaIa(true, true)).toBe('leida');
      expect(lecturaIa(true, false)).toBe('sin_leer');
    });
  });

  describe('propuestaVigente: la propuesta es de las fotos que la ficha tiene HOY (la regla del worker, fichaLista)', () => {
    // FILA: una sola foto real de la unidad principal (frente, sha-frente); la reverso se saltó y la de «dos» no cuenta.
    const ok = (o: Partial<LecturaGuardada> = {}) => ({ estado: 'ok', lectura: { version: 'prueba' }, ...o }) as unknown as LecturaGuardada;
    it('CONTROL: propuesta + todas las fotos reales del principal leídas ok → vigente (y «leída» con la IA encendida)', () => {
      const x = { ...FILA, con_propuesta: true, lecturas: { 'sha-frente': ok() } };
      expect(propuestaVigente(x)).toBe(true);
      expect(lecturaIa(true, propuestaVigente(x))).toBe('leida');
    });
    it('⭐ recapturada: la propuesta quedó de las fotos viejas y la foto nueva no tiene lectura → NO vigente («sin leer»)', () => {
      // Así queda tras `apartar` + fotos nuevas: `photos` con la foto nueva y `ai_raw` intacto (lecturas de las viejas).
      const x = { ...FILA, photos: [{ ...FILA.photos[0], sha256: 'sha-nueva' }], con_propuesta: true, lecturas: { 'sha-frente': ok() } };
      expect(propuestaVigente(x)).toBe(false);
      expect(lecturaIa(true, propuestaVigente(x))).toBe('sin_leer');
    });
    it('sin propuesta, sin lecturas o con una lectura que no quedó ok → NO vigente', () => {
      expect(propuestaVigente({ ...FILA, con_propuesta: false, lecturas: { 'sha-frente': ok() } })).toBe(false);
      expect(propuestaVigente({ ...FILA, con_propuesta: true, lecturas: null })).toBe(false);
      expect(propuestaVigente({ ...FILA, con_propuesta: true, lecturas: { 'sha-frente': ok({ estado: 'error' } as Partial<LecturaGuardada>) } })).toBe(false);
      expect(propuestaVigente({ ...FILA, con_propuesta: true, lecturas: { 'sha-frente': ok({ lectura: null }) } })).toBe(false);
    });
    it('sin ninguna foto real del principal (todas saltadas) → NO vigente', () => {
      expect(propuestaVigente({ ...FILA, photos: [FILA.photos[1]], con_propuesta: true, lecturas: { 'sha-frente': ok() } })).toBe(false);
    });
  });

  describe('sucursalDeCobertura', () => {
    it('sin sucursal → la del piloto (01); con espacios se recorta', () => {
      expect(sucursalDeCobertura(undefined)).toBe('01');
      expect(sucursalDeCobertura('')).toBe('01');
      expect(sucursalDeCobertura(' 05 ')).toBe('05');
    });
    it('prueba negativa: lo que no son dos dígitos → 400 (no «universo 0»)', () => {
      for (const b of ['1', '001', 'xx', '0a', "01' OR 1=1"]) expect(() => sucursalDeCobertura(b)).toThrow(BadRequestException);
    });
  });

  describe('paginaDe (la misma regla en la bandeja y en Publicadas)', () => {
    it('1..100, 30 si no viene; desde 0', () => {
      expect(paginaDe(undefined, undefined)).toEqual({ lim: 30, off: 0 });
      expect(paginaDe('500', '-3')).toEqual({ lim: 100, off: 0 });
      expect(paginaDe('0', '10')).toEqual({ lim: 30, off: 10 });
      expect(paginaDe(-5, 2.9)).toEqual({ lim: 1, off: 2 });
      expect(paginaDe('abc', 'abc')).toEqual({ lim: 30, off: 0 });
    });
    it('⛔ el offset también se topa (va al SQL de Publicadas): 1e20 desbordaba bigint (500) y 1e21 se volvía 1 en knex', () => {
      expect(paginaDe(undefined, '1e20')).toEqual({ lim: 30, off: 1_000_000 });
      expect(paginaDe(undefined, '1e21')).toEqual({ lim: 30, off: 1_000_000 });
      expect(paginaDe(undefined, 'Infinity')).toEqual({ lim: 30, off: 1_000_000 });
      expect(paginaDe(undefined, '999999')).toEqual({ lim: 30, off: 999_999 }); // CONTROL: debajo del tope pasa igual
      for (const o of ['1e20', '1e21', 'Infinity']) expect(Number.isSafeInteger(paginaDe(undefined, o).off)).toBe(true);
    });
  });

  describe('armarFichaComun: la armada compartida por la bandeja y Publicadas', () => {
    const firmadas: string[] = [];
    const firmar = async (k: string) => { firmadas.push(k); return `https://firmada.invalid/${k}`; };

    it('dato de Kepler de SU sucursal, fotos SÓLO de la unidad principal (firmadas; la saltada sin URL)', async () => {
      const r = await armarFichaComun(FILA, new Map([['01|63004', KDII]]), new Map([['01', 'Padre Hidalgo']]), firmar);
      expect(r).toEqual({
        id: 'f1', sku: '63004', name: 'TRIDENT XTRA CARE MENTA /12', branch_code: '01', branch_name: 'Padre Hidalgo',
        rung: 'base', unit_label: 'PZA', unit_factor: 1, scanned_code: '7622210571403', kepler_codes: ['7622210571403'],
        captured_by: 'ana', captured_at: '2026-11-04T09:00:00.000Z',
        photos: [
          { face: 'frente', url: 'https://firmada.invalid/levantamiento/t/frente.jpg', skipped_reason: null, sharpness: 800 },
          { face: 'reverso', url: null, skipped_reason: 'otro', sharpness: 800 },
        ],
      });
      expect(firmadas).toEqual(['levantamiento/t/frente.jpg']);
    });

    it('la unidad principal «dos» toma rótulo, factor y códigos del paquete', async () => {
      const r = await armarFichaComun({ ...FILA, sheet: { ...FILA.sheet, principal: 'dos' } }, new Map([['01|63004', KDII]]), new Map(), firmar);
      expect(r).toMatchObject({ rung: 'dos', unit_label: 'PAQ', unit_factor: 12, kepler_codes: ['7501056960216'], scanned_code: null, branch_name: null });
      expect(r.photos.map((p) => p.face)).toEqual(['frente']);
    });

    it('sin ficha de Kepler en ESA sucursal (la misma clave en otra no cuenta) → nombre y unidad null, sin inventar', async () => {
      const r = await armarFichaComun(FILA, new Map([['05|63004', KDII]]), new Map(), firmar);
      expect(r).toMatchObject({ name: null, unit_label: null, unit_factor: null, kepler_codes: [] });
    });

    it('sin «capturó» registrado: quien creó la fila y cuándo', async () => {
      const r = await armarFichaComun({ ...FILA, sheet: { principal: 'base' } }, new Map(), new Map(), firmar);
      expect(r).toMatchObject({ captured_by: 'quien_creo', captured_at: '2026-11-03T08:00:00.000Z' });
    });

    it('⛔ lista blanca: ni costo, ni precio, ni margen, ni venta', async () => {
      const r = await armarFichaComun(FILA, new Map([['01|63004', KDII]]), new Map(), firmar);
      expect(Object.keys(r).sort()).toEqual([
        'branch_code', 'branch_name', 'captured_at', 'captured_by', 'id', 'kepler_codes', 'name', 'photos', 'rung',
        'scanned_code', 'sku', 'unit_factor', 'unit_label',
      ]);
    });
  });

  describe('la ruta (metadata de Nest; vitest no emite design:paramtypes: el arranque queda NO VERIFICADO)', () => {
    const meta = (k: string, o: object) => (Reflect as unknown as { getMetadata(k: string, o: object): unknown }).getMetadata(k, o);
    const handler = RevisionController.prototype.publicadas;
    it('GET catalog/fichas/publicadas, con la clave de la bandeja (CATALOGO_FICHAS_REVISAR)', () => {
      expect(meta('path', RevisionController)).toBe('catalog/fichas');
      expect(meta('path', handler)).toBe('publicadas');
      expect(meta('method', handler)).toBe(RequestMethod.GET);
      expect(meta('permissions', handler)).toEqual([Permission.CATALOGO_FICHAS_REVISAR]);
    });
    it('el constructor del controlador sigue tomando UNA dependencia (el servicio)', () => {
      expect(RevisionController.length).toBe(1);
    });
  });
});

/**
 * Regla 12 sin Postgres local: el SQL lo compila knex DE VERDAD (cliente `pg`, el mismo de prod) y sólo la
 * conexión es un doble que anota cada consulta y devuelve filas fijas. Cubre lo que la lógica pura no ve: el
 * WHERE de Publicadas (en revisión y descartadas fuera), el ORDER BY de la bandeja después de la armada
 * compartida, y el cableado del interruptor de la IA y de «quién publicó» dentro de `publicadas()`.
 * ⚠️ NO prueba qué filas devuelve Postgres con ese SQL: eso lo ejerce `levantamiento.it.spec.ts` (sin `TP_IT_DB`
 * local se salta y lo dice: NO MEDIDO). Sin `connection` en la config, knex no arma pool ni driver: si el doble
 * fallara, la consulta revienta con «Unable to acquire a connection», nunca sale a una base.
 */
describe('[NP.7.L.5] el SQL que mandan publicadas() y bandeja() (knex real, conexión que sólo anota)', () => {
  type Consulta = { sql: string; bindings: unknown[] };
  const TENANT = '00000000-0000-0000-0000-00000000d01c';
  let k: Knex;
  let consultas: Consulta[];
  let responder: (sql: string) => unknown[];

  beforeEach(() => {
    k = knexFactory({ client: 'pg' });
    consultas = [];
    responder = () => [];
    const conexion = {
      query(cfg: { text: string; values: unknown[] }, cb: (e: unknown, r: unknown) => void) {
        consultas.push({ sql: cfg.text, bindings: cfg.values });
        cb(null, { command: 'SELECT', rows: responder(cfg.text) });
      },
    };
    Object.assign(k.client, { acquireConnection: async () => conexion, releaseConnection: async () => undefined });
  });
  afterEach(async () => { await k.destroy(); });

  const servicio = () => new RevisionService(
    { run: <T>(fn: (t: Knex.Transaction) => Promise<T>) => fn(k as unknown as Knex.Transaction) } as never,
    { requireTenantId: () => TENANT } as never,
    { signedUrl: async (key: string) => `https://firmada.invalid/${key}` } as never,
  );
  const deFichas = (c: Consulta) => /from "catalog"\."product_sheets"/.test(c.sql);
  /** El filtro: lo que va entre WHERE y ORDER BY / LIMIT. */
  const whereDe = (sql: string) => sql.slice(sql.indexOf(' where ')).split(/ order by | limit /)[0];
  /** Los valores ligados a `<columna> in (…)`, en orden; null si la consulta no filtra esa columna. */
  const enDe = (c: Consulta, col: string): unknown[] | null => {
    const m = new RegExp(`${col.replace(/\./g, '\\.')} in \\(([^)]*)\\)`).exec(c.sql);
    return m ? m[1].split(',').map((p) => c.bindings[Number(p.trim().slice(1)) - 1]) : null;
  };

  /** Una publicada con propuesta VIGENTE de la IA (su única foto real leída ok) y dos publicaciones en su historial. */
  const PUBLICADA = {
    ...FILA,
    sheet: {
      ...FILA.sheet,
      publicada: { by: 'u9', at: '2026-11-04T12:00:00.000Z' },
      revisiones: [
        { decision: 'publicar', by_username: 'marta' },
        { decision: 'recapturar', by_username: 'luis' },
        { decision: 'publicar', by_username: 'catalogo2' },
      ],
    },
    con_propuesta: true,
    lecturas: { 'sha-frente': { estado: 'ok', lectura: { version: 'prueba' } } },
  };
  /** Las respuestas de Publicadas: la cuenta, la página, Kepler, la sucursal y la cobertura de control del 2026-11-04. */
  const respuestasPublicadas = (sql: string): unknown[] => {
    if (sql.includes('sales_share_pct')) return [{ universe: 4230, published: 7, missing: 4223, sales_share_pct: '0.888' }];
    if (/count\(\*\)/.test(sql) && sql.includes('"product_sheets" as "ps"')) return [{ n: '1' }];
    if (sql.includes('"product_sheets" as "ps"')) return [PUBLICADA];
    if (sql.includes('kepler_ods.kdii')) return [{ sku: '63004', nombre: 'TRIDENT XTRA CARE MENTA /12', u1: 'PZA', b1: '7622210571403' }];
    if (sql.includes('"commercial"."warehouses"')) return [{ kepler_code: '01', name: 'Padre Hidalgo' }];
    return [];
  };

  it('⭐ Publicadas: la cuenta Y la página filtran SÓLO los estados publicados (ninguno en revisión), sin descartadas ni reemplazadas, del levantamiento y del tenant', async () => {
    responder = respuestasPublicadas;
    await servicio().publicadas({ limit: 30 });
    const fichas = consultas.filter(deFichas);
    expect(fichas).toHaveLength(2); // CONTROL: la cuenta (total) y la página; si no, lo de abajo no miraría nada
    const [cuenta, pagina] = fichas;
    expect(cuenta.sql).toMatch(/count\(\*\)/);
    for (const c of [cuenta, pagina]) {
      // Literal, no la constante: si alguien agrega «por_revisar» a ESTADOS_CON_FICHA, esto también se pone rojo.
      expect(enDe(c, '"ps"."status"')).toEqual(['publicada', 'conciliada', 'con_diferencias']);
      for (const e of ['en_captura', 'fotos_tomadas', 'analizada', 'por_revisar', 'recapturar', 'historica']) expect(c.bindings).not.toContain(e);
      expect(whereDe(c.sql)).toContain('"ps"."deleted_at" is null');
      expect(whereDe(c.sql)).toContain('"ps"."superseded_at" is null');
      expect(whereDe(c.sql)).toMatch(/"ps"\."tenant_id" = \$\d+/);
      expect(c.bindings).toEqual(expect.arrayContaining([TENANT, 'levantamiento']));
    }
    // `total` cuenta lo MISMO que se lista: las dos consultas llevan el mismo filtro.
    expect(whereDe(cuenta.sql)).toBe(whereDe(pagina.sql));
  });

  it('⭐ Publicadas, el cableado: «publicó» es la ÚLTIMA publicación y con la IA apagada la lectura es «apagada» aunque la propuesta esté vigente', async () => {
    responder = respuestasPublicadas;
    const antes = process.env['NP7_AI_ENABLED'];
    try {
      delete process.env['NP7_AI_ENABLED'];
      const r = await servicio().publicadas({});
      expect(r.total).toBe(1);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({
        sku: '63004', name: 'TRIDENT XTRA CARE MENTA /12', branch_name: 'Padre Hidalgo',
        published_by: 'catalogo2', published_at: '2026-11-04T12:00:00.000Z', ai_reading: 'apagada',
      });
      // CONTROL: la MISMA fila con la IA encendida sale «leída» (su propuesta sí es vigente): «apagada» no salió por otra razón.
      process.env['NP7_AI_ENABLED'] = 'true';
      expect((await servicio().publicadas({})).rows[0].ai_reading).toBe('leida');
    } finally {
      if (antes === undefined) delete process.env['NP7_AI_ENABLED']; else process.env['NP7_AI_ENABLED'] = antes;
    }
  });

  it('Publicadas, la cobertura: de la sucursal pedida, sin ciclos anidados, y el numeric de Postgres llega como número (0.888, sin redondear)', async () => {
    responder = respuestasPublicadas;
    const r = await servicio().publicadas({});
    expect(r.coverage).toMatchObject({ branch_code: '01', branch_name: 'Padre Hidalgo', universe: 4230, published: 7, missing: 4223, sales_share_pct: 0.888 });
    const i = consultas.findIndex((c) => c.sql.includes('sales_share_pct'));
    expect(i).toBeGreaterThan(0);
    expect(consultas[i - 1].sql).toBe('SET LOCAL enable_nestloop = off');
    expect(consultas[i].bindings).toEqual(expect.arrayContaining([TENANT, '01']));
  });

  it('⭐ bandeja: pide lo más VIEJO primero (por cuándo se terminó la captura, desempate por id) y la armada compartida no reordena', async () => {
    // Intercaladas por sucursal: `keplerDeFichas` agrupa por sucursal para leer Kepler; eso no debe mover la lista.
    const fila = (id: string, branch: string, at: string) => ({
      ...FILA, id, branch_code: branch, status: 'por_revisar', sheet: { ...FILA.sheet, capturo: { username: 'ana', at } },
    });
    responder = (sql) => (/from "catalog"\."product_sheets"/.test(sql)
      ? [fila('a', '05', '2026-11-04T09:00:00.000Z'), fila('b', '01', '2026-11-04T10:00:00.000Z'), fila('c', '05', '2026-11-04T11:00:00.000Z')]
      : []);
    const b = await servicio().bandeja({});
    const q = consultas.find(deFichas)!;
    expect(q.sql.slice(q.sql.lastIndexOf(' order by ') + ' order by '.length))
      .toBe("coalesce((sheet #>> '{capturo,at}')::timestamptz, created_at) ASC, id ASC");
    expect(enDe(q, '"status"')).toEqual(['fotos_tomadas', 'analizada', 'por_revisar']); // CONTROL: es la consulta de la bandeja
    expect(b.rows.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});
