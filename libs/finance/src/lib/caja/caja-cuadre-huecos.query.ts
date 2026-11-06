/**
 * `[LE.CU.3]` — **Las lecturas del Cuadre nuevo**: arman las entradas de los motores de `[LE.CU.2]`
 * (`caja-huecos.engine`, `caja-balance-fisico.engine`, `caja-boveda.engine`) a partir de prod.
 *
 * Viven aparte del servicio por dos razones:
 *  1. **Se ejercen sin levantar el backend** (CLAUDE.md regla 3): reciben una transacción, así que
 *     `database/scripts/verify-lecu1-flujo-efectivo-caja.js` las corre contra prod en sólo lectura
 *     y mide su tiempo. Eso es lo que prueba el SQL; un doble de Knex no lo prueba nunca.
 *  2. **Cada fuente de huecos es una función** con su propio tiempo medido, para saber cuál rompe
 *     el presupuesto de 500 ms por consulta si alguna lo hace.
 *
 * ⚠️ Sin imports con alias (`@megadulces/*`): este archivo se carga con `ts-node` transpile-only.
 *
 * ⛔ **Lo que NO arma todavía, y se declara:** las salidas que sólo registra Control y las capturas
 * dobles (§36.8–36.9). Las dos se casan por IDENTIDAD (terminación de tarjeta, beneficiario, ruta y
 * día en dos capturas), y ese casamiento no tiene motor probado. La pantalla las publica como
 * «no medido», nunca como cero (ADR-056).
 */
import type { Knex } from 'knex';
import { casarPorImporte, CUADRE_TOLERANCIA_PESOS, redondea2 } from './caja-cuadre.engine';
import { casarLibroConKepler, cobroDeRutaComoKepler, indexaLibro, juntaCuadres, llaveKeplerDelLibro, marcaEnLibro } from './caja-kepler-libro.engine';
import { fechaDeVentaDeclarada, leerVentaDeRuta } from './caja-ruta.engine';
import type { HuecoEntrada, TipoHueco } from './caja-huecos.engine';
import type { ConteoBoveda, MovBoveda } from './caja-boveda.engine';
import { bovedaEn, validaReplay } from './caja-boveda.engine';
import type { EntradaBalance } from './caja-balance-fisico.engine';

type Trx = Knex | Knex.Transaction;
const n = (x: unknown): number => Number(x) || 0;
const NUM = (c: string) => `coalesce(NULLIF(regexp_replace(${c}::text,'[^0-9.-]','','g'),'')::numeric,0)`;
/** `date` de pg llega como `Date` local; se arma con las partes locales, nunca por UTC (`[LC.16]`). */
export function ymd(f: unknown): string {
  if (f instanceof Date) {
    const p = (k: number) => String(k).padStart(2, '0');
    return `${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}`;
  }
  return String(f ?? '').slice(0, 10);
}
const sumaDias = (d: string, k: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const llave = (r: { sucursal: string; doc_tipo: string; folio: string; clave_banco: string }) => `${r.sucursal}|${r.doc_tipo}|${r.folio}|${r.clave_banco}`;

/** Los tipos que esta versión NO mide (se publican como tales). */
export const HUECOS_NO_MEDIDOS: readonly TipoHueco[] = ['salida_sin_documento', 'captura_doble'];

interface Tiempos { [fuente: string]: number }
const mide = async <T>(t: Tiempos, k: string, f: () => Promise<T>): Promise<T> => { const t0 = Date.now(); const r = await f(); t[k] = (t[k] ?? 0) + (Date.now() - t0); return r; };

// ── 1. El cuadre del libro contra la Caja General de Kepler, día por día (§36.2) ───────────────

interface LblK { id: string; key: string; fecha: string; importe: number; ref?: string | null; glosa?: string | null; signo?: number | null }

async function huecosDelCuadre(trx: Trx, tenantId: string, from: string, to: string, t: Tiempos): Promise<HuecoEntrada[]> {
  const libro = await mide(t, 'cuadre', () => trx('finance.cash_ledger').where('tenant_id', tenantId).whereNull('deleted_at').whereNot('estado', 'cancelado')
    .andWhere('fecha', '>=', from).andWhere('fecha', '<=', to)
    .select('folio', 'tipo', 'fecha', 'monto', 'glosa', 'origen_tipo', 'origen_ref', 'declared_doc_ref'));
  const tes = await mide(t, 'cuadre', () => trx('analytics.kepler_bank_movements').where('tenant_id', tenantId).andWhere('account_label', 'CG')
    .andWhere('fecha_valor', '>=', from).andWhere('fecha_valor', '<=', to)
    .select('sucursal', 'clave_banco', 'folio', 'fecha_valor as fecha', 'concepto', 'doc_tipo', 'importe', 'signo'));
  const rc = await mide(t, 'cuadre', () => trx('analytics.route_collections').where('tenant_id', tenantId).andWhere('cuenta', '0011')
    .andWhere('fecha', '>=', sumaDias(from, -10)).andWhere('fecha', '<=', to)
    .groupBy('almacen', 'cobro_folio', 'fecha')
    .select('almacen', 'cobro_folio', 'fecha', trx.raw('SUM(importe)::numeric AS importe'), trx.raw(`string_agg(DISTINCT truck, ',') AS truck`), trx.raw(`NULL AS concepto`)));
  // Los cobros de ruta anteriores a la ventana sirven para LIGAR (la venta del sábado depositada el lunes), no para cuadrar.
  const rcK = (rc as any[]).map((r) => ({ ...cobroDeRutaComoKepler(r), truck: r.truck as string | null }));
  const kep = [...(tes as any[]), ...rcK.filter((r) => ymd(r.fecha) >= from)];
  const kepFuera = new Map(rcK.filter((r) => ymd(r.fecha) < from).map((r) => [llave(r), r] as const));

  const lib = (libro as any[]).map((r) => ({ ...r, fecha: ymd(r.fecha), dir: r.tipo === 'ingreso' ? 'in' : 'out', ref: llaveKeplerDelLibro(r) }));
  /**
   * ⭐ Los documentos de tesorería que el libro NOMBRA y caen fuera de la ventana se buscan por su
   * llave, en cualquier fecha (lo mismo que `docsKeplerPorLlave` del servicio). Sin esto,
   * `CI-2026-00002` (cobro del 9-oct capturado el 12) salía «sin documento en Kepler».
   */
  const enVentana = new Set([...kep, ...kepFuera.values()].map(llave));
  const refsFuera = [...new Set(lib.map((r) => r.ref).filter((k): k is string => !!k && !enVentana.has(k)))];
  if (refsFuera.length) {
    const otros = await mide(t, 'cuadre', () => trx('analytics.kepler_bank_movements').where('tenant_id', tenantId).andWhere('account_label', 'CG')
      .whereRaw(`sucursal || '|' || doc_tipo || '|' || folio || '|' || clave_banco = ANY(?)`, [refsFuera])
      .select('sucursal', 'clave_banco', 'folio', 'fecha_valor as fecha', 'concepto', 'doc_tipo', 'importe', 'signo'));
    for (const r of otros as any[]) kepFuera.set(llave(r), r);
  }
  /**
   * Los cobros de camioneta de TODAS las cuentas, para reconocer lo que el libro tiene y Kepler cobró
   * a otra cuenta (la ruta 21 del 16-oct, a `0001`). Sólo sirven para ligar, nunca para cuadrar.
   */
  const rcTodas = ((await mide(t, 'cuadre', () => trx('analytics.route_collections').where('tenant_id', tenantId)
    .andWhere('fecha', '>=', sumaDias(from, -10)).andWhere('fecha', '<=', to)
    .groupBy('almacen', 'cobro_folio', 'fecha', 'cuenta')
    .select('almacen', 'cobro_folio', 'fecha', 'cuenta', trx.raw('SUM(importe)::numeric AS importe'), trx.raw(`string_agg(DISTINCT truck, ',') AS truck`)))) as any[])
    .map((r) => ({ key: `${r.almacen}|U-A-5|${r.cobro_folio}|${r.cuenta}`, cuenta: String(r.cuenta), fecha: ymd(r.fecha), importe: n(r.importe), truck: String(r.truck ?? ''), folio: String(r.cobro_folio) }));
  const enLibroPorLlave = new Set(lib.map((r) => r.ref).filter(Boolean) as string[]);
  const lblK = (r: any): LblK => ({ id: String(r.folio), key: llave(r), fecha: ymd(r.fecha), importe: redondea2(n(r.importe)), signo: r.signo == null ? null : n(r.signo) });
  const salida: HuecoEntrada[] = [];
  const solosK: (LblK & { dir: 'in' | 'out' })[] = [];

  const dias = [...new Set([...lib.map((r) => r.fecha), ...kep.map((r) => ymd(r.fecha))])].sort();
  for (const dk of dias) {
    const kd = kep.filter((r) => ymd(r.fecha) === dk);
    const enDia = new Set(kd.map(llave));
    const ld = lib.filter((r) => r.fecha === dk);
    // Documentos que el libro nombra y caen en OTRO día (la tesorería se busca en la ventana; la ruta, 10 días antes).
    const fuera = new Map<string, LblK>();
    for (const r of [...kep, ...kepFuera.values()]) { const k = llave(r); if (!enDia.has(k)) fuera.set(k, lblK(r)); }
    for (const [dir, s] of [['in', 1], ['out', -1]] as const) {
      const kSide = kd.filter((r) => (n(r.signo) > 0 ? 1 : -1) === s).map(lblK);
      const lSide = ld.filter((r) => r.dir === dir).map((r) => ({ id: r.folio, key: `libro|${r.folio}`, fecha: dk, importe: redondea2(n(r.monto)), ref: r.ref, glosa: r.glosa }));
      const res = juntaCuadres(casarPorImporte<LblK>([], [], CUADRE_TOLERANCIA_PESOS), casarLibroConKepler<LblK>(lSide, kSide, CUADRE_TOLERANCIA_PESOS, fuera));
      for (const p of res.pares) {
        if ((p as { identidad?: boolean }).identidad) {
          // Casó por su documento y el importe difiere más que la tolerancia: la captura está mal.
          if (Math.abs(p.delta) > CUADRE_TOLERANCIA_PESOS) {
            salida.push({ tipo: 'captura_distinta', fecha: dk, monto: Math.abs(p.delta), ref: `libro|${p.caja.id}`, via: 'llave',
              etiqueta: `${p.caja.id} capturado en $${p.caja.importe.toFixed(2)}; el documento dice $${p.otro.importe.toFixed(2)}`,
              testigos: { cobro: 'si', libro: 'difiere' } });
          }
        } else {
          // Casó SÓLO por importe: está en el libro, pero sin su documento ligado.
          salida.push({ tipo: 'libro_sin_ligar', fecha: dk, monto: p.caja.importe, ref: `libro|${p.caja.id}`, via: 'importe',
            etiqueta: `${p.caja.id} sin documento ligado (candidato ${p.otro.key.split('|').slice(1, 3).join(' ')})`, testigos: { cobro: 'si', libro: 'si' } });
        }
      }
      for (const c of res.caja_solos) {
        const glosa = (c as { glosa?: string | null }).glosa;
        const ruta = leerVentaDeRuta(glosa)?.ruta;
        /**
         * ⛔ La fecha declarada sólo es identidad si cae en los 10 días previos a la captura: «ruta 27
         * 120726» se lee 12-jul y era la venta del 12-oct. Una fecha imposible no se usa; se toma el
         * día de la captura, y la etiqueta lo dice.
         */
        const declarada = fechaDeVentaDeclarada(glosa, dk);
        const valida = !!declarada && declarada <= dk && declarada >= sumaDias(dk, -10);
        const dia = valida ? declarada : ruta ? dk : null;
        const notaFecha = ruta && declarada && !valida ? ` (la fecha escrita, ${declarada}, no es posible; se toma el día de la captura)` : '';
        // ⭐ (1) IDENTIDAD: la glosa declara ruta y día, y esa ruta tiene un cobro de ESE día (en
        // cualquier cuenta). Es una liga faltante, no un documento que Kepler no tenga.
        const cand = valida && dia && ruta ? rcTodas.find((r) => r.fecha === dia && r.truck.split(',').includes(`ruta_${ruta}`)) : undefined;
        if (cand) {
          enLibroPorLlave.add(cand.key);
          salida.push({ tipo: 'libro_sin_ligar', fecha: dk, monto: c.importe, ref: `libro|${c.id}`, via: 'identidad', ruta_dia: `ruta ${ruta}|${dia}`,
            etiqueta: `${c.id} es la ruta ${ruta} del ${dia}: falta ligarlo al cobro U-A-5 ${cand.folio}${cand.cuenta !== '0011' ? ` (Kepler lo cobró a la cuenta ${cand.cuenta}, no a Caja General)` : ''}`,
            testigos: { cobro: cand.cuenta === '0011' ? 'si' : 'difiere', libro: 'si' } });
          continue;
        }
        // (2) IMPORTE, como último recurso y declarado: un cobro de camioneta de la semana anterior,
        // de Caja General, que el libro no tiene por llave. ⛔ `por_confirmar` siempre (§36.7).
        const porImporte = rcTodas.find((r) => r.cuenta === '0011' && !enLibroPorLlave.has(r.key) && r.fecha <= dk && r.fecha >= sumaDias(dk, -7) && Math.abs(r.importe - c.importe) <= CUADRE_TOLERANCIA_PESOS);
        if (porImporte) {
          enLibroPorLlave.add(porImporte.key);
          salida.push({ tipo: 'libro_sin_ligar', fecha: dk, monto: c.importe, ref: `libro|${c.id}`, via: 'importe',
            etiqueta: `${c.id} sin documento ligado (candidato por importe: cobro U-A-5 ${porImporte.folio} del ${porImporte.fecha})`, testigos: { cobro: 'si', libro: 'si' } });
          continue;
        }
        salida.push({ tipo: 'libro_sin_kepler', fecha: dk, monto: c.importe, ref: `libro|${c.id}`, ruta_dia: dia && ruta ? `ruta ${ruta}|${dia}` : undefined,
          etiqueta: dia && ruta ? `${c.id}: el efectivo de la ruta ${ruta} del ${dia} está en el libro y Kepler no tiene su cobro${notaFecha}` : `${c.id} sin documento en la Caja General de Kepler`,
          testigos: { cobro: 'no', libro: 'si' } });
      }
      for (const k of res.otro_solos) solosK.push({ ...k, dir });
    }
  }
  // «Kepler sí, libro no» — salvo lo que el libro ya capturó en otro día (por su llave).
  const keys = solosK.map((s) => s.key);
  const yaEnLibro = keys.length
    ? await mide(t, 'cuadre', () => trx('finance.cash_ledger').where('tenant_id', tenantId).whereNull('deleted_at').whereNot('estado', 'cancelado')
      .where((w: Knex.QueryBuilder) => w.whereIn('origen_ref', keys).orWhereIn('declared_doc_ref', keys))
      .select('folio', 'estado', 'origen_tipo', 'origen_ref', 'declared_doc_ref'))
    : [];
  for (const s of marcaEnLibro(solosK, indexaLibro(yaEnLibro as any[]))) {
    if (s.en_libro) continue;
    if (s.signo == null || s.signo === 0) {
      salida.push({ tipo: 'sin_direccion', fecha: s.fecha, monto: s.importe, ref: s.key, etiqueta: `${s.key.split('|').slice(1, 3).join(' ')} llega de Kepler sin dirección (no se sabe si entra o sale)` });
      continue;
    }
    salida.push({ tipo: 'kepler_sin_libro', fecha: s.fecha, monto: s.importe, ref: s.key, via: 'llave',
      etiqueta: `${s.dir === 'in' ? 'Cobro' : 'Pago'} ${s.key.split('|').slice(1, 3).join(' ')} sin captura en el libro`,
      testigos: { cobro: s.dir === 'in' ? 'si' : 'na', libro: 'no' } });
  }
  return salida;
}

// ── 2. Cobros a una cuenta que no es caja ni banco (`0001`, §36.8) ─────────────────────────────

async function huecosCuentaNoCaja(trx: Trx, from: string, to: string, t: Tiempos): Promise<HuecoEntrada[]> {
  const rows = await mide(t, 'cuenta_no_caja', () => trx.raw(`
    SELECT d.sucursal, btrim(d.c1) alm, btrim(d.c6) folio, d.c9::date AS f, ${NUM('d.c16')} AS imp, btrim(d.c45) c45, kb.nombre, left(btrim(coalesce(d.c24,'')),60) glosa
      FROM kepler_ods.kdm1 d
      JOIN (SELECT DISTINCT ON (btrim(c1)) btrim(c1) clave, btrim(c2) nombre, btrim(coalesce(c5,'')) c5 FROM kepler_ods.kdb1 ORDER BY btrim(c1), sucursal) kb ON kb.clave = btrim(d.c45)
     WHERE d.c2='U' AND d.c3='A' AND btrim(d.c4::text)='5' AND btrim(coalesce(d.c43,''))<>'C'
       AND d.c9::date BETWEEN ? AND ? AND btrim(d.c1) = d.sucursal
       -- ⛔ «Ni caja ni banco» = cuenta PUENTE: su cuenta contable no es 102 (la regla de
       -- kepler_bank_movements). NO «sin CLABE»: la Bajío 4166 trae 8 dígitos y es banco.
       AND kb.c5 !~ '^102'`, [from, to]));
  const kdm1: HuecoEntrada[] = (rows.rows as any[]).filter((r) => n(r.imp) > 1).map((r) => ({
    tipo: 'cuenta_no_caja' as const, fecha: ymd(r.f), monto: n(r.imp), ref: `${r.sucursal}|U-A-5|${r.folio}|${r.c45}`, sucursal: String(r.sucursal),
    etiqueta: `Cobro U-A-5 ${r.folio} a «${r.nombre}» (ni caja ni banco)${r.glosa ? ' · ' + r.glosa : ''}`, testigos: { cobro: 'difiere' as const },
  }));
  // El mismo error en el carril de las camionetas (la ruta 21 del 16-oct, a `0001`).
  const rc = await mide(t, 'cuenta_no_caja', () => trx.raw(`
    SELECT r.almacen, r.cobro_folio, r.fecha, r.cuenta, kb.nombre, sum(r.importe) imp, string_agg(DISTINCT r.truck, ',') truck
      FROM analytics.route_collections r
      JOIN (SELECT DISTINCT ON (btrim(c1)) btrim(c1) clave, btrim(c2) nombre, btrim(coalesce(c5,'')) c5 FROM kepler_ods.kdb1 ORDER BY btrim(c1), sucursal) kb ON kb.clave = r.cuenta
     WHERE r.fecha BETWEEN ? AND ? AND kb.c5 !~ '^102'
     GROUP BY 1,2,3,4,5`, [from, to]));
  const camioneta: HuecoEntrada[] = (rc.rows as any[]).filter((r) => n(r.imp) > 1).map((r) => ({
    tipo: 'cuenta_no_caja' as const, fecha: ymd(r.fecha), monto: n(r.imp), ref: `${r.almacen}|U-A-5|${r.cobro_folio}|${r.cuenta}`,
    etiqueta: `Cobro de camioneta U-A-5 ${r.cobro_folio} (${String(r.truck).replace(/ruta_/g, 'ruta ')}) a «${r.nombre}» (ni caja ni banco)`, testigos: { cobro: 'difiere' as const },
  }));
  return [...kdm1, ...camioneta];
}

// ── 3. Venta de ruta sin cobro (§36.3) ──────────────────────────────────────────────────────────

/**
 * Por ruta, la diferencia diaria venta − cobro, y los sobrecobros consumen los faltantes MÁS VIEJOS
 * (FIFO): el cobro del 20-oct que trae lo del 15 no deja dos huecos de signo opuesto. Lo vendido
 * ayer u hoy todavía no es hueco: el cobro llega el mismo día o el siguiente.
 */
async function huecosVentaSinCobro(trx: Trx, tenantId: string, from: string, to: string, hoy: string, t: Tiempos): Promise<HuecoEntrada[]> {
  const venta = await mide(t, 'venta_sin_cobro', () => trx('analytics.v_rd_route_daily').where('tenant_id', tenantId).where('source', 'push')
    .andWhere('business_date', '>=', from).andWhere('business_date', '<=', to)
    .groupBy('route_code', 'business_date').select('route_code', 'business_date', trx.raw('sum(venta)::numeric AS venta')));
  const cobro = await mide(t, 'venta_sin_cobro', () => trx('analytics.route_collections').where('tenant_id', tenantId)
    .andWhere('fecha', '>=', from).andWhere('fecha', '<=', to)
    .groupBy('truck', 'fecha').select('truck', 'fecha', trx.raw('sum(importe)::numeric AS importe')));
  const porRuta = new Map<string, Map<string, number>>();
  const acum = (ruta: string, d: string, v: number) => { const m = porRuta.get(ruta) ?? new Map(); m.set(d, (m.get(d) ?? 0) + v); porRuta.set(ruta, m); };
  for (const v of venta as any[]) acum(String(v.route_code), ymd(v.business_date), n(v.venta));
  for (const c of cobro as any[]) acum(String(c.truck ?? '').replace(/^ruta_/, ''), ymd(c.fecha), -n(c.importe));
  const out: HuecoEntrada[] = [];
  const limite = sumaDias(hoy, -1);
  for (const [ruta, m] of porRuta) {
    const pend: { d: string; v: number }[] = [];
    for (const d of [...m.keys()].sort()) {
      let g = redondea2(m.get(d) ?? 0);
      if (g > 1) { pend.push({ d, v: g }); continue; }
      while (g < -1 && pend.length) { const p = pend[0]; const u = Math.min(p.v, -g); p.v = redondea2(p.v - u); g = redondea2(g + u); if (p.v <= 1) pend.shift(); }
    }
    for (const p of pend) if (p.d < limite) out.push({ tipo: 'venta_sin_cobro', fecha: p.d, monto: p.v, ref: `ruta ${ruta}|${p.d}`, etiqueta: `Ruta ${ruta}: vendió y no cobró`, testigos: { venta: 'si', cobro: 'no' } });
  }
  return out;
}

// ── 4. Cortes de las cajas que alimentan Caja General, sin cobro (§36.3b) ─────────────────────

/**
 * ⭐ Una caja «alimenta» a Caja General si, en los 60 días previos, sus cortes se cobraron sobre todo
 * a `0011`: sale del dato, no de una lista escrita (01 caja 4, 07 cajas 3 y 4, 08 caja 9 el
 * 2026-11-04). El atraso normal (p90 corte→cobro) se mide por sucursal en la misma ventana.
 */
async function huecosCorteSinCobro(trx: Trx, from: string, to: string, hoy: string, t: Tiempos): Promise<HuecoEntrada[]> {
  // 30 días de historia alcanzan para el atraso normal (≥ 10 cortes por sucursal) y caben en el
  // presupuesto: con 60 la consulta pasaba de 500 ms.
  const desde = sumaDias(from, -30);
  /**
   * ⚡ Se parte de los COBROS (`kdm1` por fecha) y se baja a `kdm5` por su llave completa. Barrer
   * `kdm5` por el folio del cargo (`c11`, sin índice) tardaba 2,083 ms; así, ~500 ms (medido en
   * prod el 2026-11-04).
   */
  const rows = await mide(t, 'corte_sin_cobro', () => trx.raw(`
    WITH c AS (
      SELECT k.sucursal, btrim(k.c27::text) caja, btrim(k.c6) folio, btrim(k.c5::text) serie, k.c9::date f, ${NUM('k.c16')} imp
        FROM kepler_ods.kdm1 k
       WHERE k.c2='U' AND k.c3='D' AND btrim(k.c4::text)='23' AND btrim(k.c1)=k.sucursal AND btrim(coalesce(k.c43,''))<>'C'
         AND k.c9::date BETWEEN ? AND ?),
    ab AS (
      SELECT ab.sucursal, ab.c1, ab.c2, ab.c3, ab.c4, ab.c5, ab.c6, btrim(ab.c45) c45, ab.c9::date fa
        FROM kepler_ods.kdm1 ab
       WHERE ab.c2='U' AND ab.c3='A' AND btrim(ab.c1)=ab.sucursal AND btrim(coalesce(ab.c43,''))<>'C' AND ab.c9::date >= ?),
    a AS (
      SELECT a.sucursal, btrim(a.c11::text) folio, btrim(a.c10::text) serie, ${NUM('a.c12')} imp, ab.c45, ab.fa
        FROM ab JOIN kepler_ods.kdm5 a
          ON a.sucursal=ab.sucursal AND a.c1=ab.c1 AND a.c2=ab.c2 AND a.c3=ab.c3 AND a.c4=ab.c4 AND a.c5=ab.c5 AND a.c6=ab.c6
       WHERE a.c8='D' AND btrim(a.c9::text)='23')
    SELECT c.sucursal, c.caja, c.folio, c.f, c.imp,
           coalesce(sum(a.imp), 0) cobrado, coalesce(sum(a.imp) FILTER (WHERE a.c45='0011'), 0) a_cg, max(a.fa) ultimo_cobro
      FROM c LEFT JOIN a ON a.sucursal=c.sucursal AND a.folio=c.folio AND a.serie=c.serie
     GROUP BY 1,2,3,4,5`, [desde, to, desde]));
  const cortes = (rows.rows as any[]).map((r) => ({ ...r, f: ymd(r.f), ultimo_cobro: r.ultimo_cobro ? ymd(r.ultimo_cobro) : null, imp: n(r.imp), cobrado: n(r.cobrado), a_cg: n(r.a_cg) }));
  const dias = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
  // La caja alimenta si ≥ 50 % de lo cobrado de sus cortes previos fue a 0011.
  const previos = cortes.filter((c) => c.f < from && c.cobrado > 0);
  const share = new Map<string, { cg: number; tot: number }>();
  for (const c of previos) { const k = `${c.sucursal}|${c.caja}`; const s = share.get(k) ?? { cg: 0, tot: 0 }; s.cg += c.a_cg; s.tot += c.cobrado; share.set(k, s); }
  const alimenta = new Set([...share].filter(([, s]) => s.tot > 0 && s.cg / s.tot >= 0.5).map(([k]) => k));
  const p90 = new Map<string, number>();
  for (const suc of new Set(previos.map((c) => c.sucursal))) {
    const lags = previos.filter((c) => c.sucursal === suc && c.ultimo_cobro && Math.abs(c.imp - c.cobrado) <= 1).map((c) => dias(c.f, c.ultimo_cobro as string)).sort((a, b) => a - b);
    if (lags.length >= 10) p90.set(suc, lags[Math.floor(0.9 * (lags.length - 1))]);
  }
  return cortes
    .filter((c) => c.f >= from && alimenta.has(`${c.sucursal}|${c.caja}`) && c.imp - c.cobrado > 1)
    .map((c) => ({
      tipo: 'corte_sin_cobro' as const, fecha: c.f, monto: redondea2(c.imp - c.cobrado), ref: `${c.sucursal}|U-D-23|${c.folio}`,
      etiqueta: `Corte U-D-23 ${c.folio} de la caja ${c.caja} sin cobrar${c.cobrado > 0 ? ' completo' : ''}`,
      testigos: { corte: 'si' as const, cobro: c.cobrado > 0 ? ('difiere' as const) : ('no' as const) },
      atraso_dias: dias(c.f, hoy), atraso_p90: p90.get(c.sucursal),
      sucursal: c.sucursal,
    }));
}

// ── 5. El bulto sin contar (§36.5) ──────────────────────────────────────────────────────────────

async function huecoBulto(trx: Trx, tenantId: string, from: string, to: string, t: Tiempos): Promise<HuecoEntrada[]> {
  const r = await mide(t, 'bulto', () => trx('finance.cash_ledger_cuts').where('tenant_id', tenantId).andWhere('fecha', '>=', from).andWhere('fecha', '<=', to)
    .orderBy('fecha', 'desc').first('folio', 'fecha', 'morralla'));
  // Sólo el ÚLTIMO corte: el bulto se arrastra de corte en corte; sumarlo por día lo multiplica (§28.4).
  if (!r || !(n((r as any).morralla) > 0.49)) return [];
  return [{ tipo: 'bulto_sin_contar', fecha: ymd((r as any).fecha), monto: n((r as any).morralla), ref: `${(r as any).folio}|morralla`,
    etiqueta: `${(r as any).folio}: monto tecleado como morralla, sin desglose (en Control figura como cheques)`, testigos: { libro: 'na', boveda: 'na' } }];
}

/** Todas las entradas de huecos del periodo, con el tiempo de cada fuente. */
export async function entradasDeHuecos(trx: Trx, tenantId: string, from: string, to: string, hoy: string): Promise<{ entradas: HuecoEntrada[]; ms: Tiempos }> {
  const ms: Tiempos = {};
  const partes = [
    await huecosDelCuadre(trx, tenantId, from, to, ms),
    await huecosCuentaNoCaja(trx, from, to, ms),
    await huecosVentaSinCobro(trx, tenantId, from, to, hoy, ms),
    await huecosCorteSinCobro(trx, from, to, hoy, ms),
    await huecoBulto(trx, tenantId, from, to, ms),
  ];
  return { entradas: unaVezLaRuta(partes.flat()), ms };
}

/**
 * ⛔ **Un peso, un hueco, entre dos lados.** Cuando el libro tiene el efectivo de una ruta y día
 * declarados y Kepler no tiene su cobro, la camioneta también sale «vendió y no cobró» por el mismo
 * dinero (ruta 27 del 12-oct, $12,594). Es UN hueco, el de Kepler: lo que el libro ya tiene se le
 * resta a la venta sin cobro, y si no queda nada, la venta sin cobro desaparece.
 */
export function unaVezLaRuta(entradas: HuecoEntrada[]): HuecoEntrada[] {
  const enLibro = new Map<string, number>();
  for (const e of entradas) if (e.ruta_dia && (e.tipo === 'libro_sin_kepler' || e.tipo === 'libro_sin_ligar')) enLibro.set(e.ruta_dia, (enLibro.get(e.ruta_dia) ?? 0) + e.monto);
  const out: HuecoEntrada[] = [];
  for (const e of entradas) {
    if (e.tipo !== 'venta_sin_cobro') { out.push(e); continue; }
    const ya = enLibro.get(e.ref) ?? 0;
    const resto = redondea2(e.monto - ya);
    if (resto > 1) out.push(ya > 0 ? { ...e, monto: resto, etiqueta: `${e.etiqueta} (descontado lo que ya está en el libro)` } : e);
  }
  return out;
}

// ── El balance físico (§36.4) ───────────────────────────────────────────────────────────────────

export interface DatosBalance {
  entrada: EntradaBalance;
  inicio: { instante: string | null; fuente: 'corte_anterior' | 'arqueo_control' | 'sin_dato'; boveda_fuente: string };
  fin: { corte: string | null; instante: string | null; boveda_fuente: string };
  replay: { pares: number; cierran: number; fallas_mismo_evento: number; fallas_reales: number };
  cortes: { folio: string; fecha: string; bulto: number }[];
}

/**
 * El balance de los cortes cuyo día cae en el periodo. El inicio es el cierre del corte anterior
 * (lo contado pieza por pieza) o, para el primer corte del libro, el último arqueo de Control que
 * declaró la custodia completa (el que dio el fondo, `A23641`). ⛔ Ingresos y gastos se suman
 * **por corte**, no por la fecha del renglón: un corte contiene lo que se le asignó (§36.4).
 */
export async function datosBalance(trx: Trx, tenantId: string, from: string, to: string): Promise<DatosBalance | null> {
  const cortes = (await trx.raw(`
    SELECT c.id, c.folio, c.fecha, c.fondo_inicial, c.morralla, c.closed_at,
           (SELECT coalesce(sum(d.denominacion*d.piezas),0) FROM finance.cash_ledger_cut_denominations d WHERE d.cut_id=c.id) piezas,
           (SELECT coalesce(sum(monto) FILTER (WHERE tipo='ingreso'),0) FROM finance.cash_ledger l WHERE l.corte_id=c.id AND l.deleted_at IS NULL AND l.estado<>'cancelado') ing,
           (SELECT coalesce(sum(monto) FILTER (WHERE tipo<>'ingreso'),0) FROM finance.cash_ledger l WHERE l.corte_id=c.id AND l.deleted_at IS NULL AND l.estado<>'cancelado') gas
      FROM finance.cash_ledger_cuts c WHERE c.tenant_id=? AND c.fecha BETWEEN ? AND ? AND c.estado='cerrado' ORDER BY c.fecha`, [tenantId, from, to])).rows as any[];
  if (!cortes.length) return null;
  const previo = (await trx.raw(`
    SELECT c.closed_at, (SELECT coalesce(sum(d.denominacion*d.piezas),0) FROM finance.cash_ledger_cut_denominations d WHERE d.cut_id=c.id) piezas, c.morralla
      FROM finance.cash_ledger_cuts c WHERE c.tenant_id=? AND c.fecha < ? ORDER BY c.fecha DESC LIMIT 1`, [tenantId, ymd(cortes[0].fecha)])).rows[0] as any;
  let instante: string | null = null; let fuente: DatosBalance['inicio']['fuente'] = 'sin_dato'; let cajon0 = 0; let sinCorte = 0;
  if (previo) {
    instante = new Date(previo.closed_at).toISOString(); fuente = 'corte_anterior';
    cajon0 = n(previo.piezas) + (n(previo.morralla) <= 0.49 ? n(previo.morralla) : 0);
  } else {
    const a = (await trx.raw(`
      SELECT ((left(movimientofecha,10)||' '||substr(movimientohora,12,8))::timestamp AT TIME ZONE 'America/Mexico_City') AS at
        FROM caja_general_ods.arqueo_movimientos
       WHERE ${NUM('dolares')} <> 0 AND left(movimientofecha,10)::date < ?
       ORDER BY 1 DESC LIMIT 1`, [ymd(cortes[0].fecha)])).rows[0] as any;
    if (a) { instante = new Date(a.at).toISOString(); fuente = 'arqueo_control'; }
    cajon0 = n(cortes[0].fondo_inicial);
    // Lo pagado entre el arqueo y el primer corte, sin corte (CG-2026-00018 el 10-oct): es de la ventana.
    if (instante) {
      sinCorte = n((await trx.raw(`SELECT coalesce(sum(monto),0) s FROM finance.cash_ledger WHERE tenant_id=? AND corte_id IS NULL AND deleted_at IS NULL AND estado<>'cancelado' AND tipo<>'ingreso'
        AND fecha >= (?::timestamptz AT TIME ZONE 'America/Mexico_City')::date AND fecha < ?`, [tenantId, instante, ymd(cortes[0].fecha)])).rows[0].s);
    }
  }
  const ult = cortes[cortes.length - 1];
  const finT = new Date(ult.closed_at).toISOString();
  const counts: ConteoBoveda[] = ((await trx.raw(`SELECT after_external_id::bigint tras_id, total::numeric total, captured_at FROM analytics.caos_cash_counts WHERE tenant_id=? ORDER BY captured_at`, [tenantId])).rows as any[])
    .map((c) => ({ tras_id: n(c.tras_id), total: n(c.total), at: new Date(c.captured_at).toISOString() }));
  const desdeMov = instante ?? finT;
  const movs: MovBoveda[] = ((await trx.raw(`SELECT external_id::bigint id, type_label tipo, total::numeric total, occurred_at FROM analytics.caos_cash_movements WHERE tenant_id=? AND occurred_at >= ?::timestamptz - interval '1 day' ORDER BY occurred_at, external_id`, [tenantId, desdeMov])).rows as any[])
    .map((m) => ({ id: n(m.id), tipo: m.tipo, total: n(m.total), at: new Date(m.occurred_at).toISOString() }));
  const v = validaReplay(counts.filter((c) => c.at >= desdeMov), movs);
  const b0 = instante ? bovedaEn(instante, counts, movs) : { monto: null, fuente: 'sin_dato' as const };
  const b1 = bovedaEn(finT, counts, movs);
  return {
    entrada: {
      inicial: { cajon: cajon0, boveda: b0.monto },
      ingresos: redondea2(cortes.reduce((s, c) => s + n(c.ing), 0)),
      gastos: redondea2(cortes.reduce((s, c) => s + n(c.gas), 0) + sinCorte),
      final: { conteo: { piezas: n(ult.piezas), morralla: n(ult.morralla) }, boveda: b1.monto },
    },
    inicio: { instante, fuente, boveda_fuente: b0.fuente },
    fin: { corte: ult.folio, instante: finT, boveda_fuente: b1.fuente },
    replay: { pares: v.pares, cierran: v.cierran, fallas_mismo_evento: v.fallas.filter((f) => f.mismo_evento).length, fallas_reales: v.fallas.filter((f) => !f.mismo_evento).length },
    cortes: cortes.map((c) => ({ folio: c.folio, fecha: ymd(c.fecha), bulto: n(c.morralla) > 0.49 ? n(c.morralla) : 0 })),
  };
}
