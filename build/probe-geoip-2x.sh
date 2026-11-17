#!/usr/bin/env bash
# 只读：确认离线 GeoIP 能力，以及节点 server IP 与真实出口的关系
echo "=== geoip.metadb 信息 ==="
ls -lh /opt/mihomo/geoip.metadb 2>/dev/null || echo "  缺失"
head -c 16 /opt/mihomo/geoip.metadb 2>/dev/null | od -An -tx1 | head -2
echo "=== python 是否有 maxminddb / geoip2 ==="
python3 -c "import maxminddb; print('  maxminddb 可用')" 2>/dev/null || echo "  maxminddb 不可用"
python3 -c "import geoip2; print('  geoip2 可用')" 2>/dev/null || echo "  geoip2 不可用"
echo "=== mihomo 是否带 GeoIP 查询子命令 ==="
/usr/local/bin/mihomo -h 2>&1 | head -20
echo "=== 节点 server IP（YAML）==="
awk '/^proxies:/{f=1} f && /server:/{print}' /opt/config/clash.yaml | head -5
echo "=== ipinfo.io/json 字段说明（离线注释：免费版返回 ip/city/region/country/loc/org/postal/timezone）==="
