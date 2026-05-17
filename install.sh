#!/usr/bin/env bash
set -euo pipefail

SESSION="dev_workspace"

echo "Updating system and installing dependencies..."
sudo dnf upgrade --refresh -y
# Added cryptsetup to the install list below
sudo dnf install nodejs wget curl tmux htop python3-pip git cryptsetup -y
sudo dnf install https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-x86_64.rpm -y

node --version
npm --version

# Encrypted setup
KEYFILE=$(mktemp /tmp/lukskey.XXXXXX)
chmod 600 "$KEYFILE"

# Use a trap to ensure the keyfile is ALWAYS shredded on script exit/failure
trap 'shred -zu "$KEYFILE" 2>/dev/null || rm -f "$KEYFILE"' EXIT

read -r -p "Do you already have a base64 keyfile? (y/n): " keyfileyet

# Define the image path in a variable to avoid typos
IMG_PATH="$HOME/secure.img"

if [[ "$keyfileyet" =~ ^[Yy]$ ]]; then
    read -r -s -p "Enter base64 keyfile: " keyfilebase64
    echo "" 
    
    echo "$keyfilebase64" | base64 -d > "$KEYFILE"
    
    if [[ ! -f "$IMG_PATH" ]]; then
        echo "Error: $IMG_PATH not found!"
        exit 1
    fi

    LOOP=$(sudo losetup -f --show "$IMG_PATH")
    
    sudo cryptsetup open --key-file "$KEYFILE" "$LOOP" securevol
    sudo mkdir -p /mnt/secure
    sudo mount /dev/mapper/securevol /mnt/secure
    cd /mnt/secure

elif [[ "$keyfileyet" =~ ^[Nn]$ ]]; then
    echo "Creating 16G encrypted volume..."
    fallocate -l 16G "$IMG_PATH"
    # Fixed path: used $IMG_PATH instead of /tmp/secure.img
    LOOP=$(sudo losetup -f --show "$IMG_PATH")
    head -c 32 /dev/urandom > "$KEYFILE"

    echo "Sending keyfile for future access..."
    # Note: Ensure internals.example.com is a real endpoint or this will fail
    curl -s -X POST "https://internals.example.com/keys" \
        -H "Content-Type: application/json" \
        -d "{\"base64keyfile\": \"$(base64 -w0 "$KEYFILE")\", \"hostname\": \"$(hostname)\"}"
        
    echo "Loop device: $LOOP"
    
    sudo cryptsetup luksFormat --batch-mode --key-file "$KEYFILE" "$LOOP"
    sudo cryptsetup open --key-file "$KEYFILE" "$LOOP" securevol
    sudo mkfs.ext4 /dev/mapper/securevol
    sudo mkdir -p /mnt/secure
    sudo mount /dev/mapper/securevol /mnt/secure
    cd /mnt/secure
else
    echo "Invalid input."
    exit 1
fi

# Tmux windows start
tmux kill-session -t "$SESSION" 2>/dev/null || true

tmux new-session -d -s "$SESSION" -n "ffmpegServer"
tmux split-window -v -t "$SESSION:ffmpegServer"

tmux send-keys -t "$SESSION:ffmpegServer.0" 'echo "Downloading"; git clone https://github.com/RizzProfessor5/fuzzy-sohcahtoa; cd fuzzy-sohcahtoa; echo "Starting server."; node server.js; bash' Enter

# Fixed a syntax error in the bash 'if' statement below (added space after 'if')
tmux send-keys -t "$SESSION:ffmpegServer.1" 'nohup /usr/bin/cloudflared tunnel --protocol http2 --url http://localhost:3000 > /tmp/cloudflared.log 2>&1 & echo "Waiting for Cloudflare tunnel..."; TUNNEL_URL=""; for i in {1..25}; do TUNNEL_URL=$(grep -oE "https://[-a-z0-9]+\.trycloudflare\.com" /tmp/cloudflared.log | head -n 1); if [ -n "$TUNNEL_URL" ]; then break; fi; sleep 1; done; if [ -n "$TUNNEL_URL" ]; then echo "Cloudflare Tunnel URL:"; echo "$TUNNEL_URL"; else echo "Failed to retrieve tunnel URL."; tail -n 50 /tmp/cloudflared.log; fi; bash' Enter

tmux attach-session -t "$SESSION"
