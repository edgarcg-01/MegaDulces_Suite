#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[DEV.9]` Desarrolladores › Proyectos — smoke HTTP contra la API corriendo (ADR-044).
 *
 * Lo que un unitario NO puede ver y esto sí: RLS forzado de `devtools.*`, el folio atómico, los
 * CHECKs de la base, la subida real al bucket y la URL prefirmada que se puede abrir.
 *
 *   API_URL=http://localhost:3334/api node database/tests/test-newdb-dev-projects.js
 *
 * Deja lo que crea DADO DE BAJA (deleted_at), no lo borra: la baja lógica es lo que se prueba.
 */
'use strict';

const API = process.env.API_URL || 'http://localhost:3334/api';
const USER = process.env.SMOKE_USER || 'superoot';
const PASS = process.env.SMOKE_PASS || 'superoot';

let ok = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { ok += 1; console.log(`  ✓ ${msg}`); } else { fail += 1; console.log(`  ✗ ${msg}`); }
};

async function call(method, path, token, body, isForm = false) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${API}${path}`, { method, headers, body: isForm ? body : body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* no JSON */ }
  return { status: r.status, json, text };
}

(async () => {
  console.log(`\n[DEV.9] Proyectos de desarrollo — ${API}`);
  const login = await fetch(`${API}/auth-mt/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS, tenant_slug: 'mega_dulces' }),
  });
  const lj = await login.json().catch(() => ({}));
  const token = lj.access_token || lj.accessToken || lj.token;
  check(!!token, `login ${USER} (${login.status})`);
  if (!token) process.exit(1);

  console.log('\n[1] Equipo');
  const team = await call('GET', '/dev/projects/team', token);
  check(team.status === 200, `GET /team → ${team.status}`);
  const names = (team.json || []).map((t) => t.display_name);
  console.log(`     ${names.join(' · ')}`);
  check(names.length === 3, `el equipo trae a las 3 personas (trae ${names.length})`);
  const member = (team.json || [])[0];

  console.log('\n[2] Alta');
  const title = `Smoke DEV ${Date.now()}`;
  const c = await call('POST', '/dev/projects', token, {
    title, objective: 'Línea 1\nLínea 2', priority: 'alta', assignee_user_id: member?.user_id, due_date: '2026-10-31',
  });
  check(c.status === 201, `POST → ${c.status} ${c.status !== 201 ? c.text.slice(0, 200) : ''}`);
  const p = c.json || {};
  check(/^DEV-\d{4}-\d{4,}$/.test(p.folio || ''), `folio con formato: ${p.folio}`);
  check(p.assignee_name === member?.display_name, `responsable: ${p.assignee_name}`);
  check(p.objective === 'Línea 1\nLínea 2', 'el objetivo conserva los saltos de línea');
  check(p.due_date === '2026-10-31', `fecha compromiso sin corrimiento de zona horaria: ${p.due_date}`);

  const c2 = await call('POST', '/dev/projects', token, { title: `${title} (2)` });
  const n1 = Number(String(p.folio).split('-')[2]);
  const n2 = Number(String(c2.json?.folio).split('-')[2]);
  check(n2 === n1 + 1, `el folio es consecutivo (${p.folio} → ${c2.json?.folio})`);

  console.log('\n[3] Compuertas (negativas)');
  const sinNombre = await call('POST', '/dev/projects', token, { title: '   ' });
  check(sinNombre.status === 400, `⛔ alta sin nombre → ${sinNombre.status}`);
  const ajeno = await call('POST', '/dev/projects', token, { title: 'x', assignee_user_id: '00000000-0000-4000-8000-000000000000' });
  check(ajeno.status === 400 && /equipo/.test(ajeno.text), `⛔ responsable fuera del equipo → ${ajeno.status}`);
  const badStatus = await call('PATCH', `/dev/projects/${p.id}`, token, { status: 'hecho' });
  check(badStatus.status === 400, `⛔ estado inventado → ${badStatus.status}`);
  const sinToken = await fetch(`${API}/dev/projects`);
  check(sinToken.status === 401, `⛔ sin sesión → ${sinToken.status}`);

  console.log('\n[4] Edición');
  const u = await call('PATCH', `/dev/projects/${p.id}`, token, { status: 'en_progreso', assignee_user_id: null });
  check(u.status === 200 && u.json.status === 'en_progreso' && u.json.assignee_user_id === null, `PATCH → ${u.status} (${u.json?.status}, sin responsable)`);
  check(u.json?.title === title, 'lo que no se mandó no se tocó');

  console.log('\n[5] Adjuntos (bucket real)');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('source', 'camara');
  fd.append('file', new Blob([png], { type: 'image/png' }), 'Fotografía pizarrón.png');
  const up = await call('POST', `/dev/projects/${p.id}/attachments`, token, fd, true);
  check(up.status === 201, `subir foto → ${up.status} ${up.status !== 201 ? up.text.slice(0, 200) : ''}`);
  check(up.json?.kind === 'imagen' && up.json?.source === 'camara', `tipo/origen: ${up.json?.kind}/${up.json?.source}`);
  check(up.json?.file_name === 'Fotografía pizarrón.png', `el nombre conserva acentos: ${up.json?.file_name}`);
  if (up.json?.url) {
    const dl = await fetch(up.json.url);
    const bytes = Buffer.from(await dl.arrayBuffer());
    check(dl.status === 200 && bytes.equals(png), `la URL firmada devuelve el MISMO archivo (${dl.status}, ${bytes.length} B)`);
  } else check(false, 'la subida devolvió URL firmada');

  const vfd = new FormData();
  vfd.append('source', 'grabacion');
  vfd.append('file', new Blob([Buffer.alloc(2048, 1)], { type: 'video/webm' }), 'video.webm');
  const upv = await call('POST', `/dev/projects/${p.id}/attachments`, token, vfd, true);
  check(upv.status === 201 && upv.json?.kind === 'video', `subir video → ${upv.status} (${upv.json?.kind})`);

  const bad = new FormData();
  bad.append('source', 'drone');
  bad.append('file', new Blob([Buffer.from('x')], { type: 'text/plain' }), 'x.txt');
  const upb = await call('POST', `/dev/projects/${p.id}/attachments`, token, bad, true);
  check(upb.status === 400, `⛔ origen inventado → ${upb.status}`);

  const d = await call('GET', `/dev/projects/${p.id}`, token);
  check(d.json?.attachments?.length === 2 && d.json?.attachments_count === 2, `detalle trae 2 adjuntos (${d.json?.attachments?.length})`);
  const rm = await call('DELETE', `/dev/projects/${p.id}/attachments/${up.json?.id}`, token);
  const d2 = await call('GET', `/dev/projects/${p.id}`, token);
  check(rm.status === 200 && d2.json?.attachments?.length === 1, 'quitar adjunto deja 1');

  console.log('\n[6] Seguimiento (DEV.10): notas, modificaciones y rastro de cambios');
  const fin = await call('PATCH', `/dev/projects/${p.id}`, token, { status: 'terminado', assignee_user_id: member?.user_id });
  const rastro = (fin.json?.notes || []).find((n) => n.kind === 'cambio');
  check(fin.status === 200 && !!rastro, `editar deja un registro automático (${rastro?.body || 'ninguno'})`);
  check(/Estado: En progreso → Terminado/.test(rastro?.body || ''), 'el registro dice de qué a qué cambió el estado');
  const mismo = await call('PATCH', `/dev/projects/${p.id}`, token, { status: 'terminado' });
  check(mismo.json?.notes?.filter((n) => n.kind === 'cambio').length === (fin.json?.notes || []).filter((n) => n.kind === 'cambio').length,
    '⛔ reenviar el mismo valor NO agrega otro registro');
  const mod = await call('POST', `/dev/projects/${p.id}/notes`, token, { kind: 'modificacion', body: 'Falta exportar a Excel' });
  check(mod.status === 201 && mod.json?.kind === 'modificacion', `modificación sobre un proyecto TERMINADO → ${mod.status}`);
  const nfd = new FormData();
  nfd.append('source', 'archivo');
  nfd.append('note_id', mod.json?.id);
  nfd.append('file', new Blob([Buffer.from('detalle')], { type: 'text/plain' }), 'detalle.txt');
  const nup = await call('POST', `/dev/projects/${p.id}/attachments`, token, nfd, true);
  check(nup.status === 201 && nup.json?.note_id === mod.json?.id, `adjunto colgado de la modificación → ${nup.status}`);
  const conNotas = await call('GET', `/dev/projects/${p.id}`, token);
  const enNota = (conNotas.json?.notes || []).find((n) => n.id === mod.json?.id);
  check(enNota?.attachments?.length === 1, 'el adjunto aparece DENTRO de la modificación');
  check(!(conNotas.json?.attachments || []).some((a) => a.id === nup.json?.id), 'y NO en la evidencia del proyecto');
  check(conNotas.json?.notes_count === 1, `notes_count cuenta sólo lo escrito por personas (${conNotas.json?.notes_count})`);
  const cfd = new FormData();
  cfd.append('note_id', rastro?.id);
  cfd.append('file', new Blob([Buffer.from('x')], { type: 'text/plain' }), 'x.txt');
  const cup = await call('POST', `/dev/projects/${p.id}/attachments`, token, cfd, true);
  check(cup.status === 400, `⛔ adjuntar al registro automático → ${cup.status}`);
  const delRastro = await call('DELETE', `/dev/projects/${p.id}/notes/${rastro?.id}`, token);
  check(delRastro.status === 400, `⛔ borrar el registro automático → ${delRastro.status}`);
  const fakeKind = await call('POST', `/dev/projects/${p.id}/notes`, token, { kind: 'cambio', body: 'inventado' });
  check(fakeKind.status === 400, `⛔ una persona escribiendo un «cambio» → ${fakeKind.status}`);
  const vacia = await call('POST', `/dev/projects/${p.id}/notes`, token, { body: '  ' });
  check(vacia.status === 400, `⛔ nota vacía → ${vacia.status}`);
  const delMod = await call('DELETE', `/dev/projects/${p.id}/notes/${mod.json?.id}`, token);
  const sinMod = await call('GET', `/dev/projects/${p.id}`, token);
  check(delMod.status === 200 && !(sinMod.json?.notes || []).some((n) => n.id === mod.json?.id), 'quitar la modificación la saca del seguimiento');

  console.log('\n[7] Lista y baja lógica');
  const l = await call('GET', `/dev/projects?search=${encodeURIComponent(title)}`, token);
  check((l.json || []).some((x) => x.id === p.id), 'la búsqueda lo encuentra');
  const del = await call('DELETE', `/dev/projects/${p.id}`, token);
  await call('DELETE', `/dev/projects/${c2.json?.id}`, token);
  const l2 = await call('GET', `/dev/projects?search=${encodeURIComponent(title)}`, token);
  check(del.status === 200 && !(l2.json || []).some((x) => x.id === p.id), 'dado de baja ya no aparece en la lista');
  const gone = await call('GET', `/dev/projects/${p.id}`, token);
  check(gone.status === 404, `detalle de un proyecto dado de baja → ${gone.status}`);

  console.log(`\n${fail ? '❌' : '✅'} DEV proyectos: ${ok} ok, ${fail} fallos\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
