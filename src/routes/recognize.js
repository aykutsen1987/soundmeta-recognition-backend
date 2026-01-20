import express from "express";
import multer from "multer";
import fs from "fs";
import { recognizeWithAudD } from "../services/audd.js";

const router = express.Router();
const upload = multer({ dest: "uploads/" });

router.post("/recognize", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "No audio file uploaded"
    });
  }

  let recognition = null;
  let source = null;

  try {
    // 🔹 ŞİMDİLİK: sadece AudD (AcoustID Adım 8'de)
    const auddResult = await recognizeWithAudD(req.file.path);

    if (auddResult) {
      recognition = auddResult;
      source = "AudD";
    }
  } catch (err) {
    // sessiz geçiyoruz (backend ASLA çökmez)
  } finally {
    // geçici dosyayı sil
    fs.unlink(req.file.path, () => {});
  }

  return res.json({
    success: true,
    message: "Audio processed",
    file: {
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size
    },
    recognition,
    source
  });
});

export default router;
