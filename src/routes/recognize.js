import express from "express";
import multer from "multer";
import fs from "fs";
import { execSync } from "child_process";
import Groq from "groq-sdk"; // ✅ Groq eklendi

import { recognizeWithAcoustID } from "../services/acoustid.js";
import { recognizeWithAudD } from "../services/audd.js";

const router = express.Router();

// ✅ Groq Yapılandırması (Render üzerinden GROQ_API_KEY okur)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// =======================
// ✅ Multer config
// =======================
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 10 * 1024 * 1024 },
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
    return { valid: true, channels, sampleRate, bitsPerSample, duration };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

// =======================
// 🎵 POST /recognize
// =======================
router.post("/", upload.single("audio"), async (req, res) => {
  console.log("\n=== 🎵 NEW RECOGNITION REQUEST ===");
  
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
    if (validation.duration < 3) throw new Error("Audio too short (<3s)");

    // 1️⃣ Ses Optimizasyonu (FFmpeg)
    console.log("🎚️ Optimizing audio...");
    execSync(
      `ffmpeg -y -i "${originalPath}" -ac 1 -ar 16000 -ss 0 -t 10 -af loudnorm "${optimizedPath}"`,
      { stdio: "ignore" }
    );

    // 2️⃣ Ücretsiz Yöntem 1: AcoustID
    console.log("🔍 Trying AcoustID...");
    const acoustIdResult = await recognizeWithAcoustID(optimizedPath);
    if (acoustIdResult) {
      recognition = acoustIdResult;
      source = "AcoustID";
    }

    // 3️⃣ Ücretsiz Yöntem 2: AudD (Eğer AcoustID bulamazsa)
    if (!recognition) {
      console.log("🔍 Trying AudD...");
      const auddResult = await recognizeWithAudD(optimizedPath);
      if (auddResult) {
        recognition = auddResult;
        source = "AudD";
      }
    }

    // 4️⃣ 🚀 ÜCRETSİZ GROQ AI FALLBACK (Sözlerden Tanıma)
    if (!recognition) {
      console.log("🤖 Traditional methods failed. Activating Groq AI...");
      
      // Step A: Whisper-v3 ile sesi yazıya dök
      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(optimizedPath),
        model: "whisper-large-v3",
        language: "tr" // Veya otomatik algılama için kaldırabilirsin
      });

      if (transcription.text && transcription.text.length > 5) {
        console.log(`📝 Groq Lyrics: "${transcription.text}"`);

        // Step B: Llama-3 ile şarkıyı bul
        const completion = await groq.chat.completions.create({
          messages: [
            { 
              role: "system", 
              content: "Sen bir müzik uzmanısın. Sadece JSON formatında cevap ver. Örn: {\"title\": \"Şarkı Adı\", \"artist\": \"Sanatçı\"}" 
            },
            { 
              role: "user", 
              content: `Bu sözler hangi şarkıya ait? Sadece en yüksek ihtimali yaz: "${transcription.text}"` 
            }
          ],
          model: "llama3-8b-8192", // En hızlı ve ücretsiz model
          response_format: { type: "json_object" }
        });

        const aiData = JSON.parse(completion.choices[0].message.content);
        recognition = {
          title: aiData.title,
          artist: aiData.artist,
          lyrics_sample: transcription.text
        };
        source = "Groq AI (Whisper + Llama3)";
      }
    }

  } catch (err) {
    console.error("❌ Error:", err.message);
    validationError = err.message;
  } finally {
    // 🗑️ Cleanup
    if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
    if (fs.existsSync(optimizedPath)) fs.unlinkSync(optimizedPath);
  }

  const response = {
    success: recognition !== null,
    message: recognition ? "Track found" : validationError || "Not found",
    recognition,
    source
  };

  console.log(`📤 Source: ${source || "None"}\n=== 🏁 COMPLETE ===`);
  return res.json(response);
});

export default router;
