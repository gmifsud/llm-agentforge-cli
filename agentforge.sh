#!/usr/bin/env bash
# agentforge — bootstrap a repo with a token-optimised CLAUDE.md / AGENTS.md
# and a symlink to the shared skill vault.
#
# POSIX bash. Idempotent. Non-destructive unless --force.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------- defaults ----------
COMMAND="help"
PROJECT_PATH=""
TARGET="claude"
NAME=""
STACK="<fill in>"
OWNER="${USER:-unknown}"
BUILD_CMD="<build>"
TEST_CMD="<test>"
RUN_CMD="<run>"
VAULT_ROOT="${AGENTFORGE_VAULT_ROOT:-}"
LINK_TYPE="auto"
DRY_RUN=0
FORCE=0

# ---------- target matrix ----------
# format: key|doc|dir|template
TARGET_ROWS=(
  "claude|CLAUDE.md|.claude|CLAUDE.md.tmpl"
  "codex|AGENTS.md|.codex|AGENTS.md.tmpl"
  "generic|AGENTS.md|.agents|AGENTS.md.tmpl"
)

# ---------- logging ----------
c_cyan='\033[0;36m'; c_green='\033[0;32m'; c_yellow='\033[0;33m'
c_red='\033[0;31m';  c_grey='\033[0;90m';  c_reset='\033[0m'
step()  { printf "${c_cyan}→ %s${c_reset}\n" "$*"; }
ok()    { printf "${c_green}✓ %s${c_reset}\n" "$*"; }
warn()  { printf "${c_yellow}! %s${c_reset}\n" "$*"; }
err()   { printf "${c_red}✗ %s${c_reset}\n" "$*"; }
dry()   { printf "${c_grey}(dry) %s${c_reset}\n" "$*"; }

usage() {
cat <<'EOF'
agentforge — repo bootstrap for agent-driven workflows

Usage:
  agentforge.sh <command> [options]

Commands:
  init      create the agent doc + skills link
  link      (re)create only the skills link
  doctor    diagnose the bootstrap state
  help      show this help

Options:
  --path PATH           Project root (default: cwd)
  --target T            claude | codex | generic | all  (default: claude)
  --name NAME           Project name (default: leaf folder)
  --stack "TXT"         Tech-stack one-liner
  --owner NAME          Owner (default: $USER)
  --build "CMD"         Build command snippet
  --test  "CMD"         Test command snippet
  --run   "CMD"         Run command snippet
  --vault PATH          Skills vault root (default: $AGENTFORGE_VAULT_ROOT
                        or ~/repos/LLM/llm-skill-vault/skills)
  --link  TYPE          symlink | copy | none (default: symlink on Unix)
  --dry-run             Print actions without performing them
  --force               Overwrite existing docs / replace existing link
  -h, --help            Show this help

Examples:
  agentforge.sh init --name my-app --stack "TypeScript / Vite"
  agentforge.sh init --target all --dry-run
  agentforge.sh doctor
EOF
}

# ---------- arg parse ----------
if [[ $# -eq 0 ]]; then usage; exit 0; fi
COMMAND="$1"; shift || true
case "$COMMAND" in
  init|link|doctor) ;;
  help|-h|--help) usage; exit 0 ;;
  *) err "unknown command: $COMMAND"; usage; exit 2 ;;
esac

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path)    PROJECT_PATH="$2"; shift 2 ;;
    --target)  TARGET="$2"; shift 2 ;;
    --name)    NAME="$2"; shift 2 ;;
    --stack)   STACK="$2"; shift 2 ;;
    --owner)   OWNER="$2"; shift 2 ;;
    --build)   BUILD_CMD="$2"; shift 2 ;;
    --test)    TEST_CMD="$2"; shift 2 ;;
    --run)     RUN_CMD="$2"; shift 2 ;;
    --vault)   VAULT_ROOT="$2"; shift 2 ;;
    --link)    LINK_TYPE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force)   FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "unknown arg: $1"; usage; exit 2 ;;
  esac
done

# ---------- resolve defaults ----------
[[ -z "$PROJECT_PATH" ]] && PROJECT_PATH="$(pwd)"
[[ -z "$NAME" ]] && NAME="$(basename "$PROJECT_PATH")"
if [[ -z "$VAULT_ROOT" ]]; then
  VAULT_ROOT="$HOME/repos/LLM/llm-skill-vault/skills"
fi
[[ "$LINK_TYPE" == "auto" ]] && LINK_TYPE="symlink"

# ---------- helpers ----------
get_targets() {
  case "$TARGET" in
    all)    printf '%s\n' "${TARGET_ROWS[@]}" ;;
    claude|codex|generic)
            printf '%s\n' "${TARGET_ROWS[@]}" | grep "^${TARGET}|" ;;
    *)      err "invalid --target: $TARGET"; exit 2 ;;
  esac
}

render_template() {
  local tmpl="$1"
  local today; today="$(date +%Y-%m-%d)"
  sed \
    -e "s|\${PROJECT_NAME}|${NAME}|g" \
    -e "s|\${TECH_STACK}|${STACK}|g" \
    -e "s|\${OWNER}|${OWNER}|g" \
    -e "s|\${REPO_ROOT}|${PROJECT_PATH}|g" \
    -e "s|\${BOOTSTRAP_DATE}|${today}|g" \
    -e "s|\${BUILD_CMD}|${BUILD_CMD}|g" \
    -e "s|\${TEST_CMD}|${TEST_CMD}|g" \
    -e "s|\${RUN_CMD}|${RUN_CMD}|g" \
    "$tmpl"
}

write_doc() {
  local doc="$1" tmpl="$2"
  local tmpl_path="$SCRIPT_DIR/templates/$tmpl"
  local out_path="$PROJECT_PATH/$doc"

  [[ ! -f "$tmpl_path" ]] && { err "template not found: $tmpl_path"; return 1; }

  if [[ -f "$out_path" && $FORCE -eq 0 ]]; then
    warn "$doc already exists — skipping (use --force)"
    return 0
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    dry "would write $out_path"
    return 0
  fi

  render_template "$tmpl_path" > "$out_path"
  ok "wrote $doc"
}

make_link() {
  local dir="$1"
  local dot_dir="$PROJECT_PATH/$dir"
  local link_path="$dot_dir/skills"

  if [[ ! -d "$VAULT_ROOT" ]]; then
    err "vault root not found: $VAULT_ROOT"
    return 1
  fi

  if [[ ! -d "$dot_dir" ]]; then
    if [[ $DRY_RUN -eq 1 ]]; then dry "would mkdir $dot_dir"
    else mkdir -p "$dot_dir"; fi
  fi

  if [[ -e "$link_path" || -L "$link_path" ]]; then
    if [[ $FORCE -eq 0 ]]; then
      warn "$dir/skills already exists — skipping (use --force)"
      return 0
    fi
    if [[ $DRY_RUN -eq 1 ]]; then dry "would remove $link_path"
    else rm -rf "$link_path"; fi
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    dry "would create $LINK_TYPE: $link_path -> $VAULT_ROOT"
    return 0
  fi

  case "$LINK_TYPE" in
    symlink) ln -s "$VAULT_ROOT" "$link_path" ;;
    copy)    cp -R "$VAULT_ROOT" "$link_path" ;;
    none)    warn "link=none — skipping"; return 0 ;;
    *)       err "unsupported --link on Unix: $LINK_TYPE"; return 1 ;;
  esac
  ok "linked $dir/skills ($LINK_TYPE) -> $VAULT_ROOT"
}

# ---------- commands ----------
cmd_init() {
  step "agentforge init"
  echo "  Project : $NAME ($PROJECT_PATH)"
  echo "  Target  : $TARGET"
  echo "  Vault   : $VAULT_ROOT"
  echo "  Link    : $LINK_TYPE"
  [[ $DRY_RUN -eq 1 ]] && echo "  Mode    : DRY RUN"
  echo ""

  if [[ ! -d "$PROJECT_PATH" ]]; then
    if [[ $DRY_RUN -eq 1 ]]; then dry "would mkdir $PROJECT_PATH"
    else mkdir -p "$PROJECT_PATH"; fi
  fi

  while IFS='|' read -r key doc dir tmpl; do
    [[ -z "$key" ]] && continue
    step "target: $key"
    write_doc "$doc" "$tmpl"
    make_link "$dir"
  done < <(get_targets)
}

cmd_link() {
  step "agentforge link"
  while IFS='|' read -r key doc dir tmpl; do
    [[ -z "$key" ]] && continue
    step "target: $key"
    make_link "$dir"
  done < <(get_targets)
}

cmd_doctor() {
  step "agentforge doctor"
  echo "  Project : $PROJECT_PATH"
  echo "  Vault   : $VAULT_ROOT"
  echo ""

  if [[ -d "$VAULT_ROOT" ]]; then
    local n; n=$(find "$VAULT_ROOT" -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ')
    ok "vault present ($n skill folders)"
  else
    err "vault not found: $VAULT_ROOT"
  fi

  for row in "${TARGET_ROWS[@]}"; do
    IFS='|' read -r key doc dir _ <<<"$row"
    local doc_path="$PROJECT_PATH/$doc"
    local link_path="$PROJECT_PATH/$dir/skills"
    local doc_mark="·"; [[ -f "$doc_path" ]] && doc_mark="✓"
    local lnk_mark="·"; [[ -e "$link_path" || -L "$link_path" ]] && lnk_mark="✓"
    printf "  %-8s  doc:%s  link:%s\n" "$key" "$doc_mark" "$lnk_mark"
    if [[ -L "$link_path" ]]; then
      local tgt; tgt="$(readlink "$link_path")"
      printf "             ${c_grey}↳ symlink → %s${c_reset}\n" "$tgt"
    fi
  done
}

case "$COMMAND" in
  init)   cmd_init ;;
  link)   cmd_link ;;
  doctor) cmd_doctor ;;
esac
