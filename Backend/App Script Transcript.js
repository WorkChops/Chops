/* =================================================================================== */
/* ============== SCRIPT B : LE TRAVAILLEUR (LENT, ASYNCHRONE) ============== */
/* =================================================================================== */
// OBJECTIF : Scanner le Drive, trouver les audios non traités, les transcrire,
//            sauver le transcript, copier le transcript, envoyer l'email de notification.
// PAS DE doPost ou doGet ici. S'exécute via un Trigger.
//
// CORRECTIONS INCLUSES :
// - Lecture sécurisée des clés (Propriétés du Script)
// - Correction MimeType.JSON -> "application/json"
// - Correction MimeType.PLAIN_TEXT -> "text/plain"
// - Correction Anti-503 (pause de 20s)
// - Correction Logique 503 (permet de réessayer)
// - Correction bug logError_ (.append -> .appendContents)
/* =================================================================================== */

/* =================================================================================== */
/* =================== RÉCUPÉRATION SÉCURISÉE DES SECRETS =================== */
/* =================================================================================== */
// Les clés et ID ne sont plus écrits ici, mais lus depuis les "Propriétés du Script"
// (Paramètres du projet ⚙️ > Propriétés du script)

const scriptProperties = PropertiesService.getScriptProperties();

/**
 * (REQUIS) Votre clé API secrète de Google AI Studio.
 */
const GEMINI_API_KEY = scriptProperties.getProperty('GEMINI_API_KEY');

/**
 * (REQUIS) L'e-mail où vous recevrez les notifications de nouvelles réponses.
 */
const NOTIFY_EMAIL = scriptProperties.getProperty('NOTIFY_EMAIL');

/**
 * (REQUIS) L'ID du dossier Google Drive principal où tout sera sauvegardé.
 */
const PARENT_FOLDER_ID = scriptProperties.getProperty('PARENT_FOLDER_ID');

/**
 * (REQUIS) L'ID du dossier spécial où une *copie* de toutes les transcriptions sera stockée.
 */
const TRANSCRIPTS_FOLDER_ID = scriptProperties.getProperty('TRANSCRIPTS_FOLDER_ID');

/**
 * Le modèle Gemini à utiliser.
 */
const GEMINI_MODEL = 'gemini-2.5-flash-preview-09-2025';

/* =================================================================================== */
/* ============ FONCTION PRINCIPALE DU BATCH & DÉCLENCHEURS ============ */
/* =================================================================================== */

/**
 * Tâche planifiée (Trigger) qui cherche les audios non transcrits.
 */
function runTranscriptionBatch_() {
  // Vérification de sécurité
  if (!GEMINI_API_KEY || !NOTIFY_EMAIL || !PARENT_FOLDER_ID || !TRANSCRIPTS_FOLDER_ID) {
    console.error("ERREUR CRITIQUE: Une ou plusieurs propriétés de script (clés API, IDs) ne sont pas définies.");
    console.error("Veuillez configurer les 'Propriétés du script' dans les Paramètres du projet (⚙️).");
    return; // Arrêter l'exécution
  }

  console.log("Script B (Worker): runTranscriptionBatch_ démarré.");
  const rootFolder = DriveApp.getFolderById(PARENT_FOLDER_ID);
  
  // Utilisation d'un objet pour que le comptage par référence fonctionne.
  let processedCount = { value: 0 }; 
  
  const startTime = Date.now();
  const maxRuntime = 5 * 60 * 1000; // 5 minutes (Google Apps Script a une limite de 6 min)

  try {
    // Parcourir récursivement pour trouver les fichiers meta.json non traités
    findAndProcessMetaFiles_(rootFolder, startTime, maxRuntime, processedCount);

  } catch (err) {
    console.error(`Erreur critique dans runTranscriptionBatch_: ${err.message}`, err.stack);
    logError_('Erreur critique runTranscriptionBatch_', err); // Log centralisé pour le batch
  }
  console.log(`Script B (Worker): runTranscriptionBatch_ terminé. ${processedCount.value} fichiers traités cette fois.`);
}

/**
 * Fonction récursive pour trouver et traiter les fichiers meta.json.
 */
function findAndProcessMetaFiles_(folder, startTime, maxRuntime, processedCountRef) {
  if (Date.now() - startTime > maxRuntime) {
    console.warn("Temps d'exécution maximum atteint, arrêt du batch.");
    return; // Arrêter si le temps est écoulé
  }

  // Traiter les fichiers meta.json dans le dossier courant
  // CORRECTION: Utiliser string au lieu de MimeType Enum
  const metaFiles = folder.getFilesByType("application/json"); 
  
  while (metaFiles.hasNext() && (Date.now() - startTime < maxRuntime)) {
    const metaFile = metaFiles.next();
    
    // Chercher spécifiquement les fichiers terminant par "_meta.json"
    if (!metaFile.getName().endsWith('_meta.json')) continue;

    let meta;
    try {
      meta = JSON.parse(metaFile.getBlob().getDataAsString());
      // Vérifier si le fichier a déjà été traité ou est incomplet
      if (meta.processedByBatch === true || !meta.baseFileName || !meta.audioFileName || !meta.mimeType) {
        continue; // Ignorer les déjà traités ou incomplets
      }
    } catch (parseErr) {
      console.error(`Erreur parsing meta ${metaFile.getName()} dans ${folder.getName()}: ${parseErr.message}`);
      logError_(`Erreur parsing meta ${metaFile.getName()}`, parseErr, folder);
      continue;
    }

    // --- NON TRAITÉ ---
    let transcriptionErrorOccurred = false;

    // CORRECTION LOGIQUE MAJEURE:
    // Marquer comme traité AVANT le traitement long (transcription).
    try {
        meta.processedByBatch = true;
        metaFile.setContent(JSON.stringify(meta, null, 2));
        console.log(`Marquage de ${metaFile.getName()} comme 'traité' AVANT le traitement.`);
    } catch (updateErr) {
        console.error(`Erreur lors du marquage meta ${metaFile.getName()} comme traité: ${updateErr.message}`);
        logError_(`Erreur marquage meta traité ${metaFile.getName()}`, updateErr, folder);
        continue; // Si on ne peut pas marquer, on ne traite pas, sinon boucle infinie
    }
    
    console.log(`Meta non traité trouvé: ${metaFile.getName()} dans ${folder.getName()}`);
    
    // Lancer le traitement (qui peut être long)
    try {
      processSingleAudio_(folder, metaFile, meta);
    } catch (processingErr) {
      // Si l'erreur est une surcharge (503), nous devons annuler le marquage "traité".
      if (processingErr.message.includes('HTTP 503') || processingErr.message.includes('overloaded')) {
        console.warn(`ERREUR 503: Surcharge détectée pour ${metaFile.getName()}. Annulation du marquage pour réessayer plus tard.`);
        logError_(`Erreur 503 (surcharge) pour ${metaFile.getName()}`, processingErr, folder);
        // Annuler le marquage
        try {
          meta.processedByBatch = false; // Remettre à false
          metaFile.setContent(JSON.stringify(meta, null, 2));
        } catch (revertErr) {
          logError_(`ERREUR CRITIQUE: Impossible d'annuler le marquage de ${metaFile.getName()}`, revertErr, folder);
        }
      } else {
        // Pour les autres erreurs (ex: fichier audio manquant), on laisse marqué "traité"
        console.error(`Erreur irrécupérable lors du traitement de ${metaFile.getName()}: ${processingErr.message}`);
        logError_(`Erreur irrécupérable processSingleAudio_ ${metaFile.getName()}`, processingErr, folder);
      }
      transcriptionErrorOccurred = true;
    }

    // Incrémenter la référence objet
    processedCountRef.value++; 
    
    // CORRECTION ANTI-503: Faire une pause après CHAQUE fichier (réussi ou non)
    // pour ne pas surcharger l'API Gemini (ex: 15 requêtes/min).
    // Ne pas pauser si c'est juste un 'skip' (déjà traité), mais pauser si c'est un 'vrai' traitement.
    if (!transcriptionErrorOccurred) {
        console.log(`Traitement de ${metaFile.getName()} réussi. Pause de 20 secondes...`);
    } else {
        console.warn(`Traitement de ${metaFile.getName()} échoué. Pause de 20 secondes...`);
    }
    Utilities.sleep(20000); // Pause de 20 secondes
  }

  // Parcourir les sous-dossiers (inchangé)
  const subFolders = folder.getFolders();
  while (subFolders.hasNext() && (Date.now() - startTime < maxRuntime)) {
    findAndProcessMetaFiles_(subFolders.next(), startTime, maxRuntime, processedCountRef);
  }
}


/**
 * Traite un seul fichier audio (transcription, sauvegarde, copie, email).
 * NOTE : Cette fonction 'propage' (throw) les erreurs Gemini pour être gérée par la fonction appelante.
 */
function processSingleAudio_(userFolder, metaFile, meta) {
  console.log(`Traitement de ${meta.audioFileName}`);
  const transcriptFileName = `${meta.baseFileName}_transcript.txt`;

  // 1. Vérifier si le transcript existe déjà (double sécurité)
  if (userFolder.getFilesByName(transcriptFileName).hasNext()) {
    console.warn(`Transcript ${transcriptFileName} existe déjà. Skip.`);
    return; 
  }

  // 2. Trouver le fichier audio
  const audioFiles = userFolder.getFilesByName(meta.audioFileName);
  if (!audioFiles.hasNext()) {
    // C'est une erreur irrécupérable pour ce fichier
    logError_(`Audio ${meta.audioFileName} manquant`, new Error('Fichier audio non trouvé mais meta existe.'), userFolder);
    return; // Ne propage pas l'erreur, on abandonne ce fichier
  }
  const audioFile = audioFiles.next();
  const audioBytes = audioFile.getBlob().getBytes();

  // 3. Transcrire
  // La fonction transcribeWithGemini_ va 'throw' une erreur si elle échoue (ex: 503)
  // Cette erreur sera attrapée par findAndProcessMetaFiles_
  let transcription;
  try {
    transcription = transcribeWithGemini_(audioBytes, meta.mimeType);
    
    if (transcription.startsWith('[ERREUR_TRANSCRIPTION')) {
        console.warn(`Erreur logique de transcription pour ${meta.audioFileName}, email ne sera pas envoyé.`);
        // Sauvegarder l'erreur
        userFolder.createFile(transcriptFileName, transcription, "text/plain"); 
        return; // Abandonner ce fichier
    }
  } catch (geminiErr) {
      // Si transcribeWithGemini_ échoue (ex: 503, 400), on sauvegarde l'erreur
      transcription = `[ERREUR_TRANSCRIPTION_BACKEND: ${geminiErr.message}]`;
      userFolder.createFile(transcriptFileName, transcription, "text/plain"); 
      // ET on propage l'erreur pour que la fonction appelante puisse décider de réessayer
      throw geminiErr; 
  }


  // 4. Sauvegarder la transcription
  const transcriptFile = userFolder.createFile(transcriptFileName, transcription, "text/plain"); 
  console.log(`Transcription sauvegardée: ${transcriptFileName}`);

  // 5. Copier la transcription
  try {
    const transcriptsRoot = DriveApp.getFolderById(TRANSCRIPTS_FOLDER_ID);
    const transcriptCopyName = `${meta.used}_${meta.profile}_${userFolder.getName()}_${meta.baseFileName}.txt`;
    transcriptsRoot.createFile(transcriptCopyName, transcription, "text/plain"); 
    console.log(`Copie transcription réussie: ${transcriptCopyName}`);
  } catch (copyErr) {
    logError_('Erreur copie transcription (batch)', copyErr, userFolder);
    console.error(`Erreur copie transcription (batch): ${copyErr.message}`);
    // On ne propage pas cette erreur, c'est non critique
  }

  // 6. Envoyer l'email de notification
  sendNotificationEmail_(meta, transcription, userFolder);
  
  // Pas d'erreur, le traitement est un succès.
}


/**
 * Envoie l'e-mail de notification.
 */
function sendNotificationEmail_(meta, transcription, userFolder) {
  console.log(`Tentative d'envoi d'e-mail pour ${meta.studentCode}`);
  try {
    const subject = `CHOPS – (Transcrit) Nouvelle réponse : ${meta.profile} / ${meta.studentCode} (${meta.topic})`;
    const body = [
      `Une nouvelle réponse vocale a été reçue et transcrite.`,
      `--------------------`,
      `Date de réception: ${new Date(meta.receivedAt).toLocaleString()}`,
      `Profil: ${meta.profile}, Usage: ${meta.used}`,
      `Utilisateur: ${meta.studentCode} (Contexte: ${meta.cohort})`,
      `Sujet: ${meta.topic}, Durée: ~${meta.durationSec}s`,
      `--------------------`,
      `Transcription:`,
      `${transcription.slice(0, 1500)}${transcription.length > 1500 ? '...' : ''}`,
      `--------------------`,
      `Lien vers le dossier utilisateur:`,
      userFolder.getUrl()
    ].join('\n');
    GmailApp.sendEmail(NOTIFY_EMAIL, subject, body, { name: "CHOPS Voice Bot" });
    console.log("E-mail envoyé.");
  } catch (err) {
    console.error(`Erreur envoi e-mail (batch): ${err.message}`);
    logError_('Erreur envoi Email (batch)', err, userFolder);
    // On ne propage pas cette erreur, c'est non critique
  }
}

/**
 * (À EXÉCUTER 1 FOIS MANUELLEMENT) Installe le déclencheur temporel.
 */
function installTrigger_ScriptB() {
  uninstallTriggers_ScriptB(); // Nettoyer d'abord

  ScriptApp.newTrigger('runTranscriptionBatch_')
      .timeBased()
      .everyMinutes(10)
      .create();
  console.log("Déclencheur 'runTranscriptionBatch_' (toutes les 10 min) installé pour Script B.");
}

/**
 * (Utilitaire - À EXÉCUTER MANUELLEMENT SI BESOIN) Supprime les déclencheurs.
 */
function uninstallTriggers_ScriptB() {
  const triggers = ScriptApp.getProjectTriggers();
  let deletedCount = 0;
  for (const trigger of triggers) {
      if (trigger.getHandlerFunction() === 'runTranscriptionBatch_') {
         ScriptApp.deleteTrigger(trigger);
         deletedCount++;
      }
  }
  console.log(`${deletedCount} déclencheur(s) 'runTranscriptionBatch_' supprimé(s) pour Script B.`);
}

/* =================================================================================== */
/* =================== FONCTION API GEMINI (Inchangée) ==================== */
/* =================================================================================== */

function transcribeWithGemini_(audioBytes, mimeType) {
  console.log(`Appel à l'API Gemini avec mimeType: ${mimeType}`);
  if (!GEMINI_API_KEY || GEMINI_API_KEY.startsWith('xxxxxxx') || GEMINI_API_KEY.length < 10) {
    throw new Error('Clé API Gemini non configurée ou invalide dans le backend.');
  }
    if (!mimeType || typeof mimeType !== 'string' || mimeType.length === 0 || mimeType === 'null' || mimeType === 'undefined') {
      console.warn(`MimeType invalide fourni à Gemini: '${mimeType}'. Utilisation de 'audio/webm' par défaut.`);
      mimeType = 'audio/webm'; // Fallback
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const bodyObj = {
    contents: [{ role: "user", parts: [ { text: "Transcris l’audio ci-dessous en FRANÇAIS. Le texte doit être brut, sans formatage, sans résumer, et sans ajouter de commentaires comme 'Transcription:'." }, { inlineData: { mimeType: mimeType, data: Utilities.base64Encode(audioBytes) } } ] }],
    generationConfig: { temperature: 0.1 }
  };
  const options = { method: 'post', contentType: 'application/json', payload: JSON.stringify(bodyObj), muteHttpExceptions: true };

  console.log(`Envoi requête Gemini (${url})`);
  const res = UrlFetchApp.fetch(url, options);
  const code = res.getResponseCode();
  const txt = res.getContentText();
  console.log(`Réponse Gemini reçue, code: ${code}`);

  if (code < 200 || code >= 300) {
      console.error(`Erreur HTTP Gemini: ${txt.slice(0, 500)}`);
    throw new Error(`Erreur Gemini HTTP ${code}: ${txt.slice(0, 300)}`);
  }
  const json = JSON.parse(txt);
  if (!json.candidates || json.candidates.length === 0 || !json.candidates[0].content || !json.candidates[0].content.parts || json.candidates[0].content.parts.length === 0) {
      console.error("Réponse Gemini vide/malformée/bloquée.", JSON.stringify(json, null, 2));
      const finishReason = json.candidates?.[0]?.finishReason;
      if (finishReason && finishReason !== 'STOP') { throw new Error(`Transcription terminée anormalement par Gemini (Raison: ${finishReason})`); }
      if (json.promptFeedback?.blockReason) { throw new Error(`Transcription bloquée par Gemini (Raison: ${json.promptFeedback.blockReason})`); }
    throw new Error('Réponse vide ou malformée de Gemini.');
  }
  const transcription = json.candidates[0].content.parts[0].text || '';
  return transcription;
}

/* =================================================================================== */
/* ================= FONCTIONS UTILITAIRES (Corrigées) ================== */
/* =================================================================================== */

function sanitize_(s, maxLength = 32) {
  if (!s) return 'NA'; const sanitized = String(s) .replace(/[^A-Za-z0-9\u00C0-\u017F\_\-\+]/g, '_') .replace(/__+/g, '_') .replace(/^\_+|\_+$/g, '') .slice(0, maxLength); return sanitized || 'NA';
}

function logError_(context, err, userFolder) { 
  const errorMsg = `[${new Date().toISOString()}] ERREUR SCRIPT B (${context}): ${err.message || String(err)}${err.stack ? '\nStack: ' + err.stack : ''}`;
  console.error(errorMsg);
  
  // Tenter d'écrire dans le dossier de l'utilisateur s'il existe
  if (userFolder && typeof userFolder.createFile === 'function') {
    try {
      let logFile; const files = userFolder.getFilesByName('log_erreurs_batch.txt');
      
      if (files.hasNext()) { 
        logFile = files.next(); 
      } else { 
        // CORRECTION: Utiliser string au lieu de MimeType Enum
        logFile = userFolder.createFile('log_erreurs_batch.txt', '', "text/plain"); 
      }
      
      const lock = LockService.getScriptLock(); 
      lock.waitLock(10000); 
      // CORRECTION: Utiliser .appendContents() au lieu de .append()
      logFile.appendContents(errorMsg + '\n\n'); 
      lock.releaseLock();
      
    } catch (e) { 
      console.error(`Échec écriture log_erreurs_batch.txt: ${e}`); 
    }
  } else if (!userFolder) { 
    console.warn(`logError_ (Script B) appelé sans userFolder valide pour '${context}'.`); 
  }
}


function getOrCreateFolder_(parentFolder, folderName) {
  if (!folderName || typeof folderName !== 'string' || folderName.trim().length === 0) { console.error(`Nom dossier invalide: '${folderName}'`); folderName = 'Dossier_Invalide'; } const folders = parentFolder.getFoldersByName(folderName); if (folders.hasNext()) { return folders.next(); } else { console.log(`Création dossier: ${folderName} dans ${parentFolder.getName()}`); return parentFolder.createFolder(folderName); }
}

/**
 * (À EXÉCUTER 1 FOIS MANUELLEMENT) Teste les permissions nécessaires.
 */
function testPermissions_ScriptB() {
  // Vérification de sécurité
  if (!GEMINI_API_KEY || !NOTIFY_EMAIL || !PARENT_FOLDER_ID || !TRANSCRIPTS_FOLDER_ID) {
    console.error("ERREUR: Une ou plusieurs propriétés de script ne sont pas définies.");
    console.error("Veuillez configurer les 'Propriétés du script' dans les Paramètres du projet (⚙️).");
    Logger.log("Erreur test permissions Script B: Propriétés de script manquantes.");
    return;
  }
  
  try {
    DriveApp.getFolderById(PARENT_FOLDER_ID); // Test Drive
    GmailApp.sendEmail(NOTIFY_EMAIL, "Test Permission Script B", "Test Gmail OK."); // Test Gmail
    UrlFetchApp.fetch('https://www.google.com'); // Test UrlFetch
    Logger.log("Test permissions Script B réussi ! (Drive, Gmail, UrlFetch)");
  } catch (e) {
    Logger.log(`Erreur test permissions Script B: ${e.message}`);
  }
}
