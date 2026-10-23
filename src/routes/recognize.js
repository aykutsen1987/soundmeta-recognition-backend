import express from "express";
import multer from "multer";
import fs from "fs";
import { execSync } from "child_process";
import Groq from "groq-sdk";
import axios from "axios";

// AcoustID servisinin dosya yolunun doğruluğundan emin olun
import { recognizeWithAcoustID } from "../services/acoustid.js";
import { recognizeWithAudD } from "../services/audd.js";
import { recognizeWithShazam } from "../services/shazam.js";

const router = express.Router();

// ✅ Yapılandırmalar
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const GENIUS_TOKEN = process.env.GENIUS_ACCESS_TOKEN;

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) cb(null, true);
    else cb(new Error("Only audio files are allowed"));
  }
});


// Hesapta gerçekten erişilebilen bir sohbet modelini otomatik seç
let cachedChatModel = null;
async function getChatModel() {
  if (cachedChatModel) return cachedChatModel;
  const res = await axios.get("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }
  });
  const ids = res.data.data.map(m => m.id).filter(id => !/whisper|guard|tts|playai|distil/i.test(id));
  const prefs = [/gpt-oss-120b/, /llama-3\.3-70b/, /llama-3\.1-8b/, /llama/, /gpt-oss/, /qwen/];
  for (const p of prefs) {
    const f = ids.find(id => p.test(id));
    if (f) { cachedChatModel = f; break; }
  }
  if (!cachedChatModel) cachedChatModel = ids[0];
  console.log("🧠 Using Groq model:", cachedChatModel, "| available:", ids.join(", "));
  return cachedChatModel;
}

const norm = (t) => (t || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim();

function validateWavFile(filePath) {
  try {
    const buffer = Buffer.alloc(44);
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buffer, 0, 44, 0);
    fs.closeSync(fd);
    if (buffer.toString("ascii", 0, 4) !== "RIFF") return { valid: false, error: "Not RIFF" };
    if (buffer.toString("ascii", 8, 12) !== "WAVE") return { valid: false, error: "Not WAVE" };
    const audioFormat = buffer.readUInt16LE(20);
    const channels = buffer.readUInt16LE(22);
    const sampleRate = buffer.readUInt32LE(24);
    const bitsPerSample = buffer.readUInt16LE(34);
    const dataSize = buffer.readUInt32LE(40);
    const duration = dataSize / (sampleRate * channels * (bitsPerSample / 8));
    return { valid: true, duration };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

router.post("/", upload.single("audio"), async (req, res) => {
  console.log("\n=== 🎵 STARTING ADVANCED HYBRID RECOGNITION ===");
  
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No audio file uploaded" });
  }

  const originalPath = req.file.path;
  const optimizedPath = originalPath + "_optimized.wav";
  let recognition = null;
  let source = null;

  try {
    const validation = validateWavFile(originalPath);
    if (!validation.valid) throw new Error(validation.error);

    // 1️⃣ FFmpeg: 16kHz mono (AudD 1MB sınırına sığar). -ss kaldırıldı (kayıt zaten 15sn).
    try {
      execSync(
        `ffmpeg -y -i "${originalPath}" -ac 1 -ar 16000 "${optimizedPath}"`,
        { stdio: "pipe" }
      );
    } catch (e) {
      console.error("❌ FFmpeg failed (kurulu mu?):", e.stderr ? e.stderr.toString().slice(-300) : e.message);
      fs.copyFileSync(originalPath, optimizedPath); // ffmpeg yoksa orijinal ile devam
    }

    // 2️⃣ KATMAN 0: Shazam (RapidAPI, gayriresmî) — orijinal 44.1kHz kayıtla
    try {
      const shazamResult = await recognizeWithShazam(originalPath);
      if (shazamResult && shazamResult.title) {
        recognition = shazamResult;
        source = "Shazam";
      }
    } catch (e) {
      console.log("⚠️ Shazam failed:", e.message);
    }

    // 2️⃣ KATMAN 1: AudD
    try {
      const auddResult = recognition ? null : await recognizeWithAudD(optimizedPath);
      if (auddResult && auddResult.title) {
        recognition = auddResult;
        source = "AudD";
      }
    } catch (e) {
      console.log("⚠️ AudD failed:", e.message);
    }

    // 2.5️⃣ KATMAN 2: AcoustID
    if (!recognition) {
      try {
        const acoustIdResult = await recognizeWithAcoustID(optimizedPath);
        if (acoustIdResult && acoustIdResult.title) {
          recognition = acoustIdResult;
          source = "AcoustID";
        }
      } catch (e) {
        console.log("⚠️ AcoustID failed:", e.message);
      }
    }

    // 3️⃣ KATMAN 3: GROQ WHISPER + GENIUS
    if (!recognition) {
      console.log("🤖 Analyzing lyrics with AI...");
      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(optimizedPath),
        model: "whisper-large-v3-turbo",
        prompt: "Bu bir şarkı kaydıdır, duyduğun sözleri hatasız yaz."
      });

      let lyrics = transcription.text.trim();
      
      // Klişe video bitiş cümlelerini temizle
      if (lyrics.toLowerCase().includes("teşekkür ederim")) lyrics = "";

      const cleanLyrics = lyrics.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g,"");

      if (cleanLyrics.split(/\s+/).length >= 3) {
        console.log(`📝 Heard Lyrics: "${cleanLyrics}"`);
        
        // Önce Llama'ya düzeltme yaptır (Kritik adım)
        console.log("🧠 Asking Llama to predict and fix typos...");
        let prediction = null;
        try {
          const model = await getChatModel();
          const aiGuess = await groq.chat.completions.create({
            messages: [
              { role: "system", content: "Sen bir müzik uzmanısın. Kullanıcının yanlış duymuş olabileceği şarkı sözlerini düzelt ve GERÇEK şarkı adını ve sanatçısını SADECE JSON olarak dön, başka hiçbir şey yazma: {\"title\": \"...\", \"artist\": \"...\"}. Emin değilsen {\"title\": null, \"artist\": null} dön, ASLA tahmin uydurma." },
              { role: "user", content: `Bu sözler hangi gerçek şarkıya ait olabilir?: "${cleanLyrics}"` }
            ],
            model,
            max_tokens: 2000,
            ...(model.includes("gpt-oss") ? { reasoning_effort: "low" } : {})
          });
          const raw = aiGuess.choices[0].message.content || "";
          console.log("🧠 LLM raw:", raw.slice(0, 300));
          const m = raw.match(/\{[\s\S]*\}/);
          prediction = m ? JSON.parse(m[0]) : null;
        } catch (e) {
          console.log("⚠️ Llama failed:", e.message);
        }

        // Arama sorgusunu belirle (Eğer AI tahmin yaptıysa onu kullan, yoksa ham sözleri)
        if (prediction && prediction.title) {
          const searchQuery = `${prediction.title} ${prediction.artist || ""}`.trim();
          console.log(`🔍 Final Genius Search: "${searchQuery}"`);
          const geniusRes = await axios.get(`https://api.genius.com/search?q=${encodeURIComponent(searchQuery)}`, {
            headers: { 'Authorization': `Bearer ${GENIUS_TOKEN}` }
          });
          const hit = geniusRes.data.response.hits
            .map(h => h.result)
            .find(r => norm(r.title).includes(norm(prediction.title)) || norm(prediction.title).includes(norm(r.title)));
          if (hit) {
            recognition = {
              title: hit.title,
              artist: hit.primary_artist.name,
              albumArt: hit.song_art_image_url,
              album: "",
              year: (hit.release_date_for_display || "").slice(-4)
            };
            source = "AI Prediction + Genius";
          } else {
            console.log("⚠️ Genius sonucu tahminle uyuşmadı, yanlış sonuç döndürülmüyor");
          }
        } else {
          // Yedek: ham sözlerle Genius adayları çıkar, LLM'e aralarından seçtir
          try {
            const q = cleanLyrics.split(/\s+/).slice(0, 8).join(" ");
            const gr = await axios.get(`https://api.genius.com/search?q=${encodeURIComponent(q)}`, {
              headers: { 'Authorization': `Bearer ${GENIUS_TOKEN}` }
            });
            const cands = gr.data.response.hits.slice(0, 5).map(h => h.result);
            console.log("🔎 Genius adayları:", cands.map(c => `${c.title} - ${c.primary_artist.name}`).join(" | "));
            if (cands.length) {
              const model = await getChatModel();
              const pick = await groq.chat.completions.create({
                messages: [
                  { role: "system", content: "Şarkı sözü uzmanısın. Verilen sözlerin hangi aday şarkıya ait olduğunu SADECE JSON olarak dön: {\"index\": N, \"confidence\": 0-1 arası sayı}. Sözlerle başlık/sanatçı ve şarkı içeriği uyumluysa en olası adayı seç. Hiçbiri olası değilse {\"index\": null, \"confidence\": 0}." },
                  { role: "user", content: `Sözler: "${cleanLyrics}"\nAdaylar:\n` + cands.map((c, i) => `${i}: ${c.title} - ${c.primary_artist.name}`).join("\n") }
                ],
                model,
                max_tokens: 2000,
                ...(model.includes("gpt-oss") ? { reasoning_effort: "low" } : {})
              });
              const raw2 = pick.choices[0].message.content || "";
              console.log("🧠 LLM pick raw:", raw2.slice(0, 200));
              const m2 = raw2.match(/\{[\s\S]*\}/);
              const parsed2 = m2 ? JSON.parse(m2[0]) : {};
              const idx = (Number(parsed2.confidence) >= 0.5) ? parsed2.index : null;
              if (Number.isInteger(idx) && cands[idx]) {
                const hit = cands[idx];
                recognition = {
                  title: hit.title,
                  artist: hit.primary_artist.name,
                  albumArt: hit.song_art_image_url,
                  album: "",
                  year: (hit.release_date_for_display || "").slice(-4)
                };
                source = "Genius candidates + AI";
              }
            }
          } catch (e) {
            console.log("⚠️ Candidate fallback failed:", e.message);
          }
          if (!recognition) console.log("⚠️ Güvenilir tahmin yok, sonuç döndürülmüyor");
        }
      }
    }

  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
    if (fs.existsSync(optimizedPath)) fs.unlinkSync(optimizedPath);
  }

  res.json({
    success: recognition !== null,
    recognition,
    source,
    message: recognition ? "Success" : "Track not found"
  });
});

export default router;
