# Modelo de trabajo del equipo (3 devs)

> Cómo se divide la carga, quién es dueño de qué, y las reglas que evitan que 3 personas se pisen.
> Ownership por **dominio vertical** (cada dev dueño de su frontend + backend + DB), aprovechando que
> el código ya está aislado en `libs/*` (los dominios no se importan entre sí, se comunican por puertos).

---

## 1. Reparto de dominios (ownership)

| Persona | Área / dominio | Qué incluye |
|---|---|---|
| **Edgar** (lead) | Plataforma + datos + AI | `libs/platform-core` (auth/RBAC/tenant/DB), **feeds + `kepler_ods`** (frágil, tribal), motores AI (**Thot/Horus/Maat**), arquitectura/ADRs, review de lo sensible (migraciones, seguridad). |
| **David** (`@dev-david24`) | **Almacén / Inventario** (`/almacen`) | Ver §2 — inventario/almacén completo. |
| **0Sistemas** (`@0SistemasMD`) | **Tienda / POS en vivo** (`/tienda`) | Ver §2 — monitor de tickets, arqueo, etiquetera. |

> **Equipo = Edgar + David + 0Sistemas.** Edgar (lead) carga **todo lo demás** por ahora: Ventas/Comercial, Finanzas, Fiscal, Logística, Compras — además de plataforma/feeds/AI. Esas áreas se reasignan a los devs a medida que agarren ritmo.

## 2. El área de David — Almacén / Inventario (alcance concreto)

**Backend:** los módulos de inventario de `libs/commercial/*` — `commercial-inventory` (stock + state-machine de movimientos), `commercial-movements` (almacén/movimientos), `commercial-warehouses` (almacenes), `commercial-receiving` (recepción), `commercial-stock-reservation` (reservas), `commercial-expiry-reviews` (caducidad) + los módulos de **inventario físico / WMS** (conteo físico, recepción-auditor, bin-locations, investigación/monitoreo/riesgo de inventario).

**Frontend:** `apps/view/src/app/modules/almacen/*` (movimientos, cuadre, recepción, conteos, existencia).

**DB:** `commercial.stock`, `commercial.stock_movements`, `commercial.warehouses` + las tablas de inventario físico/WMS.

**NO es de David:**
- Los **feeds/`kepler_ods`** que alimentan la existencia/costo (los mantiene Edgar) — si David necesita un dato nuevo del ERP o cambiar cómo entra el stock, lo coordina con Edgar.
- **Compras / reabastecimiento** (`/compras`, `libs/commercial-replenishment`) — área vecina pero distinta; definí si es de David o de otro (comparten el concepto de existencia).
- **Ventas** (pedidos/pricing) — de otro dueño; se cruzan en `commercial.stock` (la venta consume stock), así que David coordina cambios de schema de stock con el dueño de ventas.

## 2b. El área de 0Sistemas — Tienda / POS en vivo (alcance concreto)

**Backend:** `apps/api/src/modules/store` — el gateway WebSocket (`store.gateway.ts`), el endpoint de ingest de tickets (`/store/live/ingest`, protegido con `x-store-ingest-key`), y la lógica de tienda en vivo (tickets, arqueo, alertas de ticket grande).

**Frontend:** `apps/view/src/app/modules/tienda/*` — monitor de tickets POS en vivo, **arqueo de caja**, **etiquetera** (impresión de etiquetas de precio).

**DB:** las tablas de `store_live` (tickets en vivo) + arqueo.

**NO es de 0Sistemas:**
- El **poller on-prem de Wincaja** que EMPUJA los tickets al ingest (vive en `database/importers/wincaja/`, on-prem `.249`) — eso es infra de feeds, la mantiene Edgar. 0Sistemas es dueño del **consumidor** (el ingest + el monitor + WS), no del poller que envía.
- El `STORE_INGEST_KEY` (clave compartida máquina-a-máquina) — coordinar con Edgar si cambia.

## 3. Zonas compartidas (acá es donde se van a pisar)

Aunque cada uno tenga su dominio, estos archivos los tocan varios → **coordinar antes de editar**:

| Archivo / zona | Cuándo se toca | Regla |
|---|---|---|
| **Migraciones** (`database/migrations-newdb/`) | tabla/columna nueva | `git pull` de `main` **justo antes** de crear una · timestamp real · **nunca reordenar/borrar aplicadas** · avisar si dos migran el mismo día |
| **Permisos** (`permissions.ts` ×2, `ability.factory.ts`, `authz-tree.ts`, `permission-meta.ts`) | permiso/rol nuevo | son 6 touch-points compartidos → avisar en el sync; PRs chicos |
| **Wiring** (`apps/api/src/composition/*`, `app.module.ts`) | módulo nuevo | idem |
| **Sidebar** (`apps/view/.../layout.component.ts`) | pantalla nueva | cada página agrega su nav item acá → conflicto fácil |
| **Diseño** (`libs/design-tokens/tokens.css`, `DESIGN.md`) | cambios de sistema visual | review del lead |
| **Docs vivos** (`CLAUDE.md`, tracker, CHANGELOG) | al cerrar items | commits chicos y frecuentes |

## 3b. Varias sesiones de Claude en UNA PC (worktrees)

Si corrés **varios agentes de Claude en la misma máquina**, NO los abras en la misma carpeta: comparten
un solo working tree y una sola rama, así que cuando uno hace `checkout`/`pull`/`reset` le borra el trabajo
**sin commitear** al otro (esa es la causa del "relajo" y de los cambios que se revierten). La regla es
**1 agente = 1 worktree = 1 rama = 1 carpeta**.

Herramientas (Windows/PowerShell):

```powershell
.\scripts\nuevo-agente.ps1 almacen   # crea ../tm-almacen con rama feat/almacen (desde origin/main),
                                      # + junction de node_modules + copia de .env. Abrí Claude ahí.
.\scripts\cerrar-agente.ps1 almacen -BorrarRama   # cuando el PR ya mergeó: borra carpeta + rama
git worktree list                     # ver todos los worktrees activos
```

Reglas: cada agente commitea seguido (lo no commiteado es lo único que se pierde), reparte por dominio (§1)
para que dos ramas no toquen los mismos archivos, y las **zonas compartidas** (§3) se coordinan antes de tocar.
Los 2 devs en sus máquinas NO necesitan worktrees (cada clon ya está aislado): les alcanza rama + PR.

## 4. Flujo de trabajo diario

```
1. git checkout main && git pull        # partir de main fresco
2. npm run migrate:new                   # aplicar migraciones nuevas de otros
3. git checkout -b feat/<algo>           # rama por feature (en TU dominio)
4. ...trabajar + nx affected -t lint,test + build verde...
5. push → PR contra main → CI verde + 1 review (CODEOWNERS) → merge
6. actualizar el tracker (01_TRACKER_PROGRESO.md)
```

## 5. Reglas de coordinación (matan el 80% de los conflictos)

1. **Sync corto diario (10 min):** quién toca esta semana las zonas compartidas (§3) — sobre todo **migraciones** y **permisos**.
2. **PRs chicos y frecuentes** > PRs gigantes. Menos superficie de conflicto.
3. **Ownership claro:** lo de tu dominio lo hacés vos; si tocás dominio ajeno, avisás al dueño.
4. **Review:** Edgar revisa migraciones / seguridad / arquitectura; los devs se revisan entre ellos lo de sus dominios.
5. **Migraciones concurrentes = el riesgo #1:** nunca borrar una aplicada (crash-loop "directory corrupt"); pull antes de crear.

## 6. Antes de tocar código — orientar a tu Claude

Cada dev, el día 1: *"Leé `docs/CLAUDE_ONBOARDING.md` y seguí el protocolo."* Y por tarea, el `task → doc map` de ese protocolo dice qué leer (DB→GOTCHAS, permiso→GOTCHAS §4, feeds→ERP_KEPLER, UI→DESIGN).

## 7. Deploy: `main` NO despliega, `production` sí

Railway auto-deploya la rama **`production`**, NO `main`. Así, mergear N PRs a `main` NO
dispara N builds que se pisan (antes cada merge = un deploy, 4 merges seguidos = 4 builds,
varios quedaban FAILED por superados). `main` es integración; `production` es lo que corre en prod.

**Ciclo:**
```
PRs → main (review + CI, CERO deploys)     ← se acumulan los merges del día
.\scripts\deploy-prod.ps1                   ← fast-forward production→main = UN solo deploy
```

`deploy-prod.ps1` muestra qué commits entran y hace `git push origin main:production`.
Railway arranca UN build de `production`. `main` puede tener 5 merges y prod se entera de todos
en un solo deploy, cuando vos decidís soltar.

**Setup en Railway (una vez, en el dashboard):** en cada servicio que sirve código de este repo
(MegaDulces = api+view, Portal_MegaDulces, Vendor_MegaDulces, y worker/feeds-ingest si aplican) →
Settings → Source → **Branch = `production`** (hoy están en `main`). Los servicios de DB no se tocan.

---

**Resumen:** dividir por dominio vertical + un sync diario para las zonas compartidas + disciplina de migraciones. El código modular hace el resto. Los problemas conocidos (permisos, sidebar, migraciones concurrentes) se contienen coordinando, no evitando.
