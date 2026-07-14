# Runbook — Purga de credenciales del historial de git

> **Contexto:** 3 passwords de Postgres de producción (Railway) + el password
> on-prem `superoot` estuvieron hardcodeados y pusheados a `origin/main`
> (`github.com/edgarcg-01/Megadulces-Logistica`). El commit `6eb831d` ya los
> removió del árbol trackeado (HEAD), pero **siguen en el historial**. Este
> runbook los borra del historial. **Destructivo: reescribe SHAs y requiere
> force-push.**

## ⚠️ Antes de empezar (no negociable)

1. **ROTAR los 3 passwords en Railway PRIMERO.** Purgar el historial NO deshace
   la exposición — el secreto ya salió a un repo remoto (asumir comprometido).
   La rotación es lo único que cierra el hueco; la purga es higiene.
   - DB nueva multi-tenant (`trolley.proxy.rlwy.net:39023/railway`)
   - Vector DB (`acela.proxy.rlwy.net:37056/railway`)
   - DB legacy (`switchback.proxy.rlwy.net:16885/railway`)
   Tras rotar: actualizar `.env` local + variables de entorno en Railway + redeploy.
2. **Si el repo es/fue público:** además de rotar, pedir a GitHub Support que
   purgue las vistas cacheadas de los commits viejos (el force-push no borra
   commits ya indexados/forkeados por terceros).
3. **Avisar** a cualquiera con un clon: tras el force-push deberán **re-clonar**
   (su historia local queda divergente e incompatible).

## Procedimiento

### 1. Instalar git-filter-repo
```bash
pip install git-filter-repo    # o: brew install git-filter-repo
git filter-repo --version      # confirmar
```

### 2. Backup completo (mirror)
```bash
cd ..
git clone --mirror Trade_marketing Trade_marketing-backup.git
```

### 3. Reemplazar los secretos en TODO el historial
El archivo de reemplazos con los valores literales está **fuera del repo**
(scratchpad de la sesión), para no re-introducir el secreto en un archivo trackeado:
`…/scratchpad/secrets-to-purge.txt` (formato `SECRETO==>***REMOVED***`).

```bash
cd Trade_marketing
git filter-repo --replace-text "<ruta>/secrets-to-purge.txt"
```
Esto reescribe cada blob del historial reemplazando los passwords por
`***REMOVED-DB-PASSWORD***`. Los archivos scratch (`_verify-rr3.js`, `_kep*.js`,
`_tmp*.js`, `_recover.js`, `check_migrations.js`, `settings.local.json`) quedan
en el historial pero con el secreto redactado.

**Opcional — borrar esos archivos scratch del historial por completo:**
```bash
git filter-repo --invert-paths \
  --path database/_verify-rr3.js --path _recover.js --path database/_recover.js \
  --path check_migrations.js --path _tmp_alma7.js --path _tmp_lt.js \
  --path database/_kep.js --path database/_kep2.js --path .claude/settings.local.json
```

### 4. Re-agregar remoto y force-push
`filter-repo` elimina el remoto por seguridad. Re-agregarlo y empujar:
```bash
git remote add logistica https://github.com/edgarcg-01/Megadulces-Logistica.git
git push logistica --force --all
git push logistica --force --tags
```

### 5. Verificación post-purga
Verificar con cada password (tomar los valores del archivo scratch, NO pegarlos aquí):
```bash
git log --all -S '<PASSWORD_DB_NUEVA>'  --oneline   # → vacío
git log --all -S '<PASSWORD_VECTOR_DB>' --oneline   # → vacío
git log --all -S '<PASSWORD_DB_LEGACY>' --oneline   # → vacío
```

## Pendiente aparte (menor severidad)

El password on-prem `superoot` (LAN `192.168.0.245` y docker local `localhost:5433`)
está como *fallback* de env en ~40 importers legítimos (`process.env.X || '…superoot…'`).
No es internet-facing (LAN + VPN), pero está en el repo. Decisión pendiente:
(a) scrubbear los fallbacks a env puro (cambio grande, ~40 archivos) o
(b) rotar también `superoot` en las DBs on-prem. Ver con Edgar.
