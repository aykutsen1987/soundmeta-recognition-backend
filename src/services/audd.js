import axios from "axios";
import FormData from "form-data";
import fs from "fs";

// =======================
// 🔑 ENV KONTROL
// =======================
const AUDD_API_TOKEN = process.env.AUDD_API_TOKEN;

if (!AUDD_API_TOKEN) {
  console.error("❌ [AudD] AUDD_API_TOKEN is missing in environment variables!");
}

const AUDD_ENDPOINT = "https://api.audd.io/";

// =======================
// 🎵 AudD Recognition
// =======================
export async function recognizeWithAudD(audioPath) {
  try {
    console.log("🔍 [AudD] Starting recognition...");
    console.log(`📂 File: ${audioPath}`);

    // =======================
    // Dosya var mı?
    // =======================
    if (!fs.existsSync(audioPath)) {
      console.error("❌ [AudD] File not found");
      return null;
    }

    const fileSize = fs.statSync(audioPath).size;
    console.log(
      `📊 File size: ${fileSize} bytes (${(fileSize / 1024).toFixed(2)} KB)`
    );

    // =======================
    // AudD LIMITLERİ
    // =======================
    if (fileSize > 1 * 1024 * 1024) {
      console.warn("⚠️ [AudD] File too large (>1MB), skipping");
      return null;
    }

    if (fileSize < 60 * 1024) {
      console.warn("⚠️ [AudD] File too small, recognition chance is low");
    }

    // =======================
    // FormData
    // =======================
    const formData = new FormData();
    formData.append("api_token", AUDD_API_TOKEN);
    formData.append("file", fs.createReadStream(audioPath));

    // AudD önerilen parametreler
    formData.append("return", "apple_music,spotify");
    formData.append("accurate_offsets", "true");

    console.log("📡 Sending request to AudD API...");

    const response = await axios.post(AUDD_ENDPOINT, formData, {
      headers: {
        ...formData.getHeaders()
      },
      timeout: 30000,
      maxContentLength: 2 * 1024 * 1024,
      maxBodyLength: 2 * 1024 * 1024,
      validateStatus: (status) => status >= 200 && status < 500
    });

    console.log(`📥 AudD HTTP Status: ${response.status}`);

    // =======================
    // API seviyesinde hata
    // =======================
    if (!response.data || response.data.status !== "success") {
      console.warn("⚠️ [AudD] API returned non-success:", response.data);
      return null;
    }

    if (!response.data.result) {
      console.warn("⚠️ [AudD] No match found");
      return null;
    }

    const result = response.data.result;

    // =======================
    // Album Art seçimi
    // =======================
    let albumArt = "";

    if (
      result.spotify &&
      result.spotify.album &&
      Array.isArray(result.spotify.album.images)
    ) {
      albumArt =
        result.spotify.album.images.length > 0
          ? result.spotify.album.images[0].url
          : "";
    } else if (result.apple_music && result.apple_music.artwork) {
      albumArt = result.apple_music.artwork.url
        .replace("{w}", "300")
        .replace("{h}", "300");
    }

    // =======================
    // Final Track Obj
    // =======================
    const trackInfo = {
      title: result.title || "Unknown Track",
      artist: result.artist || "Unknown Artist",
      album: result.album || "",
      albumArt: albumArt,
      year: result.release_date
        ? result.release_date.substring(0, 4)
        : ""
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
      console.error(
        `❌ [AudD] API Error ${error.response.status}:`,
        error.response.data
      );
    } else {
      console.error("❌ [AudD] Error:", error.message);
    }
    return null;
  }
}
