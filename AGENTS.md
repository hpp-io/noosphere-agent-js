# Codex Rules

## Git Commits
- NEVER add "Co-Authored-By" to commit messages
- NEVER push to remote without explicit user approval

## Package Dependencies
- When updating package.json dependencies, ALWAYS run `npm install` to update package-lock.json
- Commit package-lock.json together with package.json changes
- CI uses `npm ci` which requires package-lock.json to be in sync with package.json
