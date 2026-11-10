import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import knexFactory from 'knex';
import {
  candidatosDeFolio, desdeOFolioExacto, entraDesde, folioExactoDesde, SQL_DESDE_SU_SUCURSAL, SQL_FECHA_EFECTIVA,
  SQL_MAS_RECIENTE_PRIMERO,
} from './frontera-solicitudes';

/**
 * `[GX.107]` — Candado de **la fecha del documento de Kepler se muestra; no decide si una solicitud
 * aparece.** El caso (2026-11-10): una solicitud capturada en noviembre con la fecha de una póliza de
 * enero no salía en Capturar gasto, Mis gastos ni el buscador.
 *
 * Las condiciones con O se prueban COMPILANDO el SQL (knex sin conexión): un paréntesis movido
 * (`… AND fecha … OR folio …`) se saltaría el filtro de tenant, y una comparación de texto no lo ve
 * (revisión independiente, 2026-11-10).
 */
const db = knexFactory({ client: 'pg' });
const r = () => db('analytics.expense_requests as r').where('r.tenant_id', 't').select('r.folio');
const sql = (q: { toSQL: () => { toNative: () => { sql: string; bindings: readonly unknown[] } } }) => q.toSQL().toNative();

describe('[GX.107] candidatosDeFolio — el folio tecleado, como Kepler lo puede tener guardado', () => {
  it('⭐ 10570 encuentra 0010570: el número y con ceros a la izquierda', () => {
    const c = candidatosDeFolio(10570);
    expect(c).toContain('10570');
    expect(c).toContain('0010570');
    expect(c[c.length - 1]).toBe('0000010570');
  });

  it('el 23 encuentra el 0000023', () => {
    expect(candidatosDeFolio(23)).toContain('0000023');
  });

  it('⛔ contenerlo no es serlo: 287 no da 10287', () => {
    expect(candidatosDeFolio(287).every((x) => /^0*287$/.test(x))).toBe(true);
  });

  it('⛔ lo que no es folio no tiene candidatos (no se busca «nada»)', () => {
    for (const n of [0, -5, 1.5, NaN, null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
      expect(candidatosDeFolio(n as number)).toEqual([]);
    }
  });

  it('un folio más largo que 10 se queda tal cual', () => {
    expect(candidatosDeFolio(123456789012)).toEqual(['123456789012']);
  });
});

describe('[GX.107] entraDesde — «desde el arranque» por documento o por captura', () => {
  const ARRANQUE = '2026-06-29';

  it('⭐ capturada después del arranque con fecha de documento vieja: ENTRA', () => {
    expect(entraDesde('2026-01-15', '2026-11-10', ARRANQUE)).toBe(true);
  });

  it('⛔ fechada Y capturada antes del arranque: fuera, es historia (`[GX.95]`)', () => {
    expect(entraDesde('2026-01-15', '2026-01-15', ARRANQUE)).toBe(false);
  });

  it('⛔ sin captura decide la fecha del documento, como antes: nada visible desaparece', () => {
    expect(entraDesde('2026-07-01', null, ARRANQUE)).toBe(true);
    expect(entraDesde('2026-01-15', null, ARRANQUE)).toBe(false);
  });

  it('los bordes: el mismo día del arranque entra por cualquiera de las dos', () => {
    expect(entraDesde(ARRANQUE, null, ARRANQUE)).toBe(true);
    expect(entraDesde('2026-01-15', ARRANQUE, ARRANQUE)).toBe(true);
    expect(entraDesde('2026-01-15', '2026-06-28', ARRANQUE)).toBe(false);
  });

  it('sin fecha de documento o sin ventana no recorta (como antes)', () => {
    expect(entraDesde(null, null, ARRANQUE)).toBe(true);
    expect(entraDesde('2026-01-15', null, null)).toBe(true);
  });
});

describe('[GX.107] el SQL armado, compilado', () => {
  it('la fecha efectiva es la más nueva entre documento y captura (greatest ignora la captura vacía)', () => {
    expect(SQL_FECHA_EFECTIVA).toBe('greatest(r.fecha, r.capturado_at::date)');
    expect(SQL_MAS_RECIENTE_PRIMERO).toBe('greatest(r.fecha, r.capturado_at::date) DESC NULLS LAST');
    expect(SQL_DESDE_SU_SUCURSAL.startsWith('greatest(r.fecha, r.capturado_at::date) >= (SELECT min(p0.created_at)')).toBe(true);
  });

  it('⭐ el folio exacto: por texto (casa con el índice) Y desde el arranque por la fecha efectiva', () => {
    const s = sql(r().modify(folioExactoDesde, ['0010570', '10570'], '2026-06-29'));
    expect(s.sql).toBe('select "r"."folio" from "analytics"."expense_requests" as "r" where "r"."tenant_id" = $1'
      + ' and r.folio = ANY($2::text[]) and greatest(r.fecha, r.capturado_at::date) >= $3::date');
    expect(s.bindings).toEqual(['t', ['0010570', '10570'], '2026-06-29']);
  });

  it('⛔ el buscador: el O queda DENTRO de su paréntesis (no se come el tenant)', () => {
    const s = sql(r().modify(desdeOFolioExacto, '2026-06-29', ['0010570']));
    expect(s.sql).toBe('select "r"."folio" from "analytics"."expense_requests" as "r" where "r"."tenant_id" = $1'
      + ' and ("r"."fecha" >= $2 or (r.folio = ANY($3::text[]) and greatest(r.fecha, r.capturado_at::date) >= $4::date))');
  });

  it('el buscador sin folio tecleado: sólo la fecha, sin un O vacío', () => {
    const s = sql(r().modify(desdeOFolioExacto, '2026-06-29', []));
    expect(s.sql).toBe('select "r"."folio" from "analytics"."expense_requests" as "r" where "r"."tenant_id" = $1 and ("r"."fecha" >= $2)');
  });
});

describe('[GX.107] el servicio usa la regla en sus tres lugares', () => {
  const SERVICIO = readFileSync(join(__dirname, 'expense-proofs.service.ts'), 'utf8');

  it('importa la regla de su archivo (una sola definición)', () => {
    expect(SERVICIO).toMatch(/from '\.\/frontera-solicitudes'/);
  });

  it('Capturar gasto: el folio exacto desde el arranque, sin vale, y primero en la lista', () => {
    expect(SERVICIO).toContain('folioExactoDesde(v, candidatos, desdeSuite).whereNotExists(sinVale);');
    expect(SERVICIO).toContain("o.orderByRaw(sqlFolioExactoPrimero('r.folio'), [Number(q)])");
  });

  it('⛔ en ningún lado queda el folio exacto SIN tope de fecha (abría 8,323 solicitudes de antes de la Suite)', () => {
    expect(SERVICIO).not.toContain('whereRaw(SQL_FOLIO_EXACTO');
    expect(SERVICIO).not.toContain('folioExacto.includes(');
  });

  it('Mis gastos: lo asignado desde el arranque de SU sucursal, y lo más reciente primero', () => {
    expect(SERVICIO).toContain('.whereRaw(SQL_DESDE_SU_SUCURSAL)');
    expect(SERVICIO).toContain('.orderByRaw(`${SQL_MAS_RECIENTE_PRIMERO}, r.folio ASC`)');
    expect(SERVICIO).not.toMatch(/`r\.fecha >= \(SELECT min\(p0\.created_at\)/);
  });

  it('el buscador: fecha O folio exacto, y lo que llega se filtra por la fecha efectiva', () => {
    expect(SERVICIO).toContain('.modify(desdeOFolioExacto, desde, folioExacto)');
    expect(SERVICIO).toContain('.filter((k) => entraDesde(k.fecha, k.capturado,');
    expect(SERVICIO).toContain('kq.orderByRaw(SQL_MAS_RECIENTE_PRIMERO);');
  });
});
