#!/usr/bin/env bash
# gh-dispatch.sh —— 用 GitHub dispatch API 触发本仓库的 workflow。
#
# 单一来源在本仓库 scripts/ops-panel/gh-dispatch.sh；服务器 /usr/local/bin/gh-dispatch.sh
# 是它的部署副本（crontab 与运维面板都调用服务器上那一份）。改逻辑必须两边同步，
# 并按 docs/ops/管理面板.md 的步骤重新部署。
#
# 用法：
#   gh-dispatch.sh refresh        # 触发 Daily Data Refresh（安全，不发信）
#   gh-dispatch.sh broadcast      # 触发 Daily Broadcast，mode=send（真群发）
#   gh-dispatch.sh broadcast dry  # 触发 Daily Broadcast，mode=dry-run（只打印不发信）
#
# 凭据：环境变量 GH_DISPATCH_TOKEN，或文件 /root/.gh_dispatch_token（chmod 600）。
# 退出码：0 = 已dispatch且 GitHub 返回 204；1 = GitHub 返回非 204；2 = 用法错误；3 = 缺 token。
#
# 变更记录：
#   2026-10-21 进仓库并加两处改动（向后兼容，crontab 现有写法不受影响）：
#     * 新增可选第二参数 dry（broadcast dry-run）；
#     * 非 204 时退出码改为 1（以前静默返回 0）。

set -euo pipefail
TOKEN_FILE="${GH_DISPATCH_TOKEN_FILE:-/root/.gh_dispatch_token}"
TOKEN="${GH_DISPATCH_TOKEN:-$(cat "$TOKEN_FILE" 2>/dev/null || true)}"
REPO="${REPO:-liqt91/ndx_limit}"
API="https://api.github.com/repos/$REPO/actions/workflows"
A_H="Accept: application/vnd.github+json"
C_H="Content-Type: application/json"

if [ -z "$TOKEN" ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) error: token missing ($TOKEN_FILE)" >&2
  exit 3
fi

case "${1:-}" in
  refresh)
    wf="refresh.yml"
    body='{"ref":"main"}' ;;
  broadcast)
    wf="broadcast.yml"
    if [ "${2:-}" = "dry" ]; then
      body='{"ref":"main","inputs":{"mode":"dry-run"}}'
    else
      body='{"ref":"main","inputs":{"mode":"send"}}'
    fi ;;
  *)
    echo "usage: $0 refresh|broadcast [dry]" >&2
    exit 2 ;;
esac

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$API/$wf/dispatches" \
  -H "Authorization: Bearer $TOKEN" -H "$A_H" -H "$C_H" -d "$body")
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $wf -> HTTP $code"
[ "$code" = "204" ] || exit 1
