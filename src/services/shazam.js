import axios from "axios";
import fs from "fs";

// =======================
// 🔑 ENV (RapidAPI → "Shazam" by apidojo)
// =======================
const RAPIDAPI_KEY = (process.env.RAPIDAPI_KEY || "").trim();
const RAPIDAPI_HOST = "shazam.p.rapidapi.com";
const ENDPOINT = `https://${RAPIDAPI_HOST}/songs/v2/detect`;

// API: base64 ile kodlanmış ham PCM (44100 Hz, mono, 16-bit signed LE) bekler, ~500KB'a kadar
const SAMPLE_RATE = 44100;
const BYTES_PER_SEC = SAMPLE_RATE * 2;
const SLICE_SECONDS = 5;
const SLICE_OFFSETS = [4, 12, 18]; // saniye; kayıt kısaysa otomatik atlanır
const MAX_TRIES = parseInt(process.env.SHAZAM_MAX_TRIES || "2", 10); // ücretsiz kotayı korumak için

// WAV içinden ham PCM verisini çıkar ("data" chunk'ını bul)
function extractPcm(wavPath) {
  const buf = fs.readFileSync(wavPath);
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "data") return buf.subarray(pos + 8, Math.min(buf.length, pos + 8 + size));
    pos += 8 + size;
  }
  return null;
}

async function detectSlice(pcm) {
  const response = await axios.post(
    ENDPOINT,
    pcm.toString("base64"),
    {
      params: { timezone: "Europe/Istanbul", locale: "tr-TR" },
      headers: {
        "content-type": "text/plain",
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST
      },
      timeout: 30000,
      validateStatus: (s) => s >= 200 && s < 500
    }
  );
  console.log(`📥 Shazam HTTP Status: ${response.status}`);
  if (response.status !== 200) {
    console.warn("⚠️ [Shazam] API error:", JSON.stringify(response.data).slice(0, 300));
    return { error: response.status };
  }
  return { track: response.data && response.data.track };
}

/**
 * @param wavPath uygulamadan gelen ORİJİNAL wav (44.1kHz mono 16-bit)
 */
export async function recognizeWithShazam(wavPath) {
  if (!RAPIDAPI_KEY) {
    console.warn("⚠️ [Shazam] RAPIDAPI_KEY yok, atlanıyor");
    return null;
  }
  try {
    console.log("🔍 [Shazam] Starting recognition...");
    const pcm = extractPcm(wavPath);
    if (!pcm || pcm.length < BYTES_PER_SEC * 3) {
      console.warn("⚠️ [Shazam] Audio too short");
      return null;
    }

    let tries = 0;
    for (const offset of SLICE_OFFSETS) {
      const start = offset * BYTES_PER_SEC;
      const end = start + SLICE_SECONDS * BYTES_PER_SEC;
      if (end > pcm.length) continue;
      if (tries >= MAX_TRIES) break;
      tries++;

      console.log(`📡 [Shazam] Slice ${offset}s-${offset + SLICE_SECONDS}s gönderiliyor...`);
      const r = await detectSlice(pcm.subarray(start, end));
      if (r.error) {
        if (r.error === 429 || r.error === 403 || r.error === 401) return null; // kota/anahtar sorunu, devam etme
        continue;
      }

      const t = r.track;
      if (t && t.title) {
        let album = "";
        let year = "";
        const meta = t.sections?.find(s => s.type === "SONG")?.metadata || [];
        for (const m of meta) {
          if (/album/i.test(m.title)) album = m.text;
          if (/released|yıl|year/i.test(m.title)) year = (m.text || "").slice(-4);
        }
        const result = {
          title: t.title,
          artist: t.subtitle || "Unknown Artist",
          album,
          albumArt: t.images?.coverarthq || t.images?.coverart || "",
          year
        };
        console.log(`✅ [Shazam] ${result.title} - ${result.artist}`);
        return result;
      }
      console.log("ℹ️ [Shazam] Bu dilimde eşleşme yok");
    }
    return null;
  } catch (error) {
    console.error("❌ [Shazam] Error:", error.message);
    return null;
  }
}
