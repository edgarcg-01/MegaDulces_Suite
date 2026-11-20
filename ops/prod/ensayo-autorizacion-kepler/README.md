# Ensayo de autorizar un pedido TELEMARK en el Kepler vivo (`[GP.A.2]`)

Corre el `KeplerAutorizacionPedidoAdapter` **real** contra Kepler. Lee el pedido con candado, decide, ejecuta el
`UPDATE` de `kdm1.c11` y comprueba que tocó una fila; **su `COMMIT` se convierte en `ROLLBACK`**. Se prueban el permiso,
la llave y el `rowCount` sin escribir nada. Mismo empaquetado que el ensayo de la nota
(`ops/prod/ensayo-nota-kepler/README.md`): Kepler sólo acepta a `kepler_push` desde `md`.

## Antes

1. El permiso: `ops/prod/kepler-grants/gpa0d_kdm1_update_c11.sql` (pide la contraseña de superusuario; lo corre el PM).
   Sin él, el ensayo termina en «permiso denegado» y eso también es un resultado.
2. Un pedido TELEMARK en `CREADO` del servidor (del ODS o de la bandeja «Por autorizar»): sucursal, serie y folio.

## Cómo se corre

```bash
node ops/prod/ensayo-autorizacion-kepler/empaquetar.js /tmp/ensayo-autorizacion.cjs      # no lleva credenciales
scp /tmp/ensayo-autorizacion.cjs superoot@192.168.0.222:/tmp/ensayo-autorizacion-gpa2.cjs
{ echo "$KEPLER_PUSH_URL_08"; echo '{"sucursal":"08","serie":1,"folio":"<folio>","accion":"autorizar"}'; } \
  | ssh superoot@192.168.0.222 'docker run --rm -i --network host -v /tmp/ensayo-autorizacion-gpa2.cjs:/e.cjs:ro mirror.gcr.io/library/node:22-alpine node /e.cjs'
ssh superoot@192.168.0.222 'rm -f /tmp/ensayo-autorizacion-gpa2.cjs'
```

## Cómo se lee

- `ANTES`: el estatus, el canal, el estado del documento y si `kepler_push` tiene el permiso sobre `c11`.
- `resultado.estado = "escrito"` y `deshecho: true`: el adaptador llegó hasta el final y su commit se deshizo.
- `sentencias`: cada sentencia con sus filas. La del `UPDATE` tiene que dar **1**.
- La última línea es el **control**: el estatus después del ensayo tiene que ser **el mismo** que antes. Si cambió, sale
  con código 2 y hay que avisar a quien administra Kepler.
- `rechazado` con «permission denied»: falta el permiso del paso 1.

## Resultado

| Fecha | Servidor | Pedido | Resultado |
|---|---|---|---|
| — | — | — | Sin correr: falta el permiso (GP.A.0d) y la conexión de `kepler_push` |
