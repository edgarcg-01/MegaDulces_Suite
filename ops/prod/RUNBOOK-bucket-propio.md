# Runbook — bucket propio y arreglos del despliegue

> ## ✅ EL CORTE SE HIZO EL 2026-10-05. La aplicación lee y escribe en Garage, en `md`.
>
> Decisión de Edgar, con el riesgo de durabilidad planteado dos veces y asumido.
> Secuencia real: sincronizar → verificar por ETag → cambiar 5 claves de `prod-env` →
> reiniciar `api` y `worker` → verificar.
>
> **Verificado después del corte:**
> - **5 de 5 documentos VIEJOS abiertos** por URL prefirmada: HTTP 200 y **tamaño exacto**.
>   Es la prueba que importa: que sirva la COPIA, no sólo la escritura nueva.
> - Subida nueva + lectura: contenido idéntico · sin firmar: **403**.
> - Railway **1,171 / 866.8 MB** y Garage **1,171 / 866.8 MB** — nada quedó huérfano en la
>   ventana entre la última sincronización y el corte.
> - Prod: portada 200 en 29 ms, **cero** errores de almacenamiento en 15 min, 15/15 pods.
>
> ⚠️ **Lo que el corte NO cambió, y ahora pesa más:** la evidencia fiscal es ahora PRIMARIA en
> un solo NVMe. Lo único que hoy hace de respaldo externo es que **el bucket de Railway quedó
> intacto** — con los 1,171 objetos de hoy, congelado. **Todo lo que se escriba desde ahora
> existe sólo en `md`.** El paso 2 dejó de ser preparación y pasó a ser deuda viva.
>
> ⭐ **Y hay una salida barata que el corte habilitó:** Tigris ya no es el primario, así que
> sirve de destino de respaldo. `sincronizar-buckets.js` lo hace invirtiendo ORIGEN y DESTINO —
> mismo costo que ya se paga, separación real de proveedor, sin cuenta nueva.
>
> **Rollback** (Railway sigue intacto): `k3s kubectl -n prod apply -f ~/secrets/prod-env.respaldo-20261005-0927.yaml`
> y reiniciar `api` y `worker`.
>
> ---
>
> **Estado al 2026-10-03 (histórico): TODO ESCRITO Y PROBADO, NADA APLICADO A `md`.**
> Los guiones de `md` **no** se actualizan solos (verificado: `auto-deploy.sh` no se
> auto-sincroniza; sólo cambian con un `ops/prod/deploy.sh --verificar` deliberado).
> O sea que lo que está commiteado queda **inerte** hasta que alguien corra el paso 1.

---

## Lo que ya está hecho y verificado en `md`

| | |
|---|---|
| Garage corriendo en k3s | `ops/k3s/62-garage.deployment.yaml`, buckets `comprobantes` e `imagenes` |
| Ida y vuelta S3 real | desde el pod de la app: subida · metadatos · **URL prefirmada 200** · borrado · **403 sin firmar** |
| Los 911 objetos copiados | **911/911 ETags idénticos**, 0 distintos, 0 ausentes |
| Re-corrida | 0 copiados · 911 salteados · **0 bytes** (idempotente) |
| Credenciales | `~/secrets/garage.txt` en `md`, 600 |

⛔ **Y lo que NO está hecho, a propósito:** `S3_ENDPOINT` sigue apuntando a Tigris. La
aplicación lee y escribe allá. **Nada cambió para los usuarios.**

---

## Paso 1 — Los dos arreglos del despliegue  ⬅ EMPEZAR POR ACÁ

Es lo más urgente de todo lo pendiente, porque **el vigía ya está armado**: el próximo push
que el CI selle dispara un despliegue solo, y hoy ese despliegue falla y revierte a medias.

### Qué arreglan

**`[K3S.42]` — revierte un despliegue que estaba bien.** La espera de convergencia miraba
`updatedReplicas` y `availableReplicas`, que son contadores **independientes**: con `api` en 2
réplicas se llega a `u=2, v=2` donde los 2 disponibles **no son los 2 actualizados** (uno nuevo
listo y uno viejo todavía vivo). Se agrega `status.replicas` (el total de pods del Deployment):
mientras sobre uno de la versión anterior, es mayor que lo deseado.

Medido el 2026-10-02 con el despliegue de `5e392b9`: el pod viejo `api-6dd5dc7d7-59br2` seguía
sirviendo `11562e4` y **ni siquiera estaba `Terminating`**, así que el salteo de `[K3S.31]`
tampoco lo filtraba.

**`[K3S.43]` — la reversión dejaba media producción en la versión nueva.** `aplicar-k3s-prod.sh`
le pone `:$COMMIT` a los **nueve** manifiestos de prod, pero `revertir()` sólo deshacía
`$SERVICIOS`, que es lo que se *construyó*. Resultado real de ese mismo despliegue:

```
api · worker · portal · vendor  →  11562e4   revertidos
caddy · pg-prod                 →  5e392b9   NO revertidos      ← y el log decía "revertido."
```

⭐ No se arregla agregando dos nombres a una lista: se vuelve a romper con el próximo servicio.
Ahora `aplicar-k3s-prod.sh` guarda una **foto de las revisiones antes de aplicar**, y la
reversión deshace los que **subieron de revisión**. Eso es exactamente "los que este despliegue
cambió" — y distingue el caso del `apply` que no cambió nada, al que un `rollout undo` lo
mandaría a un estado **anterior** al que tenía.

### Instalar

```sh
# desde la máquina de trabajo, con el repo en la rama que tiene los arreglos
ops/prod/deploy.sh --verificar      # sincroniza los guiones a md y valida
```

### Verificar que quedó instalado

```sh
ssh superoot@192.168.0.222 'grep -c "K3S.42" ~/ops/prod/aplicar-k3s-prod.sh; grep -c "K3S.43" ~/ops/prod/auto-deploy.sh'
# los dos tienen que dar >= 1
```

### Probarlo de verdad

El próximo despliegue es la prueba. Mirarlo en **Dozzle → `deploy-log`**
(`http://192.168.0.222:30085`). Lo que tiene que pasar distinto:

- ya **no** aparece `FALLO: el pod … sirve '<commit viejo>'` por carrera;
- si algo falla de verdad, el renglón `a revertir en K3s (por revisión): …` tiene que **nombrar
  también a `caddy` y `pg-prod`** si el apply los tocó.

### Si sale mal

```sh
# los guiones viejos siguen en git; revertir el commit y volver a sincronizar
git revert <commit>   &&   ops/prod/deploy.sh --verificar
```

---

## Paso 2 — El respaldo FUERA de `md`  (requisito duro del paso 3)

⛔ **Hoy el bucket propio y su origen están en el mismo edificio, y la copia de `md` está en un
solo NVMe.** Tener el dato dos veces en el mismo disco **no es tener respaldo**. `md` se cayó
**seis veces el 2026-10-02** por una causa física sin resolver y **no tiene UPS** (deuda `VL.8`).

La herramienta ya está y es la misma que hizo la mudanza, en la otra dirección:
`database/scripts/sincronizar-buckets.js`.

### Las tres opciones, con su número

| destino | costo real | separación | veredicto |
|---|---|---|---|
| **Cloudflare R2** | 787 MB × $0.015/GB-mes ≈ **$0.012/mes**, egreso **gratis** | otro proveedor, otro continente | ⭐ el que yo elegiría |
| **Tigris** (donde ya está) | lo que ya se paga | otro proveedor | sirve, pero no reduce la dependencia que motivó esto |
| **Otra máquina de la LAN** (`.249`) | gratis | **mismo edificio** | un incendio, un robo o un corte general se lleva las dos |

### Correrlo (cuando haya destino)

```sh
ORIGEN_ENDPOINT=http://garage:3900  ORIGEN_BUCKET=comprobantes \
ORIGEN_KEY=…  ORIGEN_SECRET=…       ( ~/secrets/garage.txt ) \
DESTINO_ENDPOINT=…  DESTINO_BUCKET=…  DESTINO_KEY=…  DESTINO_SECRET=… \
  node database/scripts/sincronizar-buckets.js --etags          # DRY-RUN primero
#  … y recién después agregar --apply
```

⚠️ **Correr siempre con `--etags`.** Sin eso el cuadre es por conteo y bytes, y el tamaño **no
es un hash**: dos archivos distintos del mismo tamaño se ven iguales.

### Y después, agendarlo

Un respaldo que se corre a mano una vez es una foto, no un respaldo. Va como carril con
**latido en `analytics.cron_runs` y umbral en `CRON_JOBS`** — si no late, nadie se entera de que
dejó de correr, que es exactamente lo que pasó con la pata de `pg_dump` (falla desde el
2026-10-01 y su latido tampoco se escribe, así que el tablero conserva la marca vieja).

---

## Paso 3 — El corte  (⛔ NO antes del paso 2)

Recién con respaldo externo verificado.

### Antes de tocar nada

```sh
# 1. una última sincronización: Tigris → Garage, con ETags
#    (la app siguió escribiendo en Tigris todo este tiempo)
# 2. cuadre en 0 diferencias
```

### El cambio

Es **una variable**, porque `ObjectStorageService` ya habla S3 y no distingue proveedor:

```
S3_ENDPOINT           = http://garage:3900
S3_BUCKET             = comprobantes
S3_ACCESS_KEY_ID      = (Key ID de ~/secrets/garage.txt)
S3_SECRET_ACCESS_KEY  = (Secret key de ~/secrets/garage.txt)
S3_REGION             = auto
```

⚠️ **`S3_REGION` tiene que ser `auto`** — es lo que la config de Garage declara como
`s3_region`, y si no coincide las firmas no validan.

⚠️ **Los nombres importan.** El servicio lee `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`. Con
`S3_ACCESS_KEY` / `S3_SECRET_KEY` (que es lo que tiene el `.env` de escritorio) `isConfigured()`
da **false** y el almacenamiento **degrada en silencio**.

### Verificar el corte

1. Subir un comprobante desde la aplicación y abrirlo.
2. Abrir uno **viejo** (de los 911 migrados) — eso prueba que la copia sirve, no sólo la escritura.
3. `k3s kubectl -n prod logs deploy/api | grep -i storage` sin errores.

### Rollback

Devolver las cuatro variables a los valores de Tigris y reiniciar el deployment. Tigris queda
**intacto**: esta mudanza nunca borró nada de allá. El rollback es inmediato y completo
**mientras no se borre el bucket de Tigris** — que no se borra hasta que esto lleve semanas
funcionando y con respaldo.

---

## Declarado, NO hecho

- **Las imágenes de Cloudinary** (5,313 recursos · 1,501.7 MB). Es otra mudanza: Cloudinary
  transforma al vuelo (`w_24`, `h_200`, `c_limit`, `q_auto`) y un bucket sirve bytes. Son **22
  llamadas** y **un solo archivo** arma URLs de `res.cloudinary.com`, así que es abordable —
  pero necesita decidir qué hace las miniaturas. El bucket `imagenes` ya está creado y esperando.
- **Los 111 duplicados.** Medido: 911 objetos pero **800 contenidos distintos**; 56 documentos
  repetidos, uno subido **14 veces**. Puede ser legítimo (el mismo comprobante atado a varios
  registros) — no se tocó nada, queda para mirar.
- **El `.env` de escritorio apunta a OTRO bucket** (`indexed-carrier-r94gtps6l`) que el de prod
  (`foldable-pannikin-i348jfx`), y con los nombres de variable que el servicio no lee. Medir
  desde la laptop da otro universo.
- **El respaldo `pg_dump` de prod falla desde el 2026-10-01** con *"no se pudo consultar el
  destino (credencial o red)"*, y su latido tampoco se escribe. ⚠️ **pgbackrest SÍ funciona**
  (7 respaldos, 117 GB, corrió el 1 y el 2 de octubre) — o sea que hay respaldo, pero una de las
  dos patas está muda y rota.
