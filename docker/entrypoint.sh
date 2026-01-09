#!/bin/sh
set -e

# =============================================================================
# Noosphere Agent - Docker Entrypoint (Docker-in-Docker)
# =============================================================================

echo "========================================"
echo "  Noosphere Agent Container"
echo "========================================"
echo ""

# -----------------------------------------------------------------------------
# Environment Variables
# -----------------------------------------------------------------------------
# Required:
#   KEYSTORE_PASSWORD    - Password for keystore decryption
#
# Optional:
#   CONFIG_PATH          - Path to config.json (default: /app/config.json)
#   NOOSPHERE_DATA_DIR   - Data directory (default: /app/.noosphere)
#   DASHBOARD_ENABLED    - Enable Next.js dashboard (default: true)
# -----------------------------------------------------------------------------

# Check required environment variables
if [ -z "$KEYSTORE_PASSWORD" ]; then
    echo "ERROR: KEYSTORE_PASSWORD environment variable is required"
    exit 1
fi

# Set defaults
CONFIG_PATH=${CONFIG_PATH:-/app/config.json}
NOOSPHERE_DATA_DIR=${NOOSPHERE_DATA_DIR:-/app/.noosphere}
DASHBOARD_ENABLED=${DASHBOARD_ENABLED:-true}

echo "Configuration:"
echo "  Config Path:     $CONFIG_PATH"
echo "  Data Directory:  $NOOSPHERE_DATA_DIR"
echo "  Dashboard:       $DASHBOARD_ENABLED"
echo ""

# Check if config file exists
if [ ! -f "$CONFIG_PATH" ]; then
    echo "ERROR: Config file not found at $CONFIG_PATH"
    echo "       Mount your config.json using docker-compose volumes"
    exit 1
fi

# Create symlink to config.json if not in default location
if [ "$CONFIG_PATH" != "/app/config.json" ]; then
    ln -sf "$CONFIG_PATH" /app/config.json
fi

# Ensure data directory exists and is writable
mkdir -p "$NOOSPHERE_DATA_DIR" 2>/dev/null || true

# Check Docker socket access (required for DinD)
echo "Docker Status:"
if [ -S /var/run/docker.sock ]; then
    echo "  Socket:        /var/run/docker.sock (mounted)"
    if docker ps > /dev/null 2>&1; then
        echo "  Connectivity:  OK"
        echo "  Containers:    $(docker ps -q | wc -l | tr -d ' ') running"
    else
        echo "  WARNING: Cannot connect to Docker daemon"
        echo "           Check socket permissions"
    fi
else
    echo "  ERROR: Docker socket not mounted!"
    echo "         Add to docker-compose.yml:"
    echo "         volumes:"
    echo "           - /var/run/docker.sock:/var/run/docker.sock"
    exit 1
fi
echo ""

# -----------------------------------------------------------------------------
# Start Services
# -----------------------------------------------------------------------------

if [ "$DASHBOARD_ENABLED" = "true" ]; then
    echo "Starting Next.js Dashboard (port 3000)..."
    npm run start &
    DASHBOARD_PID=$!
    sleep 2
fi

echo "Starting Noosphere Agent (port 4000)..."
echo ""

# Export environment variables for the agent
export KEYSTORE_PASSWORD
export NOOSPHERE_DATA_DIR
export CONFIG_PATH

# Start agent with tsx
exec npx tsx src/app.ts
