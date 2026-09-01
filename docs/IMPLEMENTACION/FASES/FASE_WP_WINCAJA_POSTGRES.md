# Fase WP — Wincaja sobre Postgres (retiro de Access/Jet)

> **Estado:** 🔨 DISEÑADO (planeación) · 2026-09-01
> **Disparador:** Edgar — *"la bd de wincaja, en prod se mudará a postgres"*.
> **Tesis:** cuando Wincaja deje de ser Access, **casi todo lo que construimos para leerlo sobra**.
> No es una fase de construir: es una de **borrar**, y de mover Wincaja al mismo patrón que ya
> corre para Kepler. El trabajo real no es el conector nuevo — es el cutover sin romper a nadie.

---

## 0. Qué cambia, en una línea

Hoy: `.mdb` Access 97 → Jet 32-bit → réplica `:5433` → bronze `wincaja.*` → oro `analytics.*`.
Mañana: **Postgres → Postgres**, igual que Kepler.

La consecuencia es que **la mitad de la cadena deja de existir**. Y la parte que hoy más duele
—el pipeline on-prem con una tarea diaria que puede fallar en silencio— es exactamente la que se va.

---

## 1. ⛔ La pregunta que define todo (WP.0)

**Hay dos lecturas de "se muda a Postgres" y llevan a planes distintos. Esto se resuelve antes de
escribir una línea de código.**

| | Lectura A — **el proveedor migra Wincaja** | Lectura B — **promovemos nuestra réplica** |
|---|---|---|
| Qué pasa | La aplicación Wincaja corre sobre Postgres. El `.mdb` deja de existir. | Wincaja sigue en Access; lo que se mueve a prod es la réplica `:5433`. |
| Access/Jet | **Muere** | **Sigue vivo** (el adapter alimenta la réplica) |
| Máquina on-prem | Deja de ser indispensable | Sigue siendo el único punto que lee el `.mdb` |
| Nuestro trabajo | Conector + cutover + **borrar** | Hosting + red + retiro del daily |
| Ganancia | Estructural | Operativa |

**Este documento asume la Lectura A** y marca lo que cambiaría con B. Si es B, la fase se reduce
a WP.5 + WP.6 y el resto queda pendiente para cuando el proveedor migre de verdad.

**Sub-preguntas que WP.0 tiene que contestar, con evidencia y no con supuestos** (misma disciplina
que WR.0 y CA.0, que se pagaron solas):

1. **¿Una instancia o una por sucursal?** Hoy hay un `.mdb` por tienda (30, 32, 00, 10, 40, 44, 54
   + rutas). Si Postgres es **una sola instancia consolidada**, el concepto `source_branch`
   cambia de "archivo" a "columna" y media capa de crosswalk sobra. Si es **una por tienda**, el
   problema de N-orígenes sigue igual y sólo cambia el driver.
2. **¿El esquema es el mismo o lo rediseñaron?** ¿`MovimientoProveedores` sigue llamándose así,
   con las mismas columnas? Una migración de proveedor **casi nunca** es 1:1: suelen normalizar,
   renombrar y cambiar tipos. **Si el esquema cambia, el trabajo no es el conector — es el decode
   otra vez.**
3. **¿Qué versión de Postgres y hay acceso de red desde Railway?** Kepler resolvió esto con
   replicación lógica; si Wincaja queda en la LAN sin exponerse, seguimos necesitando un empujador
   on-prem y la ganancia se achica mucho.
4. **¿Migran el histórico o arrancan en cero?** Tenemos ~13.5M filas en el bronze. Si Wincaja
   arranca vacío, **nosotros somos el archivo histórico** y el bronze pasa de espejo a acervo —
   que es una responsabilidad distinta y hay que decidirla, no heredarla.
5. **¿Fecha de corte y convivencia?** ¿Habrá un periodo con las dos fuentes vivas? Si sí, hay que
   decidir cuál manda **por sucursal y por fecha**, o se cuenta doble.

---

## 2. Lo que ya existe y no se tira

- **`wincaja.branches`** — el crosswalk `source_branch → warehouse_code` + `kepler_code`. Es la
  pieza que traduce el mundo Wincaja al nuestro, y **sobrevive intacta** sea cual sea la fuente.
  23 usos en código de app.
- **La capa derivada**: `v_sales_lines`, `v_sales_daily`, `v_ar_customer`, `v_lost_demand`,
  `mv_branch_kpis`. Son SQL sobre el bronze; **si el bronze conserva su forma, no se tocan**.
- **`mapRow`** de `import-wincaja.js` — el coerce/derive que ya está probado contra las dos
  fuentes (Jet y réplica). Un tercer origen entra por la misma puerta.
- **El patrón Kepler completo**: replicación lógica → `kepler_ods` → vistas vivas en `analytics.*`.
  Está en producción y funciona. **Wincaja debería terminar exactamente igual.**

---

## 3. Lo que muere (y es el punto de la fase)

Esto no es limpieza cosmética: cada línea de acá es una fuente de fallas que hoy pagamos.

| Pieza | Por qué se va |
|---|---|
| `access-adapter.js` + Jet 32-bit + copia-sombra | No hay `.mdb` que leer. Se lleva consigo la restricción de **Node 32-bit**, que hoy amarra la máquina de feeds. |
| Réplica `:5433/wincaja` + 2 carriles PM2 | Existía para convertir Access→Postgres. Si el origen ya es Postgres, **es una copia de una copia**. |
| `WincajaSyncActual` (daily 05:00) | El batch diario deja de tener sentido cuando la fuente es consultable en vivo. |
| Share `Z:\Salidas\Bases\Actuales` | Con él se van los incidentes SMB ya vividos ([[project_incidente_smb_249_wincaja]]). |
| El `--source` de `import-wincaja.js` | Se queda **un** camino, no tres. |

> **La máquina on-prem no desaparece**: sigue haciendo falta para Kepler y ContPAQi. Pero Wincaja
> deja de ser la razón por la que tiene que ser 32-bit.

---

## 4. Arquitectura objetivo

```
Wincaja @ Postgres  ──(replicación lógica, patrón Kepler)──▶  wincaja_ods.*   [crudo, sin tocar]
                                                                    │
                                                                    ▼
                                                   wincaja.*  [bronze: VISTAS, no copias]
                                                                    │
                                                                    ▼
                                        analytics.erp_goods_receipts + v_sales_lines + …
```

**La decisión de fondo: el bronze pasa de TABLA COPIADA a VISTA.** Hoy `wincaja.*` son tablas que
un importer rellena. Con la fuente en Postgres se aplica la regla que el repo ya tiene escrita
—*todo lo derivable sale del ODS*, [[feedback_everything_derivable_from_ods]]— y `wincaja.*` se
vuelve una capa de vistas sobre `wincaja_ods`. Eso **elimina el atraso por construcción**: no hay
importer que se pueda quedar corto, porque no hay importer.

**Excepción declarada:** si el histórico no migra (WP.0.4), las tablas actuales se congelan como
`wincaja.*_historico` y la vista hace `UNION ALL` con el ODS a partir de la fecha de corte. Un
espejo congelado es legítimo cuando es **la única copia** de algo; el antipatrón es congelarlo
cuando la fuente sigue viva ([[project_norm_audit_frozen_mirrors]]).

---

## 5. Sprints

Estados: ⬜ TODO · 🔨 EN CÓDIGO · 🧪 PROBADO · 🚀 STAGING · ✅ PROD

| # | Sprint | Entregable | Estado |
|---|---|---|---|
| **WP.0** | **Descubrimiento** ⛔ ruta crítica | Las 5 respuestas de §1, con evidencia contra la instancia real: `\dt`, conteos por tabla, tipos, PKs, y **un diff de esquema contra el bronze de hoy**. Entregable: mapa `tabla vieja → tabla nueva → columna`, con los renombres marcados. | ⬜ |
| **WP.1** | Conectividad | Acceso desde Railway o decisión de empujador on-prem. Usuario RO dedicado. Si es replicación lógica: publicación + slot, calcado de Kepler. | ⬜ |
| **WP.2** | `wincaja_ods` | Landing cruda 1:1, sin decode. Igual que `kepler_ods`: nada de interpretar acá. | ⬜ |
| **WP.3** | Bronze como vista | `wincaja.*` deja de ser tabla y pasa a vista sobre el ODS (+ `UNION ALL` con el histórico congelado si aplica). **Contrato: mismos nombres de columna**, o los 40+ consumidores se rompen. | ⬜ |
| **WP.4** | Paridad medida | Conteos y Σ de control **vieja vs nueva**, por sucursal y por mes. Mismo rigor que WR.5 y que el cuadre Kepler. Sin esto no hay cutover. | ⬜ |
| **WP.5** | Cutover | Apagar `WincajaSyncActual`, los carriles PM2 y la réplica `:5433`. **En este orden y con vuelta atrás:** primero se apaga la escritura, se observa un día, después se borra. | ⬜ |
| **WP.6** | Retiro de código | Borrar el adapter Jet, `--source`, `replicate-wincaja-live.js`, el ecosystem PM2 y el `Z:`. Actualizar `ARCHITECTURE.md` y `ERP_KEPLER.md`. | ⬜ |
| **WP.7** | Observabilidad | `db-health` source para Wincaja — el hueco que WR.5 dejó diferido y que **ya nos costó** (§7). | ⬜ |

**MVP = WP.0–WP.5.** WP.6 es cosecha; WP.7 debería adelantarse (ver abajo).

---

## 6. Lo que NO cambia y conviene decir

- **Nada de esto arregla el problema de negocio de Morelia.** Al 1-sep hay **401 recepciones sin
  factura por $12.5M**, la más vieja esperando 31 días, con 1 de 402 comprobada. Eso es captura, no
  tubería. Migrar a Postgres hace el dato más fresco; **no hace que alguien suba las facturas.**
- **El decode del negocio sobrevive**: `CR`=compra a crédito, `CC`=contado, `NP`=nota por devolución
  (excluida), `documento`=folio con prefijo, `valor+iva+ieps`=total comparable al `c16` de Kepler.
  Eso es semántica de Wincaja, no de Access — sigue valiendo. Salvo que WP.0.2 diga que el
  proveedor rediseñó el esquema, en cuyo caso **hay que re-verificarlo contra datos, no confiar en
  los nombres** ([[reference_kepler_doctypes_kdmm]], la lección de `c11`).

---

## 7. ⚠️ El hallazgo que motiva adelantar WP.7

**Medido el 2026-09-01, y es la razón por la que esta fase importa más de lo que parece:**

`WincajaSyncActual` corrió a las 05:00, reportó `LastTaskResult = 0`, y **prod se quedó en el
29-ago**. La réplica `:5433` **sí tenía el 31-ago** (w30: 2,431 filas; w32: 170). O sea: la fuente
estaba bien, el destino estaba viejo, y **el sistema reportaba éxito**.

Se destapó porque una persona avisó que no le llegaban las órdenes de entrada — no porque una
alarma sonara. `LastTaskResult = 0` sólo dice que la **tarea arrancó**, no que el script hizo su
trabajo; un `.ps1` que falla adentro puede devolver 0 igual.

**Conclusiones que van al plan:**
1. **WP.7 (observabilidad) no es el último sprint, es prerequisito del cutover.** Cambiar de
   tubería sin frescura vigilada es repetir el mismo agujero con otra tecnología.
2. La métrica correcta no es "¿corrió el feed?" sino **"¿qué tan viejo es el dato más nuevo por
   sucursal?"** — comparado contra su propia cadencia histórica. Abastos mueve 11-16 documentos
   por día hábil: tres días en cero es una alarma, y nadie la tenía puesta.
3. Mientras WP no exista, **hay que arreglar el daily igual**: que propague exit code y que
   verifique post-condición (máx fecha en destino ≥ máx fecha en origen).

---

## 8. Decisiones abiertas

1. **Lectura A o B** (§1) — ⛔ bloquea todo lo demás.
2. **¿El bronze se vuelve vista o sigue siendo copia?** Recomendación: vista (§4). Contra: si la
   instancia Wincaja no aguanta el patrón de consulta de la app, una copia protege a la fuente.
   Se decide con WP.0.3.
3. **¿Quién es el archivo histórico?** Si Wincaja arranca en cero, nosotros — y eso hay que
   aceptarlo explícitamente, con respaldo propio, no por omisión.
4. **¿Se aprovecha para sumar las sucursales que hoy quedan fuera de la réplica** (10/40/44/54 +
   rutas, hoy en Jet — el diferido WR.6.1)? Si el proveedor migra todas, el problema se disuelve
   solo. Si migra sólo algunas, **convivimos con las dos fuentes** y eso es lo peor de los dos
   mundos: hay que ponerle fecha de fin.

---

## 9. Relacionado

- [[project_fase_wr_wincaja_replica]] — la réplica que esta fase retira. Su adapter es compartido
  con Fase CA (CEDIS Access), que **NO** se retira: ese `.mdb` sigue vivo.
- [[project_fase_w_wincaja]] (ADR-031) — el decode original de Wincaja.
- [[project_logical_replication_kepler]] — el patrón a copiar.
- [[feedback_analytics_derive_view_from_ods]] · [[feedback_everything_derivable_from_ods]] — la
  regla que justifica el bronze-como-vista.
- [[project_feed_observability_control]] — `cron_runs` y el guardián que debió haber sonado.
