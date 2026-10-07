# Roadmap: de documentación a acceso — onboarding de equipo (1 → 3 devs)

> Objetivo: dejar el proyecto **listo para que 2 devs nuevos entren y produzcan**, surfaciendo el
> conocimiento que hoy vive en la cabeza del lead / la memoria privada de Claude hacia el repo, y
> **filtrando** lo que debe quedar privado (secretos, topología de prod).
>
> Ejecutar en orden: cada etapa es un gate para la siguiente. Marcá `[x]` al cerrar.

**Leyenda de "compartir vs filtrar":** 🟢 va al repo (todos lo ven) · 🔴 queda privado (lead/vault, NUNCA al repo).

---

## ETAPA 0 — Higiene del repo *(antes de compartir nada)*

Hoy el working tree tiene **25 archivos basura sin trackear** (scripts `_diag-*.js`, `.sql` sueltos,
PDFs, `.xlsx`, `c2.txt`, `chunks.txt`, `.playwright-mcp/`). Si un dev clona o el auto-committer barre,
contaminan el repo. Limpiar primero.

- [ ] Revisar los untracked: `git status --porcelain | Select-String '^\?\?'`
- [ ] Mover los `_diag-*.js` útiles a `database/scripts/` o borrarlos; el resto (PDFs, xlsx, txt) fuera del repo.
- [ ] Reforzar `.gitignore` para lo diagnóstico/temporal:
  ```
  **/_diag-*.js
  *.pdf
  *.xlsx
  .playwright-mcp/
  ```
- [ ] Confirmar que `.env` sigue fuera de git (ya verificado ✓) y que ningún `.env*` real está trackeado.

**Done when:** `git status` limpio salvo trabajo intencional; clonar el repo no arrastra basura.

---

## ETAPA 1 — Surfacing de documentación *(sacar el conocimiento tribal al repo)*

Mucho conocimiento crítico vive solo en la **memoria privada de Claude en la máquina del lead** (240
archivos) y en su cabeza. Los devs nuevos arrancan ciegos a eso. Hay que materializar lo esencial al repo.

### 1.1 Ya existe (🟢 verificar que esté actualizado)
- [x] `CLAUDE.md` — contexto, fases, reglas.
- [x] `DESIGN.md` — sistema de diseño.
- [x] `ONBOARDING.md` — setup de cero a correr *(nuevo)*.
- [x] `docs/GOTCHAS.md` — trampas técnicas *(nuevo)*.
- [x] `docs/IMPLEMENTACION/*` — 28 docs (tracker, ADRs, log, specs por fase).

### 1.2 Creado 2026-08-24 (🟢 alto valor para los devs nuevos)
- [x] **`docs/ARCHITECTURE.md`** — mapa del sistema: apps, dominios (libs), DBs, feeds, servicios externos + flujo de request.
- [x] **`docs/ERP_KEPLER.md`** — decode de Kepler (tablas `kdXX`/`cN`, cadena de compras, pipeline `kepler_ods`, reglas anti-desync). Sin credenciales.
- [x] **`docs/GLOSSARY.md`** — términos de dominio + nombres internos (Thot/Horus/Maat, Kepler, fases, schemas).

### 1.3 Filtrar — NO al repo (🔴 privado, va a vault/lead)
- [ ] Topología y credenciales de prod (hosts Railway, `.245`, connection strings reales).
- [ ] Detalle del incidente de seguridad de credenciales.
- [ ] API keys de cualquier proveedor.

**Done when:** un dev nuevo puede entender el sistema y el dominio leyendo solo el repo, sin preguntarte lo básico.

---

## ETAPA 2 — Secretos y seguridad *(antes de dar acceso)*

- [ ] **Rotar las credenciales de prod expuestas** (incidente abierto).
- [ ] **Escanear el historial de git** por secretos (el CI solo escanea commits nuevos):
      correr gitleaks sobre todo el historial; si aparece algo → rotar esas llaves.
- [ ] **Definir el gestor de secretos del equipo** (1Password / Bitwarden / Railway env). El contrato
      público es `.env.example`; los valores reales viven ahí.
- [ ] **Preparar un set de secretos "dev"** (los que necesitan para local: Cloudinary, Anthropic, Voyage…)
      separado de los de prod, para entregar a los devs sin exponer prod.

**Done when:** ninguna credencial viva está en el repo ni en su historial; hay un lugar seguro y acordado para compartirlas.

---

## ETAPA 3 — Configuración del repo *(casi todo hecho)*

- [x] CI (`.github/workflows/ci.yml`) — build 4 apps + lint/test affected + gitleaks.
- [x] PR template (`.github/pull_request_template.md`).
- [x] CODEOWNERS (`.github/CODEOWNERS`) — **pendiente: poner usuarios reales**.
- [x] Branch protection en `main` (PR + 1 review + code owners + 3 checks).
- [ ] `enforce_admins`: hoy **OFF** (para que el lead pushee directo mientras es 1 dev). **Reactivar cuando
      los devs arranquen** para que la regla aplique a todos.
- [ ] **Matar el auto-push a `main`** del entorno del lead (choca con la protección).
- [ ] Verificar que `npm run dev:bootstrap` (docker + migraciones) levanta limpio en una máquina fresca.

**Done when:** el flujo rama→PR→CI→review→merge funciona y `main` está protegida para no-admins.

---

## ETAPA 4 — Provisión de accesos *(cuando tengas los usuarios)*

- [ ] Recolectar los **usuarios de GitHub** de los 2 devs.
- [ ] Invitarlos como colaboradores con rol **Write** (no admin):
  ```powershell
  gh api -X PUT repos/edgarcg-01/Trade_marketing/collaborators/USUARIO -f permission=push
  ```
- [ ] Poner los usuarios reales en `.github/CODEOWNERS` (commit).
- [ ] Entregar los **secretos de dev** por el canal seguro de la Etapa 2.
- [ ] **Decidir el entorno de dev** (ver decisiones abiertas abajo): Docker local vs `.245` compartida.
- [ ] Si necesitan `.245` / prod / feeds → gestionar **VPN / red de oficina**.

**Done when:** cada dev puede clonar, pushear a una rama y abrir un PR.

---

## ETAPA 5 — Validación y handoff

- [ ] **Prueba de clonado fresco**: cloná el repo en una carpeta limpia y seguí `ONBOARDING.md` al pie de la
      letra. Lo que se rompa o falte → arreglar el doc. (Es la mejor prueba de que el onboarding sirve.)
- [ ] **PR de prueba** (rama chica): confirmar que corren los 3 checks y el merge está bloqueado hasta review.
- [ ] **Día 1 con los devs**: cada uno hasta "API + view corriendo"; repaso de `GOTCHAS.md`; repartir
      ownership de módulos; primer ticket chico → PR → tu review.

**Done when:** los 2 devs mergearon su primer PR real bajo el flujo nuevo.

---

## Decisiones abiertas (destraban Etapas 1, 4)

1. **Entorno de dev:** ¿Docker local autocontenido (recomendado, sin red de oficina) o la DB compartida `.245`?
2. **Acceso a prod:** ¿los devs necesitan Railway/DB de prod desde el día 1, o solo local?
3. **Gestor de secretos:** ¿ya usan 1Password/Bitwarden, o lo elegimos?
4. **Alcance de docs 1.2:** ¿los devs tocarán feeds/ERP/finanzas (→ `ERP_KEPLER.md` es necesario) o solo app?

---

## Ruta crítica (lo mínimo para dar acceso sin riesgo)

**Etapa 0 (higiene)** → **Etapa 2 (rotar secretos + escanear historial)** → **Etapa 4 (invitar)**.
El resto (docs 1.2, reactivar enforce_admins, validación) puede correr en paralelo o justo después.
