import express from "express";
import fs from "fs";
import recognizeRoute from "./routes/recognize.js";

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ uploads klasörünü oluştur
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
  console.log("✅ Created uploads directory");
}

// Middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ✅ CORS (gerekirse)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  
  next();
});

// ✅ Request logger
app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.path} - ${new Date().toISOString()}`);
  next();
});

// Routes
app.get("/", (req, res) => {
  res.json({
    service: "SoundMeta Recognition Backend",
    version: "1.0.0",
    status: "running",
    endpoints: {
      health: "/health",
      recognize: "/recognize (POST)"
    },
    time: new Date().toISOString()
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "SoundMeta Recognition Backend",
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    time: new Date().toISOString()
  });
});

app.use("/recognize", recognizeRoute);

// ✅ 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    path: req.path,
    message: "The requested endpoint does not exist"
  });
});

// ✅ Error handler
app.use((err, req, res, next) => {
  console.error("❌ Server error:", err);
  
  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error",
    success: false
  });
});

// ✅ Server başlat
app.listen(PORT, () => {
  console.log("\n🚀 ================================");
  console.log(`🎵 SoundMeta Backend Running`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`⏰ Started: ${new Date().toISOString()}`);
  console.log("================================\n");
});

// ✅ Graceful shutdown
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("🛑 SIGINT received, shutting down gracefully...");
  process.exit(0);
});
