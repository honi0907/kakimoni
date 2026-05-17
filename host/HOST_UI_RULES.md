# Host UI size/layout memo (V2)

Updated: 2026-05-16

## Current fixed rules
- Parent host window size is `1280x960` (`kakimoni-host/main.js`).
- Edit source is `kakimoni/host/public/host/index.html`.
- Served file is `kakimoni/public/host/index-v2.html` (copy sync required after edits).

## Seat card area (initial size)
- Initial grid layout:
  - `#seats-grid { grid-template-columns: repeat(5, 1fr); }`
  - `#seats-grid { grid-template-rows: repeat(2, auto); }`
- Initial spacing:
  - `padding: 16px;`
  - `gap: 12px;`
- Keep top alignment:
  - `align-items: start;`

## Action board rules
- ID-only row is removed.
- Layout is:
  - Left: `選択` (top), `正誤` (bottom)
  - Right: `ロック`
- Action button square size is fixed:
  - `--sact-cell-size: 60px;`
  - JS clamp is fixed to `60` (`SACT_BTN_SIZE_MIN/MAX = 60`).

## Exit button rule
- Top-right control button: `ソフト終了`
- Style family: same blue style as `全選択` etc.
- On click: confirm dialog `終わりますか？`
- Confirm OK -> call Electron IPC `quit-app` via `window.kmHost.quitApp()`.

## If size needs change later
- Seat card area: adjust `#seats-grid` `padding/gap` and track count.
- Action board button size: change `--sact-cell-size` and `SACT_BTN_SIZE_MIN/MAX` together.
