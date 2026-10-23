#!/usr/bin/env bash
# gh-dispatch.sh —— 用 GitHub dispatch API 触发本仓库的 workflow。
#
# 单一来源在本仓库 scripts/ops-panel/gh-dispatch.sh；服务器 /usr/local/bin/gh-dispatch.sh
# 是它的部署副本（crontab 与运维面板都调用服务器上那一份）。改逻辑必须两边同步，
# 并按 docs/ops/管理面板.md 的步骤重新部署。
#
# 用法：
#   gh-dispatch.sh refresh                  # 触发 Daily Data Refresh（安全，不发信）
#   gh-dispatch.sh broadcast                # 触发 Daily Broadcast，mode=send（真群发）
#   gh-dispatch.sh broadcast dry            # 触发 Daily Broadcast，mode=dry-run（只打印不发信）
#   gh-dispatch.sh broadcast send morning   # 显式指定 edition=盘前报（调试用，一般不用传）
#
# 版次（edition）：生产每天只发一封**收盘前报**（14:45，场外 15:00 截止前，edition=close）。
#   edition=morning 是盘前报，无调度，只在人工补发时用。
#
# 凭据：环境变量 GH_DISPATCH_TOKEN，或文件 /root/.gh_dispatch_token（chmod 600）。
# 退出码：0 = 已dispatch且 GitHub 返回 204；1 = GitHub 返回非 204；2 = 用法错误；3 = 缺 token。
#
# 变更记录：
#   2026-10-21 进仓库并加两处改动（向后兼容，crontab 现有写法不受影响）：
#     * 新增可选第二参数 dry（broadcast dry-run）；
#     * 非 204 时退出码改为 1（以前静默返回 0）。
#   2026-10-21 下午（三抓一报改版）：
#     * broadcast 自动带 edition。当时 broadcast.yml 的 inputs.edition 默认值是 morning，
#       不传就发盘前口径（正文写「07:50 抓、08:10 发」，没有「较盘前」段）——
#       14:45 那一跳若不显式传 close，订阅者收到的会是措辞与视角都不对的邮件。
#     * edition 缺省按当前小时判（12:00 前 morning、之后 close），与 scrape.mjs 的
#       slot 判定、面板走 EdgeOne 时的 edition 判定同款。
#   2026-10-23：broadcast.yml 的默认值已改为 **close**，漏传也不会再发错口径；
#     这里仍显式传，是为了「上午手点补发」时能明确要盘前报（morning）。
#       ★ 这个判定依赖服务器本地时区＝Asia/Shanghai（实测已确认：crontab 的 50 7 落在
#       北京 07:50）。注意 Debian/Ubuntu 的 cron **不认 CRON_TZ**（man 5 crontab：
#       does not support per-user timezones），所以时刻与这里的小时判断都以系统时区为准。

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
    # refresh.yml 只声明了 workflow_dispatch，没有任何 inputs
    # → 不能传 slot（传了 GitHub 会 422）。时段由 scrape.mjs 按北京时间自己判：
    #   12:00 前记 morning、之后记 close；同日重复运行幂等覆盖当日点。
    body='{"ref":"main"}' ;;
  broadcast)
    wf="broadcast.yml"
    case "${2:-}" in
      dry|dry-run) mode="dry-run" ;;
      send)        mode="send" ;;
      "")          mode="send" ;;
      *) echo "usage: $0 broadcast [dry|send] [morning|close]" >&2; exit 2 ;;
    esac
    # edition 显式传就听传的，否则按当前小时判（见文件头变更记录）：
    # 12:00 前=morning（盘前报，人工补发场景），之后=close（收盘前报，生产时点）
    edition="${3:-}"
    if [ -z "$edition" ]; then
      if [ "$(date +%-H)" -ge 12 ]; then edition="close"; else edition="morning"; fi
    fi
    case "$edition" in
      morning|close) ;;
      *) echo "usage: $0 broadcast [dry|send] [morning|close]" >&2; exit 2 ;;
    esac
    body="{\"ref\":\"main\",\"inputs\":{\"mode\":\"$mode\",\"edition\":\"$edition\"}}" ;;
  *)
    echo "usage: $0 refresh|broadcast [dry|send] [morning|close]" >&2
    exit 2 ;;
esac

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$API/$wf/dispatches" \
  -H "Authorization: Bearer $TOKEN" -H "$A_H" -H "$C_H" -d "$body")
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $wf -> HTTP $code"
[ "$code" = "204" ] || exit 1
