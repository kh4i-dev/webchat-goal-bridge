@echo off
rem Khởi động Brave với CDP cổng 9222 + khôi phục phiên. Chạy file này MỖI lần dùng bridge.
rem Cảnh báo: cổng CDP cho phép mọi process local điều khiển browser — chỉ mở trên máy cá nhân.
start "" "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" --remote-debugging-port=9222 --restore-last-session
