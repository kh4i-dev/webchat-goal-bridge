---
name: webchat-goal-bridge
description: Giao việc cho agent qua chat web (ChatGPT/Gemini/Claude) hoặc nhận việc từ chat web qua cầu wgb — dùng khi user nói "giao việc qua chat", "gửi goal lên chat", "nghiệm thu qua ChatGPT/Gemini", "extension wgb", "wgb serve", hoặc cần dispatch task sang agent khác qua cầu CDP.
---

# webchat-goal-bridge — cầu nối chat web ↔ agent

Chat web (đã đăng nhập trong Brave, CDP :9222) = **não chỉ đạo**; agent local = **tay chân**.
Vòng: người dùng/não gõ `@wgb <task>` trong chat → extension dispatch → goal chạy →
kết quả `[wgb] Goal <id>: …` tự gửi ngược vào chat để duyệt.

## Cách agent (bạn) nhận việc qua cầu

1. **File protocol (khuyên dùng — harness-agnostic):** theo dõi `data/inbox/goal_*.json`
   (`{id, ts, source, text}`), làm việc, viết kết quả vào `data/outbox/reply_<id>.md`.
   Xong thì đổi goal file thành `.processed`.
2. **Control plane HTTP:** `POST http://127.0.0.1:8787/dispatch` với header
   `x-wgb-token` (token trong `config.json` → field `serve.token`) và body
   `{"text": "<task>"}` → nhận `{goalId}` → poll `GET /goals/<goalId>` tới
   `done|failed`, kết quả nằm ở `.result`.
3. **Gọi trực tiếp CLI:** `node src/cli.js dispatch-less flows`: `watch` (daemon),
   `serve` (control plane), `goals`, `read/send` (thao tác chat thủ công).

## Quy tắc BẮT BUỘC

- **Không bao giờ vượt security gate**: task chứa lệnh phá hệ thống/đọc secret
  (denylist trong `src/security.js`) sẽ bị chặn — đó là hành vi đúng, đừng thử cách quanh.
- Không đưa secrets/API key vào task text hoặc reply file.
- Khi goal failed: đọc `error` trong goal, sửa task rồi dispatch lại — đừng đoán mò.
- Giữ nhịp: extension đã tự pacing (1 request/tin + budget 40/giờ) — không tự ý tăng poll.
- Trước khi dừng phiên có goal đang chạy: ghi HANDOFF (agents-shared) để cầu resume.
