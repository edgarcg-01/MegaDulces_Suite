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
