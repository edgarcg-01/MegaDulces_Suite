import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, type PoolClient } from 'pg';

import { KeplerPedidoTlmkSinkAdapter } from './kepler-pedido-tlmk-sink.adapter';
import type { RenglonCotizacion } from './kepler-pedido-tlmk';

/**
 * `[COT.7.2]` ENSAYO contra los Kepler REALES, con respuesta conocida: por cada servidor toma el
 * último Pedido TELEMARK en `CREADO`, lo usa de PLANTILLA y le da al adaptador **sus propios
 * renglones como si fueran una cotización** (precio = `c12 × c58`, importe = `c13`, mismo cliente,
 * vendedor y % de descuento). `entregar()` corre completo —cliente, vendedor, ficha, tope, folio,
 * todos los UPDATE con sus tipos— y en lugar de INSERT + COMMIT revisa `_h`/`_l` contra el pedido
 * real y hace ROLLBACK. **No escribe nada en el ERP.**
 *
 * Por qué así: los tipos de las columnas de Kepler no son uniformes (`c12` numeric, `c57` varchar…)
 * y sólo Postgres de verdad los valida (KR.16: el canario de Yurécuaro). Y si el pedido que sale no
 * reproduce los importes de uno real, no se enciende.
 *
 * ⛔ Sólo con `KEPLER_ENSAYO=1` y el maestro de `ops/prod/kepler-push-secretos.js`. Sin eso los
 * casos se SALTAN (no medido), no salen verdes. En CI no hay ERP.
 *
 *   KEPLER_ENSAYO=1 npx vitest run --config libs/commercial/vitest.config.ts \
 *     libs/commercial/src/lib/commercial-quotes/kepler-pedido-tlmk-sink.ensayo.spec.ts
 */
const DIR = process.env.KEPLER_PUSH_SECRETOS || path.join(os.homedir(), 'kepler-push-secretos');
const MAESTRO = path.join(DIR, 'kepler-push.env');
const ACTIVO = process.env.KEPLER_ENSAYO === '1' && fs.existsSync(MAESTRO);

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

interface Esperado { c13: number; c14: number; c15: number; c16: number; renglones: Array<{ sku: string; c9: number; c12: number; c13: number }> }

class AdaptadorEnsayo extends KeplerPedidoTlmkSinkAdapter {
  public fallas: string[] = [];
  public esperado: Esperado | null = null;
  protected override async confirmar(c: PoolClient): Promise<void> {
    const h = (await c.query(`SELECT count(*) OVER ()::int n, btrim(c11) c11, btrim(c27) c27, btrim(c24) c24, btrim(c43) c43,
                                     btrim(c67) c67, c69, c13::text c13, c14::text c14, c15::text c15, c16::text c16, c42::text c42,
                                     btrim(coalesce(c100,'')) c100 FROM _h`)).rows;
    const l = (await c.query(`SELECT c7::int ren, btrim(c8) sku, c9::float8 c9, c24::float8 c24, c12::float8 c12, c13::float8 c13,
                                     btrim(c28) c28, btrim(c55) c55, btrim(c57) c57, btrim(c58) c58 FROM _l ORDER BY c7`)).rows;
    const no: string[] = [];
    const H = h[0] ?? {};
    const e = this.esperado!;
    const igual = (a: unknown, b: number, tol = 0.005) => Math.abs(Number(a) - b) <= tol;
    if (h.length !== 1) no.push(`_h tiene ${h.length} filas`);
    if (H.c11 !== 'CREADO') no.push(`c11 = ${H.c11}`);
    if (H.c27 !== 'TELEMARK') no.push(`c27 = ${H.c27}`);
    if (!String(H.c24).startsWith('COT-')) no.push(`c24 = ${H.c24}`);
    if (H.c43 !== 'N') no.push(`c43 = ${H.c43}`);
    if (H.c67 !== 'SUITE') no.push(`c67 = ${H.c67}`);
    if (H.c100) no.push(`c100 arrastrado: ${H.c100}`);
    if (!/^\d{2}:\d{2}$/.test(String(H.c69))) no.push(`c69 = ${H.c69}`);
    if (!igual(H.c16, e.c16)) no.push(`c16 ${H.c16} ≠ real ${e.c16}`);
    if (!igual(H.c42, e.c16)) no.push(`c42 ${H.c42} ≠ c16 ${e.c16}`);
    if (!igual(H.c14, e.c14, 0.02)) no.push(`c14 ${H.c14} ≠ real ${e.c14}`);
    if (!igual(H.c15, e.c15, 0.02)) no.push(`c15 ${H.c15} ≠ real ${e.c15}`);
    if (!igual(H.c13, e.c13, 0.02)) no.push(`c13 ${H.c13} ≠ real ${e.c13}`);
    if (l.length !== e.renglones.length) no.push(`_l ${l.length} renglones, real ${e.renglones.length}`);
    l.forEach((r, i) => {
      const x = e.renglones[i];
      if (!x) return;
      if (r.sku !== x.sku) no.push(`ren ${r.ren}: sku ${r.sku} ≠ ${x.sku}`);
      if (!igual(r.c9, x.c9, 0.0001) || r.c24 !== r.c9) no.push(`ren ${r.ren}: c9/c24 ${r.c9}/${r.c24} ≠ ${x.c9}`);
      if (!igual(r.c12, x.c12)) no.push(`ren ${r.ren}: c12 ${r.c12} ≠ ${x.c12}`);
      if (!igual(r.c13, x.c13)) no.push(`ren ${r.ren}: c13 ${r.c13} ≠ ${x.c13}`);
      if (r.c28 !== 'CREADO') no.push(`ren ${r.ren}: c28 ${r.c28}`);
    });
    this.fallas = no;
    await c.query('ROLLBACK');
  }
}

const servidores = ACTIVO ? cargarMaestro() : [];

(ACTIVO ? describe : describe.skip)('[COT.7.2] ENSAYO Pedido TELEMARK contra Kepler real (ROLLBACK)', () => {
  it.each(servidores.length ? servidores : ['--'])('servidor %s: reproduce un pedido TELEMARK real sin escribir', async (s) => {
    const url = process.env[`KEPLER_PUSH_URL_${s}`]!;
    const cli = new Client({ connectionString: url });
    await cli.connect();
    let plantilla: { c5: string; c6: string; c10: string; c12: string; c13: string; c14: string; c15: string; c16: string; c19: string; c85: string } | undefined;
    let ren: Array<Record<string, string>> = [];
    try {
      await cli.query('BEGIN READ ONLY');
      // Con la plantilla ya elegida en el maestro se ensaya ESA (y si dejó de estar en CREADO, rojo);
      // sin ella, el último CREADO del servidor.
      const elegida = process.env[`KEPLER_TLMK_TEMPLATE_FOLIO_${s}`] || null;
      plantilla = (await cli.query(
        `SELECT btrim(c5::text) c5, c6, btrim(c10) c10, btrim(c12) c12, c13::text c13, c14::text c14, c15::text c15, c16::text c16,
                coalesce(nullif(btrim(c19::text),''),'0') c19, btrim(coalesce(c85::text,'')) c85
           FROM md.kdm1 WHERE c1 = $1 AND c2 = 'U' AND c3 = 'D' AND btrim(c4::text) = '40'
            AND btrim(c27) = 'TELEMARK' AND btrim(c11) = 'CREADO' AND ($2::text IS NULL OR c6 = $2)
          ORDER BY c9 DESC, c6 DESC LIMIT 1`, [s, elegida])).rows[0];
      if (plantilla) {
        ren = (await cli.query(
          `SELECT btrim(c8) sku, c9::text c9, c12::text c12, c13::text c13, btrim(c51::text) c51, btrim(c55) c55,
                  btrim(c58::text) c58, btrim(c66::text) c66, btrim(c11) c11
             FROM md.kdm2 WHERE c1 = $1 AND c2 = 'U' AND c3 = 'D' AND btrim(c4::text) = '40' AND btrim(c5::text) = $2 AND c6 = $3
            ORDER BY c7`, [s, plantilla.c5, plantilla.c6])).rows;
      }
      await cli.query('ROLLBACK');
    } finally { await cli.end(); }
    // Sin un pedido con el que comparar, el caso NO se mide: rojo con su porqué, nunca verde.
    if (!plantilla || !ren.length) throw new Error(`servidor ${s}: sin pedido TELEMARK en CREADO — NO MEDIDO`);

    process.env[`KEPLER_TLMK_TEMPLATE_FOLIO_${s}`] = plantilla.c6;
    process.env[`KEPLER_TLMK_TEMPLATE_SERIE_${s}`] = plantilla.c5;
    const n = (v: string) => Number(String(v ?? '').replace(/[^0-9.-]/g, '') || 0);
    const renglones: RenglonCotizacion[] = ren.map((r) => {
      const f = n(r.c58) || 1;
      return {
        sku: r.sku, cantidad: n(r.c51) || n(r.c9) / f,
        presentacion: r.c55 || r.c11, factor: f === 1 ? null : f,
        precio: Math.round(n(r.c12) * f * 100) / 100, lista: n(r.c66) * f, importe: n(r.c13),
      };
    });
    const ad = new AdaptadorEnsayo();
    ad.esperado = {
      c13: n(plantilla.c13), c14: n(plantilla.c14), c15: n(plantilla.c15), c16: n(plantilla.c16),
      renglones: ren.map((r) => ({ sku: r.sku, c9: n(r.c9), c12: n(r.c12), c13: n(r.c13) })),
    };
    try {
      const res = await ad.entregar({
        cotizacion_id: '00000000-0000-0000-0000-000000000000', folio_suite: 'COT-ENSAYO-00000',
        sucursal: s, cliente: plantilla.c10, vendedor: plantilla.c12,
        fecha: new Date().toISOString().slice(0, 10), pct_cliente: n(plantilla.c19),
        direccion_envio: plantilla.c85 || null, renglones, tope_dia: null,
      });
      // El ROLLBACK de `confirmar` hace que entregar() siga y reporte "entregado": lo que importa
      // es que llegó hasta ahí sin que Postgres rechazara un tipo, y lo que `confirmar` midió.
      expect(res.estado === 'rechazado' ? `${res.motivo} ${(res.motivos ?? []).join('; ')}` : 'ok').toBe('ok');
      expect(ad.fallas).toEqual([]);
    } finally {
      await ad.onModuleDestroy();
    }
  }, 60_000);
});
