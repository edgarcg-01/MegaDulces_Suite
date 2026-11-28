import { ConflictException, NotFoundException } from '@nestjs/common';
import { InventoryCountService } from './inventory-count.service';

/**
 * ⭐⭐ `[ICR.M3]` — **La CAPTURA es la unidad del conteo: el mismo producto en dos racks SUMA.**
 *
 * ## El defecto que cierra (F35, medido el 2026-11-27)
 *
 * El renglón del folio guardaba **un número por producto**. El segundo que encontraba el mismo
 * producto en otro rack recibía *«ya tiene un primer conteo de otra persona; no se puede
 * sobrescribir»* y **esa mercancía no se contaba: salía como faltante**. En una distribuidora de
 * dulces, producto en anaquel **y** en bodega es lo normal — en el catálogo de ubicaciones, de
 * 40 productos asignados **8 están en dos o tres lugares**.
 *
 * Y la bitácora (`commercial.inventory_count_scan_log`) guardaba quién y cuándo pero **ni la
 * cantidad ni el rack** (F34): 11 filas en prod, ninguna con un número.
 *
 * ## Qué se fija acá
 *
 * La identidad de una captura es **(renglón, rack, persona, vuelta)**: misma persona en el mismo
 * rack **corrige**, otro rack u otra persona **suma**, y `count_N` pasa a ser la **SUMA de las
 * capturas vivas de esa vuelta** — derivado, no tecleado, y todavía en la unidad del teórico.
 *
 * ⛔ Y el aviso dice **dónde**, nunca **cuánto**: el conteo es ciego, y decirle «ya hay 24» le da
 * a la persona un número al que anclarse.
 *
 * ## Alcance de lo que afirma
 *
 * El `trx` es un **doble en memoria**, no Postgres: acá no corre una línea de SQL, así que esto
 * **no** prueba el RLS, ni la PK de idempotencia, ni el `FOR UPDATE`, ni la migración. Lo que sí
 * ejerce es la **lógica de composición del número**, que es exactamente donde estaba el defecto
 * y donde un error no se ve hasta que el inventario ya se ajustó. Que el endpoint escribe de
 * verdad contra base real sigue **NO MEDIDO** (ADR-044: eso se prueba por HTTP).
 *
 * ⚠️ Sin `import` de `vitest`: el runner del monorepo inyecta los globales.
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const FOLIO = 'f0110000-0000-4000-8000-000000000001';
const WH = 'a1a1a1a1-0000-4000-8000-000000000001';
const PROD = 'b2b2b2b2-0000-4000-8000-000000000001';
const ITEM = 'c3c3c3c3-0000-4000-8000-000000000001';
const RACK_1 = 'd4d4d4d4-0000-4000-8000-000000000001';
const RACK_2 = 'd4d4d4d4-0000-4000-8000-000000000002';
const RACK_AJENO = 'd4d4d4d4-0000-4000-8000-000000000009';
const ANA = 'e5e5e5e5-0000-4000-8000-00000000000a';
const BETO = 'e5e5e5e5-0000-4000-8000-00000000000b';

type Fila = Record<string, any>;

/** Reloj monótono del doble: `clock_timestamp()` tiene que avanzar entre capturas. */
let reloj = 0;
const ahora = () => new Date(Date.UTC(2026, 10, 27, 12, 0, 0) + ++reloj * 1000);

const esRaw = (v: any) => !!v && typeof v === 'object' && typeof v.__raw === 'string';
const resolverRaw = (v: any) => {
  if (!esRaw(v)) return v;
  if (v.__raw.includes('current_tenant_id')) return TENANT;
  return ahora(); // now() / clock_timestamp()
};
const cmp = (a: any, b: any) => {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (x == null && y == null) return 0;
  if (x == null) return -1;
  if (y == null) return 1;
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * Un `trx` de knex en memoria, con lo justo que `submitCount` usa. Es deliberadamente tonto:
 * si una consulta nueva no está soportada, revienta en vez de devolver vacío — un doble que
 * contesta `[]` a lo que no entiende haría pasar las pruebas por vacuidad.
 */
function baseFalsa(tablas: Record<string, Fila[]>) {
  const trx: any = (tabla: string) => {
    if (!(tabla in tablas)) tablas[tabla] = [];
    const filtros: ((f: Fila) => boolean)[] = [];
    const ordenes: { col: string; dir: string }[] = [];
    let cols: string[] | null = null;

    const leer = () => {
      let out = tablas[tabla].filter((f) => filtros.every((w) => w(f)));
      for (const o of [...ordenes].reverse()) {
        out = [...out].sort((a, b) => cmp(a[o.col], b[o.col]) * (o.dir === 'desc' ? -1 : 1));
      }
      return out.map((f) => (cols ? Object.fromEntries(cols.map((c) => [c, f[c]])) : { ...f }));
    };

    const api: any = {
      where(cond: any, ...resto: any[]) {
        if (typeof cond === 'object' && cond !== null)
          filtros.push((f) => Object.entries(cond).every(([k, v]) => f[k] === v));
        else if (resto.length === 1) filtros.push((f) => f[cond] === resto[0]);
        else throw new Error(`doble: where(${String(cond)}) no soportado`);
        return api;
      },
      whereIn(col: string, vals: any[]) {
        filtros.push((f) => vals.includes(f[col]));
        return api;
      },
      whereNotNull(col: string) {
        filtros.push((f) => f[col] != null);
        return api;
      },
      forUpdate: () => api,
      orderBy(col: string, dir = 'asc') {
        ordenes.push({ col, dir });
        return api;
      },
      select(...c: any[]) {
        cols = c.flat().map(String);
        return api;
      },
      distinct(...c: any[]) {
        cols = c.flat().map(String);
        return api;
      },
      first: async () => leer()[0],
      insert(filas: Fila | Fila[]) {
        const arr = (Array.isArray(filas) ? filas : [filas]).map((f) =>
          Object.fromEntries(Object.entries(f).map(([k, v]) => [k, resolverRaw(v)])),
        );
        const meter = () => {
          const metidas: Fila[] = [];
          for (const f of arr) {
            const choca =
              tabla === 'commercial.inventory_count_scan_log' &&
              tablas[tabla].some(
                (x) =>
                  x.tenant_id === f.tenant_id &&
                  x.count_id === f.count_id &&
                  x.scan_uuid === f.scan_uuid,
              );
            if (choca) continue; // onConflict().ignore()
            const fila = { id: f.id ?? `gen-${++reloj}`, ...f };
            tablas[tabla].push(fila);
            metidas.push(fila);
          }
          return metidas;
        };
        const ins: any = {
          returning: async () => meter(),
          onConflict: () => ({ ignore: async () => meter() }),
          then: (res: any, rej: any) => Promise.resolve(meter()).then(res, rej),
        };
        return ins;
      },
      async update(patch: Fila) {
        const objetivo = tablas[tabla].filter((f) => filtros.every((w) => w(f)));
        for (const f of objetivo)
          for (const [k, v] of Object.entries(patch)) f[k] = resolverRaw(v);
        return objetivo.length;
      },
      then: (res: any, rej: any) => Promise.resolve(leer()).then(res, rej),
    };
    return api;
  };
  trx.raw = (sql: string) => ({ __raw: sql });
  trx.fn = { now: () => ({ __raw: 'now()' }) };
  return trx;
}

/** El servicio con la base falsa y los dos resolvedores que sí piden SQL, puestos a mano. */
function montar(opts: { factor?: number; unidad?: string } = {}) {
  const tablas: Record<string, Fila[]> = {
    'commercial.inventory_counts': [
      {
        id: FOLIO,
        tenant_id: TENANT,
        warehouse_id: WH,
        folio: 'INV-2026-99999',
        status: 'counting',
        current_pass: 1,
        freeze_movements: true,
        blind_double_count: true,
        stock_source: 'erp',
        recount_threshold_pct: 2,
      },
    ],
    'commercial.inventory_count_items': [
      {
        id: ITEM,
        tenant_id: TENANT,
        count_id: FOLIO,
        product_id: PROD,
        expected_qty: 100,
        status: 'pending',
        aisle_id: null,
        count_1: null,
        count_2: null,
        count_3: null,
        counted_by_1: null,
        counted_by_2: null,
        counted_by_3: null,
      },
    ],
    'commercial.inventory_count_scan_log': [],
    'commercial.inventory_count_assignments': [],
    'commercial.warehouse_aisles': [
      { id: RACK_1, warehouse_id: WH, code: 'R-1', name: 'Anaquel 1', active: true },
      { id: RACK_2, warehouse_id: WH, code: 'R-2', name: 'Bodega', active: true },
      { id: RACK_AJENO, warehouse_id: 'otro-almacen', code: 'X-9', name: 'De otra sucursal' },
    ],
    'identity.users': [
      { id: ANA, username: 'ana', nombre: 'Ana' },
      { id: BETO, username: 'beto', nombre: 'Beto' },
    ],
    'public.products': [{ id: PROD, sku: '00182', nombre: 'Paleta payaso' }],
  };
  const trx = baseFalsa(tablas);
  let uid: string | null = ANA;
  const tk = { run: async (fn: any) => fn(trx) };
  const ctx = { get: () => ({ tenantId: TENANT, userId: uid, username: 'quien-sea' }) };
  const monitor = { emitFolioEvent: () => undefined };
  const svc = new InventoryCountService(tk as any, ctx as any, monitor as any);
  // Los dos únicos ayudantes que hablan SQL que el doble no modela. Se ponen a mano y se
  // DECLARA: lo que afirma este archivo no incluye la resolución de unidades ni la ubicación.
  (svc as any).unidadesDeConteo = async () => ({
    nativa: { unit: 'PAQ', factor: 1, es_nativa: true },
    opciones: [
      { unit: 'PAQ', factor: 1, es_nativa: true },
      { unit: opts.unidad ?? 'CJA', factor: opts.factor ?? 24, es_nativa: false },
    ],
  });
  (svc as any).codigosDeUbicacion = async () => null;
  return {
    svc,
    tablas,
    comoAna: () => (uid = ANA),
    comoBeto: () => (uid = BETO),
    renglon: () => tablas['commercial.inventory_count_items'].find((i) => i.id === ITEM)!,
    bitacora: () => tablas['commercial.inventory_count_scan_log'],
  };
}

const contar = (svc: InventoryCountService, extra: Record<string, any>) =>
  svc.submitCount(FOLIO, { product_id: PROD, ...extra } as any);

describe('[ICR.M3] la captura es la unidad del conteo', () => {
  // ── CONTROL del instrumento ────────────────────────────────────────────────────────────
  /**
   * Sin esto, cualquier `submitCount` que reventara por una consulta que el doble no modela
   * haría pasar por vacuidad todo lo de abajo.
   */
  it('CONTROL — una captura escribe en la bitácora su cantidad y su rack, y el renglón la refleja', async () => {
    const t = montar();
    const r: any = await contar(t.svc, { quantity: 24, aisle_id: RACK_1 });

    expect(r.ok).toBe(true);
    expect(r.slot).toBe('count_1');
    expect(t.bitacora()).toHaveLength(1);
    expect(t.bitacora()[0]).toMatchObject({
      item_id: ITEM,
      slot: 'count_1',
      aisle_id: RACK_1,
      applied_by: ANA,
      quantity: 24,
      quantity_native: 24,
    });
    expect(Number(t.renglon().count_1)).toBe(24);
    expect(r.capture_mode).toBe('first');
  });

  // ── §4.2 del anexo: los tres casos ─────────────────────────────────────────────────────
  it('misma persona, MISMO rack → CORRIGE (no suma), y avisa con el número propio', async () => {
    const t = montar();
    await contar(t.svc, { quantity: 24, aisle_id: RACK_1 });
    const r: any = await contar(t.svc, { quantity: 12, aisle_id: RACK_1 });

    expect(Number(t.renglon().count_1), '24 y 12 en el mismo rack son 12, no 36').toBe(12);
    expect(r.capture_mode).toBe('correction');
    expect(r.previous_own_qty, 'sin el número propio, una recaptura pisa en silencio (F33)').toBe(24);
    expect(r.other_captures).toEqual([]);
    expect(t.bitacora(), 'la bitácora es append-only: la corrección NO borra el rastro').toHaveLength(2);
  });

  it('⛔ F35 — mismo producto en OTRO rack: SUMA en vez de rechazarse', async () => {
    const t = montar();
    await contar(t.svc, { quantity: 24, aisle_id: RACK_1 });
    const r: any = await contar(t.svc, { quantity: 5, aisle_id: RACK_2 });

    expect(Number(t.renglon().count_1), 'la mercancía de bodega se perdía: salía como faltante').toBe(29);
    expect(r.capture_mode).toBe('added');
    expect(r.other_captures).toHaveLength(1);
    expect(r.other_captures[0].aisle_code).toBe('R-1');
  });

  it('⛔ F35 — OTRA persona en el mismo rack: SUMA, y el aviso dice QUIÉN (ya no es un 409)', async () => {
    const t = montar();
    await contar(t.svc, { quantity: 24, aisle_id: RACK_1 });
    t.comoBeto();
    const r: any = await contar(t.svc, { quantity: 6, aisle_id: RACK_1 });

    expect(Number(t.renglon().count_1)).toBe(30);
    expect(r.capture_mode).toBe('added');
    expect(r.other_captures[0].counted_by_name).toBe('Ana');
    expect(r.other_captures[0].aisle_code).toBe('R-1');
  });

  it('sin racks dados de alta (Yurécuaro tiene 0) el montón «sin rack» se comporta igual', async () => {
    const t = montar();
    await contar(t.svc, { quantity: 10 }); // sin aisle_id
    const propia: any = await contar(t.svc, { quantity: 4 });
    expect(propia.capture_mode, 'misma persona, mismo (no) rack → corrige').toBe('correction');
    expect(Number(t.renglon().count_1)).toBe(4);

    t.comoBeto();
    const ajena: any = await contar(t.svc, { quantity: 7 });
    expect(ajena.capture_mode, 'otra persona → suma').toBe('added');
    expect(Number(t.renglon().count_1)).toBe(11);
  });

  // ── §4.3: dónde sí, cuánto NO ──────────────────────────────────────────────────────────
  it('⛔⛔ el aviso NUNCA lleva la cantidad ajena: el conteo es ciego', async () => {
    const t = montar();
    await contar(t.svc, { quantity: 777, aisle_id: RACK_1 }); // un número imposible de confundir
    t.comoBeto();
    const r: any = await contar(t.svc, { quantity: 3, aisle_id: RACK_2 });

    const serializada = JSON.stringify(r);
    expect(serializada, 'la cantidad de la otra persona viajó a la pantalla').not.toContain('777');
    // Control del propio control: el número PROPIO sí viaja (si no, la prueba de arriba pasaría
    // porque la respuesta está vacía).
    expect(serializada).toContain('3');
    expect(r.other_captures[0].aisle_code, 'el DÓNDE sí tiene que llegar').toBe('R-1');
    expect(Object.keys(r.other_captures[0]).join(',')).not.toMatch(/quantity|qty|cantidad/i);
  });

  // ── La unidad: count_N sigue viviendo en la del teórico ────────────────────────────────
  it('la suma vive en la unidad NATIVA: 3 cajas de 24 son 72, y una más en otro rack son 73', async () => {
    const t = montar({ unidad: 'CJA', factor: 24 });
    await contar(t.svc, { quantity: 3, unit: 'CJA', aisle_id: RACK_1 });
    expect(Number(t.renglon().count_1)).toBe(72);
    await contar(t.svc, { quantity: 1, unit: 'PAQ', aisle_id: RACK_2 });
    expect(Number(t.renglon().count_1), 'se sumaron cajas con paquetes sin convertir').toBe(73);
  });

  // ── La excepción que NO se retira (§4.4) ───────────────────────────────────────────────
  it('⭐ la misma persona NO puede hacer el 2.º conteo, aunque otra haya capturado DESPUÉS', async () => {
    const t = montar();
    await contar(t.svc, { quantity: 24, aisle_id: RACK_1 }); // Ana
    t.comoBeto();
    await contar(t.svc, { quantity: 6, aisle_id: RACK_2 }); // Beto captura después
    // `counted_by_1` ya apunta a Beto: si el guard sólo mirara la columna, Ana pasaría.
    expect(t.renglon().counted_by_1).toBe(BETO);

    t.comoAna();
    await expect(
      contar(t.svc, { quantity: 24, capture_pass: 2, aisle_id: RACK_1 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('PRUEBA NEGATIVA — el candado no rechaza a TODOS: quien no contó la 1.ª sí hace la 2.ª', async () => {
    const t = montar();
    await contar(t.svc, { quantity: 24, aisle_id: RACK_1 }); // Ana
    t.comoBeto();
    const r: any = await contar(t.svc, { quantity: 24, capture_pass: 2, aisle_id: RACK_1 });
    expect(r.slot).toBe('count_2');
    expect(Number(t.renglon().count_2)).toBe(24);
    expect(Number(t.renglon().count_1), 'la 2.ª vuelta no debe tocar la 1.ª').toBe(24);
  });

  // ── Un rack inventado crearía una identidad fantasma ───────────────────────────────────
  it('un rack que no es de este almacén se rechaza (si no, «corregir» se volvería «sumar»)', async () => {
    const t = montar();
    await expect(
      contar(t.svc, { quantity: 1, aisle_id: RACK_AJENO }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(contar(t.svc, { quantity: 1, aisle_id: 'no-soy-uuid' })).rejects.toThrow(
      /aisle_id/,
    );
  });

  // ── Lo que ya estaba bien y no se rompe ────────────────────────────────────────────────
  it('la idempotencia por scan_uuid sigue: un reenvío no suma ni escribe otra captura', async () => {
    const t = montar();
    await contar(t.svc, { quantity: 24, aisle_id: RACK_1, scan_uuid: 'aaaa-1' });
    const r: any = await contar(t.svc, { quantity: 24, aisle_id: RACK_1, scan_uuid: 'aaaa-1' });

    expect(r.duplicate).toBe(true);
    expect(t.bitacora()).toHaveLength(1);
    expect(Number(t.renglon().count_1), 'el replay duplicó la mercancía').toBe(24);
  });

  it('el cero es capturable y vale: «aquí no hay nada» es un faltante CONTADO', async () => {
    const t = montar();
    await contar(t.svc, { quantity: 0, aisle_id: RACK_1 });
    expect(Number(t.renglon().count_1)).toBe(0);
    expect(t.renglon().status).toBe('counted');
    expect(t.bitacora()[0].quantity_native).toBe(0);
  });
});

/**
 * ⛔⛔ `[ICR.M11]` — **Escanear la CAJA no puede contar piezas en silencio.**
 *
 * Agregar `catalog.product_barcodes` a la resolución rescata **649** códigos que hoy dan
 * «producto no encontrado»… y **335 de ellos no son el código de la unidad nativa**: son el de
 * la caja o el del paquete. Si se aceptaran sin más, alguien escanea una caja, teclea `3`, y el
 * folio guarda **3 piezas en vez de 3 cajas**.
 *
 * ⭐ Eso es **peor que el 404 que reemplaza**: el 404 se ve, el undercount no. Y no se puede
 * arreglar adivinando el factor — medido en prod el 2026-11-27, **248 de los 254 códigos `CJA`**
 * del folio de Yurécuaro tienen `factor` NULL: no hay con qué convertir.
 *
 * ⚠️ **Alcance.** Acá se ejerce el GUARD, no el resolvedor: `resolverProductoPorCodigo` se
 * sustituye por un doble porque tiene su propio archivo
 * (`inventory-count.codigo-normalizado.spec.ts`) con la escalera completa y su control contra
 * prod. Lo que se fija es qué hace `submitCount` con lo que el resolvedor le dice del código.
 */
describe('[ICR.M11] escanear la caja no cuenta piezas en silencio', () => {
  const CODIGO_DE_CAJA = '7501000000028';

  /** Monta el servicio y le dice al resolvedor qué clase de código se escaneó. */
  function conCodigo(hallazgo: Record<string, unknown> | null) {
    const t = montar();
    (t.svc as any).resolverProductoPorCodigo = async () =>
      hallazgo === null ? null : { product_id: PROD, fuente: 'folio-exacto-codigos', ...hallazgo };
    return t;
  }

  const CAJA = {
    unidad_del_codigo: 'CJA',
    factor_del_codigo: null,
    es_codigo_nativo: false,
  };
  const NATIVO = {
    unidad_del_codigo: 'PAQ',
    factor_del_codigo: 1,
    es_codigo_nativo: true,
  };

  it('CONTROL — el arnés llega de verdad a submitCount: un código nativo cuenta normal', async () => {
    const t = conCodigo(NATIVO);
    const r: any = await t.svc.submitCount(FOLIO, { barcode: '7501000000011', quantity: 4 } as any);
    expect(r.ok).toBe(true);
    expect(Number(t.renglon().count_1)).toBe(4);
  });

  it('⛔⛔ el código de la CAJA sin unidad declarada se RECHAZA, no se cuenta como piezas', async () => {
    const t = conCodigo(CAJA);
    const p = t.svc.submitCount(FOLIO, { barcode: CODIGO_DE_CAJA, quantity: 3 } as any);
    await expect(p).rejects.toBeInstanceOf(ConflictException);
    const err: any = await p.catch((e: any) => e);
    const cuerpo = err.getResponse();
    expect(cuerpo.code).toBe('UNIDAD_NO_DECLARADA');
    expect(cuerpo.scanned_unit).toBe('CJA');
    expect(cuerpo.native_unit).toBe('PAQ');
    // ⚠️ El factor se declara NULL en vez de inventarse: es lo que pasa en 248 de 254 casos.
    expect(cuerpo.scanned_factor).toBeNull();
    expect(cuerpo.units_available.length, 'la pantalla necesita con qué preguntar').toBeGreaterThan(0);
    // Y lo que más importa: NO se escribió nada.
    expect(t.renglon().count_1, 'se contó igual, en la unidad equivocada').toBeNull();
    expect(t.bitacora()).toHaveLength(0);
  });

  it('PRUEBA NEGATIVA — con la unidad declarada SÍ cuenta, y convierte', async () => {
    // Sin esto, el guard podría estar rechazando todo código de caja y el candado de arriba
    // seguiría verde — dejando 335 códigos sin forma de contarse nunca.
    const t = conCodigo(CAJA);
    const r: any = await t.svc.submitCount(FOLIO, {
      barcode: CODIGO_DE_CAJA,
      quantity: 3,
      unit: 'CJA',
    } as any);
    expect(r.ok).toBe(true);
    expect(Number(t.renglon().count_1), '3 cajas de 24 son 72 paquetes').toBe(72);
  });

  it('un código no nativo de la MISMA unidad que la nativa no molesta a nadie', async () => {
    // 26 de los rescatados son así: no primarios pero en la unidad nativa. Cuentan normal.
    const t = conCodigo({ unidad_del_codigo: 'PAQ', factor_del_codigo: 1, es_codigo_nativo: false });
    const r: any = await t.svc.submitCount(FOLIO, { barcode: '7501000000033', quantity: 5 } as any);
    expect(r.ok).toBe(true);
    expect(Number(t.renglon().count_1)).toBe(5);
  });

  it('⭐ la respuesta dice en qué unidad estaba el código, para que la pantalla preseleccione', async () => {
    const t = conCodigo(CAJA);
    const r: any = await t.svc.submitCount(FOLIO, {
      barcode: CODIGO_DE_CAJA,
      quantity: 2,
      unit: 'CJA',
    } as any);
    expect(r.scanned_unit).toBe('CJA');
    expect(r.scanned_code_is_native).toBe(false);
    expect(r.scanned_unit_factor, 'el factor que falta se declara, no se rellena').toBeNull();
  });

  it('cuando el producto llega por product_id (la pantalla ya eligió) no hay guard que estorbe', async () => {
    const t = conCodigo(CAJA); // el resolvedor ni se llama: no hay barcode
    const r: any = await t.svc.submitCount(FOLIO, { product_id: PROD, quantity: 7 } as any);
    expect(r.ok).toBe(true);
    expect(r.scanned_unit).toBeNull();
    expect(Number(t.renglon().count_1)).toBe(7);
  });
});
