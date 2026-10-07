import knexLib from 'knex';
import { CustomerReportService, ReporteDocumento } from './customer-report.service';

/**
 * `[TK.11]` El SQL que trae las partidas del reporte.
 *
 * Tres cosas que no se ven mirando el resultado y sí rompen en producción:
 *
 *  1. ⛔ **No se busca por `folio_digital`.** Es una CONCATENACIÓN y no usa el índice del ODS —
 *     el mismo motivo por el que el `EXISTS` de marca/proveedor se correlaciona por la terna.
 *  2. ⚠️ **El `doc_prefix` se recorta de la identidad**, porque el documento no lo trae suelto.
 *     `folio_digital` es `<sucursal><doc_prefix>-<folio>` por construcción de la vista; si eso
 *     cambiara, el recorte devolvería basura y la consulta traería CERO partidas en silencio.
 *  3. **Dos universos, dos consultas**: mostrador va a los renglones del ticket y todo lo demás
 *     —telemarketing, crédito, abonos— a los de factura. Mezclarlos devolvería de menos.
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';

function servicio() {
  const knex = knexLib({ client: 'pg' });
  const capturado: { sql: string; bindings: readonly unknown[] }[] = [];

  /**
   * ⚠️ El envoltorio tiene que ser RECURSIVO. La primera versión sólo envolvía el primer
   * eslabón (`.select()`), y `.from().where()…` devolvía el builder PELADO: al esperarlo, knex
   * intentaba abrir una conexión de verdad («Unable to acquire a connection»). Cada método que
   * devuelve otro builder se vuelve a envolver, y `then` captura el SQL sin tocar un socket.
   */
  const esBuilder = (v: unknown): boolean =>
    !!v && typeof v === 'object' && typeof (v as { toSQL?: unknown }).toSQL === 'function';

  const envolver = (qb: object): object => new Proxy(qb, {
    get(q, p) {
      if (p === 'then') {
        return (res: (v: unknown[]) => void) => {
          const c = (q as { toSQL(): { sql: string; bindings: readonly unknown[] } }).toSQL();
          capturado.push({ sql: c.sql, bindings: c.bindings });
          res([]);
          return Promise.resolve([]);
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
      return (target as unknown as (t: string) => unknown)(args[0] as string);
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

  const svc = new CustomerReportService({} as never, {} as never);
  const partidas = (docs: ReporteDocumento[]): Promise<void> =>
    (svc as unknown as {
      partidas(t: unknown, id: string, d: ReporteDocumento[]): Promise<void>;
    }).partidas(trx, TENANT, docs);

  return { partidas, capturado, knex };
}

const D = (p: Partial<ReporteDocumento> = {}): ReporteDocumento => ({
  id: '05UD1005-0006440', origen: 'mostrador', origen_label: 'Mostrador', sucursal: '05',
  sucursal_nombre: 'Zamora Centro', caja: 5, folio: '0006440', fecha: '2026-09-18',
  atendio: null, descuento: 0, total: 60, lineas: null, ...p,
});

describe('TK.11 · la consulta de partidas', () => {
  it('se correlaciona por la TERNA, nunca por folio_digital', async () => {
    const { partidas, capturado, knex } = servicio();
    await partidas([D()]);
    const q = capturado[0];
    expect(q.sql).toContain('(l.sucursal, l.doc_prefix, l.folio) IN');
    expect(q.sql).not.toContain('folio_digital =');
    await knex.destroy();
  });

  /** El recorte del prefijo: `05` + `UD1005` + `-` + `0006440`. */
  it('saca el doc_prefix de la identidad, exacto', async () => {
    const { partidas, capturado, knex } = servicio();
    await partidas([D()]);
    expect(capturado[0].bindings).toContain('UD1005');
    expect(capturado[0].bindings).toContain('05');
    expect(capturado[0].bindings).toContain('0006440');
    await knex.destroy();
  });

  it('mostrador y facturas van a vistas distintas, en dos consultas', async () => {
    const { partidas, capturado, knex } = servicio();
    await partidas([D(), D({ id: '05UA2101-0000044', origen: 'abono', folio: '0000044' })]);
    expect(capturado.length).toBe(2);
    expect(capturado.some((c) => c.sql.includes('erp_sale_ticket_lines'))).toBe(true);
    expect(capturado.some((c) => c.sql.includes('erp_sales_invoice_lines'))).toBe(true);
    await knex.destroy();
  });

  it('un universo sin documentos no dispara su consulta', async () => {
    const { partidas, capturado, knex } = servicio();
    await partidas([D()]);
    expect(capturado.length).toBe(1);
    await knex.destroy();
  });

  it('siempre filtra por tenant', async () => {
    const { partidas, capturado, knex } = servicio();
    await partidas([D()]);
    expect(capturado[0].bindings).toContain(TENANT);
    await knex.destroy();
  });

  /**
   * ⚠️ El documento que no trajo filas queda en `[]`, no en `null`: son dos cosas distintas y el
   * papel las imprime distinto.
   */
  it('un documento sin partidas queda en [] y no en null', async () => {
    const { partidas, knex } = servicio();
    const docs = [D()];
    await partidas(docs);
    expect(docs[0].lineas).toEqual([]);
    expect(docs[0].lineas).not.toBeNull();
    await knex.destroy();
  });
});
