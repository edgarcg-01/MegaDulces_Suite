# Runbook — Encender la escritura de requisiciones a Kepler (Fase KR)

> **Qué enciende:** que aprobar una requisición en `/compras/requisiciones` cree su documento en
> Kepler — `X-A-30` Requisición para la compra, `U-D-40` Pedido para el traspaso.
> **ADR:** [`ADR-092`](../02_DECISIONES_ARQUITECTURA.md) · **Plan:** [`FASE_KR`](../FASES/FASE_KR_REQUISICION_A_KEPLER.md)
>
> ⛔ **Hoy NO escribe nada, y eso es correcto.** Hay tres candados independientes y los tres están
> puestos. Este runbook los abre **en orden**, y cada paso se verifica antes del siguiente.

---

## 0. Antes de empezar: qué ya está hecho

| | |
|---|---|
| Migración `20261013140000` (idempotencia) | ✅ **aplicada a prod** el 2026-10-13 |
| Rol `kepler_push` en `.9.95` | ✅ existe, 2 de 360 tablas escribibles |
| Código (puerto, adapter, servicio, endpoint, pantalla) | ✅ en el repo · ⛔ **sin empujar a `main`** |
| Línea de `pg_hba` para `192.168.0.222` (donde corre prod) | ⛔ **falta** |
| `KEPLER_PUSH_URL` en el entorno de prod | ⛔ **falta** |
| Plantillas elegidas | ⛔ **falta la del traspaso** |

⚠️ **El código NO está empujado.** `main` local arrastra commits de otras fases, así que el push
necesita autorización aparte — ver §4.

---

## 1. Base de datos en `192.168.9.95` (como `sa` o superusuario)

### 1.1 El permiso que falta

El adapter lee `md.pv_suc_ip` para traducir la sucursal destino a su pseudo-cliente `TI###`.
Sin esto, **todo traspaso rebota** con *"pv_suc_ip no tiene el TI### de la sucursal"*.

```sql
GRANT SELECT ON md.pv_suc_ip TO kepler_push;
```

### 1.2 El privilegio que sobra

Quedó de cuando se creía que `md.kdfolio` era el contador de folios de compras. Se midió y no lo
es: sólo lleva prefijos del punto de venta.

```sql
REVOKE UPDATE ON md.kdfolio FROM kepler_push;
```

### 1.3 Verificación

```sql
SELECT count(*) FILTER (WHERE has_table_privilege('kepler_push', c.oid, 'INSERT')) AS escribe,
       count(*) FILTER (WHERE has_table_privilege('kepler_push', c.oid, 'SELECT')) AS lee,
       count(*) FILTER (WHERE has_table_privilege('kepler_push', c.oid, 'UPDATE')
                           OR has_table_privilege('kepler_push', c.oid, 'DELETE')) AS modifica,
       count(*) AS total
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'md' AND c.relkind IN ('r','p');
```

**Esperado: `escribe=2 · lee=4 · modifica=0 · total=360`.**

⭐ `modifica=0` es el que importa: el rol puede **agregar** documentos, nunca modificar ni borrar
los que ya existen. Un error nuestro puede ensuciar; no puede destruir.

### 1.4 El interruptor: `pg_hba.conf`

⛔ **Éste es el candado que yo usaría como llave maestra**, no el `GRANT`: es más visible y más
fácil de cerrar.

```
host  md_00  kepler_push  192.168.0.222/32  scram-sha-256
```

`192.168.0.222` es `md`, donde corre prod. Hoy sólo existe la línea de `.243` (la máquina de
trabajo), así que **aunque todo lo demás estuviera prendido, el API de prod no podría conectarse**.

Después, sin reiniciar nada:
```sql
SELECT pg_reload_conf();
```

---

## 2. Elegir las plantillas

El adapter **clona un documento que el ERP ya aceptó** y pisa sólo los campos de negocio: las 200
columnas de `kdm1` son `NOT NULL` y no se pueden inventar.

| tipo | variable | valor | por qué ése |
|---|---|---|---|
| Compra | `KEPLER_REQ_TEMPLATE_FOLIO` | `0000424` | 103 renglones, documento real y completo |
| Traspaso | `KEPLER_PED_TEMPLATE_FOLIO` | **`0000450`** | `AUTORIZADO`, `c43='N'`, 4 renglones, responsables vacíos |

⛔ **La del traspaso no tiene default a propósito**: sin ella el adapter rechaza. Clonar un
`U-D-40` ya procesado arrastra `c100`/`c102`/`c103` —quién surtió, checó y embarcó— y pare un
pedido que nace diciendo que ya lo trabajó alguien. El adapter igual los limpia, pero el default
vacío obliga a mirar cuál se eligió.

⚠️ Sólo había **dos** candidatos sanos en `md_00` (`0000450` y `0000345`). Si alguien da de baja
el elegido, el empuje de traspasos deja de funcionar y lo dice con todas sus letras.

---

## 3. Variables de entorno en prod

```bash
KEPLER_PUSH_URL=postgresql://kepler_push:<LA CONTRASEÑA>@192.168.9.95:5432/md_00
KEPLER_REQ_TEMPLATE_FOLIO=0000424
KEPLER_PED_TEMPLATE_FOLIO=0000450
```

Sin `KEPLER_PUSH_URL` el adapter **ni abre conexión** y el endpoint contesta que no está
habilitado — que es un estado legítimo y visible, no una falla.

---

## 4. Desplegar el código

⛔ **Pendiente de autorización.** Lo que hay que empujar:

```
libs/contracts/src/ports/kepler-requisition-sink.port.ts   (+ export en index.ts)
libs/commercial/src/lib/commercial-replenishment/
    kepler-doctipo.ts · kepler-unidad.ts · kepler-unidad.spec.ts
    kepler-requisition-sink.adapter.ts
    commercial-replenishment.{service,controller,module}.ts
apps/view/src/app/modules/compras/
    compras.service.ts · pages/compras-requisicion-detalle.component.ts
database/migrations-newdb/20261013140000_requisicion_push_kepler.js   (ya aplicada)
docs/...   (ADR-092, FASE_KR, ERP_KEPLER corregido, este runbook)
```

⚠️ `main` local arrastra commits de otras fases. Commitear con **pathspec explícito**
(`git commit -- <rutas>`), nunca `git commit -a`.

Prod se despliega solo: `origin/main` → `auto-deploy.sh` cada 5 min → 4 compuertas con reversión
automática. Ver [`ops/prod/RUNBOOK-despliegue.md`](../../../ops/prod/RUNBOOK-despliegue.md).

---

## 5. Verificación, en este orden

**5.1 — Que el endpoint exista y esté apagado.** Con `KEPLER_PUSH_URL` todavía sin poner,
`POST /commercial/replenishment/requisitions/:id/push-kepler` debe contestar *"no está
habilitada en este despliegue"*. Si contesta otra cosa, el binding quedó mal.

**5.2 — Que conecte.** Ya con la variable y la línea de `pg_hba`, aprobar una requisición de
**compra** de pocos renglones. La ficha tiene que mostrar *"En Kepler como requisición
00/NNNNNNN"*.

**5.3 — Abrirla en Kepler** (Compras → Requisición de compra → Consulta) y comprobar renglones,
proveedor, totales y estado `N`.

**5.4 — ⛔ Intentar darla de BAJA desde la UI.** Es el paso que falta resolver (§7) y el que
decide si esto puede operar.

**5.5 — Un traspaso**, y verificar que el destino `TI###` sea el correcto: `02` La Piedad debe
salir como `TI008`, no `TI002`.

**5.6 — Que llegó al ODS.** `.9.95` publica replicación lógica, así que el documento debe
aparecer solo en `kepler_ods.kdm1` en segundos.

---

## 6. Apagarlo

En orden de rapidez:

1. **Quitar `KEPLER_PUSH_URL`** del entorno y reiniciar — el endpoint vuelve a *"no habilitado"*.
2. **Comentar la línea de `pg_hba`** + `SELECT pg_reload_conf();` — corta desde la red.
3. **`REVOKE INSERT ON md.kdm1, md.kdm2 FROM kepler_push;`** — el candado de la base, el que no
   depende de que nadie recuerde nada.

Los tres son independientes: con **uno solo** ya no escribe.

---

## 7. ⛔ Lo que NO está resuelto

**Kepler se negó a dar de baja los documentos que escribimos** (2026-10-13), mencionando
*"documento referenciado"*. Tres hipótesis medidas y **las tres refutadas**: las columnas de
etapa del renglón están en cero en los 17,810 renglones, el puntero al padre está vacío en las
3,110 requisiciones, y **no existe ninguna columna** que aparezca sólo en las ya convertidas a
orden de compra. Los datos de nuestros clones eran indistinguibles de una requisición legítima.

Queda la sospecha de que *"Documento referenciado"* sea una **etiqueta del panel** y no el
mensaje de error. **Se contesta en treinta segundos:** intentar la Baja de una requisición
normal, capturada por una persona, y ver si se deja. Si tampoco se deja, el problema nunca fue
nuestro.

⭐ **Criterio de aceptación: un documento que no se puede cancelar es peor que uno que no se
puede crear.** Yo resolvería esto **antes** del paso 1.

**Y sigue abierto** qué es el `74,439` de `md.kdfolio` fila `PD-`, cuando el folio máximo real de
`U-D-40` es `0001081`. La secuencia observada es densa desde 1 y `MAX+1` reproduce lo que el ERP
hace, pero nadie sabe para qué sirve ese contador.

---

## 8. ⭐ `[KR.11]` Encender cada servidor de Kepler (2026-10-23)

### 8.1 Por qué una conexión no alcanza

Medido en `kepler_ods.kdm1` el 2026-10-23: los `X-A-30` y `U-D-40` de cada sucursal viven **en su
propio servidor** (`sucursal = c1` en los nueve). `md_00` sólo guarda los de oficinas. La versión
anterior del adapter tenía una sola conexión a `md_00` y escribía ahí `c1 = sucursal`: una
requisición de `02` habría quedado en un ERP que La Piedad no mira. No pasaba sólo porque la
plantilla `02/1/0000424` no existe en `md_00` y el adapter rechazaba.

Desde KR.11 el adapter abre **un pool por servidor**, con estas reglas (prueba en
`kepler-servidores.spec.ts`, rota a propósito y vista en rojo):

| variable | qué hace |
|---|---|
| `KEPLER_PUSH_URL_NN` | conexión del servidor `NN` |
| `KEPLER_PUSH_URL` | sólo para `00`, compatibilidad con §3. ⛔ **No es comodín** |
| `KEPLER_REQ_TEMPLATE_FOLIO_NN` / `_SERIE_NN` | plantilla de compra en ese servidor |
| `KEPLER_PED_TEMPLATE_FOLIO_NN` / `_SERIE_NN` | plantilla de traspaso en ese servidor, **sin default** |

Un servidor sin su variable queda **apagado** y la requisición lo dice en `kepler_error`.

### 8.2 Lo que espera salir, por servidor (prod, 2026-10-23)

Requisiciones `approved` sin `kepler_folio`. El traspaso se crea en el servidor de **origen**.

| servidor | host | compras | importe | traspasos | importe |
|---|---|---:|---:|---:|---:|
| `00` | `192.168.9.95:5432/md_00` | 31 | $5,131,936 | 371 | $10,916,246 |
| `01` | `192.168.10.10:1977/md_01` | 9 | $222,935 | 135 | $952,281 |
| `02` | `192.168.42.42:5432/md_02` | 3 | $19,975 | — | — |
| `03` | `192.168.40.40:5432/md_03` | 3 | $5,557 | — | — |
| `04` | `192.168.44.44:5432/md_04` | 3 | $9,333 | — | — |
| `05` | `192.168.54.54:5432/md_05` | 3 | $24,092 | — | — |
| `06` | `192.168.50.50:1977/md_06` | 4 | $52,638 | 29 | $201,692 |
| `07` | `192.168.32.32:1977/md_07` | 7 | $88,691 | — | — |
| `08` | `192.168.30.30:1977/md_08` (Morelia Abastos; de `database/importers/lib/kepler-branches.js`) | 15 | $681,880 | 67 | $742,583 |

⚠️ Encender **no** empuja este rezago: sólo `approve()` empuja, y el lote no (§7 c de FASE_KR).
Las ya aprobadas salen con el botón de reintento de la ficha, una por una.

### 8.3 Plantillas candidatas (de `kepler_ods`, sólo lectura)

Criterio: compra = `X-A-30` del propio servidor con más renglones en 400 días; traspaso =
`U-D-40` en `AUTORIZADO`, `c43='N'`, `c27='SUCURSAL'`, responsables vacíos. **Control:** el mismo
criterio devuelve en `00` exactamente las plantillas ya elegidas a mano (`0000424`, `0000450`).

| servidor | compra | renglones | traspaso | renglones |
|---|---|---:|---|---:|
| `00` | `0000424` | 103 | `0000450` | 4 |
| `01` | `0000092` | 48 | ⛔ ninguna sana: `0003384` pasó a EMBARCADO el mismo día; todo AUTORIZADO se procesa en <3 días | — |
| `02` | `0000101` | 286 | `0002124` | 1 |
| `03` | `0000158` | 262 | `0000002` | 1 |
| `04` | `0000059` | 154 | ninguna sana | — |
| `05` | `0000007` | 49 | ⛔ ninguna sana: la reciente puede procesarse y las antiguas van a clientes, no a `TI###` | — |
| `06` | `0000001` | 10 | `0000895` (22-sep, sin procesar) | 4 |
| `07` | `0000035` | 59 | ninguna sana | — |
| `08` | `0000005` | 53 | `0000028` | 44 |

⚠️ Un pedido `AUTORIZADO` de hoy todavía se va a surtir. Si alguien lo da de baja, ese servidor
deja de poder escribir traspasos y lo dice. Antes de fijarlas, **abrir cada una en Kepler**.

### 8.4 Por cada servidor, en este orden

Como superusuario de ese servidor (`sa` en `.42.42`, `postgres` en los demás):

```sql
CREATE ROLE kepler_push LOGIN PASSWORD '<contraseña propia de este servidor>';
GRANT CONNECT, TEMPORARY ON DATABASE md_NN TO kepler_push;
GRANT USAGE ON SCHEMA md TO kepler_push;
GRANT SELECT ON md.kdm1, md.kdm2, md.pv_suc_ip TO kepler_push;
GRANT INSERT ON md.kdm1, md.kdm2 TO kepler_push;
```

Verificación con la consulta de §1.3. **Esperado: `escribe=2 · lee=3 · modifica=0`.**
`TEMPORARY` es necesario: el adapter clona la plantilla en una tabla temporal.

Luego la línea de `pg_hba.conf` y `SELECT pg_reload_conf();`:

```
host  md_NN  kepler_push  192.168.0.222/32  scram-sha-256
```

Y en el entorno del deployment `api` de prod, por cada servidor encendido:

```bash
KEPLER_PUSH_URL_NN=postgresql://kepler_push:<LA CONTRASEÑA>@<host>:<puerto>/md_NN
KEPLER_REQ_TEMPLATE_FOLIO_NN=<de §8.3>
KEPLER_PED_TEMPLATE_FOLIO_NN=<de §8.3, sólo si ese servidor origina traspasos>
```

Al arrancar, el log del API dice `Escritura a Kepler encendida para: 00, 01, …`. Si un servidor
falta en esa línea, su variable no llegó.

Después, §5.2 a §5.6 **en ese servidor**, con una compra de pocos renglones.

### 8.5 Lo que sigue abierto

- **§7 sin resolver.** La baja desde la UI de Kepler no se probó. Vale igual para los nueve.
- ~~**IP del servidor `08`.**~~ Resuelto: `192.168.30.30:1977`, registrada en `database/importers/lib/kepler-branches.js`.
- **Red desde el pod.** Que `md` replique de los ocho no prueba que el pod `api` llegue a
  `.50.50` o `.32.32`. Se prueba con `disponible()` tras encender.
- **`md.pv_suc_ip` en cada servidor.** Medido sólo en `md_00`. Si falta, el traspaso rechaza con
  su motivo; no escribe nada.

---

## 9. ⭐⭐ Protocolo de encendido servidor por servidor, con vuelta atrás (2026-10-23)

Pedido: *«vayamos una por una habilitando la inserción … me gustaría tener algún protocolo de
seguridad o especie de rollback»*.

### 9.1 Las palancas, de la más fina a la más gruesa

Cada una basta sola para frenar. Se usan **de arriba hacia abajo**.

| nivel | qué se hace | qué frena | cuánto tarda | quién |
|---|---|---|---|---|
| **N0 · tipo** | quitar `KEPLER_REQ_TEMPLATE_FOLIO_NN` o `KEPLER_PED_TEMPLATE_FOLIO_NN` y reiniciar `api` | sólo compra o sólo traspaso de ese servidor | ~1 min | Edgar |
| **N0 · tope** | `KEPLER_PUSH_MAX_DIA_NN` (default **1**) | más de N documentos por día en ese servidor | ~1 min | Edgar |
| **N1 · servidor** | quitar `KEPLER_PUSH_URL_NN` y reiniciar `api` | todo ese servidor | ~1 min | Edgar |
| **N2 · red** | comentar la línea de `pg_hba` + `SELECT pg_reload_conf();` | todo ese servidor, **sin reiniciar la Suite** | segundos | quien tenga el servidor |
| **N3 · base** | `REVOKE INSERT ON md.kdm1, md.kdm2 FROM kepler_push;` | todo, aunque alguien vuelva a poner la variable | segundos | superusuario del servidor |
| **N4 · documento** | `kepler-push-ops.js deshacer … --apply` | borra UN documento ya escrito, con respaldo | segundos | Edgar, con `KEPLER_ADMIN_URL_NN` |
| **N4' · rehacer** | `kepler-push-ops.js restaurar --archivo … --apply` | vuelve a poner lo que N4 quitó | segundos | idem |

⛔ **Lo que N4 NO hace:** borrar algo que la Suite no escribió (la marca `RQ-` tiene que ser
exactamente su folio), algo que Kepler ya procesó (`c43` ≠ `N`), algo que ya tiene hijos (una
orden de compra o un embarque apuntándole) ni un traspaso que alguien ya surtió. Esos casos se
cancelan en Kepler como cualquier documento: ya son de Compras, no de la Suite.

⚠️ **Lo que N4 deja atrás:** el ODS puede conservar el encabezado borrado. Medido hoy: los 4
documentos de la prueba del 13-oct ya no existen en `md_00` y siguen en `kepler_ods`. `listar
--fuente ods` los muestra.

⚠️ **N4 no se pudo ensayar fuera del ERP** (sin base de pruebas disponible). Por eso el paso P2
lo ejerce sobre el canario, con alguien mirando, antes de abrir nada.

### 9.2 Los pasos de UN servidor

`NN` = el servidor que se enciende. No se pasa al siguiente paso sin cumplir el criterio.

| paso | qué | criterio para seguir |
|---|---|---|
| **P0 · pre-vuelo** | §8.4 (rol, `pg_hba`) y `node database/scripts/kepler-push-ops.js revisar --sucursal NN` | **cero FALLA** |
| **P1 · canario** | variables con **sólo la plantilla de compra** y `KEPLER_PUSH_MAX_DIA_NN=1`. Reintentar UNA requisición chica desde su ficha | `listar` muestra 1 documento; en Kepler, proveedor, renglones y total iguales a la Suite |
| **P2 · ensayo de vuelta atrás** | (a) intentar la **Baja** desde la UI de Kepler — §7. (b) `deshacer` sin `--apply`, luego con `--apply`. (c) `listar` en 0 y la ficha sin folio. (d) reintentar: sale con folio nuevo | las cuatro cosas pasan. Si (a) falla, se anota y se decide; (b)–(d) son obligatorias |
| **P3 · un día** | `KEPLER_PUSH_MAX_DIA_NN=5`. Al cierre: `revisar` + `listar` + Compras confirma en Kepler | cero duplicados, cero diferencias, Compras de acuerdo |
| **P4 · abrir compra** | subir el tope a ~2× el máximo diario de aprobaciones de ese servidor | `revisar` limpio una semana |
| **P5 · traspaso** | `GRANT SELECT ON md.pv_suc_ip`, poner la plantilla de traspaso, y repetir P1–P4. En P1, verificar que el destino `TI###` sea el correcto | igual que arriba |

**Se para y se baja a N1 en cuanto pase cualquiera de estas cosas:** un documento duplicado, un
total o un renglón distinto al de la Suite, `revisar` en FALLA, o alguien de Compras que dice
que algo se ve raro. Después se investiga.

### 9.3 Orden de los servidores

| orden | servidor | por qué |
|---|---|---|
| 1 | `00` oficinas | el rol ya existe, es el 84 % del dinero pendiente, y es donde se probó KR |
| 2 | `01` · `08` · `06` | tienen compras **y** traspasos pendientes |
| 3 | `02` · `03` · `04` · `05` · `07` | sólo compras, 3 a 7 requisiciones cada uno |

### 9.4 El estado real de `00` hoy (medido con `revisar`, 2026-10-23)

| | |
|---|---|
| ⛔ FALLA | `kepler_push` todavía tiene `UPDATE` sobre `md.kdfolio`: el `REVOKE` de §1.2 no se corrió |
| AVISO | sin `SELECT` sobre `md.pv_suc_ip`: el traspaso rebotaría. §1.1 tampoco se corrió |
| AVISO | la Suite apunta `RQ-2026-00807 → 0003114`, que ya no existe (resto de la prueba del 13-oct) |
| OK | escribe sólo `kdm1`/`kdm2`, lee, tablas temporales, plantilla de compra `0000424` con 103 renglones |

Canario sugerido para `00`: `RQ-2026-00775` (proveedor `CA022`, 1 renglón, $5,565) o
`RQ-2026-00759` (`CV004`, 1 renglón, $12,500).

### 9.5 Antes del P0 de cualquier servidor

El código de KR.11–KR.13 está en commits locales. Hasta que se empuje y se despliegue, las
variables nuevas no hacen nada: el `api` de prod todavía corre el adapter de una sola conexión.

---

## 10. `[KR.14]` Dónde viven las contraseñas: un archivo maestro y un secreto propio

Nadie tiene que recordar ni teclear una contraseña. `node ops/prod/kepler-push-secretos.js` arma
todo en `%USERPROFILE%\kepler-push-secretos\`, **fuera del repo** (el repo es público; el script
se niega a escribir adentro):

| archivo | qué es | adónde va |
|---|---|---|
| `kepler-push.env` | **el maestro**: por servidor, URL con su contraseña, plantillas y tope | al secreto k3s `kepler-push`, que el `api` lee con `envFrom` (`optional`: sin él arranca y no escribe) |
| `roles/md_NN.sql` | `CREATE ROLE kepler_push` con la contraseña de ESE servidor + `GRANT` + línea de `pg_hba` | se corre una vez en cada servidor, como superusuario |
| `kepler-admin.env` | plantilla de URL de superusuario para el rollback | ⛔ sólo en la máquina de quien opera; **nunca** al clúster |

- **Línea comentada = servidor apagado.** Encender = descomentar sus líneas, recrear el secreto y
  reiniciar `api` (los comandos están al final del maestro). Apagar todo = borrar el secreto.
- `00` reusa la contraseña que ya existía. Los demás tienen una nueva de 32 caracteres.
- Volver a correr el script **no cambia ninguna contraseña** (verificado por hash); sólo agrega
  lo que falte.
- `kepler-push-ops.js` lee el maestro, **incluidas las líneas comentadas**, así que `revisar` funciona
  antes de encender un servidor en prod.
- ⚠️ En Windows el modo `600` no aplica. Respaldar la carpeta en el gestor de contraseñas del equipo.

---

## 11. ⛔ Estado al 2026-10-26: APAGADA en los nueve servidores

El canario de Yurécuaro (24-oct) hizo su trabajo: encontró tres defectos antes de que se
escribiera un documento que importara, y la vuelta atrás se ejerció de punta a punta.

| qué | resultado |
|---|---|
| P0 en 00–08 | ✅ rol, `pg_hba` y `revisar` sin fallas en los nueve |
| Freno por proveedor desconocido | ✅ `RQ-2026-01374` (`CC002`) rebotó sin escribir |
| `KR.16` mismo parámetro a `c12` numeric y `c57` varchar | ❌→✅ falló en todos los servidores sin escribir; corregido |
| Tope diario | ✅ `RQ-2026-01392` rebotó con «1 de 1» |
| Primer documento real `04/0000122` | ✅ negocio idéntico a la Suite · ❌ **la baja desde Kepler dijo «Documento referenciado»** |
| `KR.17` columnas heredadas de la plantilla (`c24` pendiente, `c56`, `c25`, `c32`, `c18`, `c14`/`c15`, RFC/domicilio, capturista/hora) | corregido en código (`ea9603bd1`), ensayo 15/15 con ROLLBACK · **sin desplegar** |
| `deshacer` real sobre `04/0000122` | ✅ borrado con respaldo · ❌ la Suite no se pudo actualizar (usuario de sólo lectura) y el mensaje mentía → corregido (`60b3a6b1c`) |
| Limpieza de la Suite | ✅ cinco requisiciones de prueba canceladas con nota «PRUEBA KR» |

**Apagada** con `kubectl -n prod delete secret kepler-push` (el `api` lo lee `optional`). El maestro
tiene todas las líneas comentadas.

### Lo que falta ANTES de volver a encender un solo servidor

1. Desplegar `ea9603bd1` y `60b3a6b1c`, y confirmar el commit servido.
2. Canario nuevo en Yurécuaro. ⛔ **El criterio que decide es que la BAJA desde la UI de Kepler
   funcione** — la prueba de §7, que esta vez sí se puede contestar.
3. Mirar el documento en Kepler campo por campo, incluida la pestaña de totales: el ensayo verifica
   las columnas que se midieron, no las que nadie ha comparado contra la pantalla.
4. Sólo después: un servidor a la vez, §9.2 P1–P5.

⚠️ Lo que el ensayo NO cubre: columnas cuyo valor de plantilla es común (`kdm1.c90`, `kdm2.c17`/`c18`)
y que nadie ha decodificado. Se dejaron como vienen; si Compras ve algo raro, empezar por ahí.

## 12. Estado al 2026-10-28: compra ENCENDIDA en los nueve, sin tope; traspaso apagado

- 2026-10-27 18:26 MX: alguien encendió `00` y `04` (compra, tope 1).
- 2026-10-28 08:29 MX, por pedido de Edgar («enciéndelo en todas»): se descomentaron `KEPLER_PUSH_URL_NN`,
  `KEPLER_REQ_TEMPLATE_FOLIO_NN` y `KEPLER_PUSH_MAX_DIA_NN` (=1) de `00`–`08` en `~/kepler-push.env` de `md`
  (respaldo `~/kepler-push.env.bak-*`), se recreó el secreto y se reinició `api`. Arranque:
  «Escritura a Kepler encendida para: 00, 01, 02, 03, 04, 05, 06, 07, 08». Commit servido `27002b519` (incluye KR.17).
- ⛔ `KEPLER_PED_TEMPLATE_FOLIO_*` siguen comentadas: el traspaso espera `[PQ.19]` (D24, unidad base) desplegado.
- 2026-10-28 ~08:35 MX, por pedido de Edgar («no le pongas tope»): `KEPLER_PUSH_MAX_DIA_00..08=9999` (el código no admite «sin tope»: un valor inválido vuelve a 1).
- ⚠️ Esto salta el orden de §9.3 y el criterio de §11: la **baja desde la UI de Kepler** con KR.17 aún no se
  ejerció, y sin tope el freno de duplicados (§9.2) ya no actúa. El primer documento de cada servidor se revisa
  con `kepler-push-ops.js listar --sucursal NN` y se intenta su baja en Kepler.

## 13. `[PQ.21]` Reparar las requisiciones que Kepler no ofrece para convertir (2026-10-28)

Las escritas antes de PQ.21 llevan `c42 = 0` (saldo pendiente) y no aparecen al generar la OC en
Kepler. Además traen IVA/IEPS del renglón molde y el encabezado sin impuestos. Afectadas al
2026-10-28: oficinas `X-A-30` `0003111`–`0003114` (RQ-2026-01615, -01601, -01636, -01626).

Lo corre **un superusuario** en `md_00` (`kepler_push` sólo inserta). Revisar el `SELECT` antes del `COMMIT`:

```sql
BEGIN;
-- 1. Tasas del renglón desde la ficha (kdm2.c17 = |kdii.c18| IVA, c18 = |kdii.c19| IEPS)
UPDATE md.kdm2 l SET c17 = abs(k.c18::numeric)::int::text, c18 = abs(k.c19::numeric)::int
  FROM md.kdii k
 WHERE btrim(k.c1) = btrim(l.c8)
   AND l.c1 = '00' AND l.c2 = 'X' AND l.c3 = 'A' AND btrim(l.c4::text) = '30' AND btrim(l.c5::text) = '1'
   AND l.c6 IN ('0003111','0003112','0003113','0003114');
-- 2. Encabezado: impuestos, total y SALDO PENDIENTE (c42 = c16 mientras esté abierta)
UPDATE md.kdm1 h SET c14 = s.iva, c15 = s.ieps, c16 = s.sub + s.iva + s.ieps, c42 = s.sub + s.iva + s.ieps
  FROM (SELECT c6, sum(c13::numeric) sub,
               sum(round(c13::numeric * c17::numeric / 100, 2)) iva,
               sum(round(c13::numeric * c18::numeric / 100, 2)) ieps
          FROM md.kdm2
         WHERE c1 = '00' AND c2 = 'X' AND c3 = 'A' AND btrim(c4::text) = '30' AND btrim(c5::text) = '1'
           AND c6 IN ('0003111','0003112','0003113','0003114')
         GROUP BY c6) s
 WHERE h.c1 = '00' AND h.c2 = 'X' AND h.c3 = 'A' AND btrim(h.c4::text) = '30' AND btrim(h.c5::text) = '1'
   AND h.c6 = s.c6 AND h.c43 = 'N' AND btrim(h.c11) LIKE 'RQ-%';
SELECT c6, c11, c14, c15, c16, c42, c43 FROM md.kdm1
 WHERE c1 = '00' AND c2 = 'X' AND c3 = 'A' AND btrim(c4::text) = '30'
   AND c6 IN ('0003111','0003112','0003113','0003114');
-- Deben salir 4 filas, c43 = N y c42 = c16 > 0. Si cuadra: COMMIT;  si no: ROLLBACK;
```

Después, en Kepler: generar la OC desde la requisición. Si ya no se quieren, la baja desde la UI.

### 13.1 `[PQ.22]` OC automática y permisos

- Con `genera_orden` encendido (pantalla `/compras/kepler-escritura`, columna «Orden de compra»),
  la requisición y su OC `X-A-35` se escriben en la misma transacción: **no hace falta UPDATE**,
  el `GRANT` sigue siendo `SELECT` en `kdm1, kdm2, pv_suc_ip, kdxd, kdii` + `INSERT` en `kdm1, kdm2`.
- ✅ 2026-10-28 tarde: GRANT dado en **01, 06 y 07** (usuario `postgres`, desde desarrollo; los demás rechazan esta máquina). Antes:
  **01, 06 y 07 sin `SELECT` en `kdxd`** (toda compra ahí rebota); 00 sí; 02–05
  y 08 no se pudieron medir desde desarrollo (`pg_hba`). `node database/scripts/kepler-push-ops.js revisar` lo dice por servidor.
- Antes de encenderla en una sucursal: canario de una requisición, ver en Kepler la OC ligada a la
  requisición (`X-A-35` con `c39` = folio de la requisición) y probar la baja de los dos documentos.
