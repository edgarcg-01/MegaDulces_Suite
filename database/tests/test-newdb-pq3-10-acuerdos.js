#!/usr/bin/env node
/**
 * [PQ.3.10] Compras › Proveedores › Acuerdos — lo que se decide en una reunión con el proveedor, contra base REAL.
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 * `commercial.supplier_agreements` (anexo C §10.20, DC43–DC46, ADR-128). Antes de que exista la API, lo que tiene que
 * ser verdad en la base:
 *
 *  1. **Las listas del código = los CHECK.** Áreas y estados de `libs/contracts/src/http/supplier-agreements.contract.ts`
 *     son EXACTAMENTE los que aceptan los CHECK, y los estados son un subconjunto del canónico `ESTADOS_TAREA`
 *     (`libs/contracts/src/work/task.contract.ts`): el acuerdo no trae dialecto (ADR-128).
 *  2. **Los casos entran:** un acuerdo de Compras pendiente, uno de Mercadotecnia en curso, uno del PROVEEDOR con el
 *     nombre de su persona (DC43), uno cumplido con nota y uno cancelado con nota.
 *  3. **Negativas, una por regla:** área o estado desconocidos; qué se acordó en blanco o de más de 500; el del proveedor
 *     sin nombre, el de un área de Mega Dulces CON nombre de proveedor, el nombre en blanco o de más de 120; cerrado sin
 *     nota, sin quién o sin cuándo; pendiente con datos de cierre; nota en blanco; sin reunión, sin responsable, sin
 *     quién lo asignó, sin fecha compromiso; una reunión que no existe; una reunión de OTRO tenant (llave compuesta).
 *  4. **Como `app_runtime`** (el rol de prod): cierra con UPDATE y nota, NO puede borrar; con otro tenant (RLS) no ve
 *     nada ni puede escribir.
 *
 * Todo dentro de una transacción que se REVIERTE: no deja filas.
 * ⚠️ Sin la tabla (migración 20261126232231 sin aplicar) sale con 2 = NO MEDIDO, nunca ✔.
 * ⛔ Escribe (aunque revierta): exige `assert-safe-target`, nunca contra producción.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DST = process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW
  || (() => { throw new Error('falta DATABASE_URL_NEW_RUNTIME o DATABASE_URL_NEW'); })();
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000aa';
const U1 = '00000000-0000-0000-0000-0000000310a1';
const U2 = '00000000-0000-0000-0000-0000000310a2';
const RAIZ = path.join(__dirname, '..', '..', 'libs', 'contracts', 'src');
const CONTRATO = path.join(RAIZ, 'http', 'supplier-agreements.contract.ts');
const TAREAS = path.join(RAIZ, 'work', 'task.contract.ts');

let ok = 0, fail = 0, nm = 0;
const P = (m) => { ok++; console.log(`  ✔ ${m}`); };
const F = (m) => { fail++; console.log(`  ✘ ${m}`); };
const NM = (m) => { nm++; console.log(`  ○ NO MEDIDO — ${m}`); };

/** Una lista `export const NOMBRE … = [ … ]` leída del CÓDIGO (no copiada aquí: una copia se queda vieja). */
function lista(archivo, nombre) {
  const src = fs.readFileSync(archivo, 'utf8');
  const m = src.match(new RegExp(`export const ${nombre}\\b[^=]*=\\s*\\[([^\\]]*)\\]`));
  if (!m) throw new Error(`no encontré ${nombre} en ${archivo}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
}
const numero = (archivo, nombre) => {
  const m = fs.readFileSync(archivo, 'utf8').match(new RegExp(`export const ${nombre} = (\\d+)`));
  if (!m) throw new Error(`no encontré ${nombre} en ${archivo}`);
  return Number(m[1]);
};

require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pq3-10-acuerdos', { url: DST });

(async () => {
  const c = new Client({ connectionString: DST });
  await c.connect();
  let dest = (await c.query('SELECT current_user u, current_database() d')).rows[0];
  console.log(`\n[PQ.3.10] los acuerdos con el proveedor  —  ${dest.u}@${dest.d}\n`);

  const existe = (await c.query(`SELECT to_regclass('commercial.supplier_agreements') IS NOT NULL ok`)).rows[0].ok;
  if (!existe) {
    NM('commercial.supplier_agreements no existe (migración 20261126232231 sin aplicar)');
    await c.end();
    process.exit(2);
  }

  // 1. Las listas del código = los CHECK; los estados, dentro del canónico del contrato de tareas.
  const contrato = { area: lista(CONTRATO, 'AREAS_ACUERDO'), status: lista(CONTRATO, 'ESTADOS_ACUERDO') };
  const defs = (await c.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
                                WHERE conrelid = 'commercial.supplier_agreements'::regclass AND contype = 'c'`)).rows.map((r) => r.def);
  const valoresDe = (col) => [...new Set(defs.flatMap((d) => {
    // Sólo el CHECK de la LISTA de la columna (`col = ANY (ARRAY[…])`): el de cierre también nombra estados.
    const out = [];
    for (const m of d.matchAll(new RegExp(`^CHECK \\(\\(${col} = ANY \\(ARRAY\\[([^\\]]+)\\]\\)\\)\\)$`, 'g'))) out.push(...[...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
    return out;
  }))].sort();
  for (const col of ['area', 'status']) {
    const enCheck = valoresDe(col);
    if (enCheck.length && JSON.stringify(enCheck) === JSON.stringify(contrato[col])) P(`${col}: el contrato y el CHECK aceptan lo mismo (${contrato[col].join(', ')})`);
    else F(`${col}: el contrato dice [${contrato[col]}] y el CHECK acepta [${enCheck}]`);
  }
  const canonico = lista(TAREAS, 'ESTADOS_TAREA');
  const fuera = contrato.status.filter((s) => !canonico.includes(s));
  if (!fuera.length) P(`los estados del acuerdo son del canónico del contrato de tareas (ADR-128): ${contrato.status.join(', ')} ⊂ ${canonico.join(', ')}`);
  else F(`estados del acuerdo fuera del canónico de tareas: ${fuera.join(', ')}`);
  const MAXD = numero(CONTRATO, 'MAX_DESCRIPCION_ACUERDO');
  const MAXC = numero(CONTRATO, 'MAX_CONTACTO_PROVEEDOR');

  if (dest.u !== 'app_runtime') {
    try { await c.query('SET ROLE app_runtime'); dest = { ...dest, u: (await c.query('SELECT current_user u')).rows[0].u }; console.log(`  ⓘ SET ROLE app_runtime (la conexión entró como otro usuario)`); }
    catch { /* se declara abajo */ }
  }
  const comoRuntime = dest.u === 'app_runtime';

  await c.query('BEGIN');
  const sp = async (nombre, fn) => {
    await c.query(`SAVEPOINT ${nombre}`);
    try { return await fn(); } finally { await c.query(`ROLLBACK TO SAVEPOINT ${nombre}`); }
  };
  const reunion = (tenant) => c.query(`
    INSERT INTO commercial.supplier_meetings
      (tenant_id, supplier_code, kind, status, starts_at, ends_at, mode, organizer_user_id, minutes, minutes_by, minutes_at, created_by)
    VALUES ($1, 'PQ310-A', 'business_review', 'held', '2026-11-24T16:00:00Z', '2026-11-24T17:00:00Z', 'in_person', $2,
            'Se revisaron resultados y quedaron acuerdos.', 'prueba', '2026-11-24T17:30:00Z', 'prueba')
    RETURNING id`, [tenant, U1]).then((x) => x.rows[0].id);
  const acuerdo = (a) => c.query(`
    INSERT INTO commercial.supplier_agreements
      (tenant_id, meeting_id, area, description, supplier_contact, assigned_to, assigned_by, due_date, status,
       closed_at, closed_by, closing_note, created_by, updated_by)
    VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'pending'), $9, $10, $11, 'prueba', 'prueba')
    RETURNING id`, [a.meeting, a.area ?? 'compras', a.description === undefined ? 'Revisar la lista de precios 2027' : a.description,
    a.contact === undefined ? null : a.contact, 'to' in a ? a.to : U1, 'by' in a ? a.by : U1,
    'due' in a ? a.due : '2026-12-05', a.status ?? null, a.closedAt ?? null, a.closedBy ?? null,
    a.note === undefined ? null : a.note]).then((x) => x.rows[0].id);
  const rebota = async (nombre, codigo, fn, que) => sp(nombre, async () => {
    try { await fn(); F(`entró: ${que}`); }
    catch (e) { if (e.code === codigo) P(`negativa: ${que} → ${codigo}`); else F(`${que} falló por otra cosa: ${e.code} ${e.message}`); }
  });

  try {
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);
    const r1 = await reunion(TENANT);

    // 2. Los casos entran.
    const compras = await acuerdo({ meeting: r1, area: 'compras', description: 'Mandar el pedido de diciembre con el precio nuevo' });
    const mkt = await acuerdo({ meeting: r1, area: 'marketing', to: U2, description: 'Armar la exhibición de fin de año', status: 'in_progress' });
    const prov = await acuerdo({ meeting: r1, area: 'supplier', contact: 'Ejecutivo de cuenta', description: 'El proveedor manda su lista de precios 2027' });
    const cumplido = await acuerdo({ meeting: r1, area: 'finanzas', status: 'done', closedAt: '2026-11-25T18:00:00Z', closedBy: U2, note: 'Plazo confirmado a 30 días' });
    const cancelado = await acuerdo({ meeting: r1, area: 'direccion', status: 'cancelled', closedAt: '2026-11-25T18:00:00Z', closedBy: U1, note: 'Se decidió en la siguiente reunión' });
    if ([compras, mkt, prov, cumplido, cancelado].every(Boolean)) {
      P('entran: Compras pendiente · Mercadotecnia en curso · del PROVEEDOR con el nombre de su persona · Finanzas cumplido con nota · Dirección cancelado con nota');
    }
    const leido = (await c.query(`SELECT status, assigned_at IS NOT NULL AS con_fecha, supplier_contact FROM commercial.supplier_agreements WHERE id = $1`, [prov])).rows[0];
    if (leido.status === 'pending' && leido.con_fecha && leido.supplier_contact === 'Ejecutivo de cuenta') P('se lee como se guardó: pendiente por defecto, con la fecha en que se asignó y el nombre de la persona del proveedor');
    else F(`el acuerdo se lee distinto: ${JSON.stringify(leido)}`);
    const larga = await acuerdo({ meeting: r1, description: 'x'.repeat(MAXD) });
    if (larga) P(`entra lo acordado de ${MAXD} caracteres exactos (el tope del contrato)`);

    // 3. Negativas.
    const CK = '23514';
    await rebota('area', CK, () => acuerdo({ meeting: r1, area: 'sistemas' }), 'área desconocida «sistemas»');
    await rebota('estado', CK, () => acuerdo({ meeting: r1, status: 'resuelto' }), 'estado en otro dialecto «resuelto» (el acuerdo guarda el canónico)');
    await rebota('no_aplica', CK, () => acuerdo({ meeting: r1, status: 'not_applicable', closedAt: '2026-11-25T18:00:00Z', closedBy: U1, note: 'x' }), '«not_applicable» (un acuerdo se cancela)');
    await rebota('desc_blanca', CK, () => acuerdo({ meeting: r1, description: '   ' }), 'qué se acordó en blanco');
    await rebota('desc_larga', CK, () => acuerdo({ meeting: r1, description: 'x'.repeat(MAXD + 1) }), `qué se acordó de ${MAXD + 1} caracteres`);
    await rebota('prov_sin_nombre', CK, () => acuerdo({ meeting: r1, area: 'supplier' }), 'del proveedor SIN el nombre de su persona');
    await rebota('compras_con_nombre', CK, () => acuerdo({ meeting: r1, area: 'compras', contact: 'Ejecutivo' }), 'de Compras CON nombre de proveedor');
    await rebota('nombre_blanco', CK, () => acuerdo({ meeting: r1, area: 'supplier', contact: '  ' }), 'nombre del proveedor en blanco');
    await rebota('nombre_largo', CK, () => acuerdo({ meeting: r1, area: 'supplier', contact: 'x'.repeat(MAXC + 1) }), `nombre del proveedor de ${MAXC + 1} caracteres`);
    await rebota('hecho_sin_cierre', CK, () => acuerdo({ meeting: r1, status: 'done' }), 'cumplido SIN datos de cierre');
    await rebota('hecho_sin_nota', CK, () => acuerdo({ meeting: r1, status: 'done', closedAt: '2026-11-25T18:00:00Z', closedBy: U1 }), 'cumplido SIN nota');
    await rebota('hecho_sin_quien', CK, () => acuerdo({ meeting: r1, status: 'done', closedAt: '2026-11-25T18:00:00Z', note: 'listo' }), 'cumplido sin quién lo cerró');
    await rebota('hecho_sin_cuando', CK, () => acuerdo({ meeting: r1, status: 'done', closedBy: U1, note: 'listo' }), 'cumplido sin cuándo');
    await rebota('cancel_sin_nota', CK, () => acuerdo({ meeting: r1, status: 'cancelled', closedAt: '2026-11-25T18:00:00Z', closedBy: U1 }), 'cancelado SIN nota');
    await rebota('nota_blanca', CK, () => acuerdo({ meeting: r1, status: 'done', closedAt: '2026-11-25T18:00:00Z', closedBy: U1, note: '   ' }), 'nota de cierre en blanco');
    await rebota('pend_con_cierre', CK, () => acuerdo({ meeting: r1, status: 'pending', closedAt: '2026-11-25T18:00:00Z', closedBy: U1, note: 'x' }), 'pendiente CON datos de cierre');
    await rebota('curso_con_nota', CK, () => acuerdo({ meeting: r1, status: 'in_progress', note: 'x' }), 'en curso con nota suelta');
    await rebota('sin_reunion', '23502', () => acuerdo({ meeting: null }), 'acuerdo SIN reunión (DC45)');
    await rebota('sin_responsable', '23502', () => acuerdo({ meeting: r1, to: null }), 'acuerdo sin responsable');
    await rebota('sin_quien_asigna', '23502', () => acuerdo({ meeting: r1, by: null }), 'acuerdo sin quién lo asignó');
    await rebota('sin_fecha', '23502', () => acuerdo({ meeting: r1, due: null }), 'acuerdo sin fecha compromiso');
    await rebota('huerfano', '23503', () => acuerdo({ meeting: '00000000-0000-0000-0000-000000000001' }), 'acuerdo de una reunión que no existe');

    // La reunión de OTRO tenant: se crea saltando RLS sólo si la conexión puede (como dueño); si no, se declara.
    await sp('otro_tenant', async () => {
      let ajena = null;
      try {
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [OTRO]);
        ajena = await reunion(OTRO);
      } catch (e) { NM(`no se pudo crear una reunión de otro tenant para la negativa de la llave compuesta (${e.code})`); }
      finally { await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]); }
      if (ajena) await rebota('reunion_ajena', '23503', () => acuerdo({ meeting: ajena }), 'acuerdo de MI tenant colgado de una reunión de OTRO tenant');
    });

    // 4. Permisos de app_runtime y RLS.
    const deleteDePorDefecto = (await c.query(`
      SELECT EXISTS (SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) a
                      WHERE d.defaclnamespace = 'commercial'::regnamespace AND d.defaclobjtype = 'r'
                        AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime')
                        AND a.privilege_type = 'DELETE') AS si`)).rows[0].si;
    if (comoRuntime && !deleteDePorDefecto) {
      NM('esta base no da DELETE por defecto a app_runtime en commercial (prod sí): «no puede borrar» no prueba el REVOKE');
    }
    if (comoRuntime) {
      await rebota('borrar', '42501', () => c.query(`DELETE FROM commercial.supplier_agreements WHERE id = $1`, [compras]), 'app_runtime BORRA un acuerdo (se cancela con nota)');
      await sp('cierra', async () => {
        const n = (await c.query(`UPDATE commercial.supplier_agreements
                                     SET status = 'done', closed_at = now(), closed_by = $2, closing_note = 'Pedido enviado con el precio nuevo',
                                         updated_by = 'prueba', updated_at = now()
                                   WHERE id = $1`, [compras, U1])).rowCount;
        if (n === 1) P('app_runtime cierra un acuerdo con UPDATE, quién y nota');
        else F(`cerrar tocó ${n} filas`);
      });
      await sp('rls', async () => {
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [OTRO]);
        const n = (await c.query(`SELECT count(*)::int n FROM commercial.supplier_agreements WHERE meeting_id = $1`, [r1])).rows[0].n;
        if (n === 0) P('RLS: con otro tenant no se ve ningún acuerdo');
        else F(`RLS: otro tenant ve ${n} acuerdos ajenos`);
        await rebota('rls_insert', '42501', () => c.query(`
          INSERT INTO commercial.supplier_agreements (tenant_id, meeting_id, area, description, assigned_to, assigned_by, due_date, created_by)
          VALUES ($1, $2, 'compras', 'x', $3, $3, '2026-12-05', 'prueba')`, [TENANT, r1, U1]),
        'insertar con el tenant de OTRO (WITH CHECK)');
      });
    } else {
      NM(`permisos y RLS de app_runtime: la prueba corrió como ${dest.u} y no pudo hacer SET ROLE app_runtime`);
    }
  } finally {
    await c.query('ROLLBACK');
  }

  console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○ NO MEDIDO\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
