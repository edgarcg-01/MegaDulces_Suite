/* eslint-disable no-console */
/**
 * `[TR.0]` — **¿Qué traspasos tenemos que el ERP ya no tiene?**
 *
 * Disparado por el reporte de Edgar (2026-10-06): *«existen traspasos entre sucursales que se
 * registraron en CEDIS pero eran de Morelia Abastos y algunos de Canindo; éstos fueron borrados
 * del servidor principal»*.
 *
 * ── ⛔ Por qué hace falta un script y no basta mirar nuestra copia
 *
 * El carril que alimenta `kepler_ods` avanza por **marca de agua de `ctid`** (ver
 * `kepler_ods.ctl.last_ctid`): lee las filas que aparecen *después* de una posición física. Eso
 * **no puede ver un DELETE, nunca**. Una fila borrada en el origen simplemente deja de aparecer, y
 * la copia que ya shipeamos **se queda para siempre**.
 *
 * O sea: desde la plataforma, un documento borrado en Kepler y uno vigente **se ven idénticos**.
 * La única forma de saberlo es preguntarle al origen, que es lo que hace esto.
 *
 * Es el mismo hueco que `[OBS]` ya tiene anotado para la rama 04 (9,532 filas en ODS contra 9,525
 * en la réplica) y que `reconcile-ods-window` iba a cerrar — escrito y nunca levantado.
 *
 * ── Qué compara
 *
 * Los documentos de traspaso de CEDIS por folio, en una ventana de fechas:
 *   · **sobran**  → están en `kepler_ods` y NO en la réplica = **borrados en el origen**, y los
 *                   seguimos publicando. Es lo que esta investigación busca.
 *   · **faltan**  → están en la réplica y NO en `kepler_ods` = el carril se atrasó o los perdió.
 *   · **difieren**→ mismo folio, distinto importe o distinto destino = se editaron después.
 *
 * ⚠️ **Read-only de las dos puntas.** No escribe nada, ni propone borrar nada: decide un humano.
 * Borrar de nuestra copia lo que el ERP borró puede ser correcto —o puede estar tapando que el
 * documento se borró por error—. El script dice QUÉ, no QUÉ HACER.
 *
 * ── Cómo se corre
 *
 *   ODS_URL=postgresql://…/railway \
 *   REPLICA_URL=postgresql://…@192.168.0.222:5433/kepler_md_00 \
 *   node database/scripts/check-traspasos-borrados.js --desde=2026-09-01 --hasta=2026-10-06
 *
 * Desde la máquina de trabajo la réplica **no es alcanzable** con la credencial de prod (son dos
 * clusters distintos; las de `dev_ro` viven en `md:~/secrets/dev-ro/`). Correr en `md`, o pedir
 * una credencial de lectura.
 *
 * Salida: exit 0 = sin diferencias · 1 = hay diferencias · 2 = NO MEDIDO (no se pudo comparar).
 */
require('dotenv').config();
const { Client } = require('pg');

const arg = (k, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};

const ODS_URL = process.env.ODS_URL || process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
const REPLICA_URL = process.env.REPLICA_URL;
const SUCURSAL = arg('sucursal', '00');
const DESDE = arg('desde', '2026-09-01');
const HASTA = arg('hasta', new Date().toISOString().slice(0, 10));
// `U-D-13` = salida por traspaso del CEDIS. Se puede ampliar: `--doctypes=13,6`.
const DOCTYPES = arg('doctypes', '13').split(',').map((s) => s.trim()).filter(Boolean);

const noMedido = (porque) => { console.log(`\n◌ NO MEDIDO: ${porque}`); process.exit(2); };
const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;

/**
 * La misma forma en las dos puntas. ⚠️ El esquema difiere a propósito: en la réplica las tablas
 * viven en `md.*` y traen su `sucursal`; en el landing están en `kepler_ods.*`. Las columnas `cNN`
 * son idénticas — es una copia verbatim, por eso se puede comparar sin traducir nada.
 */
const SQL = (schema, conSucursal) => `
  SELECT btrim(c6) AS folio,
         (c9)::date AS fecha,
         btrim(c10) AS destino,
         round(COALESCE(NULLIF(regexp_replace(c16::text, '[^0-9.-]', '', 'g'), '')::numeric, 0), 2) AS importe
    FROM ${schema}.kdm1
   WHERE ${conSucursal ? 'sucursal = $1' : '$1 = $1'}
     AND btrim(c2) = 'U' AND btrim(c3) = 'D'
     AND btrim(c4::text) = ANY($2::text[])
     AND (c9)::date >= $3::date AND (c9)::date <= $4::date`;

(async () => {
  if (!ODS_URL) return noMedido('sin ODS_URL / DATABASE_URL_NEW');
  if (!REPLICA_URL) {
    return noMedido('sin REPLICA_URL — y SIN LA RÉPLICA ESTO NO SE PUEDE RESPONDER. '
      + 'Nuestra copia no distingue un documento vigente de uno borrado: la marca de agua es por '
      + 'ctid y no ve DELETEs. Correr en `md` con acceso a kepler_md_00.');
  }

  const ods = new Client({ connectionString: ODS_URL, statement_timeout: 120000 });
  const rep = new Client({ connectionString: REPLICA_URL, statement_timeout: 120000, connectionTimeoutMillis: 10000 });
  try { await ods.connect(); } catch (e) { return noMedido(`el landing no es alcanzable: ${e.message}`); }
  try { await rep.connect(); } catch (e) { await ods.end(); return noMedido(`la réplica no es alcanzable: ${e.message}`); }

  try {
    const params = [SUCURSAL, DOCTYPES, DESDE, HASTA];
    const [a, b] = await Promise.all([
      ods.query(SQL('kepler_ods', true), params),
      rep.query(SQL('md', false), params),
    ]);

    const idx = (rows) => new Map(rows.map((r) => [r.folio, r]));
    const A = idx(a.rows); // lo que publicamos
    const B = idx(b.rows); // lo que el ERP tiene HOY

    const sobran = [...A.values()].filter((r) => !B.has(r.folio));
    const faltan = [...B.values()].filter((r) => !A.has(r.folio));
    const diff = [...A.values()].filter((r) => {
      const o = B.get(r.folio);
      return o && (Number(o.importe) !== Number(r.importe) || String(o.destino) !== String(r.destino));
    });

    const suma = (rs) => rs.reduce((s, r) => s + Number(r.importe || 0), 0);

    console.log(`\nTraspasos U-D-${DOCTYPES.join('/')} · sucursal ${SUCURSAL} · ${DESDE} → ${HASTA}`);
    console.log(`  publicamos (kepler_ods): ${A.size} docs · ${money(suma([...A.values()]))}`);
    console.log(`  el ERP tiene hoy       : ${B.size} docs · ${money(suma([...B.values()]))}`);

    // ⛔ El hallazgo que motivó el script: lo que seguimos publicando y el ERP ya no tiene.
    console.log(`\n⛔ BORRADOS EN EL ORIGEN y todavía publicados: ${sobran.length} · ${money(suma(sobran))}`);
    for (const r of sobran.slice(0, 25)) {
      console.log(`     ${r.fecha.toISOString?.().slice(0, 10) ?? r.fecha}  folio ${r.folio}  dest ${r.destino}  ${money(r.importe)}`);
    }
    if (sobran.length > 25) console.log(`     … y ${sobran.length - 25} más`);

    console.log(`\n⚠️ En el ERP y NO en nuestra copia (el carril se atrasó o los perdió): ${faltan.length} · ${money(suma(faltan))}`);
    for (const r of faltan.slice(0, 15)) {
      console.log(`     ${r.fecha.toISOString?.().slice(0, 10) ?? r.fecha}  folio ${r.folio}  dest ${r.destino}  ${money(r.importe)}`);
    }
    if (faltan.length > 15) console.log(`     … y ${faltan.length - 15} más`);

    console.log(`\n⚠️ Mismo folio, distinto importe o destino (se editaron después): ${diff.length}`);
    for (const r of diff.slice(0, 15)) {
      const o = B.get(r.folio);
      console.log(`     folio ${r.folio}: nuestro ${money(r.importe)}/${r.destino} vs ERP ${money(o.importe)}/${o.destino}`);
    }

    // ⚠️ Cero diferencias con las DOS puntas vacías no es "está sano": es que no había qué comparar.
    if (!A.size && !B.size) {
      return noMedido(`ni el landing ni la réplica tienen documentos en esa ventana — ampliá --desde/--hasta`);
    }

    const hay = sobran.length + faltan.length + diff.length;
    console.log(`\n${hay ? '✖' : '✔'} ${hay} diferencia(s).`);
    process.exit(hay ? 1 : 0);
  } finally {
    await ods.end().catch(() => {});
    await rep.end().catch(() => {});
  }
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
