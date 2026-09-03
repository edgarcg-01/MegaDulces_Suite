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
1.bis **¿Qué pasa con `source_dataset`?** Ver §1.bis — es la pregunta que más código toca (47
   filtros) y la que falla en silencio si se elige mal.
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

## 1.bis El terreno real (medido 2026-09-01) — **son DOS capas, no una**

Confundirlas lleva a planear la fase equivocada. Lo verifiqué en vivo:

| | Espejo crudo (WR) | **Bronze de prod** |
|---|---|---|
| Dónde | `localhost:5433/wincaja` | `trolley…/railway`, schema `wincaja` |
| Qué | **70 tablas** por sucursal, schema por tienda (`w30`, `h10`…) | **28 tablas curadas**, 4.2 GB |
| Dialecto | CamelCase de Access (`ValorVenta`) | **snake_case** (`valor_venta`) |
| Alcance | 8 sucursales | 22 sucursales en `detalles_mov_almacen` |
| Identidad | PK natural + `_dataset` | `(tenant_id, source_branch, source_dataset, <clave natural>)` |

**El bronze ya es una curaduría**: se queda con las 28 que importan de las 70 del `.mdb`. Eso es
una decisión de producto que **sobrevive a la migración** y hay que preservarla explícitamente —
si el bronze se vuelve vista (§4), la vista es la que hace las dos traducciones: **recorte de 70→28
y CamelCase→snake_case**. Es exactamente para lo que sirve una vista; el riesgo es hacerlo por
accidente y perder el recorte.

**Volumen (4.2 GB):** `detalles_mov_almacen` 9.88M filas / 2,202 MB · `precios` 2.24M / 639 MB ·
`maestro_mov_almacen` 1.49M / 447 MB · `pagos_dia` 777k / 256 MB · `movimiento_clientes` 637k /
273 MB · `articulos` y `existencias` 383k c/u.

### ⚠️ `source_dataset` es la pieza que puede romper la migración

La identidad incluye `source_dataset` (`actual` / `concentrada` / `2025`), y **existe por una razón
que desaparece con Postgres**: los datasets son *archivos distintos* del mismo Access — una foto
"actual", una "concentrada" y una por año. Conviven en la misma tabla sin pisarse porque el
dataset es parte de la llave.

Cuando la fuente sea una base viva, **ese concepto deja de tener sentido para lo nuevo**, pero las
~13M filas históricas siguen cargando sus tres valores. Entonces: *¿con qué `source_dataset` nacen
las filas nuevas?* Las opciones no son equivalentes —
`actual` (y el histórico queda como estratos muertos) · un valor nuevo tipo `live` (y todo
consumidor que filtre `= 'actual'` deja de ver lo nuevo, **en silencio**) · o retirar la columna
(y romper la PK de 28 tablas). **Esto se decide en WP.0, no en el cutover.**

> **Medido:** `source_dataset` aparece **154 veces** en el código (libs/apps/database), de las
> cuales **29 filtran por `'actual'`**, más **18 en migraciones SQL** (vistas). Cualquiera de los
> tres caminos las toca; el peligro es el segundo, porque **no falla** — simplemente deja de traer
> filas, en 47 lugares a la vez.

### El hueco de observabilidad tiene número

**No hay índice sobre `imported_at` en ninguna tabla de `wincaja.*`** (verificado). Costo real de
medir frescura hoy:

| | |
|---|---|
| `max(imported_at)` en `detalles_mov_almacen` | **22.0 s** |
| en `movimiento_proveedores` | 200 ms |

Un monitor que tarda 22 segundos por corrida es un monitor que alguien apaga. Esto explica —
mecánicamente— por qué el hueco del 29→31 de agosto lo reportó una persona y no una alarma.
**Arreglo inmediato, independiente de toda la fase:** índice sobre `(source_branch, imported_at)`
en las tablas que se vigilan.

**Frescura medida (16:17 MX):** las tres sucursales del carril vivo cargan a las ~05:00 y el
último movimiento es del día anterior → **~11.2 h de atraso estructural**, que es el batch diario
haciendo lo que un batch diario hace. Con la fuente en Postgres ese número debería ser minutos.

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
