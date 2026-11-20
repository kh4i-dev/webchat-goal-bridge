# webchat-goal-bridge — Cầu nối Web-AI Chat ↔ Coding Agent qua CDP

Cầu nối **zero-dependency (Node ≥ 22)** biến tab **ChatGPT / Gemini web đã đăng nhập**
(Brave chạy qua CDP) thành **kênh giao goal cho coding agent**, với vòng lặp 2 chiều:
việc mới vào → tạo goal → runner chạy → **kết quả + file gửi ngược lại chính chat web
để nghiệm thu**.

Gồm 2 phần互补:

| Phần | File | Vai trò |
| :--- | :--- | :--- |
| **wgb (integrated loop)** | `src/` — CLI `node src/cli.js` | Quản lý Brave+CDP (tắt/bật tự động, giữ phiên login), connector ChatGPT (record-first) & Gemini, goal store, runner trực tiếp (echo/exec/opencode/inbox) |
| **file watcher (harness-agnostic)** | `gemini_cdp_watcher.mjs` + `start_*.bat` | Bridge 1 file: tin nhắn mới → `state/inbox/goal_*.json`; `outbox/reply_*.md` → tự gửi vào chat. Agent bất kỳ đọc/ghi file, không cần biết bridge |

> **Nguồn & lịch sử:** rút ra từ cầu nối sống tại `E:\Workspace\Agents\SemanticLab\bridge\`
> (phiên bản chạy thực, xác nhận 2 chiều trên Gemini 2026-11-21). Đã thử
> `Ya-KARAS/AgentControlPlane` trước đó nhưng executor DSH của nó version-lock hash
> nội bộ → tự chế cầu CDP này. Phần wgb tổng hợp cơ chế từ ~13 repo prior art
> (xem `E:\Workspace\References\webchat-bridge-prior-art\` + draft tại
> `E:\Workspace\Ideal\webchat-goal-bridge\PRIOR-ART.md`).

## Trạng thái đã kiểm chứng (2026-11-21, máy thật)

- ✅ `brave on/off/status` — đóng nhẹ lưu session → nạp lại với `--remote-debugging-port=9222 --restore-last-session`; `off` luôn đóng port (port chỉ tạm thời).
- ✅ ChatGPT: probe login, **đọc tin qua record API** (`/backend-api/conversation/<id>`, UI 2026 đã bỏ `data-message-author-role`), gửi tin qua `form.requestSubmit()`/nút submit, chờ reply qua `end_turn`, gửi kết quả ngược lại chat — `submitted=yes`.
- ✅ Goal-loop e2e: `@bridge echo ...` → goal `gmwph2ovrn9yq` tạo tự động → runner chạy → kết quả `[wgb] Goal ...` xuất hiện trong đúng hội thoại ChatGPT.
- ✅ `inbox` runner (file protocol): goal JSON ra `data/inbox/`, nhặt `reply_*.md` từ `data/outbox/` — PASS (`test/inbox-runner.test.mjs`).
- ✅ Gemini: probe login OK (connector DOM `user-query`/`model-response`/`rich-textarea` — selector trùng với watcher đang sống).

## Kiến trúc

```
Bạn (ChatGPT/Gemini web, tab đã đăng nhập trong Brave)
        │  CDP :9222 (tạm thời; brave off = đóng port)
        ▼
┌─────────────────────────────────────────────────────────┐
│ wgb watch --platform chatgpt|gemini                     │
│   ① poll tin nhắn mới (record API / DOM)                │
│   ② tin bắt đầu bằng trigger "@bridge" → tạo goal       │
│   ③ runner: echo | exec | opencode | inbox              │
│   ④ gửi kết quả ngược vào chat ([wgb] Goal ...: ...)    │
└─────────────────────────────────────────────────────────┘
        │ (runner = inbox)                    ▲
        ▼                                     │ reply_*.md
  data/inbox/goal_*.json ──► AGENT BẤT KỲ ────┘
  (cùng giao thức với gemini_cdp_watcher.mjs / SemanticLab bridge)
```

## Cách chạy

### A — Vòng lặp tích hợp (wgb)

```powershell
node src/cli.js brave on                        # bật Brave + CDP (tự đóng nhẹ Brave cũ)
node src/cli.js probe --platform chatgpt        # kiểm tra login + composer
node src/cli.js watch --platform chatgpt        # vòng lặp nhận việc (mặc định runner echo)
# trong tab chat, gõ:  @bridge <việc cần làm>
# tới hạn:  @bridge status
node src/cli.js goals --short                   # xem goal store (data/goals.json)
node src/cli.js brave off                       # xong phiên: đóng CDP, trả Brave về bình thường
```

Chọn runner trong `config.json`:

```json
{ "runner": { "type": "inbox", "inbox": "data/inbox", "outbox": "data/outbox", "timeoutMs": 900000 } }
```

- `echo` — trả lại chính task (test vòng lặp, không tốn token).
- `exec` — chạy `cfg.runner.command` (chèn `{task}`), ví dụ chạy test/script.
- `opencode` — gọi `opencode run "<task>"` trong `cfg.runner.cwd` (harness thật).
- `inbox` — ghi goal JSON ra `data/inbox/`, chờ agent bất kỳ viết `reply_*.md` vào `data/outbox/`.

### B — File watcher 1 file (Gemini, dùng riêng)

1. **Mở Brave với CDP**: nhấn đúp `start_brave_cdp.bat` (nếu Brave đang mở sẵn KHÔNG có
   flag, phải đóng hết trước — flag chỉ áp dụng khi process khởi động; hoặc dùng
   `node src/cli.js brave on` để tự động hóa bước này).
2. **Chạy watcher**: `start_watcher.bat` (hoặc `node gemini_cdp_watcher.mjs`).
3. **Giao goal**: gõ tin nhắn trong tab khớp `--url-pattern`. Tin mới đầu tiên sau khi
   watcher khởi động chỉ được *ghi nhớ* (chống phát nổ khi restart) — **tin thứ hai trở
   đi** mới thành goal file. Ảnh trong tin được tải về `inbox/` kèm goal.
4. **Nhận báo cáo**: agent viết `.md` vào `outbox/` → watcher tự gõ + Gửi → `.sent`
   (thất bại → `.failed-<lý do>`).

## CLI reference (wgb)

```
brave on|off|status     Quản lý Brave + CDP (off luôn đóng port)
tabs [--url <substr>]   Liệt kê tab
probe --platform <p>    Login + composer + rate-limit
read  --platform <p>    Đọc tin (--last N) — record-first
send  --platform <p>    Gửi 1 tin + chờ reply (--new = chat mới, --url = chọn tab)
watch --platform <p>    Vòng goal-loop (--once, --catchup, --trigger, --url)
goals [--short]         Goal store
runners                 Runner có sẵn
```

Platform: `chatgpt`, `gemini`. Flags chung: `--json`, `--url <substr>`.

## Protocol file (dùng chung cho cả 2 phần)

| File | Ý nghĩa |
| :--- | :--- |
| `inbox/goal_<ts>.json` | `{id, ts, source, text, images[], tab_url}` — goal mới; xử lý xong đổi đuôi `.processed` |
| `inbox/goal_<ts>_imgN.png` | Ảnh đính kèm (base64 decode từ dataURL) |
| `outbox/reply_<ts>.md` | Agent muốn gửi ngược vào chat; `.sent` = đã gửi |
| `data/goals.json` (wgb) | Goal store: `queued → running → done/failed` + result |
| `state.json` (watcher) | Hash tin cuối + prefix reply đã gửi (chống echo) |

## Chống echo-loop (bài học đắt)

Reply agent gửi vào chat **tự động trở thành "tin nhắn user mới"** ở lần poll kế —
nếu không chặn sẽ tạo vòng lặp vô hạn goal. wgb chặn bằng: bỏ qua tin user bắt đầu
bằng `replyPrefix` (`[wgb]`); watcher chặn bằng 2 lớp: nhớ 60 ký tự đầu mỗi reply đã
gửi (`sentPrefixes`) + cooldown 30s sau khi gửi.

## Cơ chế chống DOM-drift (tổng hợp từ prior art)

- **Record là nguồn sự thật, DOM chỉ là bàn phím** (theo `chatgpt-use`): đọc tin/đếm
  turn/xong-turn từ `/backend-api/conversation/<id>` (bearer cache 5 phút trong
  `window.__wgbTok`); DOM chỉ dùng khi chưa có conversation id.
- **Composer**: không bao giờ `innerHTML`; focus + `selectAll` + `execCommand('insertText')`
  từng khúc ≤1500 ký tự + fingerprint trước submit (đoạn đa dòng không bị chẻ).
- **Submit ladder**: `form.requestSubmit()` → `button[type=submit]` → nút có label
  send đa ngôn ngữ (UI 2026 bỏ `data-testid="send-button"`, label tiếng Việt "Gửi")
  → Enter synthetic. Sau submit **phải có receipt** (số user-turn tăng qua record);
  `submitted=unknown` thì KHÔNG BAO GIỜ tự gửi lại.
- **Tab nền bị freeze**: `Target.activateTarget` trước khi attach/evaluate, nếu không
  `Runtime.evaluate` treo tới khi tab được rã đông.

## Điểm hỏng thường gặp

| Triệu chứng | Nguyên nhân / cách xử lý |
| :--- | :--- |
| `fetch failed` / `ECONNREFUSED 9222` | Brave không mở bằng flag CDP → `node src/cli.js brave on` |
| Lệnh treo 1-3 phút rồi mới xong | Tab đang nền bị freeze → đã tự `activate`; nếu vẫn chậm, click tab 1 lần |
| `ambiguous-editors` / `no-editor` | ChatGPT đổi composer → sửa `COMPOSER_SELECTOR` trong `src/connectors/chatgpt.js` |
| `DOM pattern lạ — dump` (watcher) | Trang đổi cấu trúc → xem `debug/dom_snapshot.txt`, sửa `EXTRACT_JS` |
| `send_button_not_found` | Nút Gửi đổi label → sửa regex trong `SEND_JS` / `exprSubmit` |
| Goal file sinh với NỘI DUNG reply của mình | Echo chưa chặn hết → kiểm tra `replyPrefix` / `sentPrefixes` trong state |

## Bảo mật

- CDP `:9222` cho phép **mọi process local** điều khiển toàn bộ browser — chỉ bật trên
  máy cá nhân; `brave off` (hoặc đóng Brave) khi không dùng. Không chạy port này khi
  duyệt web không tin cậy cùng lúc.
- Bridge không đọc/ghi cookie, không đăng nhập hộ — mọi thứ diễn ra trong phiên đăng
  nhập sẵn của bạn. Tự động hóa giao diện web có thể chạm điều khoản dịch vụ của nền
  tảng: giữ tốc độ chậm (poll ≥ 8s), opt-in bằng trigger `@bridge`, dừng khi bị rate-limit.

## Roadmap

- [ ] P1: throttle file + pace ledger (5/15/30 phút escalation — theo `chatgpt-use`); ACK/NACK read-back cho kết quả; upload file nghiệm thu; Gemini qua record `batchexecute`.
- [ ] P2: map goal store ↔ goal MCP của harness (`.claude/goal/goal_state.json`); multi-project routing `#slug`; nhiều instance song song (mỗi nền tảng 1 watcher, tách `--inbox/--outbox/--state`).
- [ ] Ý tưởng: webui nhỏ xem goal + nghiệm thu 1 nút (accept / changes-requested).

## Credits

Tổng hợp cơ chế từ: `chatgpt-use`, `aegisloop`, `auto-chat`, `AgentControlPlane`,
`OLmatter-chatgpt-bridge`, `DrA1ex-chatgpt-bridge`, `codex-chatgpt-control`,
`agentify/desktop`, `OpenBrowser`, `Gemini-API`, `uniqlaw`, `agent-anywhere`, `AgEnD`
(clone tại `E:\Workspace\References\webchat-bridge-prior-art\`). Cầu sống gốc:
`E:\Workspace\Agents\SemanticLab\bridge\`.
