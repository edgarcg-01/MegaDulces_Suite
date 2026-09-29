import knexLib from 'knex';
import { CustomerReportService } from './customer-report.service';

/**
 * `[TK.d3]` El descuento del reporte por cliente salía en CERO justo en el universo donde
 * existe.
 *
 * El `SELECT` de facturas traía `0::numeric as descuento_documento` clavado, mientras la vista
 * `analytics.erp_sales_invoices` publica `descuento` (el importe de cabecera, `kdm1.c13`) y
 * `descuento_pct` (`c19`). Y ese universo —telemarketing y crédito— es el **único** donde el
 * descuento de cabecera se usa: en el ticket de mostrador `c13` es 0.00 en el 100% de los
 * 30,549 documentos medidos (`ERP_KEPLER` §3.1).
 *
 * Consecuencias que se veían en pantalla y nadie podía distinguir de «este cliente no tuvo
 * descuento»:
 *
 *  1. La columna «Descuento» del papel y de la tabla imprimía `—` en toda factura.
 *  2. El KPI del resumen sumaba cero.
 *  3. ⛔ **El filtro «Sólo con descuento» no podía devolver una sola factura**, porque filtra
 *     por `descuento > 0` sobre ese mismo campo. Un filtro que siempre devuelve vacío se lee
 *     como un hecho del negocio, no como un defecto.
 *
 * Se prueba contra el SQL que se arma y contra el mapeo, con un knex de Postgres sin conexión.
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';

/** Filas que el doble de knex devuelve según la tabla que se consulte. */
interface Canned { tickets?: unknown[]; facturas?: unknown[]; plazas?: unknown[] }

function servicio(rows: Canned = {}) {
  const knex = knexLib({ client: 'pg' });
  const capturado: string[] = [];

  const esBuilder = (v: unknown): boolean =>
    !!v && typeof v === 'object' && typeof (v as { toSQL?: unknown }).toSQL === 'function';

  // El envoltorio es RECURSIVO a propósito: `.where().select().limit()` devuelve un builder
  // nuevo en cada eslabón, y el pelado intentaría abrir una conexión de verdad al esperarlo.
  const envolver = (qb: object): object => new Proxy(qb, {
    get(q, p) {
      if (p === 'then') {
        return (res: (v: unknown[]) => void) => {
          const sql = (q as { toSQL(): { sql: string } }).toSQL().sql;
          capturado.push(sql);
          const r = /erp_sale_tickets/.test(sql) ? rows.tickets
            : /erp_sales_invoices/.test(sql) ? rows.facturas
            : /commercial\.warehouses/.test(sql) ? rows.plazas
            : [];
          res(r ?? []);
          return Promise.resolve(r ?? []);
        };
      }
      const v = Reflect.get(q, p);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        const r = (v as (...a: unknown[]) => unknown).apply(q, args);
        return esBuilder(r) ? envolver(r as object) : r;
      };
    },
  });

  const trx = new Proxy(knex, {
    apply(target, _this, args: unknown[]) {
      return envolver((target as unknown as (t: string) => object)(args[0] as string));
    },
    get(t, prop) {
      const v = Reflect.get(t, prop);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        const r = (v as (...a: unknown[]) => unknown).apply(t, args);
        return esBuilder(r) ? envolver(r as object) : r;
      };
    },
  });

  const tk = { run: <T>(fn: (t: unknown) => Promise<T>) => fn(trx) };
  const ctx = { requireTenantId: () => TENANT };
  const svc = new CustomerReportService(tk as never, ctx as never);
  return { svc, capturado, knex };
}

/** Una fila como la que devuelve `analytics.erp_sales_invoices`. */
const FACTURA = (over: Record<string, unknown> = {}) => ({
  id: '05UF1001-0000912', sucursal: '05', folio: '0000912', fecha: '2026-09-05',
  atendio: 'Rosa Maria', total: '24000.00', doc_tipo: 'factura', doc_prefix: 'UF1001',
  // El `descuento_efectivo` de la vista: 24000 / (1 − 0.03) − 24000 = 742.27
  caja: null, descuento_documento: '742.27', descuento_pct: '3', ...over,
});

const sqlDeFacturas = (c: string[]) => c.find((s) => /erp_sales_invoices/.test(s)) ?? '';

describe('[TK.d3] el descuento de cliente en el reporte', () => {
  it('el SELECT de facturas pide el descuento que la vista publica, no un cero', async () => {
    const { svc, capturado, knex } = servicio();
    await svc.reporte('10448', {}, null);
    const sql = sqlDeFacturas(capturado);
    expect(sql).toContain('descuento_efectivo');
    expect(sql).toContain('descuento_pct');
    await knex.destroy();
  });

  /**
   * ⛔ La columna obvia es la EQUIVOCADA, y este candado existe para que nadie la «simplifique»
   * de vuelta. `i.descuento` es `kdm1.c13`, que viaja SIN impuesto mientras el total va CON:
   * medido en la Fase DC, en `07 U-D-10 s4 f0000513` el descuento real es $147.43 y `c13` dice
   * $135.26 — publicarlo subdeclara 8.3%.
   */
  it('NO lee c13: el descuento se deriva del total, no se copia de la cabecera', async () => {
    const { svc, capturado, knex } = servicio();
    await svc.reporte('10448', {}, null);
    const sql = sqlDeFacturas(capturado);
    expect(sql).not.toMatch(/"i"[.]"descuento"(?!_)/);
    await knex.destroy();
  });

  /**
   * ⚠️ La prueba negativa. Sin ella esto sólo dice «hay una columna que se llama descuento», y
   * el literal podría volver en el próximo refactor sin que nada se ponga en rojo.
   */
  it('NINGUNA consulta clava el descuento en cero', async () => {
    const { svc, capturado, knex } = servicio();
    await svc.reporte('10448', {}, null);
    for (const sql of capturado) {
      expect(sql).not.toMatch(/0::numeric as descuento_documento/i);
    }
    await knex.destroy();
  });

  it('una factura con descuento llega al documento con su importe y su porcentaje', async () => {
    const { svc, knex } = servicio({ facturas: [FACTURA()] });
    const r = await svc.reporte('10448', {}, null);
    expect(r.documentos).toHaveLength(1);
    expect(r.documentos[0].descuento).toBe(742.27);
    expect(r.documentos[0].descuento_pct).toBe(3);
    await knex.destroy();
  });

  /**
   * El defecto que más se notaba: con el cero clavado este filtro devolvía vacío SIEMPRE, y
   * «no hay facturas con descuento» es indistinguible de «el filtro está roto».
   */
  it('«sólo con descuento» ya puede devolver una factura', async () => {
    const { svc, knex } = servicio({ facturas: [FACTURA()] });
    const r = await svc.reporte('10448', { solo_con_descuento: true }, null);
    expect(r.documentos).toHaveLength(1);
    await knex.destroy();
  });

  /** Y sigue descartando la que de verdad no tiene descuento: el filtro filtra. */
  it('«sólo con descuento» descarta la factura sin descuento', async () => {
    const { svc, knex } = servicio({
      facturas: [FACTURA({ descuento_documento: '0', descuento_pct: '0' })],
    });
    const r = await svc.reporte('10448', { solo_con_descuento: true }, null);
    expect(r.documentos).toHaveLength(0);
    await knex.destroy();
  });

  /**
   * ⚠️ `null`, no 0. Un documento que no declara porcentaje no es uno con 0% de descuento, y
   * el papel imprime una cosa y la otra distinto (ADR-056).
   */
  it('sin porcentaje declarado el campo queda en null, nunca en cero', async () => {
    const { svc, knex } = servicio({
      facturas: [FACTURA({ descuento_pct: null }), FACTURA({ descuento_pct: '0' })],
    });
    const r = await svc.reporte('10448', {}, null);
    expect(r.documentos[0].descuento_pct).toBeNull();
    expect(r.documentos[1].descuento_pct).toBeNull();
    await knex.destroy();
  });

  /** El ticket de mostrador no tiene porcentaje de cabecera, y se declara como tal. */
  it('el ticket de mostrador llega con el porcentaje en null', async () => {
    const { svc, knex } = servicio({
      tickets: [{
        id: '05UD1005-0006440', sucursal: '05', caja: 5, folio: '0006440',
        fecha: '2026-09-18', atendio: 'Rosa Maria', total: '265.80', descuento_documento: '0',
      }],
    });
    const r = await svc.reporte('10448', {}, null);
    expect(r.documentos[0].origen).toBe('mostrador');
    expect(r.documentos[0].descuento_pct).toBeNull();
    await knex.destroy();
  });
});
