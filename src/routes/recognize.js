import express from "express";
import multer from "multer";
import fs from "fs";
import { execSync } from "child_process";
import Groq from "groq-sdk";

import { recognizeWithAcoustID } from "../services/acoustid.js";
import { recognizeWithAudD } from "../services/audd.js";

const router = express.Router();

// ✅ Groq Yapılandırması
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// =======================
// ✅ Multer config
// =======================
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 15 * 1024 * 1024 }, // 25 saniye için limit 15MB'a çıkarıldı
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) cb(null, true);
    else cb(new Error("Only audio files are allowed"));
  }
});

// =======================
// ✅ WAV validation
// =======================
function validateWavFile(filePath) {
  try {
    const buffer = Buffer.alloc(44);
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buffer, 0, 44, 0);
    fs.closeSync(fd);
    if (buffer.toString("ascii", 0, 4) !== "RIFF") return { valid: false, error: "Not RIFF" };
    if (buffer.toString("ascii", 8, 12) !== "WAVE") return { valid: false, error: "Not WAVE" };
    const audioFormat = buffer.readUInt16LE(20);
    if (audioFormat !== 1) return { valid: false, error: "Not PCM" };
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

// =======================
// 🎵 POST /recognize
// =======================
router.post("/", upload.single("audio"), async (req, res) => {
  console.log("\n=== 🎵 STARTING DEEP RECOGNITION ===");
  
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No audio file uploaded" });
  }

  const originalPath = req.file.path;
  const optimizedPath = originalPath + "_optimized.wav";
  let recognition = null;
  let source = null;
  let validationError = null;

  try {
    const validation = validateWavFile(originalPath);
    if (!validation.valid) throw new Error(validation.error);

    // 1️⃣ Ses Optimizasyonu (Süre 25 saniyeye çıkarıldı - Sözleri yakalamak için kritik)
    console.log("🎚️ Optimizing 25 seconds of audio for AI...");
    execSync(
      `ffmpeg -y -i "${originalPath}" -ac 1 -ar 16000 -ss 0 -t 25 -af loudnorm "${optimizedPath}"`,
      { stdio: "ignore" }
    );

    // 2️⃣ AcoustID Denemesi
    try {
      console.log("🔍 Trying AcoustID...");
      const acoustIdResult = await recognizeWithAcoustID(optimizedPath);
      if (acoustIdResult) {
        recognition = acoustIdResult;
        source = "AcoustID";
      }
    } catch (e) { console.warn("⚠️ AcoustID failed."); }

    // 3️⃣ AudD Denemesi
    if (!recognition) {
      try {
        console.log("🔍 Trying AudD...");
        const auddResult = await recognizeWithAudD(optimizedPath);
        if (auddResult) {
          recognition = auddResult;
          source = "AudD";
        }
      } catch (e) { console.warn("⚠️ AudD failed."); }
    }

    // 4️⃣ 🚀 GROQ AI FALLBACK (Söz Odaklı ve Doğrulanmış Mod)
    if (!recognition) {
      console.log("🤖 Traditional methods failed. Activating Groq AI...");
      
      // A: Sesi Yazıya Dök (Whisper-v3-Turbo)
      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(optimizedPath),
        model: "whisper-large-v3-turbo",
        response_format: "json",
        prompt: "Bu bir şarkı kaydıdır, lütfen duyduğun şarkı sözlerini eksiksiz ve hatasız yaz."
      });

      const lyrics = transcription.text.trim();

      // B: Eğer 4 kelimeden az duyulduysa uydurmaması için durdur
      if (lyrics.split(/\s+/).length >= 4) {
        console.log(`📝 Groq Heard: "${lyrics}"`);

        // C: Şarkıyı Tahmin Et (Llama-3.1 Strict Mode)
        const completion = await groq.chat.completions.create({
          messages: [
            { 
              role: "system", 
              content: "Sen bir müzik kütüphanesisin. Sana verilen metni GERÇEK şarkılarla eşleştir. Eğer şarkıdan emin değilsen title kısmına 'Unknown' yaz. Asla uydurma. Sadece şu JSON formatında cevap ver: {\"title\": \"Şarkı Adı\", \"artist\": \"Sanatçı\", \"confidence\": 0-100}" 
            },
            { 
              role: "user", 
              content: `Bu sözler hangi gerçek şarkıya ait olabilir?: "${lyrics}"` 
            }
          ],
          model: "llama-3.1-8b-instant",
          response_format: { type: "json_object" },
          temperature: 0 // Yaratıcılığı kapatıyoruz (Sadece gerçek veriler)
        });

        const aiData = JSON.parse(completion.choices[0].message.content);
        
        // Güven puanı 75'ten düşükse veya bilinmiyor dediyse kabul etme
        if (aiData.title && aiData.title !== "Unknown" && aiData.confidence > 75) {
          recognition = {
            title: aiData.title,
            artist: aiData.artist || "Bilinmiyor",
            lyrics_found: lyrics,
            confidence: aiData.confidence
          };
          source = "Groq AI (Strict Mode)";
        } else {
          console.warn("⚠️ AI results are not confident enough.");
        }
      } else {
        console.warn("⚠️ Lyrics too short to analyze.");
      }
    }

  } catch (err) {
    console.error("❌ Critical Error:", err.message);
    validationError = err.message;
  } finally {
    // 🗑️ Temizlik
    if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
    if (fs.existsSync(optimizedPath)) fs.unlinkSync(optimizedPath);
  }

  const response = {
    success: recognition !== null,
    recognition,
    source,
    message: recognition ? "Track found" : (validationError || "Could not identify the track")
  };

  console.log(`📤 Final Source: ${source || "None"}\n=== 🏁 COMPLETE ===`);
  return res.json(response);
});

export default router;
