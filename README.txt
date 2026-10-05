MONEY TRACKER - app files (upload these to GitHub Pages)

BEFORE UPLOADING
 1. Open config.js and paste your Google OAuth Client ID (see chat steps).

UPLOAD
 2. Create a GitHub repository named  YOURNAME.github.io  (public).
 3. Upload ALL files in this folder to the root of the repository
    (including the hidden file .nojekyll).
 4. Settings > Pages > Deploy from a branch > main > / (root) > Save.
 5. Your app is then at  https://YOURNAME.github.io/

MAKE THE APK
 6. Go to pwabuilder.com, paste your link, Start > Package for stores > Android.
 7. Download the zip. It contains the .apk (the install file) and assetlinks.json.
 8. Upload assetlinks.json into the repository folder  .well-known/
    (path: .well-known/assetlinks.json) so the app opens full screen.

SHARE
 9. Send the .apk to any Android phone. Installing and opening it asks the
    user to sign in with Google; the spreadsheet is created automatically
    in that user's own Drive. Nothing else to do.
