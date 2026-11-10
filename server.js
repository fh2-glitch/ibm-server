/* =====================================================================
   SERVEUR DE RECONNAISSANCE VOCALE — IBM WATSON SPEECH TO TEXT
   Un serveur à part, à côté du serveur Google (qui ne change pas) : on peut comparer les deux.
   Même envoi que le serveur Google (champ « audio » = audio.wav) et même réponse : { text, normalized }.
   Dans une activité, il suffit de changer urlServeur : https://<ce-serveur>.onrender.com/recognize-ibm

   Réglages sur Render → Environment :
     IBM_STT_APIKEY       = la clé d'API du service Speech to Text (IBM Cloud → Données d'identification)
     IBM_STT_URL          = l'URL du service (ex. https://api.eu-de.speech-to-text.watson.cloud.ibm.com/instances/…)
     IBM_STT_MODEL        = le modèle arabe (facultatif, par défaut ar-MS_Telephony)
     ORIGINES_AUTORISEES  = les sites autorisés (comme pour le serveur Google)
   Pour un test, on peut choisir le modèle dans l'adresse : …/recognize-ibm?modele=ar-MS_BroadbandModel
   Liste des modèles arabes disponibles : …/modeles-ibm
   ===================================================================== */
import express from "express";
import multer from "multer";
import cors from "cors";

const app = express();

/* 1. Sites autorisés à utiliser le serveur (protège votre quota Google).
      Réglage sur Render → Environment → variable ORIGINES_AUTORISEES, adresses séparées par des virgules, ex. :
        https://e-madrassa.ma,https://www.e-madrassa.ma,https://autre-site.ma
      ORIGINES_AUTORISEES = *   → tous les sites sont acceptés (comme avant)
      Sans variable : e-madrassa.ma + les tests sur votre ordinateur (fichier ouvert directement, localhost). */
const ORIGINES = (process.env.ORIGINES_AUTORISEES ||
  "https://e-madrassa.ma,https://www.e-madrassa.ma")
  .split(",").map(o => o.trim().replace(/\/$/, "")).filter(Boolean);
const TOUT_ACCEPTER = ORIGINES.includes("*");

function origineAcceptee(origin) {
  if (TOUT_ACCEPTER || !origin || origin === "null") return true;            // "null" = page ouverte depuis un fichier (tests)
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;  // tests sur votre ordinateur
  if (ORIGINES.includes(origin)) return true;
  // un sous-domaine d'un site autorisé (ex. cours.e-madrassa.ma) est accepté aussi
  return ORIGINES.some(o => { try { return new URL(origin).hostname.endsWith("." + new URL(o).hostname.replace(/^www\./, "")); } catch (e) { return false; } });
}
app.use(cors({ origin: (origin, ok) => ok(null, origineAcceptee(origin)) }));

/* 2. L'audio reste en mémoire : il n'est JAMAIS écrit sur le disque du serveur.
      Taille maximum 5 Mo (une lecture de 20 s en WAV fait environ 2 Mo). */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});

function normalizeArabic(text) {
  return text
    .replace(/[ًٌٍَُِّْـ]/g, "")
    .replace(/[آأإٱ]/g, "ا")
    .replace(/\s+/g, " ")
    .replace(/[،؛؟.!?,:]/g, "")
    .replace(/[​-‍﻿]/g, "")
    .replace(/[^؀-ۿ\s]/g, "")
    .trim();
}

const IBM_CLE = process.env.IBM_STT_APIKEY || "";
const IBM_URL = (process.env.IBM_STT_URL || "").replace(/\/$/, "");
const IBM_MODELE = process.env.IBM_STT_MODEL || "ar-MS_Telephony";
const ibmAuth = () => "Basic " + Buffer.from("apikey:" + IBM_CLE).toString("base64");

app.get("/", (req, res) => res.send("ok"));            // réveil du serveur par les activités
app.get("/health", (req, res) => {
  res.json({ status: "ok-ibm", ibm: IBM_CLE && IBM_URL ? "configuré" : "non configuré", modele: IBM_MODELE });
});

app.get("/modeles-ibm", async (req, res) => {
  if (!IBM_CLE || !IBM_URL) return res.status(500).json({ error: "IBM non configuré (IBM_STT_APIKEY, IBM_STT_URL)." });
  try {
    const r = await fetch(IBM_URL + "/v1/models", { headers: { Authorization: ibmAuth() } });
    const data = await r.json();
    const arabes = (data.models || []).filter(m => /^ar/i.test(m.name)).map(m => ({ nom: m.name, description: m.description }));
    res.json({ modeles: arabes, parDefaut: IBM_MODELE });
  } catch (error) {
    console.error("ERREUR IBM (modèles) :", error.message);
    res.status(500).json({ message: error.message });
  }
});

app.post("/recognize-ibm", upload.single("audio"), async (req, res) => {
  try {
    if (!IBM_CLE || !IBM_URL) return res.status(500).json({ error: "IBM non configuré (IBM_STT_APIKEY, IBM_STT_URL)." });
    if (!req.file) return res.status(400).json({ error: "Aucun fichier audio reçu." });
    /* Le journal ne contient que la taille du fichier, jamais l'audio ni le texte reconnu. */
    console.log("Audio reçu :", req.file.size, "octets");

    const modele = /^[A-Za-z0-9_-]+$/.test(req.query.modele || "") ? req.query.modele : IBM_MODELE;
    const r = await fetch(IBM_URL + "/v1/recognize?model=" + encodeURIComponent(modele), {
      method: "POST",
      headers: {
        Authorization: ibmAuth(),
        "Content-Type": "audio/wav",
        "X-Watson-Learning-Opt-Out": "true"      // IBM ne garde pas l'audio pour améliorer ses services
      },
      body: req.file.buffer
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("ERREUR IBM :", r.status, data.error || "");
      return res.status(500).json({ message: data.error || ("HTTP " + r.status), code: r.status });
    }
    const text = (data.results || []).map(x => x.alternatives?.[0]?.transcript || "").join(" ").trim();
    const confiance = data.results?.[0]?.alternatives?.[0]?.confidence ?? null;

    /* Même réponse que le serveur Google (+ le modèle et la confiance, utiles pour comparer) */
    res.json({ text, normalized: normalizeArabic(text), modele, confiance });

  } catch (error) {
    console.error("ERREUR IBM :", error.message);
    res.status(500).json({ message: error.message });
  } finally {
    if (req.file) req.file.buffer = null;      // l'audio est libéré dans tous les cas
  }
});

/* fichier trop gros ou autre erreur d'envoi */
app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Serveur IBM prêt sur le port", PORT));
