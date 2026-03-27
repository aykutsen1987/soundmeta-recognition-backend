import express from "express";
import multer from "multer";
import fs from "fs";
import { execSync } from "child_process";
import Groq from "groq-sdk";
import axios from "axios";

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

    // 2️⃣ AcoustID Denemesi (İsteğe bağlı servisleri çağırıyoruz)
    // recognizeWithAcoustID ve recognizeWithAudD servislerinin import edildiğinden emin olun.

    // 3️⃣ 🚀 GROQ + GENIUS (Zengin Veri Paketi)
    if (!recognition) {
      console.log("🤖 Scanning lyrics with AI...");
      
      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(optimizedPath),
        model: "whisper-large-v3-turbo",
        response_format: "json",
        prompt: "Bu bir şarkı kaydıdır, duyduğun sözleri hatasız yaz."
      });

      const lyrics = transcription.text.trim();

      if (lyrics.split(/\s+/).length >= 3) {
        console.log(`📝 Detected Lyrics: "${lyrics}"`);
        const searchQuery = lyrics.split(/\s+/).slice(0, 6).join(" ");
        console.log(`🔍 Searching Genius for: "${searchQuery}"`);

        const geniusRes = await axios.get(`https://api.genius.com/search?q=${encodeURIComponent(searchQuery)}`, {
          headers: { 'Authorization': `Bearer ${GENIUS_TOKEN}` }
        });

        const hits = geniusRes.data.response.hits;

        if (hits && hits.length > 0) {
          const bestMatch = hits[0].result;
          
          // ✅ TÜM EKSİK BİLGİLER BURAYA EKLENDİ
          recognition = {
            title: bestMatch.title,                     // Şarkı Adı
            artist: bestMatch.primary_artist.name,       // Sanatçı Adı
            album_art: bestMatch.song_art_image_url,    // Ana Kapak Resmi (Büyük Boy)
            thumbnail: bestMatch.song_art_image_thumbnail_url, // Küçük Resim
            release_date: bestMatch.release_date_for_display || "Bilinmiyor", // Tarih
            full_title: bestMatch.full_title,            // Sanatçı + Şarkı tam isim
            artist_image: bestMatch.primary_artist.image_url, // Sanatçının fotoğrafı
            lyrics_snippet: lyrics                      // AI'nın duyduğu kısım
          };
          source = "Genius (Verified)";
        } else {
          console.warn("⚠️ Genius could not find a match.");
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

  console.log(`📤 Source: ${source || "Failed"}\n=== 🏁 COMPLETE ===`);
  return res.json(response);
});

export default router;
