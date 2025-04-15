import { useState } from "react";
import axios from "axios";

export default function FacebookReelDownloader() {
  const [url, setUrl] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
      console.log("Response:", response.data); // Debug response
      setVideoUrl(response.data.videoUrl);
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