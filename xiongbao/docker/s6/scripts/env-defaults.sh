#!/bin/sh
# The image's defaults, for the container's own environment, and the refusal of settings still under the
# names they had before v0.2.16. Runs as a oneshot before everything that reads the environment, because
# s6 services see only what is in this directory.
#
# THE IMAGE'S DEFAULTS COME FIRST AND COUNT LEAST. Each `<X>=<value>` line of the defaults file
# (`#` starts a comment) is written as XIONGBAO_<X> only when XIONGBAO_<X> is not set. As an image ENV it
# would win over a customer's own setting: RLS_ENFORCE=warn turned back into refuse.
# An entry right after a line that is exactly `#third-party` is a third party's own variable name and has no
# XIONGBAO_ counterpart: it is written as it is, only when that name is not set.
# A missing defaults file is skipped.
#
# SETTINGS UNDER THE OLD PREFIX ARE REFUSED, NOT READ. v0.2.16 read every setting under both prefixes and
# its upgrade sheet renamed the lines; this release reads only the new one and is reached only from v0.2.16.
# One of the product's settings (the list below, the same as PRODUCT_SETTINGS in shared/env-name.ts, which a
# test holds this file to; plus the BUILD_ and POOL_ families) under the old prefix, with a value whose new
# name is unset or empty, is something the deployment relies on and this release would silently drop, so
# the container stops here, naming each one (never a value). One set under both names is not refused: the
# new one is in effect, as it was in v0.2.16. Another tool's variable that only shares the old prefix is not
# a setting and is left alone. The server, the worker and the other processes refuse the same settings
# themselves (shared/env-name.ts).
#
# Usage: env-defaults.sh [dir] [defaults-file]
#   dir            default /run/s6/container_environment
#   defaults-file  default /etc/xiongbao/defaults.env (s6 passes neither; the tests pass both)
set -eu
dir=${1:-/run/s6/container_environment}
defaults=${2:-/etc/xiongbao/defaults.env}
[ -d "$dir" ] || exit 0
old=OPENBOT_
settings='
ACCEPT_WITH_READS ACCESSIBILITY_DISABLED ACP_ADAPTERS_DIR ACP_STATE_DIR AGENT_DESKTOP_BINARY
AGENT_MODEL_COMPUTER_URL AGENT_MODEL_PROXY AGENT_MODEL_PUBLIC_URL AGENT_MODEL_RATE_PER_MINUTE
AGENT_MODEL_TOKEN APP_URL ARCH AUTO_COMPACTION BROKER_PROVIDER CARD_AUTOCLAIM
CHAT_SERVER_COMPUTER_TOOLS COMMAND_INLINE_BYTES CONTENT_BIND CONTENT_DOMAIN CONTENT_HOST_PORT
CONTENT_PORT CRAWL_CONTAINER_URL CRAWL_TOKEN CRAWL_URL CREDENTIAL_LOCK DATABASE_WAIT_HINT
DATABASE_WAIT_SECONDS DELIVER_ENDS_TURN DELIVER_NUDGE DEPLOYMENT DESKTOP_ENGINE DESKTOP_HELPER
DESKTOP_HOST_TOKEN DEV_NO_AUTH DISTRIBUTION EDITION EMBEDDING_API_KEY EMBEDDING_BASE_URL
EMBEDDING_MODEL ENGINE FASTPATH_CHECK_GATE GENERATIVE_UI GROUP_TURN_WORKERS GROUP_UPGRADE
HEADLESS_ANSWER_FORMAT HEARTBEAT HEAVY_TASK_ROUTING HOST_GATEWAY IMAGE IMAGE_API_KEY IMAGE_BASE_URL
IMAGE_MODEL INBOUND_EMAIL_DOMAIN INBOUND_EMAIL_SNS_TOPIC_ARNS IN_CONTAINER LEARNING_MODEL_TOKEN
LOCAL_COMPUTER_DIR LOCAL_LEARNING MAX_PARALLEL_CARDS MEMORY_CORRECTIONS MEMORY_EXTRACT MEMORY_EXTRACT_PER_DAY
MEMORY_INJECT_CHARS MEMORY_SOURCE_DEFAULTS MEMORY_STICKY MERGE_COMMANDS MODEL_CAPABILITIES_URL
MODEL_NET_RETRY MODEL_OAUTH_FILE NPM_REGISTRY NUDGE_WHOLE_TURN ONE_COMPUTER_EACH OPENAI_API
ORGANIZATION_AUTH_URL OS_VERSION OTEL_EXPORT PARALLEL_TOOLS PERSONAL_MEMORY PHYSICAL_GATE
PLAN_WITH_ACTION PLATFORM PORT PROACTIVE_DEFAULTS PROMPT_SLIM PUBLIC_URL QUIET_BUILD_OUTPUT
QUIET_HOURS READ_INLINE_BYTES RETRO_CARD_MIN_STEPS RETRO_MIN_STEPS RETRO_PER_DAY
RETRO_TOTAL_TIMEOUT_MS RLS_ENFORCE RUNNER_BINARY RUNNER_DATA_DIR SEARCH_CONTAINER_URL
SEARCH_PROVIDER SEARCH_URL SEARXNG_SECRET SELF_HOST_BANNER SERVER_USER SINGLE_USER
SKILLS_PER_EMPLOYEE SKILL_CHOOSE_CACHE TAG TENANT_FRAME_GUARD TESTS_PASSED_HINT
THIS_MACHINE_CONTAINER_HOST THIS_MACHINE_HOST TOOL_URL TURN_FOLD TURN_FOLD_BRIEF
TURN_FOLD_BUDGET_TOKENS TURN_FOLD_CALLS TURN_NOTICE_WINDOW_SECONDS UPDATE_OPERATION VERIFY_NUDGE
VERSION VIDEO_API_KEY VIDEO_BASE_URL VIDEO_MODEL VIDEO_PROVIDER WORKING_EVENT_TYPES
'

refused=''
for file in "$dir/$old"*; do
  [ -f "$file" ] && [ -s "$file" ] || continue
  name=${file##*/}
  suffix=${name#"$old"}
  case $suffix in
    BUILD_?* | POOL_?*) ;;
    *) case " $(echo $settings) " in *" $suffix "*) ;; *) continue ;; esac ;;
  esac
  [ -s "$dir/XIONGBAO_$suffix" ] && continue
  refused="$refused${refused:+, }$name"
done
if [ -n "$refused" ]; then
  echo "这些设置还是 v0.2.16 之前的旧名，这个版本不再读取，不启动：$refused。这个版本只能从 v0.2.16 升级上来：请先升级到 v0.2.16（按它的升级单把旧名改成新名），或者把每一行改成 XIONGBAO_ 开头的同名设置后再启动。" >&2
  exit 1
fi

if [ -f "$defaults" ]; then
  own=
  while IFS= read -r entry || [ -n "$entry" ]; do
    case $entry in
      '#third-party') own=1; continue ;;
      '' | '#'*) continue ;;
    esac
    suffix=${entry%%=*}
    [ -n "$suffix" ] && [ "$suffix" != "$entry" ] || { own=; continue; }
    if [ -n "$own" ]; then
      own=
      [ -e "$dir/$suffix" ] || printf %s "${entry#*=}" > "$dir/$suffix"
      continue
    fi
    [ -e "$dir/XIONGBAO_$suffix" ] || printf %s "${entry#*=}" > "$dir/XIONGBAO_$suffix"
  done < "$defaults"
fi
