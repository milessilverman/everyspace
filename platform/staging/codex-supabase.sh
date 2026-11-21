#!/usr/bin/env bash
set -euo pipefail

staging_server=everyspace-staging-supabase
staging_tools='[
  "list_organizations", "get_organization", "list_projects", "get_project", "get_cost", "confirm_cost", "create_project",
  "get_project_url", "get_publishable_keys", "list_migrations", "list_tables", "apply_migration", "execute_sql",
  "deploy_edge_function", "list_edge_functions", "create_edge_function_secret", "get_advisors", "query_logs"
]'
staging_settings="mcp_servers.$staging_server={url=\"https://mcp.supabase.com/mcp\",enabled_tools=${staging_tools//$'\n'/ }}"
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)

case "${1:-open}" in
  status)
    exec codex mcp -c "$staging_settings" get "$staging_server" --json
    ;;
  authorize)
    codex mcp -c "$staging_settings" login "$staging_server"
    ;;
  open) ;;
  *) printf 'Usage: bash platform/staging/codex-supabase.sh [authorize|open|status]\n' >&2; exit 2 ;;
esac

exec codex --cd "$repo_dir" -c "$staging_settings"
