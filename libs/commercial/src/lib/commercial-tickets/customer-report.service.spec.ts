import { CustomerReportService, ReporteFiltros } from './customer-report.service';

/**
 * Candado del servicio del reporte por cliente (TK.8).
 *
 * Lo que se prueba acá es el **SQL que se arma**, no la base: cada aserción corresponde a un
 * defecto que ya existió en este archivo y que ni `tsc` ni el build atrapan.
 *
 *  1. ⛔ **Los bindings no se interpolan.** `brand_id` y `supplier_id` llegan del query string;
 *     `.toString()` sobre un `knex.raw` los mete en el texto del SQL. Estuvo así.
 *  2. ⛔ **El alcance va DENTRO de la consulta.** El defecto anterior traía 26 filas alfabéticas
 *     y recién entonces filtraba por las plazas del usuario: con las coincidencias repartidas
 *     parejo entre nueve sucursales, alguien con acceso a una sola veía tres o ninguno.
 *  3. ⛔ **`ILIKE` no ignora acentos.** `'%MARIA%'` devolvía 869 clientes y `'%MARÍA%'` cero.
 *  4. ⛔ **El escape de `%` necesita la cláusula `ESCAPE`.** Sin ella Postgres ignora la barra
 *     y quien teclea un `%` obtiene un comodín (medido: con y sin escape, las mismas 5,299).
 *  5. **El `EXISTS` se correlaciona por (sucursal, doc_prefix, folio)**, no por `folio_digital`,
 *     que es una concatenación y no usa el índice del ODS.
 *
 * Se usa un knex de PostgreSQL sin conexión (`knex({ client: 'pg' })`): construye el SQL real
 * con sus bindings y nunca abre un socket.
 */

import knexLib from 'knex';

const TENANT = '00000000-0000-0000-0000-00000000d01c';

/** Captura el SQL y los bindings de la consulta que el servicio arma, sin tocar una base. */
function servicio() {
  const knex = knexLib({ client: 'pg' });
  const capturado: { sql: string; bindings: readonly unknown[] }[] = [];

  // `trx` es el propio knex: el servicio sólo lo usa para construir. Se intercepta `raw` para
  // quedarse con el SQL literal, y las consultas del builder se resuelven a [] con `then`.
  const trx = new Proxy(knex, {
    apply(target, _this, args: unknown[]) {
      const qb = (target as unknown as (t: string) => Record<string, unknown>)(args[0] as string);
      return new Proxy(qb, {
        get(t, prop) {
          if (prop === 'then') {
            return (res: (v: unknown[]) => void) => {
              const c = (t as unknown as { toSQL(): { sql: string; bindings: readonly unknown[] } }).toSQL();
              capturado.push({ sql: c.sql, bindings: c.bindings });
              res([]);
              return Promise.resolve([]);
            };
          }
          return Reflect.get(t, prop);
        },
      });
    },
    get(t, prop) {
      if (prop === 'raw') {
        return (sql: string, bindings?: unknown[]) => {
          // El `raw` del buscador se ejecuta (tiene `.rows`); los de `select` sólo se componen.
          if (/SELECT cliente_code/.test(sql)) {
            capturado.push({ sql, bindings: bindings ?? [] });
            return Promise.resolve({ rows: [] });
          }
          return (t as unknown as { raw(s: string, b?: unknown[]): unknown }).raw(sql, bindings);
        };
      }
      return Reflect.get(t, prop);
    },
  }) as unknown as Parameters<Parameters<FakeTk['run']>[0]>[0];

  interface FakeTk { run<T>(fn: (trx: unknown) => Promise<T>): Promise<T> }
  const tk = { run: <T>(fn: (t: unknown) => Promise<T>) => fn(trx) } as FakeTk;
  const ctx = { requireTenantId: () => TENANT };

  const svc = new CustomerReportService(
    tk as never,
    ctx as never,
  );
  return { svc, capturado, knex };
}

const SIN: ReporteFiltros = {};

describe('el buscador de clientes', () => {
  it('normaliza acentos en LOS DOS lados: "MARÍA" y "MARIA" no pueden dar distinto', async () => {
    const { svc, capturado, knex } = servicio();
    await svc.clientes('MARÍA', null);
    const q = capturado[0];
    expect(q.sql).toContain('unaccent(nombre)');
    // Dos veces: una para el ILIKE y otra para el operador de parecido.
    expect((q.sql.match(/unaccent\(nombre\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(q.sql).toContain('unaccent(?)');
    await knex.destroy();
  });

  it('admite errores de dedo: usa el operador de similitud, no sólo ILIKE', async () => {
    const { svc, capturado, knex } = servicio();
    await svc.clientes('abarotes', null);
    expect(capturado[0].sql).toContain('%');
    expect(capturado[0].sql).toContain('similarity(');
    await knex.destroy();
  });

  it('ordena por PARECIDO, no alfabéticamente', async () => {
    const { svc, capturado, knex } = servicio();
    await svc.clientes('abarrotes', null);
    expect(capturado[0].sql).toContain('ORDER BY score DESC');
    await knex.destroy();
  });

  it('agrupa por clave: el catálogo está replicado en las nueve plazas', async () => {
    const { svc, capturado, knex } = servicio();
    await svc.clientes('abarrotes', null);
    expect(capturado[0].sql).toContain('GROUP BY cliente_code');
    await knex.destroy();
  });

  /** ⛔ El defecto que dejaba sin resultados a quien alcanza una sola plaza. */
  it('el alcance va DENTRO del WHERE, antes del LIMIT', async () => {
    const { svc, capturado, knex } = servicio();
    await svc.clientes('abarrotes', ['05']);
    const q = capturado[0];
    expect(q.sql).toContain('fuente_sucursal = ANY(?)');
    // ⚠️ El binding es el ARREGLO entero (`ANY(?)` recibe un array), no cada código suelto.
    expect(q.bindings).toContainEqual(['05']);
    expect(q.sql.indexOf('fuente_sucursal = ANY')).toBeLessThan(q.sql.indexOf('LIMIT'));
    await knex.destroy();
  });

  it('sin alcance no inventa un filtro de sucursal', async () => {
    const { svc, capturado, knex } = servicio();
    await svc.clientes('abarrotes', null);
    expect(capturado[0].sql).not.toContain('fuente_sucursal = ANY');
    await knex.destroy();
  });

  /** ⛔ El escape sin la cláusula ESCAPE no hace nada. */
  it('escapa el % tecleado Y declara la cláusula ESCAPE', async () => {
    const { svc, capturado, knex } = servicio();
    await svc.clientes('50%', null);
    const q = capturado[0];
    expect(q.sql).toContain("ESCAPE '\\'");
    expect(q.bindings).toContain('%50\\%%');
    await knex.destroy();
  });

  it('excluye CONTADO: la venta de piso no es de nadie', async () => {
    const { svc, capturado, knex } = servicio();
    await svc.clientes('contado', null);
    expect(capturado[0].bindings).toContain('CONTADO');
    await knex.destroy();
  });

  it('con menos de dos letras no pregunta nada', async () => {
    const { svc, capturado, knex } = servicio();
    const r = await svc.clientes('a', null);
    expect(capturado.length).toBe(0);
    expect(r.candidatos).toEqual([]);
    await knex.destroy();
  });
});

describe('el reporte: el SQL que se arma', () => {
  const sqlDe = async (f: ReporteFiltros, alcance: string[] | null = null) => {
    const { svc, capturado, knex } = servicio();
    await svc.reporte('10448', f, alcance);
    await knex.destroy();
    return capturado.map((c) => c);
  };

  it('el cliente NO lleva sucursal en la identidad: la clave es global', async () => {
    const qs = await sqlDe(SIN);
    const mos = qs.find((q) => q.sql.includes('erp_sale_tickets'));
    expect(mos?.bindings).toContain('10448');
    // Sin alcance ni filtro, no hay recorte de plaza en el WHERE.
    expect(mos?.sql).not.toContain('"sucursal" in');
  });

  it('el alcance recorta las dos consultas, no sólo una', async () => {
    const qs = await sqlDe(SIN, ['01', '05']);
    const mos = qs.find((q) => q.sql.includes('erp_sale_tickets'));
    const fac = qs.find((q) => q.sql.includes('erp_sales_invoices'));
    for (const q of [mos, fac]) {
      expect(q?.sql).toContain('"sucursal" in');
      expect(q?.bindings).toContain('05');
    }
  });

  /** El folio no identifica un documento: cada plaza y cada caja tienen su contador. */
  it('el folio es "contiene", no igualdad, y va escapado', async () => {
    const qs = await sqlDe({ folio: '6440' });
    const mos = qs.find((q) => q.sql.includes('erp_sale_tickets'));
    expect(mos?.sql).toContain('ILIKE');
    expect(mos?.bindings).toContain('%6440%');
  });

  /** ⚠️ `caja` sólo existe en mostrador: pedirla no puede traer facturas. */
  it('filtrar por caja NO consulta el universo de facturas', async () => {
    const qs = await sqlDe({ caja: 5 });
    expect(qs.some((q) => q.sql.includes('erp_sale_tickets'))).toBe(true);
    expect(qs.some((q) => q.sql.includes('erp_sales_invoices'))).toBe(false);
  });

  it('sin filtro de caja sí consulta los dos universos', async () => {
    const qs = await sqlDe(SIN);
    expect(qs.some((q) => q.sql.includes('erp_sale_tickets'))).toBe(true);
    expect(qs.some((q) => q.sql.includes('erp_sales_invoices'))).toBe(true);
  });

  /** «Atendió» mira columnas distintas según el universo: cajero acá, vendedor allá. */
  it('atendió mira cajero_code en mostrador y vendedor_code en facturas', async () => {
    const qs = await sqlDe({ atendio: 'RT01' });
    expect(qs.find((q) => q.sql.includes('erp_sale_tickets'))?.sql).toContain('cajero_code');
    expect(qs.find((q) => q.sql.includes('erp_sales_invoices'))?.sql).toContain('vendedor_code');
  });

  describe('el EXISTS de marca y proveedor', () => {
    /** ⛔ El defecto real: `.toString()` sobre un raw mete el UUID en el texto del SQL. */
    it('el UUID viaja como BINDING, nunca dentro del SQL', async () => {
      const id = '11111111-2222-3333-4444-555555555555';
      const qs = await sqlDe({ brand_id: id });
      const mos = qs.find((q) => q.sql.includes('erp_sale_tickets'));
      expect(mos?.sql).not.toContain(id);
      expect(mos?.bindings).toContain(id);
    });

    it('se correlaciona por (sucursal, doc_prefix, folio), no por folio_digital', async () => {
      const qs = await sqlDe({ brand_id: '11111111-2222-3333-4444-555555555555' });
      const mos = qs.find((q) => q.sql.includes('erp_sale_tickets'));
      expect(mos?.sql).toContain('l.doc_prefix = t.doc_prefix');
      expect(mos?.sql).toContain('l.folio = t.folio');
      expect(mos?.sql).not.toContain('l.folio_digital');
    });

    it('sin marca ni proveedor no agrega el EXISTS', async () => {
      const qs = await sqlDe(SIN);
      expect(qs.find((q) => q.sql.includes('erp_sale_tickets'))?.sql).not.toContain('EXISTS');
    });
  });
});
