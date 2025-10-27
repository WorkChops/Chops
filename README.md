<!-- /README.md -->
# Mini-Voiceform CHOPS (HTML + Apps Script + Gemini)

Collecte zéro-friction de retours vocaux étudiants sur CHOPS/CHOPi : une page HTML (GitHub Pages) enregistre l’audio et l’envoie à un Web App Apps Script. Le backend stocke audio + métadonnées, lance une transcription Gemini, sauvegarde le `.txt` et notifie l’enseignant.

## Structure
/project-root
/frontend
index.html
/assets
chopi_logo.png
chopi_mark.png
favicon.ico
/backend
Code.gs
appsscript.json

## Mise en place (pas à pas)
1. **Drive** : créez un dossier parent (ex. `CHOPS_Responses`) → copiez son **ID** → remplacez `PARENT_FOLDER_ID` dans `Code.gs`.
2. **Apps Script** : nouveau projet → collez `Code.gs` et `appsscript.json` (Fichier > Projet Manifeste) → **Renseignez** `GEMINI_API_KEY`, `NOTIFY_EMAIL`, `PARENT_FOLDER_ID`, ajustez `ENABLE_TRANSCRIPTION` si besoin.
3. **Déploiement Web App** : Publier > Déployer en tant que application web → *Exécuter en tant que* **Moi** ; *Qui a accès* **Toute personne disposant du lien** → copiez l’URL et mettez-la dans `WEBAPP_URL` de `index.html`.
4. **Frontend** : placez `chopi_logo.png`, `chopi_mark.png`, `favicon.ico` dans `/frontend/assets/`. Ouvrez `index.html`, vérifiez que `WEBAPP_URL` est renseignée.
5. **GitHub Pages** : poussez `/frontend` (ou tout le repo) et activez Pages. Testez depuis Chrome (mobile + desktop).

## Utilisation
- Remplir métadonnées → cocher consentement → **Enregistrer** (max 120 s, arrêt auto) → pré-écoute → **Envoyer**.
- États visibles : *Enregistrement en cours…*, *Prêt à l’envoi*, *Transfert…*, *Terminé ✅*.
- Le backend crée `CHOPS_{cohort}_{studentCode}_{topic}_{yyyyMMdd_HHmmss}` sous le dossier parent, y dépose :
  - `audio.webm` (ou `audio.mp4` selon MIME),
  - `meta.json`,
  - `transcript.txt` (ou `[TRANSCRIPTION_ERROR] …` si l’API échoue),
  - `log.txt` (si erreurs critiques).
- Un email est envoyé à `NOTIFY_EMAIL`.

## Quotas, sécurité
- Front : aucun secret exposé. Taille limite 10 Mo (client + serveur).
- Web App : exécuter **en tant que Moi**. Accès **via lien** uniquement.
- Logs : erreurs majeures journalisées dans `log.txt`.

## Coûts & alternatives
- **Gemini Free Tier** possible selon quotas région/compte. En cas de dépassement ou si vous préférez : 
  - `ENABLE_TRANSCRIPTION=false` pour désactiver (toujours stocké, pas de blocage).
  - Transcription ultérieure manuelle (locale) en téléchargeant `audio.*`.

## Tests d’acceptation (checklist)
- Android Chrome & Desktop Chrome/Edge : enregistrer 30–90 s, pré-écouter, envoyer → réponse `ok:true`.
- Refus micro : message clair, aucun crash JS.
- >120 s : arrêt auto + message.
- Panne Gemini : audio + `meta.json` OK, `transcript.txt` contient `[TRANSCRIPTION_ERROR]`.
- Drive : le dossier contient audio, meta, transcript. Email reçu.

## Notes techniques
- Front : `MediaRecorder` + `AudioContext/AnalyserNode` (vu-mètre), base64 POST JSON → `WEBAPP_URL`.
- Back : `doPost` → validations → `DriveApp` → `UrlFetchApp` vers `v1beta/models/gemini-1.5-flash:generateContent` (inlineData base64) avec `temperature=0.2`.
- A11y : labels explicites, focus visibles, messages live (toasts).
