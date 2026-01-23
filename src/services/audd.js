import axios from "axios";
import FormData from "form-data";
import fs from "fs";

const AUDD_API_TOKEN = process.env.AUDD_API_TOKEN || "YOUR_API_TOKEN_HERE";
const AUDD_ENDPOINT = "https://api.audd.io/";

export async function recognizeWithAudD(audioPath) {
  try {
    console.log("🔍 [AudD] Starting recognition...");
    console.log(`📂 File: ${audioPath}`);

    // Dosya kontrolü
    if (!fs.existsSync(audioPath)) {
      console.error("❌ [AudD] File not found");
      return null;
    }

    const fileSize = fs.statSync(audioPath).size;
    console.log(`📊 File size: ${fileSize} bytes (${(fileSize / 1024).toFixed(2)} KB)`);

    // AudD maksimum 1MB kabul eder
    if (fileSize > 1 * 1024 * 1024) {
      console.warn("⚠️ [AudD] File too large (>1MB), skipping");
      return null;
    }

    if (fileSize < 50 * 1024) {
      console.warn("⚠️ [AudD] File too small");
    }

    // Form data oluştur
    const formData = new FormData();
    formData.append("api_token", AUDD_API_TOKEN);
    formData.append("file", fs.createReadStream(audioPath));
    formData.append("return", "apple_music,spotify");

    console.log("📡 Sending to AudD API...");

    const response = await axios.post(AUDD_ENDPOINT, formData, {
      headers: {
        ...formData.getHeaders()
      },
      timeout: 30000,
      maxContentLength: 2 * 1024 * 1024,
      maxBodyLength: 2 * 1024 * 1024
    });

    console.log(`📥 AudD Response: ${response.status}`);

    if (response.data.status !== "success") {
      console.error("❌ [AudD] API returned error:", response.data);
      return null;
    }

    if (!response.data.result) {
      console.warn("⚠️ [AudD] No match found");
      return null;
    }

    const result = response.data.result;

    // Album art - Spotify veya Apple Music'ten al
    let albumArt = "";
    if (result.spotify && result.spotify.album && result.spotify.album.images) {
      const images = result.spotify.album.images;
      albumArt = images.length > 0 ? images[0].url : "";
    } else if (result.apple_music && result.apple_music.artwork) {
      albumArt = result.apple_music.artwork.url
        .replace("{w}", "250")
        .replace("{h}", "250");
    }

    const trackInfo = {
      title: result.title || "Unknown Track",
      artist: result.artist || "Unknown Artist",
      album: result.album || "",
      albumArt: albumArt,
      year: result.release_date ? result.release_date.substring(0, 4) : ""
    };

    console.log("✅ [AudD] Recognition successful:");
    console.log(`   🎵 ${trackInfo.title}`);
    console.log(`   👤 ${trackInfo.artist}`);
    console.log(`   💿 ${trackInfo.album || "N/A"}`);

    return trackInfo;

  } catch (error) {
    if (error.code === "ECONNABORTED") {
      console.error("⏱️ [AudD] Request timeout");
    } else if (error.response) {
      console.error(`❌ [AudD] API Error ${error.response.status}:`, error.response.data);
    } else {
      console.error("❌ [AudD] Error:", error.message);
    }
    return null;
  }
}
