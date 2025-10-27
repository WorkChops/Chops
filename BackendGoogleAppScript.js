//* =================================================================================== */
/* =================== CONFIGURATION DU BACKEND (APPS SCRIPT) ================== */
/* =================================================================================== */
// Renseignez ces 5 constantes avant de déployer.

/**
 * (REQUIS) Votre clé API secrète de Google AI Studio.
 * NE PARTAGEZ JAMAIS CE FICHIER AVEC CETTE CLÉ REMPLIE.
 */
const GEMINI_API_KEY = 'À_RENSEIGNER_VOTRE_CLÉ_API_GEMINI';

/**
 * (REQUIS) L'e-mail où vous recevrez les notifications de nouvelles réponses.
 */
const NOTIFY_EMAIL = 'À_RENSEIGNER_VOTRE_EMAIL_DE_NOTIFICATION';

/**
 * (REQUIS) L'ID du dossier Google Drive principal où tout sera sauvegardé.
 * Pour l'obtenir : ouvrez le dossier dans Drive, l'URL est .../folders/ID_DU_DOSSIER
 */
const PARENT_FOLDER_ID = 'À_RENSEIGNER_ID_DU_DOSSIER_DRIVE_PARENT';

/**
 * (REQUIS) L'ID du dossier spécial où une *copie* de toutes les transcriptions sera stockée.
 * Créez un dossier séparé pour cela.
 */
const TRANSCRIPTS_FOLDER_ID = 'À_RENSEIGNER_ID_DU_DOSSIER_TRANSCRIPTIONS';

/**
 * Le modèle Gemini à utiliser.
 * 'gemini-2.5-flash-preview-09-2025' est le plus récent (natif audio) et rapide.
 * Si vous rencontrez une erreur, essayez 'gemini-2.5-flash' (stable).
 */
const GEMINI_MODEL = 'gemini-2.5-flash-preview-09-2025';

// Limite de taille (en octets) pour les fichiers base64 (10MB)
const MAX_BASE64_BYTES = 10 * 1024 * 1024;

/* =================================================================================== */
/* ============ POINT D'ENTRÉE PRINCIPAL (GOOGLE APPS SCRIPT) ============= */
/* =================================================================================== */

/**
 * Point d'entrée principal de l'application Web.
 * Gère toutes les requêtes POST du frontend.
 */
function doPost(e) {
  try {
    // CORRECTION CORS (Failed to Fetch) :
    // Le frontend envoie en 'text/plain', nous devons donc parser le corps manuellement.
    if (!e || !e.postData || !e.postData.contents) {
      return jsonError_('Requête vide.');
    }
    
    const payload = JSON.parse(e.postData.contents);

    if (!payload || !payload.action) {
      return jsonError_('Action manquante.');
    }

    // --- Routeur d'actions ---
    switch (payload.action) {
      
      // Cas 1: Le client demande une transcription
      case "transcribe":
        
      
      // Cas 2: Le client envoie la réponse finale
      case "uploadAudio":
        // Passer l'objet 'e' pour pouvoir récupérer l'IP plus tard
        return handleUpload_(payload, e); 
      
      // Cas par défaut
      default:
        return jsonError_('Action inconnue.');
    }

  } catch (err) {
    // Erreur générale (ex: JSON mal formé)
    logError_('Erreur globale doPost', err);
    return jsonError_(String(err.message));
  }
}

/* =================================================================================== */
/* ========================== GESTIONNAIRES D'ACTIONS (HANDLERS) ===================== */
/* =================================================================================== */
/**
 * Gère l'envoi de la réponse finale (audio, transcription, métadonnées).
 * @param {object} payload - Les données complètes de la réponse.
 * @param {object} e - L'objet événement Apps Script (pour l'IP).
 * @returns {ContentService.TextOutput} - JSON de succès ou d'erreur.
 */
function handleUpload_(payload, e) {
  try {
    // --- Validation basique ---
    if (payload.consent !== true) return jsonError_('Consentement requis.');
    if (!payload.fileBase64) return jsonError_('Audio manquant.');
    if (!payload.studentCode || !payload.cohort || !payload.profile || !payload.used || !payload.topic) {
      return jsonError_('Métadonnées manquantes.');
    }
    
    // --- Décodage et validation de taille ---
    const audioBytes = Utilities.base64Decode(payload.fileBase64);
    if (audioBytes.length > MAX_BASE64_BYTES) {
      return jsonError_('Fichier > 10 Mo.');
    }

    // --- Sanétisation des données ---
    const studentCode = sanitize_(payload.studentCode, 32);
    const cohort = sanitize_(payload.cohort, 32);
    const profile = sanitize_(payload.profile, 32);
    const used = sanitize_(payload.used, 32);
    const topic = sanitize_(payload.topic, 32);
    const durationSec = Number(payload.durationSec || 0);
    const mimeType = (typeof payload.mimeType === 'string' && payload.mimeType.length > 0) ? String(payload.mimeType).slice(0, 64) : 'audio/webm';
    const ua = String(payload.clientUA || '');
    const ip = getIp_(e);
    let transcription;
    try {
      // On génère la transcription directement ici, côté backend
      transcription = transcribeWithGemini_(audioBytes, mimeType);
      } catch (geminiErr) {
      transcription = `[ERREUR_TRANSCRIPTION_BACKEND: ${geminiErr.message}]`;
      // On logue l'erreur Gemini, mais on continue le script
      // pour au moins sauvegarder le fichier audio.
      logError_('Erreur transcribeWithGemini_ dans handleUpload_', geminiErr, userFolder); // J'ai ajouté userFolder au log
      }
    
    // --- Horodatage ---
    const now = new Date();
    const stamp = Utilities.formatDate(now, Session.getScriptTimeZone() || 'Etc/UTC', 'yyyyMMdd_HHmmss');

    // --- Création de la structure de dossiers (selon la logique demandée) ---
    // 1. Racine -> 2. Usage -> 3. Profil -> 4. Utilisateur (ID_Contexte)
    const rootFolder = DriveApp.getFolderById(PARENT_FOLDER_ID);
    const usageFolder = getOrCreateFolder_(rootFolder, used);
    const profileFolder = getOrCreateFolder_(usageFolder, profile);
    const userFolderId = `${studentCode}_${cohort}`; // Fusionné
    const userFolder = getOrCreateFolder_(profileFolder, userFolderId);
    
    // --- Création des noms de fichiers uniques ---
    const baseFileName = `${topic}_${stamp}`;
    const audioFileName = `${baseFileName}_audio.${mimeType.includes('mp4') ? 'mp4' : 'webm'}`;
    const transcriptFileName = `${baseFileName}_transcript.txt`;
    const metaFileName = `${baseFileName}_meta.json`;

    // --- Enregistrement des fichiers ---
    // 1. Audio
    const audioFile = saveBlob_(userFolder, audioBytes, audioFileName, mimeType);
    
    // 2. Transcription (dans le dossier utilisateur)
    const transcriptFile = userFolder.createFile(transcriptFileName, transcription, MimeType.PLAIN_TEXT);

    // 3. Copie de la transcription (dans le dossier spécial)
    try {
      const transcriptsRoot = DriveApp.getFolderById(TRANSCRIPTS_FOLDER_ID);
      const transcriptCopyName = `${used}_${profile}_${userFolderId}_${baseFileName}.txt`;
      transcriptsRoot.createFile(transcriptCopyName, transcription, MimeType.PLAIN_TEXT);
    } catch (err) {
      logError_('Erreur copie transcription', err, userFolder); // Log dans le dossier utilisateur
    }

    // 4. Métadonnées
    const meta = {
      receivedAt: now.toISOString(),
      studentCode, cohort, profile, used, topic, durationSec, mimeType,
      ip, userAgent: ua,
      files: {
        audio: audioFile.getUrl(),
        transcript: transcriptFile.getUrl()
      }
    };
    const metaFile = userFolder.createFile(metaFileName, JSON.stringify(meta, null, 2), MimeType.JSON);

    // --- Notification par e-mail ---
    try {
      const subject = `CHOPS – Nouvelle réponse : ${profile} / ${studentCode} (${topic})`;
      const body = [
        `Une nouvelle réponse vocale a été reçue.`,
        `--------------------`,
        `Date: ${now.toLocaleString()}`,
        `Profil: ${profile}`,
        `Usage: ${used}`,
        `Utilisateur: ${studentCode} (Contexte: ${cohort})`,
        `Sujet: ${topic}`,
        `Durée: ~${durationSec}s`,
        `--------------------`,
        `Transcription:`,
        `${transcription.slice(0, 500)}${transcription.length > 500 ? '...' : ''}`,
        `--------------------`,
        `Lien vers le dossier utilisateur:`,
        userFolder.getUrl()
      ].join('\n');
      GmailApp.sendEmail(NOTIFY_EMAIL, subject, body, { name: "CHOPS Voice Bot" });
    } catch (err) {
      logError_('Erreur envoi Email', err, userFolder);
    }

    // --- Réponse de succès au client ---
    return ContentService
      .createTextOutput(JSON.stringify({
        ok: true,
        folderUrl: userFolder.getUrl(),
        audioUrl: audioFile.getUrl()
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    logError_('Erreur handleUpload_', err);
    return jsonError_(String(err.message));
  }
}


/* =================================================================================== */
/* =============================== FONCTION API GEMINI =============================== */
/* =================================================================================== */

/**
 * Transcrit l'audio via Gemini (server-to-server).
 * @param {byte[]} audioBytes - Les octets du fichier audio.
 * @param {string} mimeType - Le MimeType (ex: 'audio/webm').
 * @returns {string} - Le texte transcrit.
 */
function transcribeWithGemini_(audioBytes, mimeType) {
  if (!GEMINI_API_KEY || GEMINI_API_KEY.startsWith('À_RENSEIGNER')) {
    throw new Error('Clé API Gemini non configurée dans le backend.');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  
  // Construction manuelle de l'objet pour forcer 'inlineData' (Apps Script
  // convertit parfois 'inlineData' en 'inline_data', ce que l'API n'aime pas).
  const bodyObj = {
    contents: [{
      role: "user",
      parts: [
        { text: "Transcris l’audio ci-dessous en FRANÇAIS. Le texte doit être brut, sans formatage, sans résumer, et sans ajouter de commentaires comme 'Transcription:'." },
        { inlineData: { 
            mimeType: mimeType, 
            data: Utilities.base64Encode(audioBytes)
          } 
        }
      ]
    }],
    generationConfig: {
      temperature: 0.1 // Faible température pour une transcription factuelle
    }
  };

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(bodyObj),
    muteHttpExceptions: true // Important pour capturer les erreurs HTTP
  });

  const code = res.getResponseCode();
  const txt = res.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error(`Erreur Gemini HTTP ${code}: ${txt.slice(0, 300)}`);
  }

  const json = JSON.parse(txt);
  
  // Gérer les cas où Gemini bloque la réponse (safety ratings)
  if (!json.candidates || json.candidates.length === 0) {
    if (json.promptFeedback && json.promptFeedback.blockReason) {
      throw new Error(`Transcription bloquée par Gemini (Raison: ${json.promptFeedback.blockReason})`);
    }
    throw new Error('Réponse vide de Gemini (pas de candidats).');
  }
  
  const transcription = json.candidates[0]?.content?.parts?.[0]?.text || '';
  
  if (!transcription) {
    throw new Error('Réponse de Gemini reçue, mais transcription vide.');
  }
  
  return transcription;
}


/* =================================================================================== */
/* ============================= FONCTIONS UTILITAIRES ============================= */
/* =================================================================================== */

/**
 * Crée une réponse JSON d'erreur standardisée.
 * @param {string} errorMsg - Le message d'erreur.
 * @returns {ContentService.TextOutput}
 */
function jsonError_(errorMsg) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: false, error: errorMsg }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Sanétise une chaîne pour l'utiliser dans les noms de dossiers/fichiers.
 * Autorise les lettres, chiffres, accents, +, _, -.
 * @param {string} s - La chaîne à nettoyer.
 * @param {number} [maxLength=32] - La longueur maximale.
 * @returns {string}
 */
function sanitize_(s, maxLength = 32) {
  if (!s) return 'NA';
  // Remplace tout ce qui n'est PAS une lettre (y compris accentuée), un chiffre, _, -, +
  // par un '_'. S'assure qu'il n'y a pas de '..' et limite la longueur.
  const sanitized = String(s)
    .replace(/[^A-Za-z0-9\u00C0-\u017F\_\-\+]/g, '_') 
    .replace(/__+/g, '_') // Remplace les multiples __
    .replace(/^\_+|\_+$/g, '') // Enlève _ au début ou à la fin
    .slice(0, maxLength);
  return sanitized || 'NA';
}

/**
 * Crée un fichier blob dans un dossier.
 * @param {DriveApp.Folder} folder - Le dossier de destination.
 * @param {byte[]} bytes - Les octets du fichier.
 * @param {string} name - Le nom du fichier.
 * @param {string} mime - Le MimeType.
 * @returns {DriveApp.File}
 */
function saveBlob_(folder, bytes, name, mime) {
  const blob = Utilities.newBlob(bytes, mime, name);
  return folder.createFile(blob);
}

/**
 * Tente de récupérer l'adresse IP de l'utilisateur.
 * @param {object} e - L'objet événement Apps Script.
 * @returns {string}
 */
function getIp_(e) {
  try {
    // L'IP n'est pas garantie, mais parfois disponible via X-Forwarded-For
    const ip = e?.parameter?.ip || e?.headers?.['X-Forwarded-For'] || '';
    return String(ip);
  } catch (err) {
    return 'IP_Inconnue';
  }
}

/**
 * Tente d'écrire un message d'erreur dans un fichier log.txt dans le dossier utilisateur.
 * Si le dossier n'est pas fourni, logue seulement dans la console Apps Script.
 * @param {string} context - D'où vient l'erreur (ex: 'handleUpload_').
 * @param {Error} err - L'objet erreur.
 * @param {DriveApp.Folder} [userFolder] - Le dossier utilisateur pour y écrire le log.
 */
function logError_(context, err, userFolder) {
  const errorMsg = `[${new Date().toISOString()}] ERREUR (${context}): ${err.message || err}${err.stack ? '\nStack: ' + err.stack : ''}`;
  
  // Logue toujours dans la console Google Apps Script
  console.error(errorMsg);
  
  // Tente de loguer dans le fichier log.txt du dossier utilisateur si fourni
  if (userFolder) {
    try {
      let logFile;
      const files = userFolder.getFilesByName('log_erreurs.txt');
      if (files.hasNext()) {
        logFile = files.next();
      } else {
        logFile = userFolder.createFile('log_erreurs.txt', '', MimeType.PLAIN_TEXT);
      }
      logFile.append(errorMsg + '\n\n');
    } catch (e) {
      console.error(`Échec de l'écriture dans log_erreurs.txt: ${e}`);
    }
  }
}

/**
 * Récupère un dossier par son nom dans un dossier parent, ou le crée s'il n'existe pas.
 * @param {DriveApp.Folder} parentFolder - Le dossier où chercher.
 * @param {string} folderName - Le nom du dossier à trouver/créer.
 * @returns {DriveApp.Folder}
 */
function getOrCreateFolder_(parentFolder, folderName) {
  const folders = parentFolder.getFoldersByName(folderName);
  if (folders.hasNext()) {
    // Le dossier existe, on le retourne
    return folders.next();
  } else {
    // Le dossier n'existe pas, on le crée
    return parentFolder.createFolder(folderName);
  }
}
