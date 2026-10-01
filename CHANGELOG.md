# Changelog

## 0.1.1

- Interactive Telegram first-run setup: only a bot token is required; `chat_id` is captured after you message the bot (`getUpdates`), shown for confirmation, then saved
- New CLI flag: `npx omo-slim-plan --setup-telegram`
- `--telegram-token` without `--telegram-chat-id` now auto-enters interactive setup after install
- Event `test` bypasses webhook event filters so the setup test notification can always verify config
- New helper module `plugin/planflow-telegram.mjs` (getMe / getUpdates / confirm / save / test send)

## 0.1.0

- Initial public release: plan-first workflow for OpenCode + oh-my-opencode-slim
- Commands: `/plan`, `/start-work`, `/plan-review`
- Skill `plan-workflow` (`.plans/` contract, human gates, checkbox progress)
- Plugin `planflow` + notify CLI + extensible providers (`telegram` / `generic` / `command`)
- npx installer (zero runtime deps)
