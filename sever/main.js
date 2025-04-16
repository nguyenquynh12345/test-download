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
const FormData = require('form-data');

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
    const { reelUrl, description } = req.body;

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
                "--enable-usermedia-screen-capturing",
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
                potentialVideos.push({ url, headers, type: "video" });
                console.log("🎬 Captured video URL:", url);
            } else if (
                (url.includes(".mp4") || url.includes("audio") || url.includes(".m3u8")) &&
                response.status() === 200 &&
                headers["content-type"]?.includes("audio")
            ) {
                potentialVideos.push({ url, headers, type: "audio" });
                console.log("🎵 Captured audio URL:", url);
            } else if (url.includes(".mpd") && response.status() === 200) {
                potentialVideos.push({ url, headers, isManifest: true });
                console.log("🎬 Captured DASH manifest:", url);
            }
            console.log("🌐 Response:", url, headers["content-type"]);
        });

        console.log("⏳ Accessing:", reelUrl);
        await page.goto(reelUrl, { waitUntil: "networkidle2", timeout: 60000 });

        await page.evaluate(() => {
            window.scrollBy(0, 500);
            const video = document.querySelector("video");
            if (video) video.click();
        });
        await new Promise((resolve) => setTimeout(resolve, 3000));

        await page.waitForSelector("video", { timeout: 60000 });
        await page.evaluate(() => {
            const video = document.querySelector("video");
            if (video) {
                video.play();
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
                };
            }
            return null;
        });
        console.log("🎬 Video info:", videoInfo);

        console.log("🎬 Potential streams:", potentialVideos.map((v) => `${v.url} (${v.type || 'manifest'})`));

        const videoStreams = potentialVideos.filter((v) => v.type === "video");
        const audioStreams = potentialVideos.filter((v) => v.type === "audio");

        if (videoStreams.length > 0) {
            const videoId = Date.now().toString();
            const videoPath = path.join(videosDir, `${videoId}_video.mp4`);
            const audioPath = path.join(videosDir, `${videoId}_audio.mp4`);
            const finalPath = path.join(videosDir, `${videoId}.mp4`);

            try {
                const videoStream = videoStreams[0];
                const videoUrl = videoStream.url.split("&bytestart")[0];
                console.log("⏳ Downloading video from:", videoUrl);
                const videoResponse = await axios({
                    url: videoUrl,
                    method: "GET",
                    responseType: "stream",
                    headers: {
                        "User-Agent":
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                            "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
                        Referer: "https://www.facebook.com/",
                        ...requestHeaders[videoUrl],
                    },
                    timeout: 120000,
                });

                const videoWriter = fs.createWriteStream(videoPath);
                videoResponse.data.pipe(videoWriter);

                await new Promise((resolve, reject) => {
                    videoWriter.on("finish", resolve);
                    videoWriter.on("error", reject);
                });

                let finalVideoPath = videoPath;

                if (audioStreams.length > 0) {
                    const audioStream = audioStreams[0];
                    const audioUrl = audioStream.url.split("&bytestart")[0];
                    console.log("⏳ Downloading audio from:", audioUrl);
                    const audioResponse = await axios({
                        url: audioUrl,
                        method: "GET",
                        responseType: "stream",
                        headers: {
                            "User-Agent":
                                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                                "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
                            Referer: "https://www.facebook.com/",
                            ...requestHeaders[audioUrl],
                        },
                        timeout: 120000,
                    });

                    const audioWriter = fs.createWriteStream(audioPath);
                    audioResponse.data.pipe(audioWriter);

                    await new Promise((resolve, reject) => {
                        audioWriter.on("finish", resolve);
                        audioWriter.on("error", reject);
                    });

                    console.log("⏳ Merging video and audio...");
                    await execPromise(
                        `ffmpeg -i ${videoPath} -i ${audioPath} -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 ${finalPath} -y`
                    );
                    fs.unlinkSync(videoPath);
                    fs.unlinkSync(audioPath);
                    finalVideoPath = finalPath;
                }

                const stats = fs.statSync(finalVideoPath);
                console.log("📏 Downloaded file size:", stats.size, "bytes");

                if (stats.size > 500000) {
                    const { stdout } = await execPromise(
                        `ffprobe -v error -show_streams -of json ${finalVideoPath}`
                    );
                    const metadata = JSON.parse(stdout);
                    const hasAudio = metadata.streams.some((s) => s.codec_type === "audio");
                    const { width, height } = metadata.streams.find((s) => s.codec_type === "video") || {};
                    console.log(`🎥 Video resolution: ${width}x${height}, Has audio: ${hasAudio}`);

                    if (height >= 720 && hasAudio) {
                        console.log("✅ High-quality video with audio downloaded:", finalVideoPath);

                        const formData = new FormData();
                        formData.append('access_token', 'EAAKItZCZAlZCMIBO6VMIZBTqxv2X9Hq3vqksfI2Ly4Av5sP1qW7f7vqnn8ruhBGwlHQGwx47Isa1zPS2yZAJm1HxZCqS5IW7pDGWWjN63376rYzUeDdbg6yZCNHYyL91w9OqZCLNuHleqIBFcO6R0VLSP3AfiyDG41bZBs9pPHIxRnPK9ZBDxKZBPU3EBUGxkWtN0lZCZCsd2vbFb9GK145XFWjtJe28ZD'); // Replace with your token
                        formData.append('source', fs.createReadStream(finalVideoPath));
                        formData.append('description', description);

                        try {
                            const response = await axios.post(
                                `https://graph-video.facebook.com/v12.0/115173538155061/videos`,
                                formData,
                                { headers: formData.getHeaders() }
                            );
                            console.log('✅ Video uploaded successfully:', response.data);
                            return res.json({
                                message: 'Video uploaded successfully',
                                videoId: response.data.id,
                                videoUrl: `https://www.facebook.com/115173538155061/videos/${response.data.id}`,
                                localVideoUrl: `http://103.20.102.115:${PORT}/videos/${videoId}.mp4`
                            });
                        } catch (err) {
                            console.error('❌ Error uploading video:', err.response?.data || err.message);
                            return res.status(500).json({ error: 'Error uploading video to Facebook' });
                        }
                    } else {
                        fs.unlinkSync(finalVideoPath);
                        console.log("⚠️ Video quality too low or no audio");
                    }
                } else {
                    fs.unlinkSync(finalVideoPath);
                    console.log("⚠️ Video too small");
                }
            } catch (downloadErr) {
                console.error("❌ Download error:", downloadErr.message);
                if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
                if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
                if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
            }
        }

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
                console.log("🎵 Audio tracks:", audioTracks.length);

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
                    }, Math.max(duration * 1000 + 2000, 15000));
                });
            }, videoInfo.duration);

            if (videoData) {
                console.log("✅ Recorded video data");
                const base64Data = videoData.split(",")[1];
                const videoId = Date.now().toString();
                const tempPath = path.join(videosDir, `${videoId}.webm`);
                const finalPath = path.join(videosDir, `${videoId}.mp4`);

                try {
                    fs.writeFileSync(tempPath, Buffer.from(base64Data, "base64"));

                    const { stdout: probeStdout } = await execPromise(
                        `ffprobe -v error -show_streams -of json ${tempPath}`
                    );
                    const probeMetadata = JSON.parse(probeStdout);
                    const hasVideo = probeMetadata.streams.some((s) => s.codec_type === "video");
                    const hasAudio = probeMetadata.streams.some((s) => s.codec_type === "audio");
                    console.log(`📋 Input file has video: ${hasVideo}, has audio: ${hasAudio}`);

                    if (!hasVideo) {
                        throw new Error("Input .webm file has no video stream");
                    }

                    await execPromise(
                        `ffmpeg -i ${tempPath} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -f mp4 ${finalPath} -y`
                    );
                    fs.unlinkSync(tempPath);

                    const stats = fs.statSync(finalPath);
                    console.log("📏 Downloaded file size:", stats.size, "bytes");

                    const { stdout } = await execPromise(
                        `ffprobe -v error -show_streams -of json ${finalPath}`
                    );
                    const metadata = JSON.parse(stdout);
                    const hasAudioOutput = metadata.streams.some((s) => s.codec_type === "audio");
                    const { width, height } = metadata.streams.find((s) => s.codec_type === "video") || {};
                    console.log(`🎥 Video resolution: ${width}x${height}, Has audio: ${hasAudioOutput}`);

                    if (stats.size > 500000 && height >= 720 && hasAudioOutput) {
                        console.log("✅ High-quality video with audio downloaded:", finalPath);

                        // Upload to Facebook
                        const formData = new FormData();
                        formData.append('access_token', 'EAAKItZCZAlZCMIBO6VMIZBTqxv2X9Hq3vqksfI2Ly4Av5sP1qW7f7vqnn8ruhBGwlHQGwx47Isa1zPS2yZAJm1HxZCqS5IW7pDGWWjN63376rYzUeDdbg6yZCNHYyL91w9OqZCLNuHleqIBFcO6R0VLSP3AfiyDG41bZBs9pPHIxRnPK9ZBDxKZBPU3EBUGxkWtN0lZCZCsd2vbFb9GK145XFWjtJe28ZD'); // Replace with your token
                        formData.append('source', fs.createReadStream(finalPath));
                        formData.append('description', description);

                        try {
                            const response = await axios.post(
                                `https://graph-video.facebook.com/v12.0/115173538155061/videos`,
                                formData,
                                { headers: formData.getHeaders() }
                            );
                            console.log('✅ Video uploaded successfully:', response.data);
                            return res.json({
                                message: 'Video uploaded successfully',
                                videoId: response.data.id,
                                videoUrl: `https://www.facebook.com/115173538155061/videos/${response.data.id}`,
                                localVideoUrl: `http://103.20.102.115:${PORT}/videos/${videoId}.mp4`
                            });
                        } catch (err) {
                            console.error('❌ Error uploading video:', err.response?.data || err.message);
                            return res.status(500).json({ error: 'Error uploading video to Facebook' });
                        }
                    } else {
                        fs.unlinkSync(finalPath);
                        console.log("⚠️ Video quality too low, size too small, or no audio");
                    }
                } catch (err) {
                    console.error("❌ FFmpeg or file error:", err.message);
                    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                    if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
                }
            } else {
                console.log("❌ Failed to record video data");
            }
        }

        console.log("❌ No video found. Debug info:", {
            potentialVideos: potentialVideos.map((v) => `${v.url} (${v.type || 'manifest'})`),
            videoStreams: videoStreams.map((v) => v.url),
            audioStreams: audioStreams.map((v) => v.url),
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
    console.log(`🚀 Server running at http://103.20.102.115:${PORT}`);
});