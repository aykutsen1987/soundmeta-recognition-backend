import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import { generateFingerprint } from "../utils/fingerprint.js";

// =======================
// 🔑 ENV KONTROL
// =======================
const ACOUSTID_API_KEY = (process.env.ACOUSTID_API_KEY || "").trim();

if (!ACOUSTID_API_KEY) {
  console.error("❌ [AcoustID] ACOUSTID_API_KEY is missing in environment variables!");
}

const ACOUSTID_ENDPOINT = "https://api.acoustid.org/v2/lookup";

// =======================
// 🎵 AcoustID Recognition
// =======================
export async function recognizeWithAcoustID(audioPath) {
  try {
    console.log("🔍 [AcoustID] Starting recognition...");
    console.log(`📂 File: ${audioPath}`);

    // =======================
    // Dosya kontrolü
    // =======================
    if (!fs.existsSync(audioPath)) {
      console.error("❌ [AcoustID] File not found");
      return null;
    }

    const fileSize = fs.statSync(audioPath).size;
    console.log(
      `📊 File size: ${fileSize} bytes (${(fileSize / 1024).toFixed(2)} KB)`
    );

    if (fileSize < 50 * 1024) {
      console.warn("⚠️ [AcoustID] File too small, fingerprint quality may be low");
    }

    // =======================
    // 1️⃣ Fingerprint
    // =======================
    console.log("🔐 Generating fingerprint...");
    const fingerprintData = await generateFingerprint(audioPath);

    if (
      !fingerprintData ||
      !fingerprintData.fingerprint ||
      !fingerprintData.duration
    ) {
      console.error("❌ [AcoustID] Invalid fingerprint data");
      return null;
    }

    console.log(
      `✅ Fingerprint generated (duration: ${fingerprintData.duration.toFixed(2)}s)`
    );

    if (fingerprintData.duration < 3) {
      console.warn("⚠️ [AcoustID] Audio too short (< 3 seconds)");
      return null;
    }

    // =======================
    // 2️⃣ API Request
    // =======================
    const formData = new FormData();
    formData.append("client", ACOUSTID_API_KEY);
    formData.append("duration", Math.floor(fingerprintData.duration));
    formData.append("fingerprint", fingerprintData.fingerprint);
    formData.append("meta", "recordings releasegroups artists");

    console.log("📡 Sending to AcoustID API...");

    const response = await axios.post(ACOUSTID_ENDPOINT, formData, {
      headers: formData.getHeaders(),
      timeout: 30000,
      validateStatus: (status) => status >= 200 && status < 500
    });

    console.log(`📥 AcoustID HTTP Status: ${response.status}`);

    if (!response.data || response.data.status !== "ok") {
      console.error("❌ [AcoustID] API returned error:", response.data);
      return null;
    }

    if (!response.data.results || response.data.results.length === 0) {
      console.warn("⚠️ [AcoustID] No results found");
      return null;
    }

    // =======================
    // En iyi sonucu seç
    // =======================
    const bestResult = response.data.results.reduce(
      (best, current) =>
        current.score > (best?.score || 0) ? current : best,
      null
    );

    console.log(
      `🎯 Best match score: ${(bestResult.score * 100).toFixed(1)}%`
    );

    if (bestResult.score < 0.5) {
      console.warn("⚠️ [AcoustID] Match confidence too low");
      return null;
    }

    if (!bestResult.recordings || bestResult.recordings.length === 0) {
      console.warn("⚠️ [AcoustID] No recordings metadata");
      return null;
    }

    const recording = bestResult.recordings[0];

    // =======================
    // Metadata
    // =======================
    let album = "";
    let albumArt = "";
    let year = "";

    if (recording.releasegroups && recording.releasegroups.length > 0) {
      const releaseGroup = recording.releasegroups[0];
      album = releaseGroup.title || "";

      if (releaseGroup.id) {
        albumArt = `https://coverartarchive.org/release-group/${releaseGroup.id}/front-250`;
      }
    }

    let artist = "Unknown Artist";
    if (recording.artists && recording.artists.length > 0) {
      artist = recording.artists.map(a => a.name).join(", ");
    }

    const result = {
      title: recording.title || "Unknown Track",
      artist,
      album,
      albumArt,
      year
    };

    console.log("✅ [AcoustID] Recognition successful:");
    console.log(`   🎵 ${result.title}`);
    console.log(`   👤 ${result.artist}`);
    console.log(`   💿 ${result.album || "N/A"}`);

    return result;

  } catch (error) {
    if (error.code === "ECONNABORTED") {
      console.error("⏱️ [AcoustID] Request timeout");
    } else if (error.response) {
      console.error(
        `❌ [AcoustID] API Error ${error.response.status}:`,
        error.response.data
      );
    } else {
      console.error("❌ [AcoustID] Error:", error.message);
    }
    return null;
  }
}
