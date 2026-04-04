#!/bin/bash
# ═══════════════════════════════════════════════════════
#  Ozon Pilot 一键部署脚本（Ubuntu 22.04 / 2C2G 香港）
#  用法: ssh root@YOUR_IP < scripts/deploy.sh
# ═══════════════════════════════════════════════════════

set -e

echo "=== 1. 系统更新 ==="
apt update && apt upgrade -y

echo "=== 2. 安装 Node.js 22 ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

echo "=== 3. 安装 Playwright 依赖 ==="
npx playwright install-deps chromium
npx playwright install chromium

echo "=== 4. 安装 PM2 (进程管理) ==="
npm install -g pm2

echo "=== 5. 安装 Nginx (反代) ==="
apt install -y nginx

echo "=== 6. 创建项目目录 ==="
mkdir -p /opt/ozon-pilot
cd /opt/ozon-pilot

echo "=== 7. 克隆代码 ==="
# 替换成你的仓库地址
git clone https://github.com/YOUR_REPO/ai-select.git .
npm install --production

echo "=== 8. 配置 .env ==="
cat > .env << 'ENVEOF'
DEEPSEEK_API_KEY=your-deepseek-key-here
JWT_SECRET=your-production-secret-change-this
ENVEOF

echo "=== 9. 配置 Nginx 反代 ==="
cat > /etc/nginx/sites-available/ozon-pilot << 'NGEOF'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
    }
}
NGEOF

ln -sf /etc/nginx/sites-available/ozon-pilot /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

echo "=== 10. 用 PM2 启动 ==="
pm2 start scripts/login-server.js --name ozon-pilot --max-memory-restart 1500M
pm2 save
pm2 startup

echo "=== 11. 开放端口 ==="
ufw allow 80
ufw allow 443
ufw allow 22
ufw --force enable

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  部署完成!"
echo "  访问: http://$(curl -s ifconfig.me)"
echo ""
echo "  下一步:"
echo "  1. 修改 .env 里的 API Key"
echo "  2. 绑定域名 + HTTPS (certbot)"
echo "  3. 注册第一个账号（自动成为管理员）"
echo "═══════════════════════════════════════════════════════"
