import express from "express";
import multer from "multer";
import fs from "fs";
import { execSync } from "child_process";
import Groq from "groq-sdk";
import axios from "axios";

// AcoustID servisinin dosya yolunun doğruluğundan emin olun
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
  console.log("\n=== 🎵 STARTING ADVANCED HYBRID RECOGNITION ===");
  
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

    // 1️⃣ FFmpeg: Sesi optimize et (25 saniye)
    console.log("🎚️ Optimizing audio...");
    execSync(
      `ffmpeg -y -i "${originalPath}" -ac 1 -ar 16000 -ss 0 -t 25 -af loudnorm "${optimizedPath}"`,
      { stdio: "ignore" }
    );

    // 2️⃣ KATMAN 1: AcoustID (Ses Parmak İzi - Müzikten Bulma)
    try {
      console.log("🔍 Attempting Audio Fingerprinting...");
      const acoustIdResult = await recognizeWithAcoustID(optimizedPath);
      if (acoustIdResult && acoustIdResult.title) {
        recognition = acoustIdResult;
        source = "AcoustID (Direct Audio Match)";
      }
    } catch (e) { console.log("⚠️ AcoustID skipped."); }

    // 3️⃣ KATMAN 2: GROQ WHISPER + GENIUS (Sözden Bulma)
    if (!recognition) {
      console.log("🤖 Analyzing lyrics with AI...");
      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(optimizedPath),
        model: "whisper-large-v3-turbo",
        prompt: "Bu bir şarkı kaydıdır, duyduğun sözleri hatasız yaz."
      });

      const lyrics = transcription.text.trim();
      const cleanLyrics = lyrics.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g,"");

      if (cleanLyrics.split(/\s+/).length >= 3) {
        console.log(`📝 Heard Lyrics: "${cleanLyrics}"`);
        
        const words = cleanLyrics.split(/\s+/);
        const searchAttempts = [
          words.slice(0, 6).join(" "),
          words.slice(Math.floor(words.length / 2) - 3, Math.floor(words.length / 2) + 3).join(" "),
          words.slice(-6).join(" ")
        ];

        for (const query of searchAttempts) {
          if (!query || query.length < 5) continue;
          console.log(`🔍 Searching Genius: "${query}"`);
          const geniusRes = await axios.get(`https://api.genius.com/search?q=${encodeURIComponent(query)}`, {
            headers: { 'Authorization': `Bearer ${GENIUS_TOKEN}` }
          });

          if (geniusRes.data.response.hits.length > 0) {
            const best = geniusRes.data.response.hits[0].result;
            recognition = {
              title: best.title,
              artist: best.primary_artist.name,
              album_art: best.song_art_image_url,
              thumbnail: best.song_art_image_thumbnail_url,
              release_date: best.release_date_for_display || "Bilinmiyor",
              full_title: best.full_title
            };
            source = "Genius (Verified Lyrics)";
            break;
          }
        }

        // 4️⃣ KATMAN 3: LLAMA PREDICTION (Eğer Genius bulamazsa AI tahmin etsin)
        if (!recognition) {
          console.log("🧠 Genius failed. Asking Llama to predict...");
          const aiGuess = await groq.chat.completions.create({
            messages: [
              { role: "system", content: "Sen uzman bir müzik kütüphanesisin. Verilen metne en yakın GERÇEK şarkıyı bul ve JSON olarak dön: {\"title\": \"...\", \"artist\": \"...\"}. Eğer bulamazsan null dön." },
              { role: "user", content: `Bu sözler hangi şarkıya ait olabilir?: "${cleanLyrics}"` }
            ],
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" }
          });

          const prediction = JSON.parse(aiGuess.choices[0].message.content);
          if (prediction && prediction.title) {
            // Tahmin edilen şarkıyı tekrar Genius'ta doğrula (Resim çekmek için)
            const verifyRes = await axios.get(`https://api.genius.com/search?q=${encodeURIComponent(prediction.title + " " + prediction.artist)}`, {
              headers: { 'Authorization': `Bearer ${GENIUS_TOKEN}` }
            });

            if (verifyRes.data.response.hits.length > 0) {
              const best = verifyRes.data.response.hits[0].result;
              recognition = {
                title: best.title,
                artist: best.primary_artist.name,
                album_art: best.song_art_image_url,
                thumbnail: best.song_art_image_thumbnail_url,
                full_title: best.full_title
              };
              source = "Groq AI Prediction + Genius Verify";
            }
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

  res.json({
    success: recognition !== null,
    recognition,
    source,
    message: recognition ? "Success" : "Track not found"
  });
});

export default router;
