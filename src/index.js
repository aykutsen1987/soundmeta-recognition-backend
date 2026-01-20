import express from "express";
import recognizeRoute from "./routes/recognize.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "SoundMeta Recognition Backend",
    time: new Date().toISOString()
  });
});

app.use("/recognize", recognizeRoute);

app.listen(PORT, () => {
  console.log(`🚀 SoundMeta backend running on port ${PORT}`);
});
