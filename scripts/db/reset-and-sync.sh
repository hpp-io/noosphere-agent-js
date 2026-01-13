#!/bin/bash
#
# Reset database and sync from blockchain (Production/Docker)
#
# Usage:
#   ./scripts/db/reset-and-sync.sh          # Run inside Docker container
#   docker compose -f docker/docker-compose.yml exec agent ./scripts/db/reset-and-sync.sh
#

set -e

DATA_DIR="${NOOSPHERE_DATA_DIR:-/app/.noosphere}"
DB_FILE="$DATA_DIR/agent.db"
DB_WAL="$DATA_DIR/agent.db-wal"
DB_SHM="$DATA_DIR/agent.db-shm"

echo "🗄️  Database Reset & Sync"
echo "========================="
echo ""

# Check if database exists
if [ -f "$DB_FILE" ]; then
    echo "📁 Found database at: $DB_FILE"

    # Show current stats before reset
    if command -v sqlite3 &> /dev/null; then
        EVENTS=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM events;" 2>/dev/null || echo "0")
        echo "   Current events: $EVENTS"
    fi

    echo ""
    echo "🗑️  Removing database files..."
    rm -f "$DB_FILE" "$DB_WAL" "$DB_SHM"
    echo "   ✓ Database removed"
else
    echo "📁 No existing database at: $DB_FILE"
fi

echo ""
echo "🔄 Running blockchain sync..."
echo ""

# Run sync with --full flag to sync from deployment block
npx tsx scripts/db/sync-from-blockchain.ts --full

echo ""
echo "✅ Reset and sync complete!"
