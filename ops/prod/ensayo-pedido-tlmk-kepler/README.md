# Ensayo del pedido TELEMARK (`U-D-40`, contador `KFUD4001`) contra el Kepler vivo (`[PGP.122.4]`)

Espejo de `../ensayo-pago-kepler/`. Corre el `KeplerPedidoTlmkSinkAdapter` **real** contra Kepler y
termina en `ROLLBACK`: no escribe nada. Toma el último pedido TELEMARK del servidor como **plantilla**
y le da sus propios renglones como cotización. Prueba lo que el spec
(`kepler-pedido-tlmk-sink.ensayo.spec.ts`) no puede en `md`: que el folio sale del **contador**
(`md.sqliov`, con el GRANT de `[PGP.122.4]`) y que `sqliov.c4` avanzó.

**Por qué desde `md`:** `pg_hba.conf` de Kepler sólo acepta `kepler_push` desde `md`, que no tiene
node ni el repo. Se empaqueta en un `.cjs` y corre en un contenedor que se borra.

## Cómo se corre

```bash
# 1. Empaquetar en la máquina de trabajo:
node ops/prod/ensayo-pedido-tlmk-kepler/empaquetar.js /tmp/ensayo-pedido-tlmk.cjs
scp /tmp/ensayo-pedido-tlmk.cjs superoot@192.168.0.222:/tmp/ensayo-pedido-tlmk.cjs
# 2. Correr. 1ª línea stdin = URL de kepler_push; 2ª = JSON { sucursal }.
{ echo "$KEPLER_PUSH_URL_00"; echo '{"sucursal":"00"}'; } \
  | ssh superoot@192.168.0.222 'docker run --rm -i --network host -v /tmp/ensayo-pedido-tlmk.cjs:/e.cjs:ro mirror.gcr.io/library/node:22-alpine node /e.cjs'
ssh superoot@192.168.0.222 'rm -f /tmp/ensayo-pedido-tlmk.cjs'
```

Verde = `fallas: []`, `contadores` con `KFUD4001 … folio` → `contador` (folio+1), `CONTROL: … = 0`.
Si la sucursal no tiene ningún pedido TELEMARK de plantilla, sale **NO MEDIDO** (no verde). Si el
pedido plantilla es viejo y su ficha cambió, el adaptador rechaza bien (fail-closed de unidad): elegir
una sucursal con un pedido TELEMARK reciente.

## Resultado

| Fecha | Resultado |
|---|---|
| 2026-11-17 | 00: NO MEDIDO — sin pedido TELEMARK de ficha vigente en 00 (la plantilla más nueva, folio 0000700, tiene un SKU con la caja cambiada). El contador `KFUD4001` es el mismo código probado en pago/compra/OC. Pendiente correrlo en una sucursal con pedido reciente. |
