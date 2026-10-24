import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, type PoolClient } from 'pg';

import { KeplerRequisitionSinkAdapter, textoKepler } from './kepler-requisition-sink.adapter';

/**
 * `[KR.16]` ENSAYO contra los Kepler REALES: corre `entregar()` completo —plantilla, proveedor,
 * tope, folio, los tres UPDATE con sus tipos— y en vez de los dos INSERT + COMMIT hace ROLLBACK.
 * No escribe nada en el ERP: todo lo que toca son tablas temporales de la sesión.
 *
 * Existe porque el 2026-10-24 el canario de Yurécuaro reventó con «tipos de dato inconsistentes
 * para el parámetro $5»: `c12` es numeric y `c57` varchar en los nueve servidores, y el código
 * mandaba el mismo parámetro a las dos. Ningún doble lo habría visto — sólo Postgres de verdad.
 *
 * ⛔ Sólo corre con `KEPLER_ENSAYO=1` y el maestro de `ops/prod/kepler-push-secretos.js`. Sin eso,
 * los casos se declaran NO MEDIDO (se saltan), no verdes. En CI no hay ERP: se saltan siempre.
 *
 *   KEPLER_ENSAYO=1 npx vitest run --config vitest.config.ts \
 *     src/lib/commercial-replenishment/kepler-requisition-sink.ensayo.spec.ts
 */
const DIR = process.env.KEPLER_PUSH_SECRETOS || path.join(os.homedir(), 'kepler-push-secretos');
const MAESTRO = path.join(DIR, 'kepler-push.env');
const ACTIVO = process.env.KEPLER_ENSAYO === '1' && fs.existsSync(MAESTRO);

/** Carga el maestro, incluidas las líneas comentadas (servidores apagados en prod). */
function cargarMaestro(): string[] {
  const servidores: string[] = [];
  for (const line of fs.readFileSync(MAESTRO, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^#?\s*(KEPLER_[A-Z_]+_(\d{2}))=(\S+)\s*$/);
    if (!m) continue;
    process.env[m[1]] = m[3];
    if (m[1].startsWith('KEPLER_PUSH_URL_')) servidores.push(m[2]);
  }
  return servidores;
}

/**
 * El adaptador real, con el único paso que escribe reemplazado por ROLLBACK. Antes de deshacer,
 * revisa sobre `_h`/`_l` que lo arrastrable de la plantilla quedó con valores DEL PEDIDO
 * (`[KR.17]`): las reglas medidas sobre >30 mil renglones reales.
 */
class AdaptadorEnsayo extends KeplerRequisitionSinkAdapter {
  public fallas: string[] = [];
  protected override async confirmar(c: PoolClient): Promise<void> {
    const h = (await c.query(`SELECT count(*) OVER ()::int n, c9::date f, c18::date entrega, btrim(c10) c10, c14::text c14, c15::text c15,
                                     btrim(c67) c67, c69, btrim(c43) c43 FROM _h`)).rows;
    const l = (await c.query(`SELECT c7::text ren, c9::float8 cant, c24::float8 pend, btrim(c56) c56, btrim(c25) c25, c32::date f,
                                     btrim(c11) u, btrim(c55) uc, btrim(c57) c57, btrim(c58) c58 FROM _l ORDER BY c7`)).rows;
    const no: string[] = [];
    if (h.length !== 1) no.push(`_h tiene ${h.length} filas`);
    if (!l.length) no.push('_l vacío');
    const H = h[0] ?? {};
    const mismo = (a: unknown, b: unknown) => String(a) === String(b);
    if (!mismo(H.entrega?.toISOString?.(), H.f?.toISOString?.())) no.push(`c18 ${H.entrega} ≠ fecha ${H.f}`);
    if (Number(H.c14) !== 0 || Number(H.c15) !== 0) no.push(`c14/c15 = ${H.c14}/${H.c15}`);
    if (H.c67 !== 'SUITE') no.push(`c67 = ${H.c67}`);
    if (!/^\d{2}:\d{2}$/.test(String(H.c69))) no.push(`c69 = ${H.c69}`);
    if (H.c43 !== 'N') no.push(`c43 = ${H.c43}`);
    for (const r of l) {
      if (r.pend !== r.cant) no.push(`ren ${r.ren}: c24 ${r.pend} ≠ c9 ${r.cant} (quedaría «referenciado»)`);
      if (Number(r.c56) !== r.cant) no.push(`ren ${r.ren}: c56 ${r.c56} ≠ c9 ${r.cant}`);
      if (r.c25 !== H.c10) no.push(`ren ${r.ren}: c25 ${r.c25} ≠ c10 ${H.c10}`);
      if (!mismo(r.f?.toISOString?.(), H.f?.toISOString?.())) no.push(`ren ${r.ren}: c32 ${r.f} ≠ fecha`);
      if (r.u !== 'CJA' || r.uc !== 'CJA' || r.c58 !== '1') no.push(`ren ${r.ren}: unidad ${r.u}/${r.uc}/${r.c58}`);
    }
    this.fallas = no;
    await c.query('ROLLBACK');
  }
}

const servidores = ACTIVO ? cargarMaestro() : [];

describe('textoKepler — el formato de c57', () => {
  it('como lo guarda Kepler: sin relleno, hasta dos decimales', () => {
    expect(textoKepler(791)).toBe('791');
    expect(textoKepler(373.76)).toBe('373.76');
    expect(textoKepler(0.1 + 0.2)).toBe('0.3');
    expect(textoKepler(1037.875)).toBe('1037.88');
  });
});

describe.skipIf(!ACTIVO)('ensayo contra los Kepler reales (ROLLBACK, no escribe)', () => {
  // El ensayo no escribe, así que el tope diario no aplica: si no, un servidor que ya usó su
  // documento del día (Yurécuaro el 2026-10-24) quedaría sin ensayar.
  for (const s of servidores) process.env[`KEPLER_PUSH_MAX_DIA_${s}`] = '999';
  const adapter = ACTIVO ? new AdaptadorEnsayo() : null;
  afterAll(async () => { await adapter?.onModuleDestroy(); });

  const contar = async (k: Client, s: string, g: string, n: string, gr: string) =>
    (await k.query(`SELECT count(*)::int n FROM md.kdm1 WHERE c1=$1 AND c2=$2 AND c3=$3 AND btrim(c4::text)=$4`, [s, g, n, gr])).rows[0].n as number;

  for (const s of servidores) {
    it(`compra en ${s}: SQL completo, columnas del pedido y ROLLBACK`, async (ctx) => {
      if (!process.env[`KEPLER_REQ_TEMPLATE_FOLIO_${s}`] && s !== '00') ctx.skip(); // sin plantilla: NO MEDIDO
      const k = new Client({ connectionString: process.env[`KEPLER_PUSH_URL_${s}`], statement_timeout: 20000 });
      await k.connect();
      // Proveedor y producto REALES de ese servidor: su última orden de compra.
      const muestra = (await k.query(
        `SELECT btrim(m.c10) prov, btrim(d.c8) sku, btrim(d.c10) nombre
           FROM md.kdm1 m JOIN md.kdm2 d ON d.c1=m.c1 AND d.c2=m.c2 AND d.c3=m.c3 AND d.c4=m.c4 AND d.c5=m.c5 AND d.c6=m.c6
          WHERE m.c1=$1 AND m.c2='X' AND m.c3='A' AND btrim(m.c4::text) IN ('30','35') AND btrim(m.c11) NOT LIKE 'RQ-%'
          ORDER BY m.c9 DESC LIMIT 1`, [s])).rows[0];
      expect(muestra, `el servidor ${s} no tiene ninguna compra de la que tomar proveedor`).toBeTruthy();
      const antes = await contar(k, s, 'X', 'A', '30');

      const r = await adapter!.entregar({
        requisition_id: '00000000-0000-0000-0000-000000000000', folio_suite: 'RQ-ENSAYO-KR17', tipo: 'compra',
        sucursal: s, proveedor_code: muestra.prov, fecha: new Date().toISOString().slice(0, 10),
        lineas: [{ sku: muestra.sku, nombre: muestra.nombre, cajas: 3, costo_caja: 373.76, importe: 1121.28 }], total: 1121.28,
      });
      expect(r.motivo ?? '', `servidor ${s}`).toBe('');
      expect(r.estado).toBe('entregada');
      expect(adapter!.fallas, `servidor ${s}: columnas arrastradas de la plantilla`).toEqual([]);
      expect(await contar(k, s, 'X', 'A', '30')).toBe(antes);   // no escribió
      await k.end();
    }, 60000);

    it(`traspaso desde ${s}: SQL completo, columnas del pedido y ROLLBACK`, async (ctx) => {
      if (!process.env[`KEPLER_PED_TEMPLATE_FOLIO_${s}`]) ctx.skip(); // sin plantilla de traspaso: NO MEDIDO
      const k = new Client({ connectionString: process.env[`KEPLER_PUSH_URL_${s}`], statement_timeout: 20000 });
      await k.connect();
      const muestra = (await k.query(
        `SELECT btrim(d.c8) sku, btrim(d.c10) nombre FROM md.kdm2 d
          WHERE d.c1=$1 AND d.c2='U' AND d.c3='D' AND btrim(d.c4::text)='40' ORDER BY d.c32 DESC LIMIT 1`, [s])).rows[0];
      const antes = await contar(k, s, 'U', 'D', '40');
      const r = await adapter!.entregar({
        requisition_id: '00000000-0000-0000-0000-000000000000', folio_suite: 'RQ-ENSAYO-KR17', tipo: 'traspaso',
        sucursal: s, destino_sucursal: s === '01' ? '00' : '01', fecha: new Date().toISOString().slice(0, 10),
        lineas: [{ sku: muestra.sku, nombre: muestra.nombre, cajas: 4, costo_caja: 100, importe: 400 }], total: 400,
      });
      expect(r.motivo ?? '', `servidor ${s}`).toBe('');
      expect(r.estado).toBe('entregada');
      expect(adapter!.fallas, `servidor ${s}: columnas arrastradas de la plantilla`).toEqual([]);
      expect(await contar(k, s, 'U', 'D', '40')).toBe(antes);   // no escribió
      await k.end();
    }, 60000);
  }
});
