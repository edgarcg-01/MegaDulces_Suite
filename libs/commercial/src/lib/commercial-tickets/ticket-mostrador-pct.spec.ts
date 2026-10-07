import knexLib from 'knex';
import { CommercialTicketsService, TicketDetalle } from './commercial-tickets.service';

/**
 * `[TK.d4]` El ticket de mostrador también puede traer el porcentaje del descuento de cliente.
 *
 * `detalleMostrador()` tenía `descuento_pct_erp: null` **clavado**, y tenía motivo: `ERP_KEPLER`
 * §3.1 midió que en `U-D-10` la cabecera del descuento es 0.00 en el **100%** de 30,549
 * documentos. Con esa medición, leer el porcentaje habría sido leer una columna vacía.
 *
 * ⭐ **Ese 100% se midió sin Morelia.** Verificado contra prod el 2026-09-28 (Fase DC §6), las
 * ramas `06`, `07` y `08` sí cobran el descuento del cliente en mostrador — 20 tickets,
 * $1,948.15 — y el % que el documento declara (`kdm1.c19`) coincide con el negociado en el
 * maestro (`kdud.c17`) en **533 de 578 ventas (92.2%)**. La vista gana `descuento_pct` (mig
 * `20260928260000`, aditiva) y el servicio la lee.
 *
 * ⚠️ El porcentaje es **sólo el rótulo**. El importe lo sigue midiendo `armar()` como
 * `Σ renglones − total`, porque `c13` viaja sin impuesto y subdeclara 8.3%: en el documento del
 * caso, real $147.43 contra los $135.26 que declara la cabecera. Este spec lo comprueba con ese
 * mismo documento, para que nadie "simplifique" el importe leyéndolo de la cabecera.
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';

/** La cabecera del caso real de la Fase DC: `07 · U-D-10 · serie 4 · folio 0000513`. */
const CAB = (over: Record<string, unknown> = {}) => ({
  folio_digital: '07UD1004-0000513', doc_label: 'Ticket Contado Caja 4',
  sucursal: '07', warehouse_name: 'Morelia Centro', caja: 4, folio: '0000513',
  fecha: '2026-09-18', cliente_nombre: 'SUPER TOMY', cliente_rfc: null,
  cajero_nombre: 'Rosa Maria',
  total: '4767.01', iva: '0', ieps: '0',
  descuento_documento: '135.26', descuento_pct: '3', ...over,
});

/**
 * Dos renglones que suman los $4,914.44 del documento real, para que
 * `Σ renglones − total = 147.43` sea el número que el servicio tiene que producir.
 */
const LINEAS = [
  { linea: 1, sku: '900', descripcion: 'PALETA PAYASO CHICO 20G', unidad: 'PZA',
    cantidad: '2000', precio: '2.00', importe: '4000.00', precio_lista: null,
    iva: '0', ieps: '0', iva_tasa: '0', ieps_tasa: '0' },
  { linea: 2, sku: '901', descripcion: 'GOMITA ACIDA GRANEL', unidad: 'PZA',
    cantidad: '457.22', precio: '2.00', importe: '914.44', precio_lista: null,
    iva: '0', ieps: '0', iva_tasa: '0', ieps_tasa: '0' },
];

function servicio(cab: Record<string, unknown> | null, lineas: unknown[]) {
  const knex = knexLib({ client: 'pg' });

  const esBuilder = (v: unknown): boolean =>
    !!v && typeof v === 'object' && typeof (v as { toSQL?: unknown }).toSQL === 'function';

  // Recursivo: `.where().first()` devuelve otro builder en cada eslabón, y el pelado intentaría
  // abrir una conexión de verdad al esperarlo.
  const envolver = (qb: object, tabla: string): object => new Proxy(qb, {
    get(q, p) {
      if (p === 'then') {
        return (res: (v: unknown) => void) => {
          const esCab = /erp_sale_tickets(?!_)/.test(tabla);
          const r = esCab ? cab : /erp_sale_ticket_lines/.test(tabla) ? lineas : [];
          res(r as unknown);
          return Promise.resolve(r);
        };
      }
      const v = Reflect.get(q, p);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        const r = (v as (...a: unknown[]) => unknown).apply(q, args);
        return esBuilder(r) ? envolver(r as object, tabla) : r;
      };
    },
  });

  const trx = new Proxy(knex, {
    apply(target, _this, args: unknown[]) {
      const tabla = String(args[0]);
      return envolver((target as unknown as (t: string) => object)(tabla), tabla);
    },
    get(t, prop) {
      const v = Reflect.get(t, prop);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => (v as (...a: unknown[]) => unknown).apply(t, args);
    },
  });

  const tk = { run: <T>(fn: (t: unknown) => Promise<T>) => fn(trx) };
  const ctx = { requireTenantId: () => TENANT };
  const svc = new CommercialTicketsService(tk as never, ctx as never);

  const detalle = (): Promise<TicketDetalle> => (svc as unknown as {
    detalleMostrador(
      p: { sucursal: string; docPrefix: string; folio: string },
      w: string[] | null,
    ): Promise<TicketDetalle>;
  }).detalleMostrador({ sucursal: '07', docPrefix: 'UD1004', folio: '0000513' }, null);

  return { detalle, knex };
}

describe('[TK.d4] el porcentaje del descuento en el ticket de mostrador', () => {
  it('ya no llega en null: se lee de la vista', async () => {
    const { detalle, knex } = servicio(CAB(), LINEAS);
    const d = await detalle();
    expect(d.cascada.descuento_documento_pct_erp).toBe(3);
    await knex.destroy();
  });

  /**
   * ⛔ El candado que importa. Si alguien "simplifica" el importe leyéndolo de `descuento_documento`
   * (la cabecera), el papel publicaría $135.26 donde el cliente ahorró $147.43.
   */
  it('el IMPORTE se mide, no se copia de la cabecera: 147.43 y no 135.26', async () => {
    const { detalle, knex } = servicio(CAB(), LINEAS);
    const d = await detalle();
    expect(d.cascada.descuento_documento).toBe(147.43);
    expect(d.cascada.descuento_documento).not.toBe(135.26);
    // Y el 3% declarado lo reproduce: 147.43 / 4914.44 = 3.0000%
    expect(Math.round((147.43 / 4914.44) * 10000) / 100).toBe(3);
    await knex.destroy();
  });

  /**
   * ⚠️ El caso de siempre, que es la mayoría: un ticket sin descuento de cliente. `null`, no 0 —
   * los papeles imprimen una cosa y la otra distinto (ADR-056).
   */
  it('sin porcentaje declarado sigue llegando null, nunca 0', async () => {
    const { detalle, knex } = servicio(
      CAB({ descuento_pct: null, descuento_documento: '0', total: '4914.44' }), LINEAS,
    );
    const d = await detalle();
    expect(d.cascada.descuento_documento_pct_erp).toBeNull();
    expect(d.cascada.descuento_documento).toBe(0);
    await knex.destroy();
  });

  /** Y un `'0'` del ERP tampoco se publica como un descuento de cero por ciento. */
  it('un cero del ERP no se convierte en «0% de descuento» impreso', async () => {
    const { detalle, knex } = servicio(
      CAB({ descuento_pct: '0', descuento_documento: '0', total: '4914.44' }), LINEAS,
    );
    const d = await detalle();
    expect(d.cascada.descuento_documento_pct_erp).toBe(0);
    // El papel sólo lo imprime cuando es verdadero: un 0 no llega a tinta.
    expect(Boolean(d.cascada.descuento_documento_pct_erp)).toBe(false);
    await knex.destroy();
  });
});
