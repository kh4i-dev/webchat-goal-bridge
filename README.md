# webchat-goal-bridge — Cầu nối Web-AI Chat ↔ Coding Agent qua CDP

Cầu nối tự chế (không dependency, 1 file Node) biến một tab **web-AI chat bất kỳ**
(đã thử trên `gemini.google.com`) thành **kênh giao goal cho coding agent**, với
vòng lặp 2 chiều: goal đi vào `inbox/`, báo cáo đi ra qua `outbox/`.

> Nguồn ý tưởng: rút ra từ cầu nối sống tại `E:\Workspace\Agents\SemanticLab\bridge\`
> (phiên bản chạy thực, đã xác nhận 2 chiều trên Gemini ngày 2026-11-21).
> Repo tham khảo đã thử trước đó: `Ya-KARAS/AgentControlPlane` — executor DSH của nó
> version-lock hash nội bộ nên không dùng được với mọi bản DSH → tự chế cầu CDP này.

## Kiến trúc

```
Tab chat web (Gemini, đăng nhập sẵn trong Brave)
        │  Chrome DevTools Protocol (CDP) qua --remote-debugging-port=9222
        ▼
gemini_cdp_watcher.mjs  (poll 4s/lần)
        │  DOM: <user-query> / <model-response> + composer rich-textarea
        ├── tin nhắn user MỚI ──► inbox/goal_<ts>.json (+ ảnh tải qua in-page fetch)
        └── outbox/reply_*.md ──► tự insertText + click Send trong trang
```

Agent (hoặc bất kỳ process nào) đọc `inbox/`, làm việc, viết báo cáo vào `outbox/` —
không cần API key, không cần login từ phía agent, credential ở nguyên trong browser.

## Cách chạy

1. **Mở Brave với CDP** (bắt buộc, mỗi lần dùng): nhấn đúp `start_brave_cdp.bat`
   (tương đương `brave.exe --remote-debugging-port=9222 --restore-last-session`).
   Lưu ý: nếu Brave đang mở sẵn KHÔNG có flag, phải đóng hết trước — flag chỉ áp dụng
   khi process khởi động.
2. **Chạy watcher**: nhấn đúp `start_watcher.bat` (hoặc `node gemini_cdp_watcher.mjs`).
3. **Giao goal**: gõ tin nhắn trong tab chat khớp `--url-pattern` (mặc định
   `gemini.google.com/app`). Tin nhắn mới đầu tiên sau khi watcher khởi động chỉ được
   *ghi nhớ* (chống phát nổ khi restart) — **tin nhắn thứ hai trở đi** mới thành goal file.
   Kèm ảnh: ảnh trong tin nhắn được tải về `inbox/` kèm goal.
4. **Nhận báo cáo**: agent viết file `.md` vào `outbox/` → watcher tự gõ vào khung chat
   và bấm Gửi → file đổi tên `.sent` (thất bại → `.failed-<lý do>`).

## Protocol file

| File | Ý nghĩa |
| :--- | :--- |
| `inbox/goal_<ts>.json` | `{id, ts, source, text, images[], tab_url}` — goal mới chờ xử lý; xử lý xong đổi đuôi `.processed` |
| `inbox/goal_<ts>_imgN.png` | Ảnh đính kèm (base64 decode từ dataURL) |
| `outbox/reply_<ts>.md` | Nội dung agent muốn gửi ngược vào chat; `.sent` = đã gửi |
| `state.json` | Hash tin nhắn cuối + prefix reply đã gửi (chống echo-loop) |

## Chống echo-loop (bài học đắt)

Reply agent gửi vào chat **tự động trở thành "tin nhắn user mới"** ở lần poll kế —
nếu không chặn sẽ tạo vòng lặp vô hạn goal. Cầu xử lý bằng 2 lớp:
1. Ghi nhớ 60 ký tự đầu của mỗi reply đã gửi (`sentPrefixes`) — tin nhắn chứa prefix đó bị bỏ qua;
2. Cooldown 30 giây sau mỗi lần gửi.

## Điểm hỏng thường gặp

| Triệu chứng | Nguyên nhân / cách xử lý |
| :--- | :--- |
| `loop error: fetch failed` | Brave không mở bằng flag CDP → chạy lại `start_brave_cdp.bat` |
| `DOM pattern lạ — dump` | Trang đổi cấu trúc DOM → xem `debug/dom_snapshot.txt`, sửa selector trong `EXTRACT_JS` |
| Gửi reply không thành `send_button_not_found` | Nút Gửi đổi label → sửa regex `/send|gửi/i` trong `SEND_JS` |
| Goal file sinh với NỘI DUNG reply của mình | Echo chưa bị chặn hết → kiểm tra `sentPrefixes` trong `state.json` |
| Tải model/file lớn từ HF stall 0 MB | Nguồn mạng DPI/ISP — dùng mirror (ModelScope) hoặc retry; luôn assert kích thước file |

## Tùy chọn CLI

```
node gemini_cdp_watcher.mjs --help
--cdp URL           Mặc định http://127.0.0.1:9222
--url-pattern REGEX Mặc định gemini\.google\.com/app (đổi để dùng ChatGPT/Claude/…)
--inbox DIR --outbox DIR --state FILE   Tách instance riêng cho từng agent/dự án
--poll-ms N         Chu kỳ quét
```

Chạy nhiều instance cùng lúc: mỗi instance cần `--url-pattern` khác nhau (khác tab)
và `--inbox/--outbox/--state` khác thư mục — tránh hai watcher cùng ăn một tab.

## Bảo mật

- CDP :9222 cho phép **mọi process local** điều khiển toàn bộ browser — chỉ bật trên
  máy cá nhân, tắt (đóng Brave mở bằng flag) khi không dùng.
- Watcher không đọc/ghi cookie, không đăng nhập hộ — mọi thứ diễn ra trong session
  đăng nhập sẵn của bạn.
