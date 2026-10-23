import express from "express";
import multer from "multer";
import fs from "fs";
import { execSync } from "child_process";
import Groq from "groq-sdk";
import axios from "axios";

// AcoustID servisinin dosya yolunun doğruluğundan emin olun
import { recognizeWithAcoustID } from "../services/acoustid.js";
import { recognizeWithAudD } from "../services/audd.js";

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

    // 1️⃣ FFmpeg: 16kHz mono (AudD 1MB sınırına sığar). -ss kaldırıldı (kayıt zaten 15sn).
    try {
      execSync(
        `ffmpeg -y -i "${originalPath}" -ac 1 -ar 16000 "${optimizedPath}"`,
        { stdio: "pipe" }
      );
    } catch (e) {
      console.error("❌ FFmpeg failed (kurulu mu?):", e.stderr ? e.stderr.toString().slice(-300) : e.message);
      fs.copyFileSync(originalPath, optimizedPath); // ffmpeg yoksa orijinal ile devam
    }

    // 2️⃣ KATMAN 1: AudD (mikrofon kaydı için en uygun)
    try {
      const auddResult = await recognizeWithAudD(optimizedPath);
      if (auddResult && auddResult.title) {
        recognition = auddResult;
        source = "AudD";
      }
    } catch (e) {
      console.log("⚠️ AudD failed:", e.message);
    }

    // 2.5️⃣ KATMAN 2: AcoustID
    if (!recognition) {
      try {
        const acoustIdResult = await recognizeWithAcoustID(optimizedPath);
        if (acoustIdResult && acoustIdResult.title) {
          recognition = acoustIdResult;
          source = "AcoustID";
        }
      } catch (e) {
        console.log("⚠️ AcoustID failed:", e.message);
      }
    }

    // 3️⃣ KATMAN 3: GROQ WHISPER + GENIUS
    if (!recognition) {
      console.log("🤖 Analyzing lyrics with AI...");
      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(optimizedPath),
        model: "whisper-large-v3-turbo",
        prompt: "Bu bir şarkı kaydıdır, duyduğun sözleri hatasız yaz."
      });

      let lyrics = transcription.text.trim();
      
      // Klişe video bitiş cümlelerini temizle
      if (lyrics.toLowerCase().includes("teşekkür ederim")) lyrics = "";

      const cleanLyrics = lyrics.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g,"");

      if (cleanLyrics.split(/\s+/).length >= 3) {
        console.log(`📝 Heard Lyrics: "${cleanLyrics}"`);
        
        // Önce Llama'ya düzeltme yaptır (Kritik adım)
        console.log("🧠 Asking Llama to predict and fix typos...");
        const aiGuess = await groq.chat.completions.create({
          messages: [
            { role: "system", content: "Sen bir müzik uzmanısın. Kullanıcının yanlış duymuş olabileceği şarkı sözlerini düzelt ve GERÇEK şarkı adını ve sanatçısını JSON dön: {\"title\": \"...\", \"artist\": \"...\"}. Eğer bulamazsan null dön." },
            { role: "user", content: `Bu sözler hangi gerçek şarkıya ait olabilir?: "${cleanLyrics}"` }
          ],
          model: "llama-3.1-8b-instant",
          response_format: { type: "json_object" }
        });

        const prediction = JSON.parse(aiGuess.choices[0].message.content);
        
        // Arama sorgusunu belirle (Eğer AI tahmin yaptıysa onu kullan, yoksa ham sözleri)
        const searchQuery = (prediction && prediction.title) 
          ? `${prediction.title} ${prediction.artist}` 
          : cleanLyrics.split(/\s+/).slice(0, 6).join(" ");

        console.log(`🔍 Final Genius Search: "${searchQuery}"`);
        const geniusRes = await axios.get(`https://api.genius.com/search?q=${encodeURIComponent(searchQuery)}`, {
          headers: { 'Authorization': `Bearer ${GENIUS_TOKEN}` }
        });

        if (geniusRes.data.response.hits.length > 0) {
          const best = geniusRes.data.response.hits[0].result;
          recognition = {
            title: best.title,
            artist: best.primary_artist.name,
            albumArt: best.song_art_image_url,
            album: "",
            year: (best.release_date_for_display || "").slice(-4),
            full_title: best.full_title
          };
          source = (prediction && prediction.title) ? "AI Prediction + Genius" : "Genius (Verified Lyrics)";
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
