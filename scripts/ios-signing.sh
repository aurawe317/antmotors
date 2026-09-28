#!/bin/bash
# ios-signing.sh — 把 Apple 分发证书 / 描述文件转成 GitHub Secrets 需要的 base64
# 在本地 Mac 上运行（需 macOS，使用 pbcopy 自动复制）。
# 用法:
#   ./scripts/ios-signing.sh /path/to/dist.p12 /path/to/AppStore.mobileprovision
#
# 输出:
#   - ANTOTO_IOS_DIST_CERT_P12 的 base64 （复制到剪贴板 + 存 /tmp）
#   - ANTOTO_IOS_PROVISIONING_PROFILE 的 base64 （复制到剪贴板 + 存 /tmp）
# 另需手动在仓库 Secrets 填:
#   ANTOTO_IOS_DIST_CERT_PASSWORD = p12 导出时设的密码
#   ANTOTO_IOS_TEAM_ID            = 74DK5WW7RT
#   ANTOTO_IOS_PROFILE_NAME       = Apple 后台描述文件的名称
set -euo pipefail
if [ $# -lt 2 ]; then
  echo "用法: $0 <dist.p12> <profile.mobileprovision>" >&2
  exit 1
fi
P12="$1"; PROF="$2"
B64_P12=$(base64 -i "$P12"  | tr -d '\n')
B64_PROF=$(base64 -i "$PROF" | tr -d '\n')
printf '%s' "$B64_P12"  > /tmp/ANTOTO_IOS_DIST_CERT_P12.b64
printf '%s' "$B64_PROF" > /tmp/ANTOTO_IOS_PROVISIONING_PROFILE.b64
if command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$B64_P12"  | pbcopy; echo "[已复制] ANTOTO_IOS_DIST_CERT_P12 -> 剪贴板"
  sleep 0.3
  printf '%s' "$B64_PROF" | pbcopy; echo "[已复制] ANTOTO_IOS_PROVISIONING_PROFILE -> 剪贴板"
else
  echo "非 macOS 环境，请手动复制 /tmp 下两个 .b64 文件内容"
fi
echo ""
echo "证书 base64 长度:      ${#B64_P12}"
echo "描述文件 base64 长度:  ${#B64_PROF}"
echo ""
echo "下一步: 把上面两个值粘贴进 GitHub -> Settings -> Secrets，"
echo "        再加 ANTOTO_IOS_DIST_CERT_PASSWORD / ANTOTO_IOS_TEAM_ID(74DK5WW7RT) / ANTOTO_IOS_PROFILE_NAME，"
echo "        然后手动跑一次 build-ios 工作流即可产出 antoto-ios-ipa。"
