import { useState } from "react";
import axios from "axios";

export default function FacebookReelDownloader() {
  const [url, setUrl] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const sendVideoToTelegram = async (videoUrl: string) => {
    const botToken = "7739533740:AAHNvWJsJk9GET90o-YRQy2d9OxHWkHMNfY"; // ← Thay bằng token thật
    const chatId = "1458259171";     // ← Thay bằng chat ID thật

    const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendVideo`;

    try {
      await axios.post(telegramApiUrl, {
        chat_id: chatId,
        video: videoUrl,
        caption: "🎬 Đây là video Facebook Reel bạn đã yêu cầu!",
      });
      console.log("✅ Video đã được gửi qua Telegram");
    } catch (err) {
      console.error("❌ Gửi video qua Telegram thất bại:", err);
    }
  };

  const handleDownload = async () => {
    if (!url.trim()) {
      setError("Vui lòng nhập URL!");
      return;
    }

    setLoading(true);
    setError("");
    setVideoUrl("");

    try {
      const response = await axios.post("http://103.20.102.115:3001/get-fb-reel", {
        reelUrl: url,
      });
      console.log("Response:", response.data);

      const downloadedVideoUrl = response.data.videoUrl;
      setVideoUrl(downloadedVideoUrl);

      // Gửi tới Telegram
      await sendVideoToTelegram(downloadedVideoUrl);
    } catch (err) {
      console.error("Error:", err);
      setError("Không tìm thấy video hoặc có lỗi xảy ra!");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: "2em", maxWidth: "600px", margin: "auto" }}>
      <input
        type="text"
        placeholder="Dán link reel tại đây..."
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        style={{ width: "100%", padding: "0.5em", marginBottom: "1em" }}
        disabled={loading}
      />
      <button onClick={handleDownload} disabled={loading} style={{ marginTop: "1em" }}>
        {loading ? "Đang xử lý..." : "Lấy video"}
      </button>

      {error && <p style={{ color: "red", marginTop: "1em" }}>{error}</p>}

      {videoUrl && (
        <div style={{ marginTop: "2em" }}>
          <video
            src={videoUrl}
            controls
            style={{ width: "100%", maxHeight: "400px" }}
            onError={() => setError("Video không tải được!")}
          />
          <a
            href={videoUrl}
            download="facebook_reel.mp4"
            style={{ display: "block", marginTop: "1em" }}
          >
            ⬇️ Tải xuống video
          </a>
        </div>
      )}
    </div>
  );
}
