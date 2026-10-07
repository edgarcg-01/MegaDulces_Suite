# P0.1 — Las 7 tablas de `md_00` que nunca sincronizaron (y por qué tiene reloj)

**Necesita tus manos**: hay que correrlo en el POS `192.168.9.95` como **superusuario** o como el
propio **`sa`**. Yo no tengo esa credencial.

**Tiempo:** menos de un minuto. **No reinicia nada. No bloquea nada.**

## Qué está pasando

`sub_md_00` tiene **7 de sus 355 tablas** trabadas en estado `d` (copia inicial) **desde siempre**:
`kdfe33nomem`, `kdrhdfes`, `kdrhfeba`, `kdrhfpag`, `kdrhhor`, `kdrhrut`, `kdrhtpcn` — todas de RH y
nómina. El log del suscriptor dice la causa exacta:

```
could not start initial contents copy … permiso denegado a la tabla kdrhdfes
```

`ods_repl` **no tiene SELECT** sobre ellas. Son de dueño **`sa`** y son **las únicas 7 de todo
`md.*`** sin permiso, así que el `ALTER DEFAULT PRIVILEGES` que se puso en su momento no las
alcanzó (se puso para otro rol, o después de que existieran).

## ⛔ Por qué no puede esperar

**Cada reintento del tablesync deja un slot de replicación en el publicador.** `md_00` va en
**8 de 10** `max_replication_slots` (7 inactivos + el de la suscripción). **Tres tablas más en esa
situación y muere la suscripción completa de la sucursal** — o sea, se corta la ingesta del CEDIS,
no sólo de esas 7 tablas.

Las otras 7 sucursales están limpias, con 1 slot cada una.

## Lo que hay que correr

En `192.168.9.95`, sobre la base `md_00`, como superusuario o como `sa`:

```sql
GRANT SELECT ON ALL TABLES IN SCHEMA md TO ods_repl;
ALTER DEFAULT PRIVILEGES FOR ROLE sa IN SCHEMA md GRANT SELECT ON TABLES TO ods_repl;
```

La primera línea arregla las 7 de hoy. **La segunda es la que evita que vuelva a pasar**: sin ella,
la próxima tabla que cree `sa` nace otra vez sin permiso y el ciclo se repite — es la misma trampa
que dejó estas 7 trabadas.

⚠️ Las dos son **aditivas y de sólo lectura**: no cambian dato, no tocan permisos de nadie más, y
`ods_repl` es un rol de replicación, no de aplicación.

## No hay que tocar nada más

Después del `GRANT`, los tablesync **terminan solos en el próximo reintento** y **los 7 slots se
liberan sin intervención**. No hay que reiniciar la suscripción, ni el contenedor, ni re-copiar
nada.

## Cómo se verifica (esto lo corro yo)

```sh
ops/vl/dev-ro-setup.sh    # no: la verificación es la de abajo
```

Desde `md`:

```sh
ssh superoot@192.168.0.222 'docker exec -i pgvector-md psql -U postgres -d kepler_md_00 -tAc "
  SELECT count(*) FILTER (WHERE srsubstate = $$r$$) AS listas,
         count(*) FILTER (WHERE srsubstate <> $$r$$) AS pendientes
    FROM pg_subscription_rel r JOIN pg_subscription s ON s.oid = r.srsubid
   WHERE s.subname = $$sub_md_00$$;"'
```

**Antes (medido 2026-09-11):** `348 listas · 7 pendientes`.
**Después, esperado:** `355 listas · 0 pendientes` — puede tardar uno o dos ciclos de reintento.
