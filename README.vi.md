<div align="center">

# webchat-goal-bridge (wgb)

**Biến tab ChatGPT / Gemini / Claude đã đăng nhập thành điều khiển từ xa cho
coding agent trên máy bạn — và gửi kết quả ngược lại chính cuộc chat để nghiệm thu.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)
[![Chat platforms](https://img.shields.io/badge/chat-ChatGPT%20%7C%20Gemini%20%7C%20Claude-black.svg)](#c%C3%A1ch-ch%E1%BA%A1y-nhanh)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-orange.svg)](#%C4%91%C3%B3ng-g%C3%B3p)

[English](README.md) · [Tiếng Việt](README.vi.md)

*Không cần API key. Không đăng ký thêm gì. Web chat bạn đang dùng hàng ngày thành
bộ não; agent trên máy thành tay chân — với vòng nghiệm thu khép kín.*

</div>

---

## Tại sao?

Các model mạnh trong web chat — **kể cả gói free** — rất giỏi lập kế hoạch và
nghiệm thu, nhưng không đụng được vào máy bạn. Coding agent trên máy thì chạy
được thật, nhưng mất đi vòng lặp hội thoại nơi bạn (hoặc chính chat) chỉ đạo,
soi và duyệt từng bước.

**wgb nối hai bên lại:**

```
Bạn + web chat (não chỉ đạo) ──@bridge <việc>──►  wgb  ──►  runner trên máy (tay chân)
        ▲                                                         │
        └─────────── "[wgb] Goal <id>: <kết quả>" ────────────────┘
                      gửi ngược vào đúng cuộc chat để duyệt
```

Khác với phần lớn bridge cùng loại (one-way, cần API key), wgb là **2 chiều có
vòng nghiệm thu**, và được thiết kế xoay quanh những lỗi thật giết chết các dự
án tương tự: rate-limit của nền tảng, DOM drift, và echo-loop của reply.

## Kiến trúc

```
 Bạn (tab ChatGPT / Gemini / Claude đã đăng nhập)
        │  gõ:  @bridge <việc>          (hoặc @wgb qua extension)
        ▼
┌───────────────────────────────────────────────────────────┐
│ webchat-goal-bridge                                       │
│  ① phát hiện tin nhắn có trigger (CDP watch / extension)  │
│  ② security gate: denylist + allowlist vùng làm việc      │
│  ③ runner: echo │ exec │ opencode │ inbox                 │
│  ④ tự gõ + Gửi "[wgb] Goal <id>: <kết quả>"               │
└───────────────────────────────────────────────────────────┘
        │ (runner = inbox)                        ▲
        ▼                                         │ reply_*.md
  data/inbox/goal_*.json ──► AGENT BẤT KỲ ────────┘
```

Goal chạy qua một máy trạng thái nhỏ (`queued → running → done/failed`, lưu ở
`data/goals.json`) — xem lại mọi lần chạy bằng `node src/cli.js goals`.

## Yêu cầu

- **Node ≥ 22** (global `fetch` / `WebSocket` — zero npm dependency, không cần `npm install`)
- **Brave** (Chromium nào cũng chạy được luồng CDP; `brave on/off` mặc định trỏ Brave)
- Windows cho các file `.bat` chạy nhanh; phần CLI là ESM Node thuần, chạy ở đâu có Node cũng được

## Cách chạy nhanh

### A — Vòng lặp tích hợp (CDP watch, ChatGPT / Gemini)

```bash
git clone https://github.com/kh4i-dev/webchat-goal-bridge
cd webchat-goal-bridge
cp config.example.json config.json      # Windows: copy config.example.json config.json

node src/cli.js brave on                # nạp lại Brave với CDP port TẠM THỜI, giữ nguyên phiên login
node src/cli.js probe --platform chatgpt   # kiểm tra login + composer
node src/cli.js watch --platform chatgpt   # bật vòng lặp nhận việc
```

Rồi gõ trong tab chat:

```
@bridge liệt kê TODO trong repo này và ghi ra TODO.md
@bridge status          ← xem goal đang chạy, không tốn token
```

Xong phiên: `node src/cli.js brave off` (luôn đóng CDP port).

### B — Chế độ extension (thêm claude.ai)

Extension MV3 `wgb-companion` nghe **ngay trong tab chat** và dispatch qua HTTP
về `wgb serve` — không cần CDP, hoạt động trên chatgpt.com, gemini.google.com
**và claude.ai**.

1. Chạy control plane: `node src/cli.js serve` → nghe `127.0.0.1:8787`, tự sinh
   token auth vào `config.json`.
2. Brave → `brave://extensions` → bật **Developer mode** → **Load unpacked** → chọn thư mục `extension/`.
3. Mở tab chat — thấy pill `wgb` góc dưới phải. Dán token từ `config.json` vào popup.
4. Gõ `@wgb <việc>` (hoặc `@wgb status`). Kết quả được tự gõ + Gửi ngược lại.

### C — File watcher độc lập (harness-agnostic)

`gemini_cdp_watcher.mjs` là bridge 1 file dùng thuần **giao thức file**: tin
nhắn mới thành `inbox/goal_*.json`, agent nào viết `outbox/reply_*.md` là được
tự gõ + Gửi vào chat. Dùng khi agent không gọi được HTTP hay CLI — chỉ cần đọc/ghi file.

## Runner

Chọn trong `config.json`:

```json
{ "runner": { "type": "inbox", "inbox": "data/inbox", "outbox": "data/outbox", "timeoutMs": 900000 } }
```

| Runner | Hành vi |
| :--- | :--- |
| `echo` | Trả lại chính task — test trọn vòng lặp, không tốn gì |
| `exec` | Chạy `cfg.runner.command` với `{task}` được chèn vào (script, test suite) |
| `opencode` | Gọi `opencode run "<task>"` trong `cfg.runner.cwd` — harness coding thật |
| `inbox` | Ghi goal JSON ra `data/inbox/`, chờ `reply_*.md` trong `data/outbox/` — giao thức chạy với agent bất kỳ |

## CLI reference

```
brave on|off|status     Quản lý Brave + CDP port (tạm thời; off luôn đóng port)
tabs [--url <substr>]   Liệt kê tab Brave đang mở qua CDP
probe --platform <p>    Kiểm tra login + composer
read  --platform <p>    Đọc tin gần nhất (--last N) — record-first trên ChatGPT
send  --platform <p>    Gửi 1 tin và chờ reply (--new, --url, --image a.png,b.png)
watch --platform <p>    Vòng goal-loop (--once, --catchup, --trigger, --url)
goals [--short]         Xem goal store
runners                 Liệt kê runner có sẵn
serve                   Control plane HTTP cho extension (127.0.0.1:8787)
```

Platform: `chatgpt`, `gemini` (claude.ai qua extension). Flag chung: `--json`, `--url <substr>`.

## Giao thức file

Dùng chung cho runner `inbox` và file watcher độc lập:

| File | Ý nghĩa |
| :--- | :--- |
| `inbox/goal_<ts>.json` | `{id, ts, source, text, images[], tab_url}` — goal mới; xử lý xong đổi đuôi `.processed` |
| `inbox/goal_<ts>_imgN.png` | Ảnh đính kèm (base64 decode từ dataURL) |
| `outbox/reply_<ts>.md` | Báo cáo agent gửi ngược về chat; `.sent` = đã gửi, `.failed-<lý do>` = lỗi |
| `data/goals.json` (wgb) | Goal store: `queued → running → done/failed` + kết quả |
| `state.json` (watcher) | Hash tin cuối + prefix reply đã gửi (chống echo) |

## Độ bền — those lessons were expensive

Tổng hợp từ prior art, mỗi mục đều trả giá bằng lỗi thật:

- **Record-first, DOM chỉ là bàn phím.** Đọc tin ChatGPT qua
  `/backend-api/conversation/<id>` (UI 2026 đã bỏ attribute đánh dấu role); DOM
  chỉ dùng để gõ và bấm.
- **Submit phải có receipt.** Sau khi gửi, số user-turn **phải** tăng. Nếu trạng
  thái submit là `unknown`, wgb **không bao giờ** tự gửi lại — không tin nhắn trùng.
- **Chống echo-loop.** Reply của bridge tự thành "tin user mới" ở lần poll kế —
  bị lọc bằng reply prefix (`[wgb]`), nhớ prefix đã gửi, và cooldown — không bao
  giờ lặp goal vô hạn.
- **Rate-limit là ngân sách.** Bắt tin event-driven (nghe submit của form = 0
  request), đúng **1 record fetch / 1 tin**, safety-net poll 60 s, ledger theo
  giờ (40 loads / 40 sends) tự tạm dừng khi vượt, backoff luỹ thừa tôn trọng
  `Retry-After`, dedupe theo nội dung. Chỉ thao tác SPA — không bao giờ reload
  cả trang (1 lần reload ChatGPT tốn ~45 backend request vs 1 khi làm in-place).
- **Tab nền bị freeze.** Tab nền bị memory saver đóng băng; `Target.activateTarget`
  chạy trước mọi evaluate, nếu không `Runtime.evaluate` treo hàng phút.
- **Nút Gửi nào cũng bấm được.** Regex đa ngôn ngữ (vd. tiếng Việt "Gửi") trên
  một submit ladder: `form.requestSubmit()` → `button[type=submit]` → khớp label
  → Enter synthetic.

## Bảo mật

- **Task gate.** Denylist (xoá đĩa, shutdown, sửa registry, đường dẫn credential…)
  chặn task nguy hiểm **trước khi** runner nào chạy. Từ phủ định bị strip trước,
  nên *"do not run rm -rf"* không tự whitelist chính nó được.
- **Allowlist vùng làm việc.** cwd của runner phải nằm trong `runner.allowedRoots`
  — path từ chat không bao giờ được tin.
- **Control plane có token.** `wgb serve` tự sinh token vào `config.json`;
  extension phải xuất trình token mới dispatch được.
- **Audit trail.** Mọi dispatch và mọi lần gate chặn đều được ghi vào `data/events.jsonl`.
- **Thực tế CDP.** Port `9222` cho phép **mọi process trên máy** điều khiển toàn
  bộ browser — chỉ dùng trên máy cá nhân, `brave off` khi xong, không duyệt web
  không tin cậy trong lúc CDP đang bật.
- **Điều khoản dịch vụ.** Tự động hoá UI web có thể vi phạm ToS của nền tảng.
  Giữ nhịp chậm, trigger là opt-in (`@bridge`), dừng khi bị rate-limit. Bạn tự
  chịu trách nhiệm về cách sử dụng.

## Trạng thái

| Năng lực | Trạng thái |
| :--- | :--- |
| ChatGPT 2 chiều (record API + submit ladder + reply) | ✅ verify e2e trên máy thật |
| Gemini 2 chiều (DOM connector) | ✅ verify trên cầu sống |
| Claude qua extension (DOM) | 🟡 best-effort — claude.ai đổi DOM thường xuyên; chưa test kỹ |
| Runner `exec` / `opencode` trên Windows | ✅ |
| macOS / Linux | ❔ chưa test — phần lõi là Node ESM thuần; helper `brave` + `.bat` riêng cho Windows |

Chạy test (zero dependency, `node:test`):

```bash
npm test
```

## FAQ

**Có cần API key không?**
Không. wgb dùng tab chat bạn đã đăng nhập sẵn — gói free dùng được.

**Hỗ trợ model nào?**
Bất cứ model nào trong tab của bạn. ChatGPT và Gemini đã verify; claude.ai chạy
qua extension (best-effort).

**Sao không dùng API chính chủ?**
Dùng được — project này sinh ra cho một vòng lặp khác: để chính *web chat*
(kể cả gói free, với đủ context và lịch sử của bạn) chỉ đạo công việc trên máy,
nghiệm thu ngay trong cùng cuộc hội thoại, và lặp tới khi được duyệt.

**Chỉ chạy trên Windows?**
Lõi CLI là Node ≥ 22 thuần. Đã verify trên Windows 11 + Brave; helper `brave
on/off` và các file `.bat` mặc định Windows, nền tảng khác chưa test.

## Roadmap

- [ ] Pace ledger cho file watcher độc lập; ACK/NACK read-back cho kết quả
- [ ] Upload file cho luồng nghiệm thu; Gemini qua `batchexecute`
- [ ] Map goal store ↔ goal state của harness (vd. `.claude/goal/goal_state.json`)
- [ ] Multi-project routing (`#slug`) và nhiều instance song song (inbox/outbox/state tách theo nền tảng)
- [ ] WebUI nhỏ: xem goal, nghiệm thu 1 nút (accept / changes-requested)

## Đóng góp

Issue và PR đều được hoan nghênh! Giữ ràng buộc zero-dependency (chỉ Node
stdlib) — đó là một tính năng. Chạy `npm test` trước khi gửi PR.

## Credits

wgb tổng hợp cơ chế từ ~13 repo prior art mã nguồn mở:
`chatgpt-use`, `aegisloop`, `auto-chat`, `AgentControlPlane`,
`OLmatter-chatgpt-bridge`, `DrA1ex-chatgpt-bridge`, `codex-chatgpt-control`,
`agentify/desktop`, `OpenBrowser`, `Gemini-API`, `uniqlaw`, `agent-anywhere`, `AgEnD`.

## License

[MIT](LICENSE)

---

<div align="center">

Nếu wgb giúp bạn bớt qua lại giữa các tab, một ⭐ giúp người khác tìm thấy nó.

</div>
