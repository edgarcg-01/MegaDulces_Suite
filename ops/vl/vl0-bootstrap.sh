#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# VL.0 — la pila de §6.0 del plan, ejecutable. Corre UNA vez en el server nuevo.
#
#   sudo bash ops/vl/vl0-bootstrap.sh
#
# Deja: TZ MX · Docker CE oficial + compose v2 · postgresql-client-18 de PGDG ·
# unattended-upgrades CON Docker en lista negra · sysctl y THP de Postgres.
#
# NO instala Postgres en el host a propósito: el replica corre en el contenedor
# `pgvector/pgvector:pg18`. Del host sólo sale el CLIENTE, y de PGDG — porque
# `pg_dump` 17 o menor SE NIEGA a volcar un servidor 18, y de eso te enterás
# justo el día que necesitás el respaldo.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "correlo con sudo"; exit 1; }

CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
echo "▶ Ubuntu $(. /etc/os-release && echo "$VERSION_ID") · codename: $CODENAME"

# Los repos de abajo se verificaron presentes para `resolute` el 2026-09-10. Si
# algún día se instala sobre otro codename, se avisa en vez de fallar a ciegas.
[[ "$CODENAME" == "resolute" ]] || echo "  ⚠️  el plan verificó Docker CE y PGDG para 'resolute', no para '$CODENAME' — confirmalo antes de seguir"

echo "▶ 1/6 · zona horaria + reloj"
# NO es cosmético: los @Cron del proyecto están escritos asumiendo hora MX.
timedatectl set-timezone America/Mexico_City
timedatectl set-ntp true

echo "▶ 2/6 · base"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg lsb-release cifs-utils unattended-upgrades

echo "▶ 3/6 · Docker CE del repo OFICIAL (no docker.io: ese trae compose v1)"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $CODENAME stable" \
  > /etc/apt/sources.list.d/docker.list

echo "▶ 4/6 · PGDG (sólo el cliente 18)"
install -d /usr/share/postgresql-common/pgdg
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /etc/apt/keyrings/pgdg.asc
chmod a+r /etc/apt/keyrings/pgdg.asc
echo "deb [signed-by=/etc/apt/keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list

apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin postgresql-client-18

echo "▶ 5/6 · Docker FUERA de los upgrades desatendidos"
# Un upgrade desatendido del daemon reinicia TODOS los contenedores en medio de
# una pasada de shipment. Los parches del SO sí se quieren; el reinicio no.
cat > /etc/apt/apt.conf.d/52-docker-hold.conf <<'EOF'
// VL.0 (ADR-060) — el daemon de Docker NO se actualiza solo: al reiniciarse se
// lleva con él los carriles del ODS a mitad de una pasada. Se actualiza a mano,
// en ventana, junto con el resto del mantenimiento.
Unattended-Upgrade::Package-Blacklist {
    "docker-ce";
    "docker-ce-cli";
    "containerd.io";
    "docker-compose-plugin";
    "docker-buildx-plugin";
};
EOF

echo "▶ 6/6 · sysctl y THP para Postgres"
cat > /etc/sysctl.d/99-postgres.conf <<'EOF'
# VL.0 — lo estándar para Postgres, nada exótico.
vm.swappiness = 1
vm.dirty_background_ratio = 5
vm.dirty_ratio = 10
EOF
sysctl -q --system

if ! grep -q 'transparent_hugepage=never' /etc/default/grub; then
  sed -i 's/^GRUB_CMDLINE_LINUX_DEFAULT="\(.*\)"/GRUB_CMDLINE_LINUX_DEFAULT="\1 transparent_hugepage=never"/' /etc/default/grub
  update-grub
  echo "  · THP=never agregado al cmdline → pide REINICIO para tomar efecto"
fi

if [[ -n "${SUDO_USER:-}" ]]; then usermod -aG docker "$SUDO_USER"; echo "  · $SUDO_USER agregado al grupo docker (re-login para que aplique)"; fi

echo
echo "═══ listo ═══"
docker --version; docker compose version | head -1; psql --version
echo
echo "SIGUIENTE: bash ops/vl/vl0-verify.sh      ← la compuerta de VL.0"
echo "           bash ops/vl/vl0-verify.sh --negative   ← y su prueba negativa"
