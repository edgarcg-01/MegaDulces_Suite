# Contexto del proyecto Trade Marketing (auto-cargado por Claude Code)

> Este archivo se lee en **cada sesión de cada dev**: cada KB se paga muchas veces. Mantenerlo
> **breve, actualizado, accionable**. Cada regla lleva **una** cifra que la justifica; la historia
> completa de cómo se ganó vive en [`docs/HISTORIA_DE_LAS_REGLAS.md`](docs/HISTORIA_DE_LAS_REGLAS.md).
> ⛔ **No borres ni «simplifiques» la cifra de una regla**: es lo que impide racionalizarla. Si una
> regla y un relato se contradicen, **gana la fecha más nueva** y se corrige acá.

---

## ⛔ Las 20 reglas, en una pantalla

**Nunca, sin autorización explícita:**
1. **Crear un importer.** Todo dato sale del ODS (`kepler_ods.*`), de UNA tabla principal, por VISTA. Si no se puede derivar: **parar y decirlo**.
2. **Copiar una tabla** (`*_bak`, "la misma en otro schema", 2ª materialización). Derivá o extendé la que existe.
3. **Compilar o levantar el backend en local** (`nx serve`, `nx build`, `node dist/...`). Compila **el CI**; se verifica **leyendo prod**.
4. **Invocar Python.** Node/TS/JS, SQL y PowerShell/Bash. Un `python - <<EOF` mal formado **no falla: espera stdin para siempre**.
5. **Borrar tablas, columnas o migraciones aplicadas** en prod.
6. **Hacer push o abrir PR** (Claude; los devs sí empujan a `main`, ver «Modo de trabajo»).
7. **Tocar CORS o credenciales.**
8. **Crear ramas o worktrees.** Se trabaja sobre `main`, en el checkout compartido, **commiteando con pathspec**.
9. **Escrituras pesadas en horario hábil** (un `CREATE MATERIALIZED VIEW` ya sostuvo el candado de migraciones 22 min).

**Siempre, por default:**
10. **Nunca adivinar una fuente de datos** — investigarla, contrastarla contra un hecho independiente y **probar la unidad**.
11. **Lo que no se pudo medir se DECLARA** (`unknown`, `measured:false`, `NO MEDIDO`), **nunca se dibuja como cero ni como verde**.
12. **Un gate sin prueba negativa es una intención**: rompelo a propósito una vez y verificá el rojo.
13. **Un endpoint que ESCRIBE no está probado** hasta que una prueba lo ejerció contra base real, con el payload de la pantalla.
14. **Al agregar una columna `NOT NULL` o cambiar una PK**: recorrer TODOS los caminos que insertan en esa tabla.
15. **Un commit que cambia un número** no cierra sin la medición antes/después. Optimizar va **aparte** de cambiar alcance de negocio.
16. **Un primitivo inventado en una fase no cierra la fase** (ADR-056): va a `libs/` o queda como deuda con nombre.
17. **Migraciones**: se **generan** (`node scripts/nueva-migracion.js`), idempotentes, y en prod **una por una** (`apply-one-migration-prod.js`), nunca `migrate:latest`.
18. **Tablas nuevas**: `tenant_id` UUID NOT NULL + audit fields. Naming snake_case, inglés salvo término de dominio.
19. **Al cerrar un item**: actualizar `01_TRACKER_PROGRESO.md` y `03_LOG_REVISIONES.md` (⬜→🔨→🧪→🚀→✅), y ADR si hubo decisión.
20. **Un módulo no está entregado** hasta que su permiso está **repartido** en prod, no sólo declarado en el enum.

---

## Modo de trabajo

**Equipo de 4 devs** (lead y PM: Edgar). El trabajo se apoya fuerte en **Claude Code**: los `.md` del repo son la memoria compartida entre sesiones y máquinas (la memoria personal de Claude **no** se comparte); mantenerlos al día es **mandatorio** al cerrar cualquier item. Un dev nuevo: [`ONBOARDING.md`](ONBOARDING.md) (§8.0 `npm run hooks:install` es **obligatorio por máquina**) y, para su Claude, [`docs/CLAUDE_ONBOARDING.md`](docs/CLAUDE_ONBOARDING.md).

- ⛔⛔ **Sobre `main`, en el checkout compartido, sin ramas ni worktrees** (Edgar, 2026-10-08 y 10-12). Varias sesiones comparten árbol e índice: **commit SIEMPRE con pathspec** (`git commit -- <rutas>`), nunca `git add -A`, nunca `--amend`. *Cifra: un commit sin pathspec borró 4,887 archivos; un barrido encontró 14 ramas y 4 worktrees muertos, ninguno aportaba nada.* Una rama sólo si el trabajo no puede entrar a medias, contra `main` y se borra al mergear. Lo que creás, lo borrás. ⚠️ Al quitar un worktree: `cmd /c rmdir node_modules` **antes** de `git worktree remove` (al revés ya destruyó el `node_modules` compartido).
- **Los devs empujan a `main`; Claude no empuja sin pedir** (regla 6). La compuerta es el `pre-push` local (sobre *tus* archivos) y después el CI.
- ⭐⭐ **El carril de entrega —PR, pull, push, SOLTAR, migración— vive en la skill [`entrega`](.claude/skills/entrega/SKILL.md)** y se carga **antes** de tocarlo. *Cifra: prod estuvo 23 h sin actualizarse con dos tramos sellados detrás.* Lo esencial: **soltar NO es desplegar**; la mergeabilidad de GitHub es una caché; el `pre-push` lee el árbol y el CI el commit; el único testigo de que algo llegó es **`/api/health`**.
- **Protección de `main`** (medido 2026-10-27): exige `Build & typecheck (affected)` + `Secret scan (gitleaks)`, bloquea force-push y borrado. ⛔ **`enforce_admins: false`**: el admin la saltea. **El PR es el carril del CI, no una revisión** (reviews obligatorios: no). ⛔ **El repo es PÚBLICO**: lo que se escribe en un `.md` (IPs, cifras del negocio) es público, y un runner propio de Actions está prohibido.
- ⭐ **El candado de producción es `ci-green`**: `sellar` lo mueve cuando pasan `build` + `secret-scan`, y `ops/prod/auto-deploy.sh` se niega a desplegar lo que no bendijo. `main` puede ponerse roja; lo rojo no llega a prod. Lógica y candado: `npm run check:compuerta-ci`.
- **Dos reglas se EJECUTAN, no se piden** ([`.claude/settings.json`](.claude/settings.json), código en [`scripts/hooks/`](scripts/hooks/)): `bloquea-python.js` rechaza `python/pip` y dice qué usar (*cifra: 9 procesos colgados quemaban 8.8 de 12 núcleos, ~366 h de CPU*); `verifica-al-cerrar.js` corre las compuertas rápidas al terminar el turno y devuelve el rojo.
- **La profundidad del razonamiento la fija `effortLevel`** en `~/.claude/settings.json` (personal, no versionado): **`medium`** por decisión de Edgar (2026-10-14). Si una sesión «va plana», ese es el dial.
- ⭐ **Una migración se GENERA**: `node scripts/nueva-migracion.js <nombre>`. ⚠️ `npm run migrate:new` **no crea nada: corre `migrate:latest`**. *Cifra: 187 de 1,084 migraciones compartían marca de tiempo.*

---

## Qué es el proyecto

**Suite operativa de Mega Dulces** (distribuidora de dulces en MX, 9 sucursales): nació como app de trade marketing y auditoría de ejecución en PdV, y hoy cubre comercial, compras, almacén, logística, finanzas, contabilidad, RH y un portal B2B, **multi-tenant con RLS**.

- **ERP: Kepler** (un Postgres por sucursal). La suite **lo lee** por el ODS (`kepler_ods.*`) y **no escribe en él** (la escritura Suite→Kepler está apagada). POS: Wincaja. Contabilidad: **ContPAQi** es el sistema de registro (ADR-040; la suite arma el archivo, nunca escribe directo).
- **Stack:** NestJS 11 + Knex + PostgreSQL + Socket.IO · Angular standalone + PrimeNG + Tailwind · Capacitor + Dexie (vendedor offline) · Nx monorepo · **prod en k3s sobre el servidor propio `md`** (ver «Datos del entorno»).
- **Mapas:** código en [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · cómo se conectan los módulos en [`docs/MAPA_DE_MODULOS.md`](docs/MAPA_DE_MODULOS.md) · tablas en [`docs/ARQUITECTURA_DATOS.md`](docs/ARQUITECTURA_DATOS.md) (⚠️ su §1 todavía dibuja Railway como prod).

---

## Reglas críticas, con su evidencia

### ⛔ NO hacer sin autorización explícita
- **⭐ REGLA PRINCIPAL — CERO importers: todo dato sale del ODS, de UNA tabla principal, normalizada, documentada y verificada.** Gana ante cualquier otra consideración («ya hay un script», «es más rápido»). Dataset nuevo = **VISTA `derive-no-copy` sobre `kepler_ods`** (fresca sin mantenimiento, la alimenta `OdsLiveLoop`). Tabla real SOLO para datos propios (HITL, OCR, feedback) o snapshots. `database/importers/**` **no es canónico**: es lo que se está retirando. *Cifra: `analytics.customer_receivables` quedó en prod como tabla vacía porque el importer nunca corrió; el arreglo fue una vista sobre `kepler_ods.kdue`.*
- **NUNCA copiar tablas** (`*_bak`, `*_old`, otro schema, 2ª materialización). Materializar por costo es legítimo; materializar un valor **inventado** no. [`GOTCHAS.md` §32](docs/GOTCHAS.md), caso canónico §29.
- **⛔⛔ NADA de compilar ni levantar el backend en local** (`nx serve`, `nx build`, `node dist/...`). Compila el CI; los datos se verifican **leyendo prod**. *Cifra (2026-10-02): un backend local quedó con 6 conexiones a la base de PRODUCCIÓN, y un `CREATE MATERIALIZED VIEW` local sostuvo el candado de migraciones 22 min y se revirtió entero.* Lo pesado contra prod va fuera de horario hábil y se avisa.
- **No borrar tablas** en prod · **no borrar columnas** sin confirmación · **no borrar migraciones aplicadas** (Knex compara `knex_migrations` con el filesystem → «directory corrupt» → crash loop; vivido).
- **No hacer push ni crear PRs sin pedir** · **no tocar CORS ni credenciales** (diferido 2026-05-26, `[A.0bis.1-3]` BLOCKED).
- **⛔ NADA DE PYTHON**, ni para un script de un solo uso. En su lugar: `Edit`/`Write`, `node -e` sin heredoc, o `Write` al scratchpad + `node <ruta>`. *Cifra: 9 `python.exe -` huérfanos, 8.8 de 12 núcleos, ~366 h de CPU; al matarlos `nx build api` bajó de 2m05s a 1m03s.* [`GOTCHAS.md` §79](docs/GOTCHAS.md).

### ✅ SÍ hacer por default
- **NUNCA adivinar una fuente de datos** (cualquier `cN` de Kepler, columna sin documentar, feed): contrastarla contra un hecho independiente (¿costo? contra lo pagado; ¿precio? contra lo cobrado) y **probar la unidad** (¿1, `bf` o `1/bf`?). Si no alcanza, **declararlo**. Protocolo: [`ERP_KEPLER.md`](docs/ERP_KEPLER.md) §5 regla 0. *Cifra: ADR-051 (3.3 pp de margen falso por mezclar pieza y caja) y CANON.0.1 (costos 32×).*
- **Commits locales** al completar un item del tracker: `feat([A.0mt.1.1]): descripción`.
- **Antes de enviar un PR: el protocolo de [`ONBOARDING.md` §8.0b](ONBOARDING.md)**, punto por punto contra tu diff (cada punto ya costó un incidente). Lo mínimo: contra `main` y nunca apilado · `origin/main` fusionado **y re-probado** · `npm run check:mig-colisiones` al abrir y antes del merge · si cambiás un tipo de `libs/contracts`, recorrer **todos** sus consumidores (vitest no tipa plantillas) · en frontend, `diseno` + `npm run check:pantalla -- <módulo>` **antes y después** · tocar decoradores o firmas inyectadas de Nest = probar `design:paramtypes` o declarar «arranque no verificado» (*#414 tiró la API en prod con el CI en verde*) · una compuerta roja por causa ajena es **NO MEDIDA para tu cambio** · lo que no pudiste ver se declara «sin validación visual».
- **Un primitivo inventado en una fase NO cierra la fase** (ADR-056): vive en `libs/` o queda como deuda con nombre. *Cifra: ocho fases inventaron su propia bandeja de hallazgos; la frescura llegó a 4 de 171 endpoints.*
- **Un commit que cambia un número** no se cierra sin la medición antes/después; si el diff toca un `WHERE` de negocio, no es optimización.
- **Lo que no se pudo medir se DECLARA** (ADR-056): el dato (`status: 'unknown'`), la cobertura (`measured: false`) y los tests (`NO MEDIDO`, no ✔).
- **Un gate sin prueba negativa es una intención**: rompelo una vez y verificá el rojo.
- ⛔⛔ **Un endpoint que ESCRIBE no está probado hasta que una prueba lo ejerció contra una base real, con el payload de la pantalla** — en el CI o un entorno de pruebas, **nunca la laptop apuntando a prod**. *Cifra (2026-10-14): `POST /cortes/:id/contar` daba 500 por una columna `NOT NULL` que sólo uno de los dos caminos de inserción llenaba; `finance.cash_ledger_cut_denominations` llevó 8 días en cero filas y se leyó como «nadie usa el módulo».* **Cero filas por defecto es indistinguible de cero por desuso**: descartar el defecto antes de culpar a la gente. Al agregar `NOT NULL` o cambiar una PK, `grep` de la tabla y recorrer **todos** los caminos que insertan.
- **Pruebas en CI** (re-medido 2026-10-15): 526 `.spec.ts` corren (target `test` inferido por `@nx/vitest`: preguntale a Nx, no al `project.json`); el job `pruebas-db` corre las 348 suites de `database/run-all-tests.js` que sólo piden Postgres, **informativo**; las 65 suites HTTP siguen fuera.
- Tracker y log al cerrar items · ADR en `02_DECISIONES_ARQUITECTURA.md` por decisión técnica relevante · migraciones idempotentes (`hasColumn` antes de `addColumn`) · `Logger` de NestJS, no `console.log` · tablas nuevas con `tenant_id` UUID NOT NULL + audit fields.

### Convenciones técnicas
- Naming snake_case en DB y `role_name`.
- **URLs, query params, DTO fields y columnas nuevas: English snake_case** (`zone_id`, `route_id`, `date_from`, `date_to`, `user_id`). Español sólo para términos de dominio sin traducción limpia (`exhibicion`, `folio`); el legado ES queda como alias.
- TZ del backend: `America/Mexico_City` (helpers en `libs/platform-core/src/lib/date/mx-date.ts`).
- Schemas: `commercial.*`, `analytics.*`, `finance.*`, `fiscal.*`, `logistics.*`, `trade.*`, `identity.*`, `kepler_ods.*`.
- Diffs de `role_permissions` JSONB: `permissions -> 'KEY' IS NULL`, NO el operador `?` (knex no lo escapa).

---

## Sistema de tracking (mantener vivo)

| Archivo | Cuándo actualizar |
|---|---|
| [`01_TRACKER_PROGRESO.md`](docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md) | **CADA vez** que un item cambia estado (⬜→🔨→🧪→🚀→✅) |
| [`02_DECISIONES_ARQUITECTURA.md`](docs/IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md) | Al tomar decisión técnica relevante (crear ADR) |
| [`03_LOG_REVISIONES.md`](docs/IMPLEMENTACION/03_LOG_REVISIONES.md) | Al cerrar un sprint o checkpoint |
| [`AUDITORIA_BASE_INICIAL.md`](docs/IMPLEMENTACION/AUDITORIA_BASE_INICIAL.md) | Si aparece finding nuevo no listado |
| [`/CHANGELOG.md`](CHANGELOG.md) | Al cerrar feature/sprint relevante: una entry por fecha, Added/Changed/Fixed/Internal |

**Estados por item:** ⬜ TODO · 🔨 EN CÓDIGO · 🧪 PROBADO · 🚀 STAGING · ✅ PROD · ⚠️ BLOCKED · ❌ REVERTED

---

## Roadmap — índice de estado

> ⛔⛔ **CÓMO SE ORDENA EL TRABAJO: [`docs/METODO_DE_TRABAJO.md`](docs/METODO_DE_TRABAJO.md)** (Edgar, 2026-10-14). Cuatro capas **C0 dato → C1 dominio → C2 API → C3 UI** y una fase **no sube de capa hasta que la de abajo está verificada**; **máximo 4 fases 🔨 a la vez** (una por dev) y 🧪 **no libera el cupo** —lo libera ✅, ⏸️ o ❌—; **sin métrica medida HOY no se abre la fase**; DoD de 7 puntos. Fase nueva = copiar [`FASES/_PLANTILLA_FASE.md`](docs/IMPLEMENTACION/FASES/_PLANTILLA_FASE.md) **y agregar su fila acá** — sin fila, la fase no existe.
>
> ⛔ **Fase 0 en curso: campaña de aterrizaje — no se abre ninguna fase nueva hasta terminarla** (§7 del método). Lo que la motivó, medido el 2026-10-14: **26 fases abiertas a la vez** para 4 devs, **181 docs de fase contra 48 filas de roadmap**, y un tracker donde el estado más grande no es «hecho» ni «por hacer» sino **«probado y sin aterrizar» (330 🧪) + «bloqueado» (271 ⚠️) = 601 contra 395 en prod**. ⭐ El cuello **no es la calidad del código** —ya hay ~25 compuertas `check:*`, cada una con su prueba negativa `:self`—: es que **se abre más de lo que se cierra**.

> ⛔ **El detalle completo de cada fase vive en [`00_ROADMAP_FASES_DETALLE.md`](docs/IMPLEMENTACION/00_ROADMAP_FASES_DETALLE.md)** — no se repite acá.
> Esta tabla sólo dice **qué fases existen y en qué estado están**. Para trabajar sobre una fase, abrí su plan en [`docs/IMPLEMENTACION/FASES/`](docs/IMPLEMENTACION/FASES/).

> ⭐ **El control de estado lo lleva el PM** en el GitHub Project privado [«Tablero PM»](https://github.com/users/edgarcg-01/projects/2) (una tarjeta por fase: dueño, revisión, motivo de cada cambio). Primera revisión fase por fase: **2026-10-19** (16 🔨 → 5 🔨 + VP 🟡). Si esta tabla y el tablero discrepan, **manda el tablero** y se corrige acá.

🟢 cerrada (beta) · 🚀 en prod · 🧪 en código, probada · 🔨 en curso / diseñada · 🟡 parcial · 🔴 planeada, sin código · ⏸️ en espera · ⚠️ bloqueada (espera a alguien con nombre) · ⬜ TODO

| Fase | Tema | Estado |
|---|---|---|
| **A.-1** | Auditoría base | ⬜ |
| **A.0-multitenant** | Nueva DB multi-tenant | ⬜ |
| **A.0bis** | Plan correctivo audit (post-multitenant) | ⏸️ |
| **A.1-A.7** | Fundaciones (Sentry, Pino, Redis, CI, etc.) | ⏸️ |
| **B** | Core Comercial (built from scratch, no ERP externo) | 🟢 |
| **C** | Sales Intelligence ampliado | 🟢 |
| **D** | Catálogo + Portal B2B + Pedidos | 🟢 |
| **E** | Telemarketing (antes "Remote Manager / Televenta") | 🟢 |
| **F** | WhatsApp Bot conversacional | ⏸️ |
| **G** | Growth (campañas + promociones) | ⏸️ |
| **H** | Fintech (wallet) | ⏸️ |
| **I** | ML credit risk + WS scaling | ⏸️ |
| **J** | Logística (embarques, flotilla, costos) | 🟢 |
| **LT** | Rastreo de flota GPS (MagniTracking) | 🟢 |
| **K** | AI product match en captures (pgvector + Voyage + Haiku) | 🟢 |
| **Horus** | Supervisor AI de ejecución (Trade) | ⏸️ |
| **LM** | Última Milla (entrega a domicilio local en moto) | ⏸️ |
| **VR** | Venta en Ruta (autoventa offline-first, lap/móvil) | ⏸️ |
| **Maat** | AI de Finanzas (conocimiento + chat + patrones) | ⏸️ |
| **RA** | Compras / Reabastecimiento (punto de reorden + existencia crítica + sugerido) | 🟢 |
| **AB** | Autoabasto: Compras decide el traspaso, cada sucursal ve su mesa (ADR-100) | 🔨 |
| **CB** | Conciliación bancaria (interfaz reemplaza el Excel) | 🚀 |
| **CP** | Conector ContPAQi (SoR contable externo) | 🚀 |
| **CC** | Comprobantes de Cobranza (ficha de depósito + OCR) | ⏸️ |
| **LC** | Libro de Compras (el proceso aquí, a ContPAQi solo el TXT) | ⏸️ |
| **RE** | Recepción de Mercancía 360 (digitaliza el Excel de recepción) | 🟢 |
| **CA** | CEDIS (Kepler Access 97) → ODS | 🟢 |
| **WR** | Réplica cruda Wincaja (Access 97 → Postgres, continua) | 🟢 |
| **AX** | Anexo de venta imprimible (detalle + pagaré) | 🟢 |
| **MR** | Motor de Rentabilidad (cascada de margen) | ⚠️ |
| **VP** | Verdad y Procedencia (el número declara con qué se calculó) | ⏸️ |
| **OBS** | Ingesta que no se cae en silencio | 🟢 |
| **CV** | Catálogo, verificador de precios y tienda mayorista (migración de proyecto externo) | 🟢 |
| **VL** | VPS local (sacar la ingesta de la máquina de trabajo) | 🟢 |
| **TP** | Calendario de Pagos | 🟢 |
| **SN** | Suite: navegación por espacios ("Mi trabajo" en `/projects`) | 🧪 |
| **CDRP** | Cuadro de Resultados por Puesto (el tablero directivo, DENTRO de «Mi trabajo») | 🟢 |
| **FLT** | Lista de faltantes (la venta que NO ocurrió) | 🧪 |
| **PU** | Presupuestos (motor de planeación y control) | 🧪 |
| **IC** | Inventario Continuo (3 ritmos) | 🚀 |
| **CE** | Costo estándar de Kepler (el que fija el precio) | 🚀 |
| **PO** | Post-corte del 1-oct-2026 (el `00` dejó de concentrar) | ⏸️ |
| **NP** | Productos nuevos (seguimiento a 30/60/90 días) | 🧪 |
| **PF** | Flujo de venta de cualquier producto (Compras › Catálogo › Productos) | 🧪 |
| **MS** | Mesa de Servicio (tickets de servicio) | ⏸️ |
| **CSU** | Cortes/Sucursales (corte de caja → cobro → ingreso) | 🟢 |
| **CGA** | Caja General: cazar el ingreso/egreso pendiente (ruta detalle, vecinal, proveedores en efectivo) — absorbida por LE el 2026-10-27 | ⏸️ |
| **LE** | Libro de efectivo de partida doble: Caja General + CAOS como un banco (38 reglas B1–B38; reemplaza a CGA) | 🔨 |
| **ECA** | Estado de cuenta de acreedores (por tipo) | 🧪 |
| **RH** | Recursos Humanos: migración de Mega Talento | 🔨 |
| **GP** | Gestión de pedidos en almacén (surtido/checado/embarque sin papel) | 🧪 |
| **VAC** | Acople del verificador de precios al estándar (`/tienda/verificador`) | 🟢 |
| **PGP** | Pago a proveedor de punta a punta (firma → ejecución → `X-D-26` escrito en Kepler) | ⬜ |
| **PQ** | `/compras/pedido`: del sugerido al ERP sin inventar nada (lo aprobado sale, agenda de proveedores, lazo cerrado; M1/M2 medidas) | 🔨 |
| **FC** | Flotilla: costo por unidad — reemplaza la hoja «TRANSPORTES 2026» (anexo FCU; todo con pantalla). 5ª en curso, abierta por el PM el 2026-10-26 | 🔨 |
| **MX** | Movimientos por excepción: el Diario (`/almacen/movimientos`) pasa a reportería y se auditan sólo las diferencias. 6ª en curso, abierta por el PM el 2026-10-28 por encima del cupo de 4 | 🔨 |

---

## Documentación clave

> ⛔ **Los documentos de 40 KB para arriba NO caben en una ventana de contexto.** Abren con un
> **índice navegable** (sección → línea → KB): buscá tu tema ahí y leé sólo ese tramo con
> `sed -n 'DESDE,HASTAp' <archivo>`. Los índices los refresca `npm run docs:indices`;
> `npm run check:docs-indices` se pone rojo si quedaron rancios.
> **Leer un fragmento por grep y dar la regla por cumplida es el modo de fallar acá.**

Tamaños medidos el 2026-10-27.

| Archivo | KB | Para qué |
|---|---:|---|
| [`ONBOARDING.md`](ONBOARDING.md) | 76 | **Empezar acá** — máquina, flujo git, §8.0b protocolo de PR |
| [`docs/ESTANDAR_DE_INTERFACES.md`](docs/ESTANDAR_DE_INTERFACES.md) | 20 | ⭐⭐ **Cuándo una interfaz está BIEN**. Arriba de `DESIGN.md`: si se contradicen, gana éste |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 12 | Mapa de código: apps, dominios (libs), DBs, feeds, servicios externos |
| [`docs/MAPA_DE_MODULOS.md`](docs/MAPA_DE_MODULOS.md) | 30 | Cómo se implementa un módulo y cómo conviven (acople medido entre dominios) |
| [`docs/GLOSSARY.md`](docs/GLOSSARY.md) | 7 | Términos de dominio + nombres internos (Thot/Horus/Maat, Kepler, fases) |
| [`docs/VERDAD_ABSOLUTA.md`](docs/VERDAD_ABSOLUTA.md) | 365 | ⭐⭐ **FUENTE PRINCIPAL DE RAZÓN** (ADR-059): qué arbitra cada número y qué se declara. **Antes de publicar una cifra, leé su sección** |
| [`docs/GOTCHAS.md`](docs/GOTCHAS.md) | 290 | Las trampas ya vividas (RLS, transacciones, migraciones, permisos, dinero, cron). Entrá por el índice |
| [`docs/ERP_KEPLER.md`](docs/ERP_KEPLER.md) | 117 | Decode del ERP Kepler + pipeline `kepler_ods` |
| [`docs/UNIDADES_DE_MEDIDA.md`](docs/UNIDADES_DE_MEDIDA.md) | 64 | Unidades y factores de caja (el catálogo discrepa 73.6 % con el ERP). **Antes de multiplicar dos columnas** |
| [`docs/MATRIZ_ACCESOS.md`](docs/MATRIZ_ACCESOS.md) | 43 | Accesos por puesto, generada desde prod (`npm run docs:matriz-accesos`). **Antes de crear un módulo, y regenerar al cerrarlo** |
| [`docs/ARQUITECTURA_DATOS.md`](docs/ARQUITECTURA_DATOS.md) | 18 | Schemas, tablas, FKs, flujo |
| [`docs/HISTORIA_DE_LAS_REGLAS.md`](docs/HISTORIA_DE_LAS_REGLAS.md) | 37 | La historia completa de cada regla de este archivo (texto íntegro al 2026-10-27) |
| [`docs/IMPLEMENTACION/INDEX.md`](docs/IMPLEMENTACION/INDEX.md) | 11 | Mapa de toda la documentación |
| [`00_ROADMAP_FASES_DETALLE.md`](docs/IMPLEMENTACION/00_ROADMAP_FASES_DETALLE.md) | 229 | Detalle íntegro de las fases. Una fila por fase: `grep -n '\| **XX**'` |
| [`01_TRACKER_PROGRESO.md`](docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md) | **2,072** | Kanban en vivo. ⛔ El más grande del repo: **siempre por índice**, nunca entero |
| [`02_DECISIONES_ARQUITECTURA.md`](docs/IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md) | 441 | **99 ADRs** (hasta ADR-104) |
| [`03_LOG_REVISIONES.md`](docs/IMPLEMENTACION/03_LOG_REVISIONES.md) | 1,170 | Historial de checkpoints |
| [`docs/PLAN_PLATAFORMA_B2B.md`](docs/PLAN_PLATAFORMA_B2B.md) | 28 | Visión completa — sólo al planear features grandes |

---

## Datos del entorno

- **⭐⭐ PRODUCCIÓN = el servidor `md` (`192.168.0.222`), NO Railway — desde el 2026-09-22.** Dominio `megadulcessuite.com`. DB **`pg-prod`, `192.168.0.222:5434`**, base `railway` (⚠️ **mismo nombre** que la vieja: verificá siempre por **`system_identifier`**, nunca por el nombre).
- **⛔⛔ Prod corre en k3s desde el 2026-10-01**, no en Docker Compose ([`ops/k3s/`](ops/k3s/)). Namespaces `prod` e `ingesta`; NodePorts `:30080` suite · `:30081` portal · `:30082` vendedor. Prueba de vida: `curl http://192.168.0.222:30080/api/health`. ⛔ Los **deployments** se llaman `api · caddy · cloudflared · garage · pg-prod · pg-rag · pgvector-md · portal · redis · vendor · worker` (`prod-api`/`prod-caddy` son nombres de **imagen**: `kubectl` da `not found`).
- **⛔ NO «se despliega solo».** `auto-deploy.sh` conserva sus compuertas pero su renglón del `crontab` está comentado; el gatillo es `prod-release` (skill `entrega`). **Confirmá el mecanismo vigente antes de prometer un despliegue.**
- Migraciones en prod: **una por una** con `apply-one-migration-prod.js` (⛔ nunca `migrate:latest`: hay **dos** `knex_migrations`). Runbook: [`ops/prod/RUNBOOK-despliegue.md`](ops/prod/RUNBOOK-despliegue.md).
- ⚠️ **Railway = prod VIEJA y congelada** (sin escrituras desde el 23-sep). El `FLEET_DB_URL` del `.env` local **todavía apunta ahí**: medir contra eso **triunfa en el lugar equivocado** (ya costó una auditoría entera y una migración aplicada al clúster muerto).
- **⭐ La ingesta** corre en `md` (`ssh superoot@192.168.0.222`) desde el 2026-09-11, sin sesión de usuario; ahí vive la fuente (Postgres `:5433` con las réplicas lógicas de las sucursales). En `.249` sólo quedan los 3 carriles de Wincaja y el respaldo. **Qué corre dónde, medido: [`ops/README.md`](ops/README.md).**
- **Desarrollo:** stack Docker local (`npm run dev:up`, `.env.dev.example`). ⛔ `192.168.0.245` ya no se usa. Los smoke tests exigen destino seguro (`assert-safe-target`).
- **Primer tenant:** `mega_dulces`, UUID `00000000-0000-0000-0000-00000000d01c`.
- Pendientes de decidir: WhatsApp BSP (ADR-006) · LLM provider (ADR-007) · partner fintech (ADR-008).

---

## ADRs

Vigentes, con su razonamiento, en [`02_DECISIONES_ARQUITECTURA.md`](docs/IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md). **Leé ahí antes de contradecir una decisión, no de memoria.** Los que gobiernan el día a día: **ADR-010** multi-tenancy (`tenant_id` + RLS) · **ADR-040** integrar, no construir (ContPAQi = SoR contable) · **ADR-056** verdad y procedencia · **ADR-059** la cifra se ARBITRA contra un testigo del mismo ERP y grano · **ADR-054** el permiso es una CLAVE, no una tupla.

---

## Notas de operación con Claude

- **Avanzar sin pausas largas y tomar decisiones razonables.** Las de herramienta, diseño y proceso las toma Claude y las anuncia con su porqué; se pregunta sólo lo que es de Edgar (dinero, personas, prioridades de negocio, acciones irreversibles o hacia afuera).
- **Estilo CONCISO**: confirmación + qué sigue; el tracker registra el detalle. Expandir sólo ante un bug raro o una decisión de arquitectura.
- **Commits:** `feat([A.0mt.1.1]): descripción`, código del tracker entre corchetes.
- **Al cerrar item:** `[x]` + ✅ + fecha · **al cerrar sprint:** entry en `03_LOG_REVISIONES.md` con lecciones · **finding nuevo:** a `AUDITORIA_BASE_INICIAL.md`.

---

## Design System («Mercado», 2 surfaces)

> ⭐⭐⭐ **LA LEY ESTÁ EN [`docs/ESTANDAR_DE_INTERFACES.md`](docs/ESTANDAR_DE_INTERFACES.md)**: cuándo una interfaz está bien, en cinco capas (**veracidad · alcance · comprensión · sencillez · respeto**). Ley 0: **«Nada afirma lo que no es, y todo lo que importa se puede alcanzar.»** `DESIGN.md` y las skills son cómo se cumple con «Mercado»; si se contradicen, **gana el estándar**.

**Dos skills, porque construir y auditar son oficios distintos:** [`diseno`](.claude/skills/diseno/SKILL.md) para **escribir o cambiar** frontend (obligatoria) · [`auditoria-diseno`](.claude/skills/auditoria-diseno/SKILL.md) para **juzgar** una pantalla existente. *Cifra: una auditoría de `/finanzas/caja-general` no vio un libro que publicaba 248 movimientos y pintaba 100 ($1,943,998.57 invisibles): las compuertas verifican PRESENCIA de piezas, no que un rótulo mienta.* Todo instrumento que escribas arranca con un control cuya respuesta ya conocés.

- **Storefront** (`/portal/*`): Fraunces editorial + Hanken Grotesk + Geist Mono. Decoración intencional, ilustraciones SVG, densidad cómoda.
- **Operations** (`/dashboard/*`, `/comercial/*`, `/logistica/*`, `/admin/*`, `/vendor/*`, `/telemarketing/*`): **sin Fraunces ni ilustraciones**. Page-head Hanken Bold. Tabla densa + master-detail. Densidad compact++. Tesis «esto es serio».

Comparten: paleta Stone, sunset acción (`--action`), IA ember (mata morado `#8b5cf6` y azul `#2563EB`), dark **zinc `#111111` en Operations / espresso `#16130F` en Storefront** (mata `#000` puro), escala de radios. Tokens en [`libs/design-tokens/tokens.css`](libs/design-tokens/tokens.css), **archivo único para las 3 apps**. No desviarse sin aprobación. Migración Operations de `tokens.css`: pendiente de aprobación del diff («Plan de migración Operations» en `DESIGN.md`).
