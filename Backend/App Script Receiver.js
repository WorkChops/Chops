/* =================================================================================== */
/* ============ BACKEND TEMPLATE (POUR ÉTUDIANTS) ============ */
/* =================================================================================== */
// Ce script sert de modèle pour une application de collecte de feedback vocal.
// Il gère :
// 1. La création de dossiers Google Drive pour chaque utilisateur.
// 2. La réception de fichiers audio (Base64) et leur sauvegarde.
// 3. La sauvegarde de métadonnées (JSON) avec l'audio.
// 4. (Optionnel) La sauvegarde d'emails dans un Google Sheet.

/* =================================================================================== */
/* ===================== CONFIGURATION REQUISE (À FAIRE PAR L'ÉTUDIANT) ================= */
/* =================================================================================== */

// 1. ID de votre dossier Google Drive principal.
//    - Créez un dossier sur votre Google Drive.
//    - Ouvrez-le. L'URL ressemblera à : drive.google.com/drive/folders/xxxxxxxxxxxx
//    - Copiez le 'xxxxxxxxxxxx' et collez-le ci-dessous.
const PARENT_FOLDER_ID = 'REMPLACEZ_PAR_VOTRE_ID_DE_DOSSIER_DRIVE';

// 2. ID de votre Google Sheet pour la mailing list (Optionnel).
//    - Créez un nouveau Google Sheet.
//    - L'URL ressemblera à : docs.google.com/spreadsheets/d/yyyyyyyyyyyy/edit
//    - Copiez le 'yyyyyyyyyyyy' et collez-le ci-dessous.
const MAILING_LIST_SHEET_ID = 'REMPLACEZ_PAR_VOTRE_ID_DE_GOOGLE_SHEET'; 

// 3. Limite de taille pour les fichiers (ici, 10MB).
const MAX_BASE_64_BYTES = 10 * 1024 * 1024; // 10MB

/* =================================================================================== */
/* ============ POINT D'ENTRÉE PRINCIPAL (DOPOST) ============= */
/* =================================================================================== */
// Cette fonction est le "cerveau" de l'application. Elle reçoit toutes les
// requêtes du frontend et les dirige vers la bonne fonction de gestion.
function doPost(e) {
  console.log("Receiver: doPost exécuté.");
  let userFolder;

  try {
    // Vérifie si la requête n'est pas vide
    if (!e || !e.postData || !e.postData.contents) {
      console.error("Receiver: Requête vide.");
      return jsonError_('Requête vide.');
    }
    // Analyse les données JSON envoyées par le frontend
    const payload = JSON.parse(e.postData.contents);
    console.log(`Receiver: Payload reçu, action: ${payload.action}`);

    if (!payload || !payload.action) {
      console.error("Receiver: Action manquante.");
      return jsonError_('Action manquante.');
    }

    // --- Routeur d'actions ---
    // En fonction de 'l'action' demandée, on appelle une fonction différente.
    switch (payload.action) {
      // Cas 1: Le formulaire de profil est validé
      case "ensureUserFolder":
        console.log("Receiver: Routage vers handleEnsureUserFolder_...");
        return handleEnsureUserFolder_(payload);

      // Cas 2: Un fichier audio est envoyé
      case "uploadAudio":
        console.log("Receiver: Routage vers handleUpload_FAST_...");
        return handleUpload_FAST_(payload, e);
      
      // Cas 3: Un email est soumis (depuis la modale de fin)
      case "saveEmail":
        console.log("Receiver: Routage vers handleSaveEmail_...");
        return handleSaveEmail_(payload);

      default:
        console.warn(`Receiver: Action inconnue reçue: ${payload.action}`);
        return jsonError_('Action inconnue.');
    }

  } catch (err) {
    console.error(`Receiver: Erreur globale doPost: ${err.message}`, err.stack);
    logError_('Erreur globale Receiver(A)', err); 
    return jsonError_(String(err.message));
  }
}

// La fonction doGet est utile pour vérifier que le script est déployé.
// Vous pouvez visiter l'URL de l'application web dans votre navigateur.
function doGet(e) {
  console.log("Receiver: doGet exécuté.");
  return ContentService.createTextOutput("Script de réception actif. Prêt à recevoir des requêtes POST.").setMimeType(ContentService.MimeType.TEXT);
}

/* =================================================================================== */
/* ========================== GESTIONNAIRES D'ACTIONS ===================== */
/* =================================================================================== */

/**
 * Gère la sauvegarde de l'email dans le Google Sheet.
 */
function handleSaveEmail_(payload) {
  console.log("Receiver: handleSaveEmail_ démarré.");
  try {
    // Validation
    if (!payload.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
      return jsonError_('Email invalide.');
    }
    if (!payload.studentCode) {
      return jsonError_('Identifiant manquant.');
    }
    // Vérification que l'ID a bien été remplacé
    if (MAILING_LIST_SHEET_ID === 'REMPLACEZ_PAR_VOTRE_ID_DE_GOOGLE_SHEET') {
      console.error("Receiver saveEmail: MAILING_LIST_SHEET_ID non configuré.");
      return jsonError_("Service de mailing non configuré.");
    }

    // Opération Google Sheet
    const sheet = SpreadsheetApp.openById(MAILING_LIST_SHEET_ID).getSheetByName('Feuille 1') || SpreadsheetApp.openById(MAILING_LIST_SHEET_ID).getSheets()[0];
    const headers = sheet.getRange(1, 1, 1, sheet.getMaxColumns()).getValues()[0];
    
    // Initialise les en-têtes si la feuille est vide
    if (headers[0] === "") {
      sheet.getRange(1, 1, 1, 3).setValues([['Timestamp', 'Email', 'StudentCode']]);
    }

    // Ajoute la nouvelle ligne
    sheet.appendRow([
      new Date(),
      payload.email,
      payload.studentCode
    ]);
    
    console.log(`Receiver saveEmail: Email ${payload.email} sauvegardé.`);
    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    console.error(`Receiver saveEmail: Erreur critique: ${err.message}`, err.stack);
    logError_('Erreur critique saveEmail', err); 
    return jsonError_("Erreur lors de l'enregistrement de l'email.");
  }
}


/**
 * Gère la création/vérification anticipée des dossiers utilisateur.
 */
function handleEnsureUserFolder_(payload) {
  console.log("Receiver: handleEnsureUserFolder_ démarré.");
  try {
    // Validation des données nécessaires
    if (!payload.studentCode || !payload.cohort || !payload.profile || !payload.used) {
      console.error("Receiver ensureFolder: Métadonnées manquantes.");
      return jsonError_('Métadonnées manquantes pour création dossier.');
    }
    
    // Vérification que l'ID a bien été remplacé
    if (PARENT_FOLDER_ID === 'REMPLACEZ_PAR_VOTRE_ID_DE_DOSSIER_DRIVE') {
      console.error("Receiver ensureFolder: PARENT_FOLDER_ID non configuré.");
      return jsonError_("Service de stockage non configuré.");
    }

    // Sanétisation (nettoyage des entrées utilisateur)
    const studentCode = sanitize_(payload.studentCode, 32);
    const cohort = sanitize_(payload.cohort, 32);
    const profile = sanitize_(payload.profile, 32);
    const used = sanitize_(payload.used, 32);

    // Création/vérification de la structure de dossiers (ex: /Audios/Usage/Profil/ID_Cohorte)
    const rootFolder = DriveApp.getFolderById(PARENT_FOLDER_ID);
    const usageFolder = getOrCreateFolder_(rootFolder, used);
    const profileFolder = getOrCreateFolder_(usageFolder, profile);
    const userFolderId = `${studentCode}_${cohort}`;
    const userFolder = getOrCreateFolder_(profileFolder, userFolderId); // Crée ou récupère
    const userFolderDriveId = userFolder.getId(); // On récupère l'ID
    
    console.log(`Receiver ensureFolder: Dossier utilisateur OK: ${userFolder.getName()} (ID: ${userFolderDriveId})`);

    // Répondre succès AVEC l'ID du dossier (très important pour l'optimisation)
    return ContentService.createTextOutput(JSON.stringify({ ok: true, userFolderDriveId: userFolderDriveId }))
      .setMimeType(ContentService.MimeType.JSON); 

  } catch (err) {
    console.error(`Receiver ensureFolder: Erreur critique: ${err.message}`, err.stack);
    logError_('Erreur critique ensureFolder', err); 
    return jsonError_(String(err.message));
  }
}


/**
 * Gère l'envoi de l'audio (version optimisée).
 */
function handleUpload_FAST_(payload, e) {
  console.log("Receiver: handleUpload_FAST_ démarré.");
  let userFolder;

  try {
    // --- Validations ---
    if (payload.consent !== true) return jsonError_('Consentement requis.');
    if (!payload.fileBase64) return jsonError_('Audio manquant.');
    // L'ID de dossier (obtenu lors de 'ensureUserFolder') est crucial
    if (!payload.userFolderDriveId) return jsonError_('ID Dossier manquant. Veuillez rafraîchir le profil.');
    if (!payload.studentCode || !payload.cohort || !payload.profile || !payload.used || !payload.topic) return jsonError_('Métadonnées manquantes.');
    
    // Décode l'audio et vérifie sa taille
    const audioBytes = Utilities.base64Decode(payload.fileBase64);
    if (audioBytes.length > MAX_BASE_64_BYTES) return jsonError_('Fichier > 10 Mo.');
    console.log("Receiver upload: Validations & Décodage OK.");

    // --- Sanétisation & Préparation des noms de fichiers ---
    const studentCode = sanitize_(payload.studentCode, 32);
    const cohort = sanitize_(payload.cohort, 32);
    const profile = sanitize_(payload.profile, 32);
    const used = sanitize_(payload.used, 32);
    const topic = sanitize_(payload.topic, 32);
    const durationSec = Number(payload.durationSec || 0);
    const ua = String(payload.clientUA || ''); // User Agent
    const ip = getIp_(e); // IP (si possible)
    const rawMimeType = (typeof payload.mimeType === 'string' && payload.mimeType.length > 0) ? String(payload.mimeType).slice(0, 64) : 'audio/webm';
    const cleanMimeType = rawMimeType.split(';')[0];
    const fileExtension = cleanMimeType.includes('mp4') ? 'mp4' : 'webm';
    const now = new Date();
    const stamp = Utilities.formatDate(now, Session.getScriptTimeZone() || 'Etc/UTC', 'yyyyMMdd_HHmmss');
    const baseFileName = `${topic}_${stamp}`;
    const audioFileName = `${baseFileName}_audio.${fileExtension}`;
    const metaFileName = `${baseFileName}_meta.json`;

    // --- Opérations Drive (OPTIMISÉ) ---
    // Au lieu de chercher 3 dossiers, on utilise l'ID directement.
     console.log("Receiver upload: Opérations Drive...");
    try {
      userFolder = DriveApp.getFolderById(payload.userFolderDriveId);
    } catch (driveErr) {
      console.error(`Receiver upload: Dossier ID invalide ou non trouvé: ${payload.userFolderDriveId}`, driveErr.message);
      return jsonError_("Erreur accès dossier. Veuillez rafraîchir le profil.");
    }
     console.log(`Receiver upload: Dossier utilisateur trouvé par ID: ${userFolder.getName()}`);

    // --- Sauvegardes ---
    // 1. Sauvegarder le fichier audio
    const audioFile = saveBlob_(userFolder, audioBytes, audioFileName, cleanMimeType);
    console.log("Receiver upload: Audio sauvegardé.");
    
    // 2. Préparer le fichier de métadonnées
    const meta = { 
      receivedAt: now.toISOString(), studentCode, cohort, profile, used, topic, durationSec,
      mimeType: rawMimeType, ip, userAgent: ua, audioFileName: audioFile.getName(),
      baseFileName: baseFileName, userFolderId: userFolder.getId()
    };
    // 3. Sauvegarder le fichier de métadonnées (JSON)
    const metaFile = userFolder.createFile(metaFileName, JSON.stringify(meta, null, 2), "application/json"); 
    console.log("Receiver upload: Métadonnées sauvegardées.");

    // --- Réponse Rapide ---
    // On répond "OK" au client immédiatement, sans attendre quoi que ce soit d'autre.
    console.log("Receiver upload: Envoi réponse OK au client.");
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON); 

  } catch (err) {
    console.error(`Receiver: Erreur critique uploadFast: ${err.message}`, err.stack);
    logError_('Erreur critique uploadFast', err, userFolder ? userFolder : null);
    console.log(`Receiver: Envoi erreur au client: ${err.message}`);
    return jsonError_(String(err.message));
  }
}

/* =================================================================================== */
/* ============================= FONCTIONS UTILITAIRES ================= */
/* =================================================================================== */

/** Renvoie une erreur JSON standardisée. */
function jsonError_(errorMsg) { 
  console.log(`Receiver: jsonError_: ${errorMsg}`); 
  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: errorMsg }))
    .setMimeType(ContentService.MimeType.JSON); 
}

/** Nettoie une chaîne de caractères pour la rendre sûre comme nom de dossier/fichier. */
function sanitize_(s, maxLength = 32) { 
  if (!s) return 'NA'; 
  const sanitized = String(s).replace(/[^A-Za-z0-9\u00C0-\u017F\_\-\+]/g, '_').replace(/__+/g, '_').replace(/^\_+|\_+$/g, '').slice(0, maxLength); 
  return sanitized || 'NA'; 
}

/** Sauvegarde un blob de bytes dans un dossier. */
function saveBlob_(folder, bytes, name, mime) { 
  console.log(`Receiver: saveBlob_ mime: '${mime}'`); 
  if (!mime || typeof mime !== 'string' || mime.length < 3 || mime === 'null' || mime === 'undefined' || mime.includes(';')) { 
    mime = 'audio/webm'; // MimeType de secours
  } 
  try { 
    const blob = Utilities.newBlob(bytes, mime, name); 
    return folder.createFile(blob); 
  } catch (blobError) { 
    console.error(`Receiver: Err newBlob mime='${mime}': ${blobError.message}`, blobError.stack); 
    throw blobError; 
  } 
}

/** Tente de récupérer l'adresse IP de l'utilisateur. */
function getIp_(e) { 
  try { 
    return String(e?.parameter?.ip || e?.headers?.['X-Forwarded-For'] || ''); 
  } catch (err) { 
    return 'IP_Inconnue'; 
  } 
}

/** Log une erreur (simplifié pour le template). */
function logError_(context, err, userFolder) { 
  const errorMsg = `[${new Date().toISOString()}] ERREUR (${context}): ${err.message || String(err)}${err.stack ? '\nStack: ' + err.stack : ''}`; 
  console.error(errorMsg); 
}

/** Récupère un dossier par son nom s'il existe, sinon le crée. */
function getOrCreateFolder_(parentFolder, folderName) { 
  if (!folderName || typeof folderName !== 'string' || folderName.trim().length === 0) { 
    console.warn(`Receiver: Tentative création dossier nom invalide: '${folderName}', utilisation de 'Dossier_Invalide'.`); 
    folderName = 'Dossier_Invalide'; 
  } 
  const folders = parentFolder.getFoldersByName(folderName); 
  if (folders.hasNext()) { 
    return folders.next(); 
  } else { 
    console.log(`Receiver: Création dossier: ${folderName} dans ${parentFolder.getName()}`); 
    return parentFolder.createFolder(folderName); 
  } 
}

/* =================================================================================== */
/* ================= INSTRUCTIONS DE DÉPLOIEMENT (POUR LES ÉTUDIANTS) ================ */
/* =================================================================================== */

// 1. Enregistrez ce fichier.
// 2. Cliquez sur "Déployer" (en haut à droite).
// 3. Choisissez "Nouveau déploiement".
// 4. À côté de "Sélectionner le type", cliquez sur l'icône Engrenage et choisissez "Application Web".
// 5. Dans la description, mettez "v1".
// 6. Pour "Qui y a accès", sélectionnez "Tout le monde". (IMPORTANT)
// 7. Cliquez sur "Déployer".
// 8. Autorisez les permissions demandées (pour Google Drive et Google Sheets).
// 9. Copiez l'URL de "Application Web" (elle se termine par /exec).
// 10. Collez cette URL dans la variable 'WEBAPP_URL' de votre fichier HTML (dans <script id="app-config">).
//
// **POUR METTRE À JOUR LE CODE :**
// - Cliquez sur "Déployer" -> "Gérer les déploiements".
// - Choisissez votre déploiement, cliquez sur l'icône Crayon (Modifier).
// - Dans "Version", choisissez "Nouvelle version".
// - Cliquez sur "Déployer". (Inutile de recopier l'URL, elle ne change pas).
