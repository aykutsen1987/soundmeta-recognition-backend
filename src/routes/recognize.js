import express from "express";
import multer from "multer";
import fs from "fs";

import { recognizeWithAcoustID } from "../services/acoustid.js";
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
    // 1️⃣ ANA MOTOR — AcoustID (sınırsız)
    const acoustIdResult = await recognizeWithAcoustID(req.file.path);

    if (acoustIdResult) {
      recognition = acoustIdResult;
      source = "AcoustID";
    } else {
      // 2️⃣ YEDEK MOTOR — AudD (limitli)
      const auddResult = await recognizeWithAudD(req.file.path);

      if (auddResult) {
        recognition = auddResult;
        source = "AudD";
      }
    }
  } catch (err) {
    // Bilinçli olarak sessiz geçiyoruz
    // Backend ASLA crash olmaz
  } finally {
    // Geçici dosyayı her durumda sil
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
