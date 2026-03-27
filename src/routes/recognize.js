import express from "express";
import multer from "multer";
import fs from "fs";
import { execSync } from "child_process";
import Groq from "groq-sdk";
import axios from "axios";

// Diğer servislerin import edildiğinden emin olun (Gerekiyorsa)
import { recognizeWithAcoustID } from "../services/acoustid.js";

const router = express.Router();

// ✅ Yapılandırmalar
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const GENIUS_TOKEN = process.env.GENIUS_ACCESS_TOKEN;

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) cb(null, true);
    else cb(new Error("Only audio files are allowed"));
  }
});

function validateWavFile(filePath) {
  try {
    const buffer = Buffer.alloc(44);
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buffer, 0, 44, 0);
    fs.closeSync(fd);
    if (buffer.toString("ascii", 0, 4) !== "RIFF") return { valid: false, error: "Not RIFF" };
    if (buffer.toString("ascii", 8, 12) !== "WAVE") return { valid: false, error: "Not WAVE" };
    const audioFormat = buffer.readUInt16LE(20);
    const channels = buffer.readUInt16LE(22);
    const sampleRate = buffer.readUInt32LE(24);
    const bitsPerSample = buffer.readUInt16LE(34);
    const dataSize = buffer.readUInt32LE(40);
    const duration = dataSize / (sampleRate * channels * (bitsPerSample / 8));
    return { valid: true, duration };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

router.post("/", upload.single("audio"), async (req, res) => {
  console.log("\n=== 🎵 STARTING HYBRID RECOGNITION (GROQ + GENIUS) ===");
  
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No audio file uploaded" });
  }

  const originalPath = req.file.path;
  const optimizedPath = originalPath + "_optimized.wav";
  let recognition = null;
  let source = null;

  try {
    const validation = validateWavFile(originalPath);
    if (!validation.valid) throw new Error(validation.error);

    // 1️⃣ FFmpeg: 25 saniye dinle
    console.log("🎚️ Optimizing 25 seconds of audio...");
    execSync(
      `ffmpeg -y -i "${originalPath}" -ac 1 -ar 16000 -ss 0 -t 25 -af loudnorm "${optimizedPath}"`,
      { stdio: "ignore" }
    );

    // 2️⃣ Parmak İzi Denemesi (AcoustID)
    try {
      const acoustIdResult = await recognizeWithAcoustID(optimizedPath);
      if (acoustIdResult) {
        recognition = acoustIdResult;
        source = "AcoustID";
      }
    } catch (e) { console.log("AcoustID skipped."); }

    // 3️⃣ 🚀 GROQ AI + AKILLI GENIUS ARAMA
    if (!recognition) {
      console.log("🤖 Scanning lyrics with AI...");
      
      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(optimizedPath),
        model: "whisper-large-v3-turbo",
        response_format: "json",
        prompt: "Bu bir şarkı kaydıdır, duyduğun sözleri hatasız yaz."
      });

      // Noktalama işaretlerini temizle (Aramayı bozar)
      const lyrics = transcription.text.trim().replace(/[.,/#!$%^&*;:{}=\-_`~()]/g,"");

      if (lyrics.split(/\s+/).length >= 3) {
        console.log(`📝 Detected Lyrics: "${lyrics}"`);
        
        const words = lyrics.split(/\s+/);
        
        // 🛠️ AKILLI STRATEJİ: 3 farklı deneme yapıyoruz
        const searchAttempts = [
          words.slice(0, 6).join(" "),      // 1. Deneme: İlk 6 kelime
          words.slice(2, 8).join(" "),      // 2. Deneme: Ortadan 6 kelime
          words.slice(-6).join(" ")         // 3. Deneme: Sondan 6 kelime
        ];

        for (const query of searchAttempts) {
          if (!query || query.length < 5) continue;

          console.log(`🔍 Trying Genius search for: "${query}"`);
          const geniusRes = await axios.get(`https://api.genius.com/search?q=${encodeURIComponent(query)}`, {
            headers: { 'Authorization': `Bearer ${GENIUS_TOKEN}` }
          });

          const hits = geniusRes.data.response.hits;

          if (hits && hits.length > 0) {
            const bestMatch = hits[0].result;
            recognition = {
              title: bestMatch.title,
              artist: bestMatch.primary_artist.name,
              album_art: bestMatch.song_art_image_url, 
              thumbnail: bestMatch.song_art_image_thumbnail_url,
              release_date: bestMatch.release_date_for_display || "Bilinmiyor",
              full_title: bestMatch.full_title,
              artist_image: bestMatch.primary_artist.image_url,
              lyrics_snippet: lyrics
            };
            source = "Genius (Verified)";
            break; // Bir sonuç bulunduysa döngüden çık
          }
        }
      }
    }

  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
    if (fs.existsSync(optimizedPath)) fs.unlinkSync(optimizedPath);
  }

  const response = {
    success: recognition !== null,
    recognition,
    source,
    message: recognition ? "Success" : "Track not found"
  };

  console.log(`📤 Final Source: ${source || "Failed"}\n=== 🏁 COMPLETE ===`);
  return res.json(response);
});

export default router;
