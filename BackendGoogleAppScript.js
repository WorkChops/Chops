/* ===============================================================
 * Backend pour Mini-Voiceform CHOPS v2 (Frontend sécurisé)
 * Déploiement en Web App : 
 * Exécuter en tant que : Moi
 * Accès : Toute personne
 * =============================================================== */

// --- (À MODIFIER) VOS CONSTANTES ---
const GEMINI_API_KEY = 'À_RENSEIGNER_VOTRE_CLÉ_API_GEMINI';
const NOTIFY_EMAIL   = 'À_RENSEIGNER_VOTRE_EMAIL_DE_NOTIFICATION';
const PARENT_FOLDER_ID = 'À_RENSEIGNER_ID_DU_DOSSIER_DRIVE_PARENT';
const TRANSCRIPTS_FOLDER_ID = 'À_RENSEIGNER_ID_DU_DOSSIER_TRANSCRIPTIONS'; // <-- NOUVELLE CONSTANTE
// ------------------------------------

// --- Constantes du système ---
/* * CHOIX DU MODÈLE GEMINI (Note importante) :
 * * 1. `gemini-2.5-flash-preview-09-2025` (RECOMMANDÉ) : 
 * C'est la version "preview" la plus récente de la famille Flash. Elle est 
 * nativement multimodale et gère parfaitement la transcription de fichiers audio.
 * (Confirmé par les recherches Google, ex: doc 4.1, 2.1).
 *
 * 2. `gemini-2.5-flash` (Option Stable) : 
 * C'est l'alias "stable" du modèle Flash. Il gère aussi l'audio (doc 1.4). 
 * Si jamais le modèle "preview" ci-dessus échoue, utilisez celui-ci.
 *
 * 3. `gemini-2.5-flash-native-audio-dialog` (À ÉVITER) : 
 * Ce modèle est pour la "Live API" (streaming en temps réel, doc 1.5, 4.5).
 * Notre backend envoie un fichier complet (UrlFetchApp), ce n'est donc PAS compatible.
 */
const GEMINI_MODEL = 'models/gemini-2.5-flash-preview-09-2025';
const MAX_BASE64_BYTES = 10 * 1024 * 1024; // 10MB (correspond au frontend)

/**
 * Point d'entrée principal - agit comme un routeur
 */
function doPost(e) {
  let data;
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonError_('Requête vide.');
    }
    data = JSON.parse(e.postData.contents);
    
    if (!data || !data.action) {
      return jsonError_('Action manquante.');
    }

    // Routeur basé sur l'action demandée par le client
    switch (data.action) {
      case 'transcribe':
        return handleTranscribe(data);
      case 'uploadAudio':
        return handleUpload(data, e); // <-- MODIFIÉ : On passe "e" pour l'IP
      case 'exportProgress':
        return handleExport(data); // Gère l'export caché (Ctrl+Shift+E)
      default:
        return jsonError_('Action inconnue.');
    }

  } catch (err) {
    console.error(`Erreur doPost: ${err.message}`, err.stack);
    // Tenter de logger dans le Drive si possible
    try {
      logError_(data ? data.studentCode : 'UNKNOWN', `GLOBAL_ERROR: ${err.message}`);
    } catch (logErr) {}
    return jsonError_(String(err.message || err));
  }
}

/**
 * Gère l'action "transcribe" : reçoit un audio, renvoie une transcription.
 */
function handleTranscribe(data) {
  try {
    if (!data.fileBase64 || !data.mimeType) {
      return jsonError_('Données de transcription manquantes.');
    }
    
    const audioBytes = Utilities.base64DecodeWebSafe(data.fileBase64);
    if (audioBytes.length > MAX_BASE64_BYTES) {
      return jsonError_('Fichier > 10 Mo.');
    }

    const transcriptText = transcribeWithGemini_(audioBytes, data.mimeType);
    
    return jsonOK_({ transcription: transcriptText });

  } catch (err) {
    console.error(`Erreur handleTranscribe: ${err.message}`, err.stack);
    return jsonError_(String(err.message || err));
  }
}

/**
 * Gère l'action "uploadAudio" : reçoit tout, sauvegarde tout.
 */
function handleUpload(data, e) { // <-- MODIFIÉ : On reçoit "e"
  // Validation des données principales
  if (data.consent !== true) return jsonError_('Consentement requis.');
  if (!data.fileBase64) return jsonError_('Audio manquant.');
  if (Utilities.base64DecodeWebSafe(data.fileBase64).length > MAX_BASE64_BYTES) {
    return jsonError_('Fichier > 10 Mo.');
  }
  
  // Assainissement des données
  const studentCode = sanitize_(data.studentCode);
  const cohort = sanitize_(data.cohort);
  const profile = sanitize_(data.profile, 64); // Nouveau champ
  const topic = sanitize_(data.topic);
  const used = sanitize_(data.used, 64);
  const durationSec = Number(data.durationSec || 0);
  const mimeType = typeof data.mimeType === 'string' && data.mimeType.length < 64 ? data.mimeType : 'audio/webm';
  const ua = String(data.clientUA || '').slice(0, 512);
  const transcription = String(data.transcription || '[TRANSCRIPTION_NON_FOURNIE]'); // On sauvegarde celle du client

  // Organisation des dossiers (Structure: Parent/Usage/Profile/User_Context)
  const parent = DriveApp.getFolderById(PARENT_FOLDER_ID);
  const usageFolder = getOrCreateFolder_(parent, used);
  const profileFolder = getOrCreateFolder_(usageFolder, profile);
  const userFolderName = `${studentCode}_${cohort}`; // Fusion de l'ID et du Contexte
  const userFolder = getOrCreateFolder_(profileFolder, userFolderName); // Dossier unique pour cet étudiant

  // Horodatage pour les noms de fichiers
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Etc/UTC', 'yyyyMMdd_HHmmss');
  const baseFileName = `${topic}_${stamp}`; // Base pour les 3 fichiers

  // Sauvegarde des fichiers
  const audioBytes = Utilities.base64DecodeWebSafe(data.fileBase64);
  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const audioFile = saveBlob_(userFolder, audioBytes, `${baseFileName}_audio.${ext}`, mimeType);

  // Sauvegarde des métadonnées (incluant le nouveau champ "profile")
  const meta = {
    consent: true,
    studentCode, cohort, profile, used, topic,
    durationSec, mimeType,
    receivedAt: new Date().toISOString(),
    ip: getIp_(e), // <-- CORRIGÉ : "e" est maintenant disponible
    userAgent: ua
  };
  const metaFile = userFolder.createFile(`${baseFileName}_meta.json`, JSON.stringify(meta, null, 2), MimeType.JSON);
  
  // Sauvegarde de la transcription (celle fournie par le client)
  const transcriptFile = userFolder.createFile(`${baseFileName}_transcript.txt`, transcription, MimeType.PLAIN_TEXT);

  // Notification par e-mail
  try {
    const subject = `CHOPS – Nouvelle réponse vocale (${cohort}/${studentCode})`;
    const body = [
      `Date: ${new Date().toLocaleString()}`,
      `Profil: ${profile}`,
      `Cohorte: ${cohort}`,
      `Code: ${studentCode}`,
      `Thème: ${topic}`,
      `Usage: ${used}`,
      `Durée: ~${durationSec}s`,
      `Transcription: ${transcription.length > 20 ? 'oui' : 'non'}`,
      `Dossier: https://drive.google.com/drive/folders/${userFolder.getId()}`
    ].join('\n');
    GmailApp.sendEmail(NOTIFY_EMAIL, subject, body, { name: "CHOPS Research Bot" });
  } catch (err) {
    logError_(studentCode, `EMAIL_ERROR: ${String(err)}`, userFolder);
  }
  
  // --- NOUVEAU : Copie de la transcription dans le dossier centralisé ---
  try {
    const transcriptsFolder = DriveApp.getFolderById(TRANSCRIPTS_FOLDER_ID);
    // Nom de fichier descriptif pour le dossier centralisé
    const copyName = `${used}_${profile}_${userFolderName}_${baseFileName}.txt`;
    transcriptFile.makeCopy(copyName, transcriptsFolder);
  } catch (err) {
    console.error(`Erreur copie transcription: ${err.message}`);
    logError_(studentCode, `TRANSCRIPT_COPY_ERROR: ${String(err)}`, userFolder);
  }
  // --- Fin de la nouvelle section ---

  // Renvoi de la réponse de succès au client
  return jsonOK_({
    folderId: userFolder.getId(),
    files: {
      audio: `https://drive.google.com/file/d/${audioFile.getId()}/view`,
      meta: `https://drive.google.com/file/d/${metaFile.getId()}/view`,
      transcript: `https://drive.google.com/file/d/${transcriptFile.getId()}/view`
    }
  });
}

/**
 * Gère l'action "exportProgress" (fonctionnalité cachée)
 */
function handleExport(data) {
  try {
    const studentCode = sanitize_(data.studentCode);
    const parent = DriveApp.getFolderById(PARENT_FOLDER_ID);
    const folderName = `_EXPORT_${studentCode}`;
    
    // Tente de trouver un dossier existant pour cet étudiant
    let folder;
    const folders = parent.getFoldersByName(folderName);
    if (folders.hasNext()) {
      folder = folders.next();
    } else {
      folder = parent.createFolder(folderName);
    }
    
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Etc/UTC', 'yyyyMMdd_HHmmss');
    const statusFile = folder.createFile(`export_${stamp}.json`, JSON.stringify(data.status, null, 2), MimeType.JSON);
    
    return jsonOK_({ fileId: statusFile.getId() });
  } catch(err) {
    console.error(`Erreur handleExport: ${err.message}`, err.stack);
    return jsonError_(String(err.message || err));
  }
}


// ================================================================
// --- FONCTIONS UTILITAIRES ---
// ================================================================

/**
 * Trouve un sous-dossier par nom, ou le crée s'il n'existe pas.
 * @param {DriveApp.Folder} parentFolder Le dossier parent.
 * @param {string} folderName Le nom du dossier à trouver/créer.
 * @return {DriveApp.Folder} Le dossier trouvé ou créé.
 */
function getOrCreateFolder_(parentFolder, folderName) {
  const folders = parentFolder.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next(); // Trouvé, on le retourne
  } else {
    return parentFolder.createFolder(folderName); // Pas trouvé, on le crée
  }
}

/**
 * Crée une réponse JSON de succès.
 */
function jsonOK_(payload = {}) {
  const response = { ok: true, ...payload };
  return ContentService
    .createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Crée une réponse JSON d'erreur.
 */
function jsonError_(errorMessage) {
  const response = { ok: false, error: errorMessage };
  return ContentService
    .createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Nettoie une chaîne de caractères.
 */
function sanitize_(s, length = 32) {
  // Remplace les caractères interdits dans les noms de fichiers/dossiers par '_', 
  // tout en préservant les accents, espaces, et '+'.
  const sanitized = String(s || '').replace(/[\\\/:\*\?"<>\|]/g, '_');
  return sanitized.slice(0, length) || 'NA';
}

/**
 * Sauvegarde un blob dans un dossier.
 */
function saveBlob_(folder, bytes, name, mime) {
  const blob = Utilities.newBlob(bytes, mime, name);
  return folder.createFile(blob);
}

/**
 * Logue une erreur dans un fichier log.txt dans le dossier Drive.
 */
function logError_(studentCode, msg, folder = null) {
  try {
    let logFolder = folder;
    if (!logFolder) {
      // Si aucun dossier n'est fourni, tente de logger dans un dossier "global"
      const parent = DriveApp.getFolderById(PARENT_FOLDER_ID);
      const logFolderName = `_LOGS_${studentCode}`;
      const folders = parent.getFoldersByName(logFolderName);
      logFolder = folders.hasNext() ? folders.next() : parent.createFolder(logFolderName);
    }
    
    const f = logFolder.getFilesByName('log.txt').hasNext()
      ? logFolder.getFilesByName('log.txt').next()
      : logFolder.createFile('log.txt', '', MimeType.PLAIN_TEXT);
      
    f.append(`\n[${new Date().toISOString()}] ${msg}`);
  } catch (e) {
    console.error('LOG_FAIL', e);
  }
}

/**
 * Tente de récupérer l'IP (très peu fiable sur Apps Script).
 */
function getIp_(e) {
  try {
    // 'e' doit être l'objet événement de doPost
    const ip = e?.parameter?.ip || e?.headers?.['X-Forwarded-For'] || '';
    return String(ip);
  } catch { return ''; }
}

/**
 * Transcrit l'audio via Gemini (server-to-server).
 */
function transcribeWithGemini_(audioBytes, mimeType) {
  if (!GEMINI_API_KEY || GEMINI_API_KEY.startsWith('À_RENSEIGNER')) {
    throw new Error('Clé API Gemini (GEMINI_API_KEY) non configurée dans le backend.');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  // Construire manuellement le payload pour forcer "inlineData"
  // UrlFetchApp peut mal convertir le camelCase
  const bodyObj = {
    contents: [{
      role: "user",
      parts: [
        { text: "Transcris cet enregistrement audio en français. Ne traduis pas, transcris simplement la langue parlée. Si l'audio n'est pas clair ou est silencieux, réponds '[Audio non clair ou silencieux]'." },
        { inlineData: { 
            mimeType: mimeType, 
            data: Utilities.base64EncodeWebSafe(audioBytes) 
          } 
        }
      ]
    }],
    generationConfig: { 
      temperature: 0.2 
    }
  };

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(bodyObj),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const txt = res.getContentText();
  
  if (code < 200 || code >= 300) {
    throw new Error(`Erreur Gemini HTTP ${code}: ${txt.slice(0, 300)}`);
  }
  
  const json = JSON.parse(txt);
  const cand = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  
  if (!cand && !json?.candidates?.[0]?.finishReason) {
     throw new Error(`Réponse Gemini vide ou malformée: ${txt.slice(0, 300)}`);
  }
  
  // Gérer les cas où Gemini bloque le contenu (SAFETY, etc.)
  if (!cand && json?.candidates?.[0]?.finishReason) {
    console.warn(`Transcription bloquée, raison: ${json.candidates[0].finishReason}`);
    return `[Transcription bloquée par l'IA - Raison: ${json.candidates[0].finishReason}]`;
  }
  
  return cand;
}
