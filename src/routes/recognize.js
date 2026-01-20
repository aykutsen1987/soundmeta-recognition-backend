import { recognizeWithAcoustID } from "../services/acoustid.js";

router.post("/", upload.single("audio"), async (req, res) => {
  try {
    const fp = await generateFingerprint(req.file.path);

    const acoustidResult = await recognizeWithAcoustID(
      fp.fingerprint,
      fp.duration
    );

    res.json({
      success: true,
      engine: "acoustid",
      result: acoustidResult
    });

  } catch (e) {
    res.status(500).json({
      success: false,
      error: e.message
    });
  }
});
