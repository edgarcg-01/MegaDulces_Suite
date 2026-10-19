import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { expandirTier, compactarTier, VERIFICADOR_SNAPSHOT_FORMATO } from '@megadulces/contracts';
import { KpService } from './kp.service';

/**
 * `[VAC.L7]` — El comportamiento de `KpService`, que hasta hoy no se ejecutaba en ninguna prueba.
 *
 * ── Qué prueba y qué NO (límite declarado) ───────────────────────────────────────────────────
 * Corre la LÓGICA del servicio con un doble de Knex que contesta según el SQL que recibe: la
 * elección de plaza, la unidad del código escaneado, la ambigüedad de código y de precio, las
 * guardas del mayoreo y el manejo de errores. NO ejecuta el SQL: lo que toca Postgres se prueba
 * contra la base real (`database/tests/test-newdb-verificador-precio-correcto.js`, `[CV.26]`),
 * porque un doble que reimplementa la consulta se pone verde con la ruta caída. Por eso la
 * regresión del `LPAD` (CV.28) sólo se vigila aquí como TEXTO del SQL enviado y su correctitud
 * real sigue siendo del smoke contra la base.
 */

type Fila = Record<string, unknown>;

/** Una fila de `kdii` con los campos que `COLS_PRECIO` entrega, y valores neutros. */
const kdii = (o: Fila = {}): Fila => ({
  codigo: '00610', bc1: '7501000000001', bc2: '', bc3: '', bc4: '', bc5: '', bc6: '',
  nombre: 'GEL EGO GRANDE',
  u1: 'PZA', pv1: 85.49, u2: '', pv2: null, f2: null, u3: '', pv3: null, f3: null,
  costo: 60, margen: 40, iva_raw: 16, ieps_raw: 0, sucursal: '03',
  ...o,
});

/** Una fila de `product_label_prices` (la etiqueta del anaquel). */
const etiqueta = (o: Fila = {}): Fila => ({
  piece_price: 85.49, source: 'kepler', content: '1.350 ML', unit_base: 'PZA',
  wholesale_piece_price: null, wholesale_piece_min_qty: null,
  wholesale_pack_price: null, wholesale_pack_min_qty: null,
  pack_price: null, pack_size: null, product_id: 'aaaaaaaa-0000-4000-8000-000000000001',
  ...o,
});

interface Opciones {
  kdii?: Fila[];
  etiqueta?: Fila[];
  /** Falla TODA consulta con un mensaje que parece de Postgres (para probar que no se filtra). */
  falla?: boolean;
  /** Falla sólo la lectura de la etiqueta: el precio tiene que salir igual. */
  fallaEtiqueta?: boolean;
  /** `[MOS.1]` La lectura aparte de proveedores del lote del snapshot. */
  proveedores?: Fila[];
}

const MENSAJE_PG = 'relation "kepler_ods.kdii" does not exist (host 10.20.30.40:5434)';

function dbFalso(o: Opciones = {}) {
  const llamadas: { sql: string; bindings: unknown[] }[] = [];
  const raw = async (sql: string, bindings: unknown[] = []) => {
    llamadas.push({ sql, bindings });
    if (o.falla) throw new Error(MENSAJE_PG);
    if (sql.includes('SET LOCAL')) return { rows: [] };
    if (sql.includes('FROM kepler_ods.kdii')) return { rows: o.kdii ?? [] };
    if (sql.includes('catalog.suppliers') && !sql.includes('product_label_prices')) {
      return { rows: o.proveedores ?? [] };
    }
    if (sql.includes('product_label_prices')) {
      if (o.fallaEtiqueta) throw new Error(MENSAJE_PG);
      return { rows: o.etiqueta ?? [] };
    }
    return { rows: [] };
  };
  const db = { raw, transaction: async (fn: (trx: { raw: typeof raw }) => unknown) => fn({ raw }) };
  return { db, llamadas };
}

const servicio = (o: Opciones = {}) => {
  const d = dbFalso(o);
  return { svc: new KpService(d.db as never), ...d };
};

describe('[VAC.L7] KpService.getPrecio', () => {
  let logError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('sin código no consulta nada', async () => {
    const { svc, llamadas } = servicio();
    expect(await svc.getPrecio('  --  ')).toEqual({ ok: false, error: 'Sin código' });
    expect(llamadas).toHaveLength(0);
  });

  it('un código que no está contesta "no encontrado" (200 ok:false), que es una respuesta, no un error', async () => {
    const { svc } = servicio({ kdii: [] });
    expect(await svc.getPrecio('99999')).toEqual({ ok: false, code: '99999', error: 'Producto no encontrado' });
  });

  /**
   * `[VAC.L3]` ⛔ Un fallo de la base NO se cuenta al cliente ni se disfraza de "no encontrado".
   *
   * Antes: `200 { ok:false, error: <mensaje de Postgres> }` → fuga hacia un kiosco anónimo, y el
   * frontend lo leía como "no está" sin consultar su respaldo.
   */
  it('⛔ un fallo de la base lanza 503 con código estable y NO filtra el mensaje de Postgres', async () => {
    const { svc } = servicio({ falla: true });
    let cuerpo: unknown;
    try {
      await svc.getPrecio('00610', '03');
      throw new Error('debió lanzar');
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceUnavailableException);
      cuerpo = (e as ServiceUnavailableException).getResponse();
    }
    expect(cuerpo).toEqual({ ok: false, codigo_error: 'error_interno' });
    // La prueba negativa que importa: ni una pista de la infraestructura en lo que sale.
    expect(JSON.stringify(cuerpo)).not.toMatch(/relation|kdii|10\.20\.30\.40|5434/);
    // Y el detalle SÍ quedó donde debe: en el log del servidor.
    expect(logError).toHaveBeenCalledTimes(1);
    expect(String(logError.mock.calls[0][1])).toContain(MENSAJE_PG);
  });

  it('el fallo de la etiqueta no tumba el precio: es un refinamiento, sale sin mayoreo', async () => {
    const { svc } = servicio({ kdii: [kdii()], fallaEtiqueta: true });
    const r: any = await svc.getPrecio('00610', '03');
    expect(r.ok).toBe(true);
    expect(r.precio_con_iva).toBe(85.49);
    expect(r.mayoreo).toEqual([]);
    expect(r.product_id).toBeNull();      // se declara que no se pudo leer, no se inventa
  });

  it('[CV.28] el SQL conserva la guarda de longitud del LPAD y manda el código ENTERO', async () => {
    // Texto del SQL, no su ejecución (ver el límite en la cabecera): `lpad('7506306248861',5,'0')`
    // en Postgres TRUNCA a 75063, así que sin esta condición un EAN-13 casaba con cualquier c1
    // que empezara igual. Que sea correcto contra la base lo prueba el smoke de CV.26.
    const { svc, llamadas } = servicio({ kdii: [] });
    await svc.getPrecio('7506306248861');
    const q = llamadas.find((c) => c.sql.includes('FROM kepler_ods.kdii'))!;
    expect(q.sql).toMatch(/length\(\?\)\s*<=\s*5\s+AND\s+LPAD/);
    expect(q.bindings).toContain('7506306248861');
    expect(q.bindings).not.toContain('75063');
  });

  it('sin precio de venta cargado cae a la fórmula costo x margen x IVA (y lo hace sólo si hay costo)', async () => {
    const { svc } = servicio({ kdii: [kdii({ u1: '', pv1: null, costo: 60, margen: 40 })] });
    const r: any = await svc.getPrecio('00610', '03');
    expect(r.precio_con_iva).toBe(97.44);          // 60 x 1.40 x 1.16
    const sin = servicio({ kdii: [kdii({ u1: '', pv1: null, costo: null })] });
    const r2: any = await sin.svc.getPrecio('00610', '03');
    expect(r2.precio_con_iva).toBeNull();           // sin costo no se inventa un precio
    expect(r2.unidades).toEqual([]);
  });

  describe('unidad del código escaneado [TDA.3]', () => {
    const fila = kdii({
      bc1: '7501000000001', u1: 'PZA', pv1: 85.49,
      bc2: '7501000000012', u2: 'PAQ', pv2: 1010, f2: 12,
    });

    it('cada código dice de qué unidad es', async () => {
      const { svc } = servicio({ kdii: [fila] });
      expect(((await svc.getPrecio('7501000000001', '03')) as any).unidad_escaneada).toBe('PZA');
      expect(((await svc.getPrecio('7501000000012', '03')) as any).unidad_escaneada).toBe('PAQ');
    });

    it('la clave del propio producto no dice unidad: null ("no sé"), nunca "es la base"', async () => {
      const { svc } = servicio({ kdii: [fila] });
      const r: any = await svc.getPrecio('00610', '03');
      expect(r.unidad_escaneada).toBeNull();
      expect(r.unidad_base).toBe('PZA');
    });

    it('las unidades salen base-primero con su factor', async () => {
      const { svc } = servicio({ kdii: [fila] });
      const r: any = await svc.getPrecio('7501000000001', '03');
      expect(r.unidades.map((u: any) => [u.u, u.factor])).toEqual([['PZA', 1], ['PAQ', 12]]);
    });
  });

  describe('ambigüedades que se DECLARAN [TDA.2] [TDA.9]', () => {
    it('un código en dos productos distintos lo declara y lista los candidatos', async () => {
      const { svc } = servicio({
        kdii: [
          kdii({ codigo: '33252', nombre: 'MERENGUES', pv1: 28.36 }),
          kdii({ codigo: '33259', nombre: 'KOKITO ALFAJOR', pv1: 31.83 }),
        ],
      });
      const r: any = await svc.getPrecio('7501000000001');
      expect(r.codigo_ambiguo).toBe(true);
      expect(r.productos_candidatos.map((c: any) => c.codigo)).toEqual(['33252', '33259']);
    });

    it('un solo producto no es ambiguo', async () => {
      const { svc } = servicio({ kdii: [kdii()] });
      const r: any = await svc.getPrecio('00610', '03');
      expect(r.codigo_ambiguo).toBe(false);
      expect(r.productos_candidatos).toEqual([]);
    });

    const plazas = [
      kdii({ sucursal: '03', pv1: 85.49 }),
      kdii({ sucursal: '04', pv1: 88.0 }),
    ];

    it('sin plaza y con precios distintos entre plazas: precio_ambiguo declarado', async () => {
      const { svc } = servicio({ kdii: plazas });
      const r: any = await svc.getPrecio('00610');
      expect(r.precio_ambiguo).toBe(true);
      expect(r.plazas_con_precio_distinto).toBe(2);
    });

    it('con plaza pedida contesta la de esa plaza y no hay ambigüedad', async () => {
      const { svc } = servicio({ kdii: plazas });
      const r: any = await svc.getPrecio('00610', '04');
      expect(r.precio_ambiguo).toBe(false);
      expect(r.sucursal_precio).toBe('04');
      expect(r.precio_con_iva).toBe(88);
    });

    it('si la plaza pedida no tiene el producto lo dice y sigue con la determinista', async () => {
      const { svc } = servicio({ kdii: plazas });
      const r: any = await svc.getPrecio('00610', '05');
      expect(r.ok).toBe(true);
      expect(r.plaza_pedida_sin_dato).toBe(true);
    });

    it('CEDIS (00) va al final: el retail gana cuando no se pidió plaza', async () => {
      // El orden lo impone el SQL (ORDER BY); aquí se comprueba que el servicio respeta el que
      // recibe y que el texto de la consulta lo pide.
      const { svc, llamadas } = servicio({ kdii: [kdii({ sucursal: '03' }), kdii({ sucursal: '00' })] });
      const r: any = await svc.getPrecio('00610');
      expect(r.sucursal_precio).toBe('03');
      expect(llamadas.find((c) => c.sql.includes('FROM kepler_ods.kdii'))!.sql)
        .toMatch(/ORDER BY \(TRIM\(sucursal::text\) = '00'\)/);
    });
  });

  describe('mayoreo: las cuatro guardas [TDA.4]', () => {
    const conEtiqueta = async (o: Fila) => {
      const { svc } = servicio({ kdii: [kdii()], etiqueta: [etiqueta(o)] });
      return (await svc.getPrecio('00610', '03')) as any;
    };

    it('un mayoreo de pieza y uno de paquete salen con su unidad, su ahorro y su equivalencia', async () => {
      const r = await conEtiqueta({
        wholesale_piece_price: 79.9, wholesale_piece_min_qty: 3,
        wholesale_pack_price: 940, wholesale_pack_min_qty: 12,
        pack_price: 1010, pack_size: 12,
      });
      const [pieza, paquete] = r.mayoreo;
      expect(pieza).toMatchObject({
        etiqueta: 'pieza', desde: 3, palabra: 'piezas', precio_con_iva: 79.9, unidad_monto: 'c/u',
        aplica_a: 'base', ahorro_por_unidad: 5.59, ahorro_en_el_minimo: 16.77, realza: true,
      });
      expect(pieza.equivale_a).toBeNull();
      expect(paquete).toMatchObject({
        etiqueta: 'paquete', desde: 12, palabra: 'paquetes', precio_con_iva: 940,
        unidad_monto: 'por paquete', aplica_a: 'paquete',
      });
      // [VAC.H3] 12 paquetes de 12 = 144 piezas, calculado una vez aquí.
      expect(paquete.equivale_a).toBe('144 piezas');
    });

    it('⛔ guarda 2: un umbral "desde 1" no es mayoreo', async () => {
      const r = await conEtiqueta({ wholesale_piece_price: 79.9, wholesale_piece_min_qty: 1 });
      expect(r.mayoreo).toEqual([]);
    });

    it('⛔ guarda: sin umbral real NO se muestra (no se inventa un "desde 3")', async () => {
      const r = await conEtiqueta({ wholesale_piece_price: 79.9, wholesale_piece_min_qty: null });
      expect(r.mayoreo).toEqual([]);
    });

    it('⛔ guarda 3: si no es más barato que el unitario, no es mayoreo', async () => {
      const r = await conEtiqueta({ wholesale_piece_price: 85.49, wholesale_piece_min_qty: 3 });
      expect(r.mayoreo).toEqual([]);
      const r2 = await conEtiqueta({ wholesale_piece_price: 90, wholesale_piece_min_qty: 3 });
      expect(r2.mayoreo).toEqual([]);
    });

    it('⛔ guarda 4: sin precio unitario no hay contra qué comparar', async () => {
      const r = await conEtiqueta({ piece_price: null, wholesale_piece_price: 79.9, wholesale_piece_min_qty: 3 });
      expect(r.mayoreo).toEqual([]);
    });

    it('un descuento menor a 1 % se muestra pero NO se realza como oferta', async () => {
      const r = await conEtiqueta({ wholesale_piece_price: 85.0, wholesale_piece_min_qty: 3 });
      expect(r.mayoreo).toHaveLength(1);
      expect(r.mayoreo[0].realza).toBe(false);
    });

    it('con base PAQ/CJA no hay "pieza suelta" que mayorear', async () => {
      const r = await conEtiqueta({
        unit_base: 'PAQ', wholesale_piece_price: 79.9, wholesale_piece_min_qty: 3,
      });
      expect(r.mayoreo.find((t: any) => t.etiqueta === 'pieza')).toBeUndefined();
    });

    it('el gramaje califica al nombre y viaja con el producto', async () => {
      const r = await conEtiqueta({});
      expect(r.contenido).toBe('1.350 ML');
      expect(r.product_id).toBe('aaaaaaaa-0000-4000-8000-000000000001');
    });
  });

  describe('override manual [TDA.2]', () => {
    it('una corrección humana gana al ERP y se declara', async () => {
      const { svc } = servicio({
        kdii: [kdii()],
        etiqueta: [etiqueta({ source: 'manual', piece_price: 90 })],
      });
      const r: any = await svc.getPrecio('00610', '03');
      expect(r.origen_precio).toBe('override_manual');
      expect(r.precio_con_iva).toBe(90);
      expect(r.precio_sin_iva).toBe(77.59);   // 90 / 1.16
    });

    it('sin corrección, el origen es kepler', async () => {
      const { svc } = servicio({ kdii: [kdii()], etiqueta: [etiqueta()] });
      expect(((await svc.getPrecio('00610', '03')) as any).origen_precio).toBe('kepler');
    });
  });
});

describe('[VAC.L7] KpService.getPreciosTodos', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('⛔ un fallo de la base lanza 503 con código estable y no devuelve un catálogo "vacío"', async () => {
    const { svc } = servicio({ falla: true });
    await expect(svc.getPreciosTodos('03')).rejects.toBeInstanceOf(ServiceUnavailableException);
    try {
      await svc.getPreciosTodos('03');
    } catch (e) {
      const cuerpo = (e as ServiceUnavailableException).getResponse();
      expect(cuerpo).toEqual({ ok: false, codigo_error: 'error_interno' });
      expect(JSON.stringify(cuerpo)).not.toMatch(/relation|kdii|10\.20\.30\.40/);
    }
  });

  it('arma el snapshot: un renglón por código, sin los que no tienen precio, con códigos y unidad', async () => {
    const { svc } = servicio({
      kdii: [
        kdii({ codigo: '00610', bc1: '7501000000001', bc2: '7501000000012', u2: 'PAQ', pv2: 1010, f2: 12 }),
        kdii({ codigo: '00610' }),                                   // repetido: se ignora
        kdii({ codigo: '00700', u1: '', pv1: null, costo: null }),     // sin precio ni costo: no sirve
      ],
      etiqueta: [],
    });
    const r: any = await svc.getPreciosTodos('03');
    expect(r.total).toBe(1);
    expect(r.sucursal).toBe('03');
    const it0 = r.productos[0];
    expect(it0.c).toBe('00610');
    // Los códigos son los de las casillas, sin repetir la clave, y la unidad va en paralelo.
    expect(it0.b).toEqual(['7501000000001', '7501000000012']);
    expect(it0.bu).toEqual(['PZA', 'PAQ']);
    expect(it0.u.map((x: any) => x.u)).toEqual(['PZA', 'PAQ']);
  });

  it('[VAC.L11] el snapshot declara la versión de su formato', async () => {
    const { svc } = servicio({ kdii: [kdii()], etiqueta: [] });
    const r: any = await svc.getPreciosTodos('03');
    expect(r.v).toBe(VERIFICADOR_SNAPSHOT_FORMATO);
    expect(VERIFICADOR_SNAPSHOT_FORMATO).toBeGreaterThanOrEqual(2);
  });

  it('el mayoreo del snapshot es el MISMO tier que el modo en línea y sobrevive a la codificación', async () => {
    const { svc } = servicio({
      kdii: [kdii()],
      etiqueta: [etiqueta({
        sku: '610',
        wholesale_pack_price: 940, wholesale_pack_min_qty: 12, pack_price: 1010, pack_size: 12,
      })],
    });
    const r: any = await svc.getPreciosTodos('03');
    // La consulta indexa la etiqueta por SKU (sin ceros): `sku` es la llave de la unión en memoria.
    const compacto = r.productos[0].m?.[0];
    expect(compacto).toBeDefined();
    const tier = expandirTier(compacto);
    expect(compactarTier(tier)).toEqual(compacto);
    expect(tier.equivale_a).toBe('144 piezas');
  });

  describe('[MOS.1] lo que necesita el buscador del mostrador', () => {
    it('cada presentación lleva cuántas unidades base trae (la caja cuenta desde la pieza)', async () => {
      const { svc } = servicio({
        kdii: [kdii({ u2: 'PAQ', pv2: 126, f2: 40, u3: 'CJA', pv3: 2380, f3: 800 })],
      });
      const r: any = await svc.getPreciosTodos('03');
      expect(r.productos[0].u.map((x: any) => [x.u, x.f])).toEqual([['PZA', 1], ['PAQ', 40], ['CJA', 800]]);
    });

    it('el proveedor viaja como índice en un diccionario, sin repetir el nombre', async () => {
      const { svc } = servicio({
        kdii: [kdii({ codigo: '00610' }), kdii({ codigo: '00611' }), kdii({ codigo: '00612' })],
        proveedores: [
          { sku: '610', proveedor: 'DULCES DE LA ROSA' },
          { sku: '611', proveedor: 'DULCES DE LA ROSA' },
        ],
      });
      const r: any = await svc.getPreciosTodos('03');
      expect(r.pr).toEqual(['DULCES DE LA ROSA']);
      expect(r.productos.map((x: any) => x.pv)).toEqual([0, 0, undefined]);
    });

    it('⛔ sin proveedor en la ficha NO se inventa uno: el campo se omite', async () => {
      const { svc } = servicio({ kdii: [kdii()], proveedores: [] });
      const r: any = await svc.getPreciosTodos('03');
      expect(r.pr).toEqual([]);
      expect('pv' in r.productos[0]).toBe(false);
    });

    it('si falla la lectura del lote el snapshot sale igual, sin mayoreo ni proveedor', async () => {
      const { svc } = servicio({ kdii: [kdii()], fallaEtiqueta: true, proveedores: [{ sku: '610', proveedor: 'X' }] });
      const r: any = await svc.getPreciosTodos('03');
      expect(r.total).toBe(1);
      expect(r.pr).toEqual([]);
    });
  });
});

describe('[MOS.1] KpService.getPrecio publica el proveedor', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('el proveedor sale de la misma fila que el mayoreo', async () => {
    const { svc } = servicio({ kdii: [kdii()], etiqueta: [etiqueta({ proveedor: ' RICOLINO ' })] });
    const r: any = await svc.getPrecio('00610', '03');
    expect(r.proveedor).toBe('RICOLINO');
  });

  it('sin fila de etiqueta el proveedor es null, no una cadena vacía', async () => {
    const { svc } = servicio({ kdii: [kdii()], etiqueta: [] });
    const r: any = await svc.getPrecio('00610', '03');
    expect(r.proveedor).toBeNull();
  });
});
