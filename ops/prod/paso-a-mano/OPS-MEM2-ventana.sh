#!/bin/sh
# [OPS.MEM.2] + [OPS.CONF.1] — Ventana FUERA DE HORARIO en md.
#   1. pg-prod y pgvector-md con la memoria nueva (caída ~1-2 min por base; la ingesta reconecta).
#   2. auto-deploy.sh / aplicar-k3s-prod.sh pasan a leer los manifiestos del checkout del despliegue.
#      Va DESPUÉS del 1 a propósito, y SÓLO si prod-release ya trae los manifiestos nuevos: si no,
#      el próximo despliegue aplicaría un 52 viejo (o un 42-worker sin las variables de LE).
#
# Uso, desde la raíz del repo en tu máquina (Git Bash), con origin/main ya traído:
#   scp ops/k3s/51-pgvector-md.deployment.yaml ops/k3s/52-pg-prod.deployment.yaml \
#       ops/prod/auto-deploy.sh ops/prod/aplicar-k3s-prod.sh superoot@192.168.0.222:/tmp/
#   ssh superoot@192.168.0.222 'sh -s' < ops/prod/paso-a-mano/OPS-MEM2-ventana.sh
#
# Volver atrás (en md):
#   cp ~/ops/k3s/52-pg-prod.deployment.yaml.bak-20261031 ~/ops/k3s/52-pg-prod.deployment.yaml
#   k3s kubectl apply -f ~/ops/k3s/52-pg-prod.deployment.yaml      (idem 51-pgvector-md)
#   cp ~/ops/prod/auto-deploy.sh.bak-20261031 ~/ops/prod/auto-deploy.sh   (idem aplicar-k3s-prod.sh)
set -eu
K="k3s kubectl"
R=~/auto-deploy/repo

for f in 52-pg-prod 51-pgvector-md; do
  [ -f "/tmp/$f.deployment.yaml" ] || { echo "⛔ falta /tmp/$f.deployment.yaml (hacé el scp primero)"; exit 1; }
  grep -q 'OPS.MEM.2' "/tmp/$f.deployment.yaml" || { echo "⛔ /tmp/$f.deployment.yaml no es la versión nueva"; exit 1; }
done

# El mismo candado que los despliegues: que ninguno aplique ~/ops/k3s a mitad de esto.
exec 9>/tmp/auto-deploy.lock
flock -w 600 9 || { echo "⛔ hay un despliegue corriendo hace 10 min; reintentar"; exit 1; }

echo "== antes"; free -m | sed -n 2,3p

reiniciar() { # reiniciar <deploy> <archivo>
  d=$1; f=$2
  # Idempotente: si lo vivo ya es igual al archivo nuevo, no se reinicia nada (re-correr es seguro).
  if $K diff -f /tmp/"$f" >/dev/null 2>&1; then echo "= $d ya está al día, no se toca"; return 0; fi
  cp ~/ops/k3s/"$f" ~/ops/k3s/"$f".bak-20261031
  $K exec -n prod deploy/"$d" -- psql -U postgres -c CHECKPOINT      # apagado corto
  cp /tmp/"$f" ~/ops/k3s/"$f"
  $K apply -f ~/ops/k3s/"$f"
  sleep 3
  # Recreate manda SIGTERM = apagado «smart», que esperaría al pool hasta terminationGracePeriod
  # (300 s en pg-prod). SIGINT lo escala a «fast»: corta sesiones, checkpoint y cierre limpio.
  viejo=$($K get pod -n prod -l app="$d" -o jsonpath='{.items[0].metadata.name}')
  $K exec -n prod "$viejo" -- kill -INT 1 2>/dev/null || true
  $K rollout status -n prod deploy/"$d" --timeout=600s
}
date '+%F %T'; reiniciar pg-prod 52-pg-prod.deployment.yaml
date '+%F %T'; reiniciar pgvector-md 51-pgvector-md.deployment.yaml
date '+%F %T'

echo "== después"
for d in pg-prod pgvector-md; do
  echo "-- $d"
  $K exec -n prod deploy/"$d" -- psql -U postgres -tAc "select string_agg(n || '=' || current_setting(n), '  ') from unnest(array['shared_buffers','maintenance_work_mem','effective_cache_size']) n"
  echo "oom_score_adj del postmaster: $($K exec -n prod deploy/"$d" -- cat /proc/1/oom_score_adj)"
done
free -m | sed -n 2,3p
echo "== salud"; curl -s -m 10 http://192.168.0.222:30080/api/health; echo

echo "== [OPS.CONF.1] manifiestos desde el checkout"
listo=0
for f in auto-deploy.sh aplicar-k3s-prod.sh; do
  grep -q 'OPS.CONF.1' "/tmp/$f" 2>/dev/null && sh -n "/tmp/$f" || { echo "⛔ /tmp/$f falta, no es la versión nueva o no parsea"; exit 1; }
done
# ¿La rama que despliega el vigía ya trae los manifiestos nuevos? Se trae a una ref APARTE para no
# tocar las del despliegue.
if GIT_SSH_COMMAND="ssh -i $HOME/.ssh/deploy_md -o IdentitiesOnly=yes" \
     git -C "$R" fetch -q --depth 5 origin +refs/heads/prod-release:refs/remotes/ventana/prod-release 2>/dev/null \
   && git -C "$R" show ventana/prod-release:ops/k3s/42-worker.deployment.yaml | grep -q LE_LIBRO_CAOS_DESDE \
   && git -C "$R" show ventana/prod-release:ops/k3s/52-pg-prod.deployment.yaml | grep -q 'shared_buffers=8GB'; then
  listo=1
fi
if [ "$listo" = 1 ]; then
  for f in auto-deploy.sh aplicar-k3s-prod.sh; do
    cp ~/ops/prod/"$f" ~/ops/prod/"$f".bak-20261031
    cp /tmp/"$f" ~/ops/prod/"$f"
  done
  echo "✓ copiados; el próximo despliegue aplica desde $R/ops/k3s"
else
  echo "⏸️  prod-release todavía no trae OPS.CONF.1: NO se copiaron los scripts (correcto)."
  echo "    Después del próximo soltar, re-correr este guion: las bases ya al día se saltan."
fi
