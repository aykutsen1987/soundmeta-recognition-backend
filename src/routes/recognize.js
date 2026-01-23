import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";

import { recognizeWithAcoustID } from "../services/acoustid.js";
import { recognizeWithAudD } from "../services/audd.js";

const router = express.Router();

// ✅ Multer konfigürasyonu
const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB max
  },
  fileFilter: (req, file, cb) => {
    // Sadece audio dosyalarını kabul et
    if (file.mimetype.startsWith("audio/")) {
      cb(null, true);
    } else {
      cb(new Error("Only audio files are allowed"));
    }
  }
});

/**
 * ✅ WAV dosyası validasyonu
 */
function validateWavFile(filePath) {
  try {
    const buffer = Buffer.alloc(44);
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buffer, 0, 44, 0);
    fs.closeSync(fd);

    // RIFF header kontrolü
    const riff = buffer.toString("ascii", 0, 4);
    if (riff !== "RIFF") {
      return { valid: false, error: "Not a valid RIFF file" };
    }

    // WAVE format kontrolü
    const wave = buffer.toString("ascii", 8, 12);
    if (wave !== "WAVE") {
      return { valid: false, error: "Not a valid WAVE file" };
    }

    // Audio format (PCM = 1)
    const audioFormat = buffer.readUInt16LE(20);
    if (audioFormat !== 1) {
      return { valid: false, error: `Unsupported audio format: ${audioFormat}` };
    }

    // Channels
    const channels = buffer.readUInt16LE(22);

    // Sample rate
    const sampleRate = buffer.readUInt32LE(24);

    // Bits per sample
    const bitsPerSample = buffer.readUInt16LE(34);

    // Data size
    const dataSize = buffer.readUInt32LE(40);

    return {
      valid: true,
      channels,
      sampleRate,
      bitsPerSample,
      dataSize,
      duration: dataSize / (sampleRate * channels * (bitsPerSample / 8))
    };

  } catch (error) {
    return { valid: false, error: error.message };
  }
}

router.post("/", upload.single("audio"), async (req, res) => {
  console.log("\n=== 🎵 NEW RECOGNITION REQUEST ===");
  console.log(`⏰ Time: ${new Date().toISOString()}`);

  if (!req.file) {
    console.error("❌ No file uploaded");
    return res.status(400).json({
      success: false,
      message: "No audio file uploaded",
      error: "Missing file"
    });
  }

  console.log("📂 File received:");
  console.log(`   Name: ${req.file.originalname}`);
  console.log(`   Type: ${req.file.mimetype}`);
  console.log(`   Size: ${req.file.size} bytes (${(req.file.size / 1024).toFixed(2)} KB)`);
  console.log(`   Path: ${req.file.path}`);

  let recognition = null;
  let source = null;
  let validationError = null;

  try {
    // ✅ 1. Dosya boyutu kontrolü
    if (req.file.size < 50 * 1024) {
      validationError = "File too small (< 50KB)";
      console.warn(`⚠️ ${validationError}`);
    } else if (req.file.size > 5 * 1024 * 1024) {
      validationError = "File too large (> 5MB)";
      console.warn(`⚠️ ${validationError}`);
    }

    // ✅ 2. WAV formatı validasyonu
    const validation = validateWavFile(req.file.path);
    
    if (!validation.valid) {
      validationError = validation.error;
      console.error(`❌ WAV validation failed: ${validationError}`);
    } else {
      console.log("✅ WAV file valid:");
      console.log(`   Channels: ${validation.channels}`);
      console.log(`   Sample Rate: ${validation.sampleRate} Hz`);
      console.log(`   Bits/Sample: ${validation.bitsPerSample}`);
      console.log(`   Duration: ${validation.duration.toFixed(2)}s`);

      // Duration kontrolü
      if (validation.duration < 3) {
        validationError = "Audio too short (< 3 seconds)";
        console.warn(`⚠️ ${validationError}`);
      } else if (validation.duration > 15) {
        console.warn(`⚠️ Audio very long (${validation.duration.toFixed(2)}s), processing may be slow`);
      }
    }

    // ✅ 3. Tanıma işlemi (validation başarılıysa)
    if (!validationError) {
      // 3a. AcoustID (ana motor)
      console.log("\n🔍 Trying AcoustID...");
      const acoustIdResult = await recognizeWithAcoustID(req.file.path);

      if (acoustIdResult) {
        recognition = acoustIdResult;
        source = "AcoustID";
        console.log("✅ AcoustID success!");
      } else {
        // 3b. AudD (yedek motor)
        console.log("\n🔍 AcoustID failed, trying AudD...");
        const auddResult = await recognizeWithAudD(req.file.path);

        if (auddResult) {
          recognition = auddResult;
          source = "AudD";
          console.log("✅ AudD success!");
        } else {
          console.warn("⚠️ Both recognition services failed");
        }
      }
    }

  } catch (err) {
    console.error("❌ Recognition error:", err.message);
    validationError = err.message;
  } finally {
    // ✅ Geçici dosyayı sil
    try {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
        console.log("🗑️ Temporary file deleted");
      }
    } catch (cleanupError) {
      console.error("⚠️ Failed to delete temp file:", cleanupError.message);
    }
  }

  // ✅ Response
  const response = {
    success: recognition !== null,
    message: recognition 
      ? "Track recognized successfully"
      : validationError || "Could not recognize the track",
    file: {
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size
    },
    recognition,
    source,
    error: validationError
  };

  console.log("\n📤 Response:");
  console.log(`   Success: ${response.success}`);
  console.log(`   Source: ${source || "None"}`);
  console.log(`   Track: ${recognition ? `${recognition.title} - ${recognition.artist}` : "N/A"}`);
  console.log("=== 🏁 REQUEST COMPLETE ===\n");

  return res.json(response);
});

export default router;
