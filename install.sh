nohup /usr/local/bin/cloudflared tunnel --protocol http2 --url http://localhost:8081 > /tmp/cloudflared.log 2>&1 &
echo "Waiting for Cloudflare tunnel..."
TUNNEL_URL=""
for i in {1..25}; do
    TUNNEL_URL=$(grep -oE 'https://[-a-z0-9]+\\.trycloudflare.com' /tmp/cloudflared.log | head -n 1)
    if [ -n "$TUNNEL_URL" ]; then
        break
    fi
    sleep 1
done
if [ -n "$TUNNEL_URL" ]; then
    echo "Cloudflare Tunnel URL:"
    echo "$TUNNEL_URL"
else
    echo "Failed to retrieve tunnel URL."
    tail -n 50 /tmp/cloudflared.log
fi
