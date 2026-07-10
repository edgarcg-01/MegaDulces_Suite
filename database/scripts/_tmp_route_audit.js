const fs = require('fs');
const src = fs.readFileSync('apps/view/src/app/app.routes.ts', 'utf8');
const lines = src.split('\n');
let ctxStack = []; // track parent path prefixes by brace depth (approx)
let lastPath = null;
const rows = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  const mp = l.match(/path:\s*'([^']*)'/);
  if (mp) lastPath = mp[1];
  const mg = l.match(/permissionGuard\(Permission\.([A-Z_0-9]+)\)/);
  const ma = l.match(/anyPermissionGuard\(([^)]*)\)/);
  if (mg) rows.push({ path: lastPath, perm: mg[1] });
  else if (ma) {
    const perms = [...ma[1].matchAll(/Permission\.([A-Z_0-9]+)/g)].map(x => x[1]);
    rows.push({ path: lastPath, perm: 'ANY(' + perms.join('|') + ')' });
  }
}
// group by perm
const byPerm = {};
for (const r of rows) {
  (byPerm[r.perm] = byPerm[r.perm] || []).push(r.path);
}
const sorted = Object.entries(byPerm).sort((a, b) => b[1].length - a[1].length);
for (const [perm, paths] of sorted) {
  console.log(`${String(paths.length).padStart(2)}  ${perm}`);
  if (paths.length >= 2) for (const p of paths) console.log(`       └ ${p}`);
}
