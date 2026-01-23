import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

import { recognizeWithAcoustID } from "../services/acoustid.js";
import { recognizeWithAudD } from "../services/audd.js";

const router = express.Router();

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

    if (buffer.toString("ascii", 0, 4) !== "RIFF")
      return { valid: false, error: "Not RIFF" };

    if (buffer.toString("ascii", 8, 12) !== "WAVE")
      return { valid: false, error: "Not WAVE" };

    const audioFormat = buffer.readUInt16LE(20);
    if (audioFormat !== 1)
      return { valid: false, error: "Not PCM" };

    const channels = buffer.readUInt16LE(22);
    const sampleRate = buffer.readUInt32LE(24);
    const bitsPerSample = buffer.readUInt16LE(34);
    const dataSize = buffer.readUInt32LE(40);

    const duration =
      dataSize / (sampleRate * channels * (bitsPerSample / 8));

    return {
      valid: true,
      channels,
      sampleRate,
      bitsPerSample,
      dataSize,
      duration
    };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

// =======================
// 🎵 POST /recognize
// =======================
router.post("/", upload.single("audio"), async (req, res) => {
  console.log("\n=== 🎵 NEW RECOGNITION REQUEST ===");
  console.log(`⏰ Time: ${new Date().toISOString()}`);

  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "No audio file uploaded"
    });
  }

  console.log("📂 File received:");
  console.log(`   Name: ${req.file.originalname}`);
  console.log(`   Size: ${(req.file.size / 1024).toFixed(2)} KB`);
  console.log(`   Path: ${req.file.path}`);

  let recognition = null;
  let source = null;
  let validationError = null;

  const originalPath = req.file.path;
  const auddPath = originalPath + "_audd.wav";

  try {
    // =======================
    // 1️⃣ WAV validation
    // =======================
    const validation = validateWavFile(originalPath);

    if (!validation.valid) {
      validationError = validation.error;
      console.warn("⚠️ WAV invalid:", validationError);
    } else {
      console.log("✅ WAV valid:");
      console.log(`   Duration: ${validation.duration.toFixed(2)}s`);

      if (validation.duration < 3) {
        validationError = "Audio too short (<3s)";
      }
    }

    // =======================
    // 2️⃣ AcoustID
    // =======================
    if (!validationError) {
      console.log("\n🔍 Trying AcoustID...");
      const acoustIdResult = await recognizeWithAcoustID(originalPath);

      if (acoustIdResult) {
        recognition = acoustIdResult;
        source = "AcoustID";
      }
    }

    // =======================
    // 3️⃣ AudD (ffmpeg ile)
    // =======================
    if (!recognition && !validationError) {
      console.log("\n🔧 Preparing audio for AudD (ffmpeg)...");

      execSync(
        `ffmpeg -y -i "${originalPath}" -ac 1 -ar 22050 -ss 3 -t 9 "${auddPath}"`
      );

      const sizeMB = fs.statSync(auddPath).size / 1024 / 1024;
      console.log(`📦 AudD WAV size: ${sizeMB.toFixed(2)} MB`);

      if (sizeMB > 1) {
        throw new Error("AudD audio still too large");
      }

      console.log("🔍 Trying AudD...");
      const auddResult = await recognizeWithAudD(auddPath);

      if (auddResult) {
        recognition = auddResult;
        source = "AudD";
      }
    }

  } catch (err) {
    console.error("❌ Recognition error:", err.message);
    validationError = err.message;
  } finally {
    // =======================
    // 🗑️ Cleanup
    // =======================
    if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
    if (fs.existsSync(auddPath)) fs.unlinkSync(auddPath);
  }

  const response = {
    success: recognition !== null,
    message: recognition
      ? "Track recognized successfully"
      : validationError || "Could not recognize the track",
    recognition,
    source
  };

  console.log("\n📤 Response:");
  console.log(`   Success: ${response.success}`);
  console.log(`   Source: ${source || "None"}`);
  console.log("=== 🏁 REQUEST COMPLETE ===\n");

  return res.json(response);
});

export default router;
