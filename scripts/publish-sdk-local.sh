#!/bin/bash
# =============================================================================
# Publish SDK Packages to Local Verdaccio Registry
# =============================================================================
#
# This script publishes @noosphere/* packages from the local SDK to Verdaccio
# for Docker development builds.
#
# Prerequisites:
#   1. Verdaccio running: docker compose -f docker/docker-compose.yml up verdaccio -d
#   2. SDK directory at: ../noosphere-sdk (relative to noosphere-agent-js)
#
# Usage:
#   npm run sdk:publish:local
#   # or directly:
#   ./scripts/publish-sdk-local.sh
#
# =============================================================================

set -e

# Configuration
VERDACCIO_URL="http://localhost:4873"
SDK_PATH="${SDK_PATH:-$(dirname "$0")/../../noosphere-sdk}"
PACKAGES=("contracts" "crypto" "registry" "agent-core")

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=========================================="
echo "Publishing SDK to Local Verdaccio"
echo "=========================================="
echo ""

# Check if Verdaccio is running
echo -e "${YELLOW}Checking Verdaccio...${NC}"
if ! curl -s "${VERDACCIO_URL}/-/ping" > /dev/null 2>&1; then
    echo -e "${RED}Error: Verdaccio is not running at ${VERDACCIO_URL}${NC}"
    echo ""
    echo "Start Verdaccio first:"
    echo "  docker compose -f docker/docker-compose.yml up verdaccio -d"
    echo ""
    exit 1
fi
echo -e "${GREEN}Verdaccio is running${NC}"
echo ""

# Check SDK path
if [ ! -d "$SDK_PATH" ]; then
    echo -e "${RED}Error: SDK not found at ${SDK_PATH}${NC}"
    echo ""
    echo "Set SDK_PATH environment variable or ensure ../noosphere-sdk exists"
    exit 1
fi
echo "SDK path: $SDK_PATH"
echo ""

# Configure npm to use local registry for publishing
echo -e "${YELLOW}Configuring npm registry...${NC}"
npm config set registry "${VERDACCIO_URL}"
echo ""

# Create npm user if not exists (Verdaccio auto-creates on first adduser)
echo -e "${YELLOW}Setting up npm authentication...${NC}"
# Check if already logged in
if ! npm whoami --registry "${VERDACCIO_URL}" > /dev/null 2>&1; then
    echo "Creating local npm user..."
    # Use expect-style input or npm-cli-login
    npm adduser --registry "${VERDACCIO_URL}" << EOF
localdev
localdev
localdev@localhost
EOF
fi
echo -e "${GREEN}Authenticated with Verdaccio${NC}"
echo ""

# Publish each package
echo "=========================================="
echo "Publishing packages..."
echo "=========================================="

for pkg in "${PACKAGES[@]}"; do
    PKG_PATH="${SDK_PATH}/packages/${pkg}"

    if [ ! -d "$PKG_PATH" ]; then
        echo -e "${YELLOW}Skipping ${pkg} (not found)${NC}"
        continue
    fi

    echo ""
    echo -e "${YELLOW}Publishing @noosphere/${pkg}...${NC}"

    cd "$PKG_PATH"

    # Build if build script exists
    if grep -q '"build"' package.json; then
        echo "  Building..."
        npm run build 2>/dev/null || true
    fi

    # Get current version
    VERSION=$(node -p "require('./package.json').version")
    echo "  Version: ${VERSION}"

    # Publish (--force to overwrite if same version exists)
    if npm publish --registry "${VERDACCIO_URL}" 2>&1; then
        echo -e "  ${GREEN}Published @noosphere/${pkg}@${VERSION}${NC}"
    else
        # Try unpublish and republish for same version
        echo "  Attempting to republish..."
        npm unpublish "@noosphere/${pkg}@${VERSION}" --registry "${VERDACCIO_URL}" --force 2>/dev/null || true
        npm publish --registry "${VERDACCIO_URL}" 2>&1 || echo -e "  ${YELLOW}Warning: Could not publish${NC}"
    fi
done

# Reset npm registry to default
echo ""
echo -e "${YELLOW}Resetting npm registry to default...${NC}"
npm config set registry "https://registry.npmjs.org"

echo ""
echo "=========================================="
echo -e "${GREEN}Done!${NC}"
echo "=========================================="
echo ""
echo "Next steps:"
echo "  1. Update package.json versions if needed"
echo "  2. Rebuild Docker image:"
echo "     docker compose -f docker/docker-compose.yml build --no-cache agent"
echo ""
