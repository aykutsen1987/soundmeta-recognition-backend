import express from "express";

const app = express();

/**
 * Render otomatik PORT verir
 * Local'de çalıştırılırsa 3000 kullanır
 */
const PORT = process.env.PORT || 3000;

/**
 * JSON body desteği
 */
app.use(express.json());

/**
 * Health check endpoint
 * Render + tarayıcıdan test için
 */
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "SoundMeta Recognition Backend",
    time: new Date().toISOString()
  });
});

/**
 * Ana endpoint (şimdilik boş)
 * Bir sonraki adımda dolduracağız
 */
app.post("/recognize", (req, res) => {
  res.status(501).json({
    message: "Recognition service not implemented yet"
  });
});

/**
 * Server başlat
 */
app.listen(PORT, () => {
  console.log(`🚀 SoundMeta backend running on port ${PORT}`);
});
