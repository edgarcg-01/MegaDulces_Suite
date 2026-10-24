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

/** El adaptador real, con el único paso que escribe reemplazado por ROLLBACK. */
class AdaptadorEnsayo extends KeplerRequisitionSinkAdapter {
  protected override async confirmar(c: PoolClient): Promise<void> {
    const h = await c.query('SELECT count(*)::int n FROM _h');
    const l = await c.query('SELECT count(*)::int n FROM _l');
    if (h.rows[0].n !== 1 || l.rows[0].n < 1) throw new Error(`ensayo: _h=${h.rows[0].n} _l=${l.rows[0].n}`);
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
  const adapter = ACTIVO ? new AdaptadorEnsayo() : null;
  afterAll(async () => { await adapter?.onModuleDestroy(); });

  for (const s of servidores) {
    it(`compra en el servidor ${s}: todo el SQL corre y termina en ROLLBACK`, async () => {
      if (!process.env[`KEPLER_REQ_TEMPLATE_FOLIO_${s}`] && s !== '00') return; // sin plantilla: apagada
      // Proveedor y producto REALES de ese servidor: su última orden de compra.
      const k = new Client({ connectionString: process.env[`KEPLER_PUSH_URL_${s}`], statement_timeout: 20000 });
      await k.connect();
      const muestra = (await k.query(
        `SELECT btrim(m.c10) prov, btrim(d.c8) sku, btrim(d.c10) nombre
           FROM md.kdm1 m JOIN md.kdm2 d ON d.c1=m.c1 AND d.c2=m.c2 AND d.c3=m.c3 AND d.c4=m.c4 AND d.c5=m.c5 AND d.c6=m.c6
          WHERE m.c1=$1 AND m.c2='X' AND m.c3='A' AND btrim(m.c4::text) IN ('30','35')
          ORDER BY m.c9 DESC LIMIT 1`, [s])).rows[0];
      const antes = (await k.query(`SELECT count(*)::int n FROM md.kdm1 WHERE c1=$1 AND c2='X' AND c3='A' AND btrim(c4::text)='30'`, [s])).rows[0].n;
      expect(muestra, `el servidor ${s} no tiene ninguna compra de la que tomar proveedor`).toBeTruthy();

      const r = await adapter!.entregar({
        requisition_id: '00000000-0000-0000-0000-000000000000', folio_suite: 'RQ-ENSAYO-KR16', tipo: 'compra',
        sucursal: s, proveedor_code: muestra.prov, fecha: new Date().toISOString().slice(0, 10),
        lineas: [{ sku: muestra.sku, nombre: muestra.nombre, cajas: 2, costo_caja: 373.76, importe: 747.52 }], total: 747.52,
      });
      expect(r.motivo ?? '', `servidor ${s}`).toBe('');
      expect(r.estado).toBe('entregada');

      // Y la prueba de que el ensayo NO escribió: mismo conteo antes y después.
      const despues = (await k.query(`SELECT count(*)::int n FROM md.kdm1 WHERE c1=$1 AND c2='X' AND c3='A' AND btrim(c4::text)='30'`, [s])).rows[0].n;
      await k.end();
      expect(despues).toBe(antes);
    }, 60000);
  }
});
