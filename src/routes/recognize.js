import express from "express";
import multer from "multer";

const router = express.Router();
const upload = multer({ dest: "uploads/" });

router.post("/recognize", upload.single("audio"), async (req, res) => {
  res.json({
    success: true,
    message: "Audio received successfully",
    file: {
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size
    },
    recognition: null,
    source: null
  });
});

export default router;
