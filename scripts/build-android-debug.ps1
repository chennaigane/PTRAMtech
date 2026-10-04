param(
    [string]$ApiUrl = '',
    [string]$JavaHome = $env:JAVA_HOME,
    [string]$SdkRoot = $env:ANDROID_HOME
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if (!$JavaHome -and (Test-Path 'C:/Program Files/Android/Android Studio/jbr/bin/java.exe')) {
    $JavaHome = 'C:/Program Files/Android/Android Studio/jbr'
}
if (!$SdkRoot -and (Test-Path "$projectRoot/.tools/android-sdk")) { $SdkRoot = "$projectRoot/.tools/android-sdk" }
if (!$JavaHome -or !(Test-Path "$JavaHome/bin/java.exe")) { throw 'JDK 17 required. Pass -JavaHome or set JAVA_HOME.' }
if (!$SdkRoot -or !(Test-Path "$SdkRoot/platforms/android-35/android.jar")) { throw 'Android SDK Platform 35 required. Pass -SdkRoot or set ANDROID_HOME.' }
$env:JAVA_HOME = $JavaHome
$env:ANDROID_HOME = $SdkRoot
$env:GRADLE_USER_HOME = "$projectRoot/.tools/gradle-home"
$env:ANDROID_SDK_HOME = "$projectRoot/.tools/android-profile"
$env:ANDROID_USER_HOME = "$env:ANDROID_SDK_HOME/.android"
$env:DEBUG = ''
New-Item -ItemType Directory -Force $env:ANDROID_USER_HOME | Out-Null
$outputDir = "$projectRoot/outputs/android-debug"
New-Item -ItemType Directory -Force $outputDir | Out-Null
$gradle = "$projectRoot/.tools/gradle-8.11.1/bin/gradle.bat"
if (!(Test-Path $gradle)) { $gradle = "$projectRoot/android/gradlew.bat" }
$buildArgs = @('-p', "$projectRoot/android", ':app:lintDebug', ':app:assembleDebug', '--no-daemon', '--console', 'plain')
if ($ApiUrl) { $buildArgs += "-PptraamApiUrl=$ApiUrl" }
& $gradle @buildArgs
if ($LASTEXITCODE -ne 0) { throw "Android build failed (exit $LASTEXITCODE). No APK copied." }
$sourceApk = "$projectRoot/android/app/build/outputs/apk/debug/app-debug.apk"
if (!(Test-Path $sourceApk)) { throw 'Gradle did not produce app-debug.apk.' }
$signer = "$SdkRoot/build-tools/35.0.0/apksigner.bat"
& $signer verify --verbose --print-certs $sourceApk
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed. No APK copied.' }
$apk = "$outputDir/PTRAAM-Enterprises-debug.apk"
Copy-Item -LiteralPath $sourceApk -Destination $apk -Force
$checksum = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$apk.sha256" -Value "$checksum  PTRAAM-Enterprises-debug.apk" -Encoding ascii
@{
    package = 'com.ptraam.tracker.debug'; variant = 'debug'; sha256 = $checksum
    backend = $(if ($ApiUrl) { $ApiUrl } else { 'Configure HTTPS server in app before signing in' })
    physicalPhoneTest = 'NOT RUN'; apk = $apk; builtAtUtc = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath "$outputDir/build-info.json" -Encoding utf8
Write-Output "Verified debug APK: $apk"
Write-Output "SHA-256: $checksum"
