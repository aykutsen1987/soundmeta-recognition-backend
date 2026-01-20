import express from "express";
import multer from "multer";
import { generateFingerprint } from "../utils/fingerprint.js";

const router = express.Router();
const upload = multer({ dest: "uploads/" });

router.post("/", upload.single("audio"), async (req, res) => {
  try {
    const fp = await generateFingerprint(req.file.path);
    res.json({
      success: true,
      fingerprint: fp.fingerprint,
      duration: fp.duration
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
