#!/usr/bin/env bash
set -euo pipefail

# Git commit/push helper com boas práticas
# Uso:
#   bash tools/git_commit_push.sh \
#     --user-name "José Roberto" \
#     --user-email "juniorferreirarob@gmail.com" \
#     --branch fix/remote-stop-chargeboxid-fallback \
#     --files services/orchestrator-api/src/routes/commands.ts \
#     --message "fix(commands): RemoteStop aceita chargeBoxId e fallback; evita 500; retorna 409 charge_point_unknown"

USER_NAME=""
USER_EMAIL=""
BRANCH="fix/remote-stop-chargeboxid-fallback"
FILES=""
MESSAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user-name) USER_NAME="$2"; shift 2;;
    --user-email) USER_EMAIL="$2"; shift 2;;
    --branch) BRANCH="$2"; shift 2;;
    --files) FILES="$2"; shift 2;;
    --message) MESSAGE="$2"; shift 2;;
    *) echo "[erro] argumento desconhecido: $1"; exit 1;;
  esac
done

if [[ -z "$FILES" || -z "$MESSAGE" ]]; then
  echo "Uso: --files <lista> --message <msg> (veja cabeçalho do script)"; exit 1
fi

command -v git >/dev/null || { echo "git não encontrado"; exit 1; }

if [[ -n "$USER_NAME" ]]; then git config --global user.name "$USER_NAME"; fi
if [[ -n "$USER_EMAIL" ]]; then git config --global user.email "$USER_EMAIL"; fi

echo "[git] criando/alternando branch: $BRANCH"
if git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  git checkout "$BRANCH"
else
  git checkout -b "$BRANCH"
fi

echo "[git] adicionando arquivos: $FILES"
git add $FILES

echo "[git] diff staged:" && git diff --staged || true

echo "[git] commitando"
git commit -m "$MESSAGE"

echo "[git] enviando para origin"
git push -u origin "$BRANCH"

echo "[ok] commit e push realizados com sucesso"