# Modelo de trabajo del equipo (3 devs)

> Cómo se divide la carga, quién es dueño de qué, y las reglas que evitan que 3 personas se pisen.
> Ownership por **dominio vertical** (cada dev dueño de su frontend + backend + DB), aprovechando que
> el código ya está aislado en `libs/*` (los dominios no se importan entre sí, se comunican por puertos).

---

## 1. Reparto de dominios (ownership)

| Persona | Área / dominio | Qué incluye |
|---|---|---|
| **Edgar** (lead) | Plataforma + datos + AI | `libs/platform-core` (auth/RBAC/tenant/DB), **feeds + `kepler_ods`** (frágil, tribal), motores AI (**Thot/Horus/Maat**), arquitectura/ADRs, review de lo sensible (migraciones, seguridad). |
| **David** (`@dev-david24`) | **Ventas / Comercial** | Ver §2 — el dominio comercial completo. |
| **Dev 2** (`@_______`) | *(por asignar)* | Propuesta: **Finanzas + Fiscal** (`libs/finance` + `libs/fiscal`): bancos, Maat, CxP/CxC, conciliación, pólizas, CFDI/SAT. |
| **Dev 3** (`@_______`) | *(por asignar)* | Propuesta: **Logística** (`libs/logistics`): embarques, flota, guías, costos, tracking, carta porte. |

> Ajustá el reparto según la fortaleza de cada dev. Si el equipo es de 3 (Edgar + 2), fusioná Finanzas+Fiscal+Logística en un solo dueño o repartilo entre los dos devs.

## 2. El área de David — Ventas / Comercial (alcance concreto)

**Backend:** `libs/commercial/*` — pedidos (orders), clientes (customers), pricing, productos, inventario comercial, promociones, analytics comercial, **sales-documents (anexo de venta / AX)**, stock, catalog-search, recomendaciones, televenta, portal-ai-order, ticket-extractor.

**Frontend:**
- `apps/view/src/app/modules/comercial/*` (admin comercial)
- `apps/portal/*` (portal B2B del cliente)
- `apps/vendor/*` (app del vendedor en campo)

**DB:** schema `commercial.*` (+ las vistas `analytics.*` que consumen ventas).

**NO es de David** (aunque toque "ventas" de refilón): los **feeds/`kepler_ods`** que alimentan los datos de venta (los mantiene Edgar), y los **motores AI** (Thot). Si David necesita un dato nuevo del ERP, lo coordina con Edgar.

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

---

**Resumen:** dividir por dominio vertical + un sync diario para las zonas compartidas + disciplina de migraciones. El código modular hace el resto. Los problemas conocidos (permisos, sidebar, migraciones concurrentes) se contienen coordinando, no evitando.
