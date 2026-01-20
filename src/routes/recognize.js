import multer from "multer";
import express from "express";

const router = express.Router();

/**
 * Dosya bellekte tutulur
 * (ileride ffmpeg ile işlenecek)
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10 MB
  }
});

/**
 * POST /recognize
 * multipart/form-data
 * field name: audio
 */
router.post("/", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Audio file not provided"
      });
    }

    // ŞİMDİLİK SADECE BİLGİ DÖNÜYORUZ
    return res.status(200).json({
      success: true,
      message: "Audio received successfully",
      file: {
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size
      },
      recognition: null, // henüz yok
      source: null
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
});

export default router;
