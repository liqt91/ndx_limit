#!/usr/bin/env bash
# 部署 dist/ 到腾讯云 COS 静态网站。
# 用法: ./scripts/deploy-cos.sh <BUCKET> <REGION> <SECRET_ID> <SECRET_KEY>
#   REGION 例如 ap-guangzhou / ap-shanghai
set -euo pipefail

BUCKET="${1:?bucket 必填}"
REGION="${2:?region 必填}"
SECRET_ID="${3:?secret id 必填}"
SECRET_KEY="${4:?secret key 必填}"

COSCLI=coscli
if ! command -v coscli >/dev/null 2>&1; then
  echo ">> 未检测到 coscli，临时下载（linux amd64）..."
  curl -sL "https://cosbrowser.cloud.tencent.com/software/coscli/coscli-linux-amd64" -o coscli
  chmod +x coscli
  COSCLI=./coscli
fi

ENDPOINT="cos.${REGION}.myqcloud.com"

echo ">> 同步 dist/ -> cos://${BUCKET}/ (region=${REGION})"
"$COSCLI" sync dist/ "cos://${BUCKET}/" \
  --endpoint "$ENDPOINT" \
  --secret_id "$SECRET_ID" \
  --secret_key "$SECRET_KEY" \
  --delete

echo ">> 部署完成 -> https://${BUCKET}.${ENDPOINT}"
