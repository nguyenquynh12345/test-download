const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());

app.use("/videos", express.static(path.join(__dirname, "videos")));

const videosDir = path.join(__dirname, "videos");
if (!fs.existsSync(videosDir)) {
  fs.mkdirSync(videosDir);
}

app.post("/get-fb-reel", async (req, res) => {
  const { reelUrl } = req.body;

  if (!reelUrl || !reelUrl.includes("facebook.com/reel")) {
    return res.status(400).json({ error: "Invalid URL" });
  }

  const videoIdMatch = reelUrl.match(/reel\/(\d+)/);
  const targetVideoId = videoIdMatch ? videoIdMatch[1] : null;
  if (!targetVideoId) {
    return res.status(400).json({ error: "Could not extract video ID" });
  }
  console.log("🎯 Targeting video_id:", targetVideoId);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--window-size=1920,1080",
      ],
      timeout: 30000,
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1920, height: 1080 });

    let requestHeaders = {};

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      requestHeaders[url] = request.headers();
      request.continue();
    });

    const potentialVideos = [];
    page.on("response", async (response) => {
      const url = response.url();
      const headers = await response.headers();
      if (
        (url.includes(".mp4") || url.includes("video") || url.includes(".m3u8")) &&
        response.status() === 200 &&
        headers["content-type"]?.includes("video")
      ) {
        potentialVideos.push({ url, headers });
        console.log("🎬 Captured video URL:", url);
      } else if (url.includes(".mpd") && response.status() === 200) {
        potentialVideos.push({ url, headers, isManifest: true });
        console.log("🎬 Captured DASH manifest:", url);
      }
    });

    console.log("⏳ Accessing:", reelUrl);
    await page.goto(reelUrl, { waitUntil: "networkidle2", timeout: 120000 });

    await page.evaluate(() => {
      window.scrollBy(0, 500);
      const video = document.querySelector("video");
      if (video) video.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 10000));

    await page.waitForSelector("video", { timeout: 60000 });
    await page.evaluate(() => {
      const video = document.querySelector("video");
      if (video) {
        video.play();
        // Không mute để giữ audio
      }
    });

    await page.waitForFunction(
      () => {
        const video = document.querySelector("video");
        return video && video.readyState === 4;
      },
      { timeout: 60000 }
    );

    const videoInfo = await page.evaluate(() => {
      const video = document.querySelector("video");
      if (video) {
        return {
          src: video.src,
          currentSrc: video.currentSrc,
          sourceElements: Array.from(video.querySelectorAll("source")).map((s) => s.src),
          duration: video.duration,
          readyState: video.readyState,
          playing: !video.paused,
          hasAudio: video.mozHasAudio || video.webkitAudioDecodedByteCount > 0,
        };
      }
      return null;
    });
    console.log("🎬 Video info:", videoInfo);

    console.log("🎬 Potential videos:", potentialVideos.map((v) => v.url));
    const filteredVideos = potentialVideos.filter((video) => {
      const decodedUrl = decodeURIComponent(video.url);
      const isAudio = decodedUrl.includes("audio") || decodedUrl.includes("mp4a");
      const isAd = decodedUrl.includes("ads") || decodedUrl.includes("advert");
      if (isAudio || isAd) {
        console.log("⚠️ Excluded (audio or ad):", video.url);
        return false;
      }
      const urlVideoIdMatch = decodedUrl.match(/video_id=(\d+)/);
      const urlVideoId = urlVideoIdMatch ? urlVideoIdMatch[1] : null;
      if (urlVideoId && urlVideoId !== targetVideoId) {
        console.log("⚠️ Excluded (wrong video_id):", video.url);
        return false;
      }
      return true;
    });

    console.log("🎬 Filtered videos:", filteredVideos.map((v) => v.url));

    let prioritizedVideos = filteredVideos;
    if (videoInfo && videoInfo.sourceElements.length > 0) {
      const sourceUrls = videoInfo.sourceElements;
      prioritizedVideos = filteredVideos.sort((a, b) => {
        const aIsSource = sourceUrls.includes(a.url) ? 1 : 0;
        const bIsSource = sourceUrls.includes(b.url) ? 1 : 0;
        return bIsSource - aIsSource;
      });
    }

    // Chọn video chất lượng cao nhất và có audio
    let bestVideo = null;
    let maxHeight = 0;
    let qualityScore = 0;
    for (const video of prioritizedVideos) {
      const videoId = Date.now().toString();
      const tempPath = path.join(videosDir, `${videoId}_temp.mp4`);
      const downloadUrl = video.url.split("&bytestart")[0];

      try {
        console.log("⏳ Probing:", downloadUrl);
        const videoResponse = await axios({
          url: downloadUrl,
          method: "GET",
          responseType: "stream",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
              "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            Referer: "https://www.facebook.com/",
            ...requestHeaders[downloadUrl],
          },
        });

        const writer = fs.createWriteStream(tempPath);
        videoResponse.data.pipe(writer);

        await new Promise((resolve, reject) => {
          writer.on("finish", resolve);
          writer.on("error", reject);
        });

        const stats = fs.statSync(tempPath);
        console.log("📏 Temp file size:", stats.size, "bytes");

        const { stdout } = await execPromise(
          `ffprobe -v error -show_streams -of json ${tempPath}`
        );
        const metadata = JSON.parse(stdout);
        console.log(`📋 Metadata for ${downloadUrl}:`, metadata);

        const videoStream = metadata.streams.find((s) => s.codec_type === "video");
        const audioStream = metadata.streams.find((s) => s.codec_type === "audio");
        const { width, height } = videoStream || {};

        if (!audioStream) {
          console.log("⚠️ Excluded (no audio):", downloadUrl);
          fs.unlinkSync(tempPath);
          continue;
        }

        console.log(`🎥 Resolution for ${downloadUrl}: ${width}x${height}`);

        let tempScore = height || 0;
        if (downloadUrl.includes("_q100")) tempScore += 1000;
        else if (downloadUrl.includes("_q80")) tempScore += 500;
        else if (downloadUrl.includes("_q40")) tempScore -= 500;
        if (videoInfo && videoInfo.sourceElements.includes(downloadUrl)) tempScore += 2000;

        if (tempScore > qualityScore) {
          qualityScore = tempScore;
          maxHeight = height || 0;
          bestVideo = { url: downloadUrl, tempPath, stats, height };
        }

        fs.unlinkSync(tempPath);
      } catch (err) {
        console.error("❌ Probe error for", downloadUrl, ":", err.message);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      }
    }

    if (bestVideo) {
      const videoId = Date.now().toString();
      const videoPath = path.join(videosDir, `${videoId}.mp4`);

      try {
        console.log("⏳ Downloading best video from:", bestVideo.url);
        const videoResponse = await axios({
          url: bestVideo.url,
          method: "GET",
          responseType: "stream",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
              "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            Referer: "https://www.facebook.com/",
            ...requestHeaders[bestVideo.url],
          },
        });

        const writer = fs.createWriteStream(videoPath);
        videoResponse.data.pipe(writer);

        await new Promise((resolve, reject) => {
          writer.on("finish", () => {
            console.log("📏 Downloaded file size:", fs.statSync(videoPath).size, "bytes");
            resolve();
          });
          writer.on("error", reject);
        });

        const stats = fs.statSync(videoPath);
        if (stats.size > 100000) {
          console.log("✅ Video downloaded:", videoPath);
          return res.json({
            videoUrl: `http://103.20.102.115:${PORT}/videos/${videoId}.mp4`,
          });
        } else {
          fs.unlinkSync(videoPath);
          console.log("⚠️ Video too small:", stats.size, "bytes");
          return res.status(400).json({ error: "Kích thước video quá nhỏ" });
        }
      } catch (downloadErr) {
        console.error("❌ Download error:", downloadErr.message);
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      }
    }

    // Fallback to MediaRecorder
    if (videoInfo && videoInfo.currentSrc.startsWith("blob:")) {
      console.log("⏳ Recording video from blob:", videoInfo.currentSrc);
      const videoData = await page.evaluate(async (duration) => {
        const video = document.querySelector("video");
        if (!video) {
          console.log("❌ No video element found");
          return null;
        }

        const stream = video.captureStream();
        if (!stream) {
          console.log("❌ No stream available");
          return null;
        }

        const audioTracks = stream.getAudioTracks();
        console.log("🎤 Audio tracks available:", audioTracks.length);

        const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
        const chunks = [];

        recorder.ondataavailable = (event) => {
          console.log("📼 Data available:", event.data.size);
          chunks.push(event.data);
        };
        recorder.start();
        console.log("🎥 Recording started");

        return new Promise((resolve) => {
          recorder.onstop = () => {
            console.log("🎥 Recording stopped");
            const blob = new Blob(chunks, { type: "video/webm" });
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          };
          recorder.onerror = (err) => console.error("❌ Recorder error:", err);
          setTimeout(() => {
            recorder.stop();
          }, Math.max(duration * 1000 + 5000, 30000));
        });
      }, videoInfo.duration);

      if (videoData) {
        console.log("✅ Recorded video data");
        const base64Data = videoData.split(",")[1];
        const videoId = Date.now().toString();
        const tempPath = path.join(videosDir, `${videoId}.webm`);
        const videoPath = path.join(videosDir, `${videoId}.mp4`);

        fs.writeFileSync(tempPath, Buffer.from(base64Data, "base64"));
        console.log("📏 Kích thước file .webm:", fs.statSync(tempPath).size);

        try {
          const { stdout } = await execPromise(
            `ffprobe -v error -show_streams -of json ${tempPath}`
          );
          const metadata = JSON.parse(stdout);
          console.log("📋 Metadata trước khi chuyển đổi:", metadata);

          const audioStream = metadata.streams.find((s) => s.codec_type === "audio");
          if (!audioStream) {
            console.log("⚠️ No audio in recorded video");
          }

          await execPromise(
            `ffmpeg -i ${tempPath} -c:v libx264 -crf 23 -preset medium -b:v 5M -c:a aac -b:a 192k -f mp4 ${videoPath} -y`
          );
          console.log("✅ Chuyển đổi sang .mp4 thành công:", videoPath);

          fs.unlinkSync(tempPath);

          const stats = fs.statSync(videoPath);
          console.log("📏 Kích thước file .mp4:", stats.size, "bytes");

          const { stdout: mp4Stdout } = await execPromise(
            `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json ${videoPath}`
          );
          const mp4Metadata = JSON.parse(mp4Stdout);
          const { width, height } = mp4Metadata.streams[0] || {};
          console.log(`🎥 Độ phân giải video: ${width}x${height}`);

          if (stats.size > 100000) {
            console.log("✅ Video đã tải thành công:", videoPath);
            return res.json({
              videoUrl: `http://103.20.102.115${PORT}/videos/${videoId}.mp4`,
            });
          } else {
            fs.unlinkSync(videoPath);
            console.log("⚠️ Kích thước video quá nhỏ:", stats.size, "bytes");
            return res.status(400).json({ error: "Kích thước video quá nhỏ" });
          }
        } catch (err) {
          console.error("❌ Lỗi FFmpeg:", err.message);
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
          return res.status(500).json({ error: "Lỗi khi chuyển đổi video" });
        }
      } else {
        console.log("❌ Không ghi được dữ liệu video");
        return res.status(404).json({ error: "Không ghi được video" });
      }
    }

    console.log("❌ No video found. Debug info:", {
      potentialVideos: potentialVideos.map((v) => v.url),
      filteredVideos: filteredVideos.map((v) => v.url),
      videoInfo,
    });
    return res.status(404).json({ error: "No video found" });
  } catch (err) {
    console.error("❌ Error:", err.message);
    return res.status(500).json({ error: "Failed to process Reel" });
  } finally {
    if (browser) {
      await browser.close().catch(console.error);
    }
  }
});

// Clean up old videos
setInterval(() => {
  fs.readdir(videosDir, (err, files) => {
    if (err) return console.error("Cleanup error:", err);
    files.forEach((file) => {
      const filePath = path.join(videosDir, file);
      const stats = fs.statSync(filePath);
      if (Date.now() - stats.mtimeMs > 60 * 60 * 1000) {
        fs.unlink(filePath, (err) => {
          if (err) console.error("Delete error:", err);
          else console.log("🧹 Deleted old video:", file);
        });
      }
    });
  });
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://103.20.102.115:3001/${PORT}`);
});